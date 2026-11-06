'use strict';

/**
 * Perfiles de la navegación suelta = cuentas de Google. Cada cuenta vive en
 * una partition (la de navegación suelta, la de algún acceso web o una
 * importada desde un perfil de Google Chrome); si el mismo mail está iniciado
 * en varias, se muestra una sola vez. Las pestañas nuevas arrancan en
 * "Sin sesión" (incógnito) salvo que el usuario elija otra predeterminada.
 */

const fs = require('fs');
const path = require('path');
const { app, Menu, dialog, nativeImage } = require('electron');
const { LOOSE_NAV_SESSION_ID } = require('./constants');
const { partitionFromSessionId, sessionIdFromName } = require('./session-partition');
const { loadShortcuts } = require('./shortcuts-store');
const { circleIcon, loadAccountPhoto, cachePhotoFromFile } = require('./account-avatar');
const { log } = require('./logger');

const NO_SESSION_LABEL = 'Sin sesión';
/** Misma consulta que usa Chrome para saber qué cuentas hay iniciadas (POST con cuerpo vacío). */
const LIST_ACCOUNTS_URL = 'https://accounts.google.com/ListAccounts?json=standard&source=ChromiumBrowser';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

/**
 * @typedef {{ email: string, name: string, photo: string }} GoogleAccount
 * @typedef {{ partition: string, email: string, name: string, photo: string, label: string, kind: 'loose' | 'session' | 'chrome', avatar?: string }} BrowseProfile
 * @typedef {{ partition: string, label: string, email: string, directory: string }} ChromeImport
 * @typedef {{ chrome: ChromeImport[], chosenDefault: string, accounts: Record<string, GoogleAccount[]> }} Store
 */

function loosePartition() {
  return partitionFromSessionId(LOOSE_NAV_SESSION_ID);
}

/** Sesión limpia para "Sin sesión": no se le buscan cuentas aunque alguien se loguee ahí. */
function guestPartition() {
  return partitionFromSessionId('browse-guest');
}

function storePath() {
  return path.join(app.getPath('userData'), 'browse-profiles.json');
}

/** @param {unknown} raw */
function normalizeAccounts(raw) {
  /** @type {Record<string, GoogleAccount[]>} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [partition, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const accounts = list
      .map((a) => (typeof a === 'string' ? { email: a, name: '', photo: '' } : a))
      .filter((a) => a && typeof a.email === 'string' && a.email)
      .map((a) => ({ email: a.email, name: String(a.name || ''), photo: String(a.photo || '') }));
    if (accounts.length) out[partition] = accounts;
  }
  return out;
}

/** @type {Store | null} */
let storeCache = null;

/** @returns {Store} */
function loadStore() {
  if (storeCache) return storeCache;
  /** @type {Store} */
  let store = { chrome: [], chosenDefault: '', accounts: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf-8'));
    store = {
      chrome: Array.isArray(raw && raw.chrome)
        ? raw.chrome.filter((c) => c && typeof c.partition === 'string' && c.partition)
        : [],
      // `defaultPartition` (la última cuenta usada) se descarta: ahora el predeterminado se elige a mano.
      chosenDefault: typeof raw.chosenDefault === 'string' ? raw.chosenDefault : '',
      accounts: normalizeAccounts(raw.accounts),
    };
  } catch {
    /* primer uso */
  }
  storeCache = store;
  return store;
}

/** @param {Store} store */
function saveStore(store) {
  storeCache = store;
  try {
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    /* noop */
  }
}

/**
 * Partitions donde puede haber una cuenta de Google, en orden de preferencia
 * para cuando el mismo mail está en varias.
 * @returns {Array<{ partition: string, kind: BrowseProfile['kind'], names: string[] }>}
 */
function candidatePartitions() {
  const store = loadStore();
  const out = [{ partition: loosePartition(), kind: /** @type {const} */ ('loose'), names: ['Navegación suelta'] }];
  const index = new Map([[out[0].partition, out[0]]]);
  for (const c of store.chrome) {
    if (index.has(c.partition)) continue;
    const entry = { partition: c.partition, kind: /** @type {const} */ ('chrome'), names: [c.label || c.directory] };
    index.set(c.partition, entry);
    out.push(entry);
  }
  let shortcuts = [];
  try {
    shortcuts = loadShortcuts();
  } catch {
    shortcuts = [];
  }
  for (const s of shortcuts) {
    if (!s || s.type !== 'web') continue;
    const partition = partitionFromSessionId(s.sessionId);
    let entry = index.get(partition);
    if (!entry) {
      entry = { partition, kind: /** @type {const} */ ('session'), names: [] };
      index.set(partition, entry);
      out.push(entry);
    }
    const name = (s.name && String(s.name).trim()) || '';
    if (name && entry.kind === 'session') entry.names.push(name);
  }
  return out;
}

/** @type {Map<string, string>} partition → data URL de la foto redonda */
const avatarDataUrls = new Map();

/**
 * "Sin sesión" siempre primero; después una entrada por mail.
 * @returns {BrowseProfile[]}
 */
function listProfiles() {
  const store = loadStore();
  const candidates = candidatePartitions();
  const preferred = store.chosenDefault;
  const ordered = preferred
    ? [...candidates.filter((c) => c.partition === preferred), ...candidates.filter((c) => c.partition !== preferred)]
    : candidates;

  /** @type {Map<string, BrowseProfile>} */
  const byEmail = new Map();
  for (const c of ordered) {
    const account = (store.accounts[c.partition] || [])[0];
    if (!account) continue;
    const key = account.email.toLowerCase();
    if (byEmail.has(key)) continue;
    byEmail.set(key, {
      partition: c.partition,
      email: account.email,
      name: account.name,
      photo: account.photo,
      label: account.email,
      kind: c.kind,
      avatar: avatarDataUrls.get(c.partition),
    });
  }
  const accounts = [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
  return [
    {
      partition: guestPartition(),
      email: '',
      name: '',
      photo: '',
      label: NO_SESSION_LABEL,
      kind: 'loose',
      avatar: avatarFor(guestPartition()),
    },
    ...accounts,
  ];
}

/** Perfil predeterminado: el elegido por el usuario o, si no hay, "Sin sesión". */
function defaultPartition() {
  const chosen = loadStore().chosenDefault;
  if (
    chosen &&
    (listProfiles().some((p) => p.partition === chosen) ||
      candidatePartitions().some((c) => c.partition === chosen))
  ) {
    return chosen;
  }
  return guestPartition();
}

/** @param {string} partition */
function setDefaultPartition(partition) {
  if (!partition) return;
  saveStore({ ...loadStore(), chosenDefault: partition === guestPartition() ? '' : partition });
}

/**
 * Nombre para mostrar de cualquier partition, aunque no tenga cuenta de Google
 * (pestañas abiertas desde un acceso sin Google).
 * @param {string} partition
 */
function labelFor(partition) {
  if (partition === guestPartition()) return NO_SESSION_LABEL;
  const account = (loadStore().accounts[partition] || [])[0];
  if (account) return account.email;
  const c = candidatePartitions().find((x) => x.partition === partition);
  if (c && c.names.length) return c.names.slice(0, 2).join(' · ');
  return NO_SESSION_LABEL;
}

/** @param {string} partition */
function avatarFor(partition) {
  if (partition === guestPartition()) {
    if (!avatarDataUrls.has(partition)) avatarDataUrls.set(partition, circleIcon(null, '').toDataURL());
  }
  return avatarDataUrls.get(partition) || '';
}

/** @param {string} partition */
function profileFor(partition) {
  const p = listProfiles().find((x) => x.partition === partition);
  return p || { partition, email: '', name: '', photo: '', label: labelFor(partition), kind: 'session' };
}

/**
 * @param {unknown} node
 * @param {GoogleAccount[]} out
 * @param {number} depth
 */
function collectAccounts(node, out, depth) {
  if (!Array.isArray(node) || depth > 6) return;
  // Fila de ListAccounts: [_, _, nombre, mail, foto, ...]
  if (typeof node[3] === 'string' && EMAIL_RE.test(node[3])) {
    if (!out.some((a) => a.email.toLowerCase() === node[3].toLowerCase())) {
      out.push({
        email: node[3],
        name: typeof node[2] === 'string' ? node[2] : '',
        photo: typeof node[4] === 'string' && /^https:\/\//i.test(node[4]) ? node[4] : '',
      });
    }
    return;
  }
  for (const child of node) collectAccounts(child, out, depth + 1);
}

/**
 * @param {string} partition
 * @returns {Promise<GoogleAccount[]>}
 */
async function fetchAccountsList(partition) {
  const ses = require('electron').session.fromPartition(partition);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await ses.fetch(LIST_ACCOUNTS_URL, {
      method: 'POST',
      body: ' ',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) log(`ListAccounts ${partition}: HTTP ${res.status}`);
    return res.ok ? text : '';
  } catch (err) {
    log(`ListAccounts ${partition}: ${err && err.message ? err.message : err}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function detectAccounts(partition) {
  const router = require('./session-router');
  /** @type {GoogleAccount[]} */
  const found = [];
  const body = await fetchAccountsList(partition);
  if (body) {
    const raw = body.replace(/^\)\]\}'\s*/, '').trim();
    try {
      collectAccounts(JSON.parse(raw), found, 0);
    } catch {
      /* formato inesperado: se prueba con el feed de Gmail */
    }
  }
  if (found.length === 0) {
    const emails = await router.googleEmailsForPartition(partition);
    for (const email of emails) found.push({ email, name: '', photo: '' });
  }
  return found;
}

async function warmAvatars() {
  const { accounts } = loadStore();
  await Promise.all(
    Object.entries(accounts).map(async ([partition, list]) => {
      const a = list[0];
      if (!a) return;
      const photo = await loadAccountPhoto(a.email, a.photo, partition);
      avatarDataUrls.set(partition, circleIcon(photo, a.email).toDataURL());
    })
  );
}

let refreshing = null;

/**
 * Relee qué cuenta de Google está iniciada en cada partition. Solo sale a la
 * red donde hay cookies de login de Google.
 * @returns {Promise<void>}
 */
function refreshAccounts() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const router = require('./session-router');
    const previous = loadStore().accounts;
    /** @type {Record<string, GoogleAccount[]>} */
    const accounts = {};
    await Promise.all(
      candidatePartitions().map(async (c) => {
        try {
          if (!(await router.partitionHasLoginForDomain(c.partition, 'google.com'))) return;
          const found = await detectAccounts(c.partition);
          if (found.length) accounts[c.partition] = found;
          else if (previous[c.partition]) accounts[c.partition] = previous[c.partition];
        } catch {
          /* esa partition queda sin cuenta */
        }
      })
    );
    saveStore({ ...loadStore(), accounts });
    await warmAvatars();
    refreshChromeRail();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const IMPORT_ERRORS = {
  CHROME_RUNNING: 'Cerrá Google Chrome por completo y volvé a intentarlo: mientras está abierto no se pueden leer sus sesiones.',
  CHROME_CLOSE_FAILED: 'No se pudo cerrar Google Chrome. Cerralo a mano y volvé a intentarlo.',
  CHROME_NOT_FOUND: 'No se encontró Google Chrome instalado.',
  CHROME_PROFILE_DIR_NOT_FOUND: 'No se encontró la carpeta de perfiles de Google Chrome.',
  NOT_SUPPORTED_PLATFORM: 'Importar perfiles de Chrome solo está disponible en Windows.',
};

/**
 * Importa las cookies de un perfil de Chrome a una partition propia.
 * @param {Electron.BrowserWindow | null} host
 * @param {{ directory: string, name: string, userName: string, picturePath?: string }} chromeProfile
 * @returns {Promise<string | null>} partition creada
 */
async function importChromeProfile(host, chromeProfile) {
  const sessionId = sessionIdFromName(`chrome-${chromeProfile.directory}`) || 'chrome-default';
  const partition = partitionFromSessionId(sessionId);
  if (!(await require('./chrome-cookie-import').confirmChromeCloseForImport(host))) return null;
  try {
    await require('./chrome-cookie-import').importGoogleCookiesFromChrome({
      profileDirectory: chromeProfile.directory,
      targetPartition: partition,
      autoCloseChrome: true,
    });
  } catch (err) {
    const code = err && typeof err.message === 'string' ? err.message : '';
    const opts = {
      type: /** @type {const} */ ('warning'),
      message: 'No se pudo traer la cuenta desde Chrome',
      detail: IMPORT_ERRORS[code] || `Error: ${code || 'desconocido'}`,
      buttons: ['Entendido'],
    };
    if (host && !host.isDestroyed()) await dialog.showMessageBox(host, opts);
    else await dialog.showMessageBox(opts);
    return null;
  }
  if (chromeProfile.userName && chromeProfile.picturePath) {
    cachePhotoFromFile(chromeProfile.userName, chromeProfile.picturePath);
  }
  const store = loadStore();
  saveStore({
    ...store,
    chrome: [
      ...store.chrome.filter((c) => c.partition !== partition),
      {
        partition,
        label: chromeProfile.name,
        email: chromeProfile.userName || '',
        directory: chromeProfile.directory,
      },
    ],
  });
  await refreshAccounts();
  const after = loadStore();
  if (!after.accounts[partition] && chromeProfile.userName) {
    saveStore({
      ...after,
      accounts: {
        ...after.accounts,
        [partition]: [{ email: chromeProfile.userName, name: chromeProfile.name, photo: '' }],
      },
    });
    await warmAvatars();
  }
  return partition;
}

/** @param {string} filePath */
function imageFromFile(filePath) {
  if (!filePath) return null;
  try {
    const img = nativeImage.createFromPath(filePath);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

/** @type {Array<{ directory: string, name: string, email: string, avatar: string }>} */
let chromeRail = [];

/** Perfiles de Chrome cuyo mail todavía no está en ninguna sesión de la app. */
function refreshChromeRail() {
  const known = new Set(listProfiles().map((p) => p.email.toLowerCase()).filter(Boolean));
  let list = [];
  try {
    list = require('./chrome-cookie-import').listChromeProfiles();
  } catch {
    list = [];
  }
  chromeRail = list
    .filter((c) => !c.userName || !known.has(c.userName.toLowerCase()))
    .map((c) => {
      const photo = imageFromFile(c.picturePath);
      return {
        directory: c.directory,
        name: c.name,
        email: c.userName || '',
        avatar: photo ? circleIcon(photo, c.userName || c.name).toDataURL() : '',
      };
    });
}

/**
 * Riel vertical de la navegación suelta: "Sin sesión", las cuentas de la app
 * y, aparte, las de Chrome que se pueden traer.
 */
function railEntries() {
  return {
    accounts: listProfiles().map((p) =>
      p.email
        ? { partition: p.partition, email: p.email, name: p.name, avatar: avatarFor(p.partition) }
        : { partition: p.partition, email: '', name: p.label, avatar: '', incognito: true }
    ),
    chrome: chromeRail.map((c) => ({ ...c })),
  };
}

/**
 * @param {Electron.BrowserWindow | null} host
 * @param {string} directory carpeta del perfil de Chrome
 * @returns {Promise<string | null>} partition donde quedó la cuenta
 */
async function importChromeByDirectory(host, directory) {
  let profile = null;
  try {
    profile = require('./chrome-cookie-import').listChromeProfiles().find((c) => c.directory === directory) || null;
  } catch {
    profile = null;
  }
  if (!profile) return null;
  const partition = await importChromeProfile(host, profile);
  refreshChromeRail();
  return partition;
}

/**
 * Menú nativo (se dibuja por encima de las páginas embebidas): "Sin sesión",
 * las cuentas de la app y, debajo, las de Chrome que todavía no están.
 * Elegir una la deja como predeterminada.
 * @param {Electron.BrowserWindow | null} host
 * @returns {Promise<string | null>} partition elegida o null si se cerró sin elegir
 */
async function pickProfile(host) {
  try {
    await refreshAccounts();
  } catch {
    /* se muestran las cuentas conocidas */
  }
  const profiles = listProfiles();
  const currentDefault = defaultPartition();
  const knownEmails = new Set(profiles.map((p) => p.email.toLowerCase()).filter(Boolean));
  let chromeProfiles = [];
  try {
    chromeProfiles = require('./chrome-cookie-import')
      .listChromeProfiles()
      .filter((c) => !c.userName || !knownEmails.has(c.userName.toLowerCase()));
  } catch {
    chromeProfiles = [];
  }

  /** @type {Map<string, Electron.NativeImage>} */
  const icons = new Map();
  await Promise.all(
    profiles.map(async (p) => {
      if (!p.email) return;
      const photo = await loadAccountPhoto(p.email, p.photo, p.partition);
      icons.set(p.partition, circleIcon(photo, p.email));
    })
  );

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const choose = (partition) => {
      setDefaultPartition(partition);
      finish(partition);
    };

    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = profiles.map((p) => ({
      label: p.partition === currentDefault ? `${p.label}   ✓` : p.label,
      icon: icons.get(p.partition) || circleIcon(null, p.email),
      click: () => choose(p.partition),
    }));

    if (chromeProfiles.length) {
      template.push({ type: 'separator' });
      for (const c of chromeProfiles) {
        template.push({
          label: `${c.userName || c.name}   · desde Chrome`,
          icon: circleIcon(imageFromFile(c.picturePath), c.userName || c.name),
          click: () => {
            settled = true;
            importChromeProfile(host, c).then(
              (partition) => {
                if (partition) setDefaultPartition(partition);
                resolve(partition);
              },
              () => resolve(null)
            );
          },
        });
      }
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: host && !host.isDestroyed() ? host : undefined,
      callback: () => setTimeout(() => finish(null), 150),
    });
  });
}

module.exports = {
  loosePartition,
  listProfiles,
  profileFor,
  labelFor,
  avatarFor,
  defaultPartition,
  setDefaultPartition,
  refreshAccounts,
  pickProfile,
  railEntries,
  importChromeByDirectory,
};

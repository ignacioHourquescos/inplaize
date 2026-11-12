'use strict';

/**
 * Motor de importación desde navegadores basados en Chromium (Chrome, Edge,
 * Brave, Vivaldi, Opera) hacia la app. A diferencia de `chrome-cookie-import.js`
 * (que solo trae cookies de Google/accesos), este módulo copia el perfil
 * completo al estilo Comet: cookies, historial, marcadores y contraseñas.
 *
 * Qué lee de cada perfil:
 *  - Cookies: igual que `chrome-cookie-import`, lanzando el propio navegador en
 *    `--headless=new` con `--remote-debugging-port=0` y pidiendo `Storage.getCookies`
 *    por CDP. Es la única forma fiable con App-Bound Encryption (Chrome/Edge 127+).
 *  - Historial: copia del SQLite `History` (tabla `urls`) a un temporal y lectura
 *    con `node:sqlite` (incluido en Electron 41). Se puede copiar aunque el
 *    navegador esté abierto.
 *  - Marcadores: archivo `Bookmarks` (JSON), sin dependencias.
 *  - Contraseñas: `Login Data` (SQLite). La clave AES se saca de `Local State`
 *    (`os_crypt.encrypted_key`) desprotegiéndola con DPAPI (CryptUnprotectData vía
 *    koffi) y cada valor `v10/v11` se descifra con AES-256-GCM. Los valores
 *    `v20`/app-bound (habituales en Edge) necesitan la clave del servicio de
 *    elevación del navegador y no se pueden descifrar acá: se cuentan como omitidos.
 *
 * Solo Windows en esta versión.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { isImageRunning, closeImage, waitImageExit, killPidTree } = require('./win-image');

let _sqlite = null;
function sqlite() {
  if (_sqlite) return _sqlite;
  // `node:sqlite` es experimental; lo cargamos perezoso para no emitir el warning
  // salvo que de verdad haga falta leer historial/contraseñas.
  _sqlite = require('node:sqlite');
  return _sqlite;
}

/* ----------------------------------------------------------------------------
 * Registro de navegadores soportados (layout estándar de Chromium en Windows).
 * -------------------------------------------------------------------------- */

/**
 * @typedef {{ id: string, name: string, userDataDir: () => (string | null), exeCandidates: () => string[], processName: string }} BrowserDef
 */

const LOCAL = () => process.env.LOCALAPPDATA || '';
const PF = () => process.env['ProgramFiles'] || '';
const PF86 = () => process.env['ProgramFiles(x86)'] || '';

/** @type {Record<string, BrowserDef>} */
const BROWSERS = {
  chrome: {
    id: 'chrome',
    name: 'Google Chrome',
    userDataDir: () => (LOCAL() ? path.join(LOCAL(), 'Google', 'Chrome', 'User Data') : null),
    exeCandidates: () => [
      PF() && path.join(PF(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
      PF86() && path.join(PF86(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
      LOCAL() && path.join(LOCAL(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean),
    processName: 'chrome.exe',
  },
  edge: {
    id: 'edge',
    name: 'Microsoft Edge',
    userDataDir: () => (LOCAL() ? path.join(LOCAL(), 'Microsoft', 'Edge', 'User Data') : null),
    exeCandidates: () => [
      PF86() && path.join(PF86(), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      PF() && path.join(PF(), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean),
    processName: 'msedge.exe',
  },
  brave: {
    id: 'brave',
    name: 'Brave',
    userDataDir: () =>
      LOCAL() ? path.join(LOCAL(), 'BraveSoftware', 'Brave-Browser', 'User Data') : null,
    exeCandidates: () => [
      PF() && path.join(PF(), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      PF86() && path.join(PF86(), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      LOCAL() &&
        path.join(LOCAL(), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ].filter(Boolean),
    processName: 'brave.exe',
  },
  vivaldi: {
    id: 'vivaldi',
    name: 'Vivaldi',
    userDataDir: () => (LOCAL() ? path.join(LOCAL(), 'Vivaldi', 'User Data') : null),
    exeCandidates: () => [
      LOCAL() && path.join(LOCAL(), 'Vivaldi', 'Application', 'vivaldi.exe'),
      PF() && path.join(PF(), 'Vivaldi', 'Application', 'vivaldi.exe'),
    ].filter(Boolean),
    processName: 'vivaldi.exe',
  },
  opera: {
    id: 'opera',
    name: 'Opera',
    userDataDir: () =>
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Opera Software', 'Opera Stable') : null,
    exeCandidates: () => [
      LOCAL() && path.join(LOCAL(), 'Programs', 'Opera', 'opera.exe'),
      PF() && path.join(PF(), 'Opera', 'opera.exe'),
      PF86() && path.join(PF86(), 'Opera', 'opera.exe'),
    ].filter(Boolean),
    processName: 'opera.exe',
  },
};

/** @param {string} browserId */
function browserDef(browserId) {
  return BROWSERS[browserId] || null;
}

/** @param {string} browserId */
function browserUserDataDir(browserId) {
  if (process.platform !== 'win32') return null;
  const def = browserDef(browserId);
  return def ? def.userDataDir() : null;
}

/** @param {string} browserId */
function findBrowserExecutable(browserId) {
  if (process.platform !== 'win32') return null;
  const def = browserDef(browserId);
  if (!def) return null;
  for (const p of def.exeCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* noop */
    }
  }
  return null;
}

/** Navegadores instalados (ejecutable + carpeta de datos presentes). */
function listInstalledBrowsers() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const id of Object.keys(BROWSERS)) {
    const dir = browserUserDataDir(id);
    const exe = findBrowserExecutable(id);
    if (dir && exe && fs.existsSync(dir)) {
      out.push({ id, name: BROWSERS[id].name });
    }
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * Perfiles.
 * -------------------------------------------------------------------------- */

function historyUrlCount(userDataDir, directory) {
  const src = path.join(userDataDir, directory, 'History');
  if (!fs.existsSync(src)) return 0;
  let tmp = '';
  try {
    tmp = copyToTemp(src, 'hist');
    const { DatabaseSync } = sqlite();
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM urls').get();
      return row && typeof row.c === 'number' ? row.c : 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  } finally {
    safeUnlink(tmp);
  }
}

/**
 * Perfiles de un navegador leyendo `Local State` → `profile.info_cache`.
 * @param {string} browserId
 * @param {{ withHistoryCount?: boolean }} [opts]
 * @returns {Array<{ browser: string, browserName: string, key: string, directory: string, name: string, userName: string, picturePath: string, historyCount: number }>}
 */
function listProfiles(browserId, opts) {
  const userDataDir = browserUserDataDir(browserId);
  if (!userDataDir) return [];
  const def = browserDef(browserId);
  const localStatePath = path.join(userDataDir, 'Local State');
  let cache = {};
  try {
    const data = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    cache = (data && data.profile && data.profile.info_cache) || {};
  } catch {
    cache = {};
  }
  // Algunos navegadores (o perfiles recién migrados) no listan en info_cache;
  // si está vacío, caemos a "Default" si existe la carpeta.
  let entries = Object.entries(cache);
  if (entries.length === 0 && fs.existsSync(path.join(userDataDir, 'Default'))) {
    entries = [['Default', { name: 'Default' }]];
  }
  const withCount = !!(opts && opts.withHistoryCount);
  return entries
    .filter(([directory]) => fs.existsSync(path.join(userDataDir, directory)))
    .map(([directory, info]) => {
      const i = info && typeof info === 'object' ? info : {};
      const pictureFile =
        typeof i.gaia_picture_file_name === 'string' && i.gaia_picture_file_name
          ? i.gaia_picture_file_name
          : 'Google Profile Picture.png';
      const picturePath = path.join(userDataDir, directory, pictureFile);
      return {
        browser: browserId,
        browserName: def ? def.name : browserId,
        key: `${browserId}::${directory}`,
        directory,
        name: typeof i.name === 'string' && i.name ? i.name : directory,
        userName: typeof i.user_name === 'string' ? i.user_name : '',
        picturePath: fs.existsSync(picturePath) ? picturePath : '',
        historyCount: withCount ? historyUrlCount(userDataDir, directory) : 0,
      };
    })
    .sort((a, b) => {
      if (a.directory === 'Default') return -1;
      if (b.directory === 'Default') return 1;
      return a.directory.localeCompare(b.directory);
    });
}

/**
 * Todos los perfiles de todos los navegadores instalados. El más usado (más
 * URLs en el historial) queda primero para preseleccionarlo.
 * @param {{ withHistoryCount?: boolean }} [opts]
 */
function listAllProfiles(opts) {
  if (process.platform !== 'win32') return [];
  const withCount = !(opts && opts.withHistoryCount === false);
  const all = [];
  for (const { id } of listInstalledBrowsers()) {
    for (const p of listProfiles(id, { withHistoryCount: withCount })) all.push(p);
  }
  if (withCount) all.sort((a, b) => b.historyCount - a.historyCount);
  return all;
}

/* ----------------------------------------------------------------------------
 * Proceso del navegador (cerrar / reabrir) — generalizado por processName/exe.
 * -------------------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} processName @returns {Promise<boolean>} */
function isBrowserRunning(processName) {
  return isImageRunning(processName);
}

/** @param {string} processName @returns {Promise<boolean>} */
function closeBrowserForImport(processName) {
  return closeImage(processName);
}

/** @param {string} browserId */
function relaunchBrowser(browserId) {
  const exe = findBrowserExecutable(browserId);
  if (!exe) return false;
  try {
    const child = spawn(exe, ['--restore-last-session'], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * Utilidades de archivos SQLite bloqueados.
 * -------------------------------------------------------------------------- */

/** Copia un archivo (posiblemente en uso) a un temporal y devuelve la ruta. */
function copyToTemp(src, tag) {
  const dst = path.join(
    os.tmpdir(),
    `inplaize-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  fs.copyFileSync(src, dst);
  return dst;
}

function safeUnlink(p) {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    /* noop */
  }
  for (const ext of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(p + ext);
    } catch {
      /* noop */
    }
  }
}

/* ----------------------------------------------------------------------------
 * Historial.
 * -------------------------------------------------------------------------- */

// Chrome guarda los tiempos en microsegundos desde 1601-01-01 (WebKit epoch).
const WEBKIT_EPOCH_OFFSET_MS = 11644473600000;
function chromeTimeToUnixMs(chromeTime) {
  const t = Number(chromeTime);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.round(t / 1000 - WEBKIT_EPOCH_OFFSET_MS);
}

/**
 * @param {string} browserId
 * @param {string} directory
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{ url: string, title: string, visitCount: number, lastVisit: number }>}
 */
function readHistory(browserId, directory, opts) {
  const userDataDir = browserUserDataDir(browserId);
  if (!userDataDir) return [];
  const src = path.join(userDataDir, directory, 'History');
  if (!fs.existsSync(src)) return [];
  const limit = Math.max(1, Math.min(100000, (opts && opts.limit) || 20000));
  let tmp = '';
  try {
    tmp = copyToTemp(src, 'hist');
    const { DatabaseSync } = sqlite();
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      // `last_visit_time` (microsegundos WebKit) supera el entero seguro de JS;
      // node:sqlite lanza si se devuelve como entero, así que lo pedimos como REAL.
      const rows = db
        .prepare(
          'SELECT url, title, visit_count AS vc, CAST(last_visit_time AS REAL) AS lvt ' +
            'FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?',
        )
        .all(limit);
      return rows.map((r) => ({
        url: String(r.url || ''),
        title: String(r.title || ''),
        visitCount: Number(r.vc) || 0,
        lastVisit: chromeTimeToUnixMs(r.lvt),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  } finally {
    safeUnlink(tmp);
  }
}

/* ----------------------------------------------------------------------------
 * Marcadores (archivo Bookmarks en JSON).
 * -------------------------------------------------------------------------- */

/**
 * @param {string} browserId
 * @param {string} directory
 * @returns {Array<{ title: string, url: string, folder: string, added: number }>}
 */
function readBookmarks(browserId, directory) {
  const userDataDir = browserUserDataDir(browserId);
  if (!userDataDir) return [];
  const src = path.join(userDataDir, directory, 'Bookmarks');
  if (!fs.existsSync(src)) return [];
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch {
    return [];
  }
  const roots = (data && data.roots) || {};
  /** @type {Array<{ title: string, url: string, folder: string, added: number }>} */
  const out = [];
  const walk = (node, folder) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url' && node.url) {
      out.push({
        title: String(node.name || node.url),
        url: String(node.url),
        folder,
        added: chromeTimeToUnixMs(node.date_added),
      });
    } else if (node.type === 'folder' && Array.isArray(node.children)) {
      const next = folder ? `${folder}/${node.name || ''}` : String(node.name || '');
      for (const c of node.children) walk(c, next);
    }
  };
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const r = roots[key];
    if (r && Array.isArray(r.children)) for (const c of r.children) walk(c, String(r.name || ''));
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * Contraseñas (Login Data + DPAPI + AES-256-GCM).
 * -------------------------------------------------------------------------- */

let _dpapi = null;
/** CryptUnprotectData vía koffi. Devuelve null si no se puede cargar. */
function dpapi() {
  if (_dpapi !== null) return _dpapi;
  if (process.platform !== 'win32') return (_dpapi = { unprotect: () => null });
  try {
    const koffi = require('koffi');
    const crypt32 = koffi.load('crypt32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const DATA_BLOB = koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: 'uint8*' });
    const CryptUnprotectData = crypt32.func('__stdcall', 'CryptUnprotectData', 'bool', [
      koffi.pointer(DATA_BLOB),
      'void*',
      'void*',
      'void*',
      'void*',
      'uint32',
      koffi.out(koffi.pointer(DATA_BLOB)),
    ]);
    const LocalFree = kernel32.func('__stdcall', 'LocalFree', 'void*', ['void*']);
    _dpapi = {
      /** @param {Buffer} buf @returns {Buffer | null} */
      unprotect(buf) {
        if (!buf || !buf.length) return null;
        const inBlob = { cbData: buf.length, pbData: buf };
        const outBlob = {};
        const ok = CryptUnprotectData(inBlob, null, null, null, null, 0, outBlob);
        if (!ok || !outBlob.pbData || !outBlob.cbData) return null;
        const bytes = Buffer.from(koffi.decode(outBlob.pbData, koffi.array('uint8', outBlob.cbData)));
        try {
          LocalFree(outBlob.pbData);
        } catch {
          /* noop */
        }
        return bytes;
      },
    };
  } catch {
    _dpapi = { unprotect: () => null };
  }
  return _dpapi;
}

/** Clave AES del navegador (os_crypt.encrypted_key de Local State), o null. */
function readMasterKey(browserId) {
  const userDataDir = browserUserDataDir(browserId);
  if (!userDataDir) return null;
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    const b64 = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
    if (!b64) return null;
    let raw = Buffer.from(String(b64), 'base64');
    if (raw.subarray(0, 5).toString('latin1') === 'DPAPI') raw = raw.subarray(5);
    return dpapi().unprotect(raw);
  } catch {
    return null;
  }
}

/**
 * Descifra un valor `password_value`. Soporta v10/v11 (AES-256-GCM con la clave
 * maestra) y el esquema clásico DPAPI. v20/app-bound devuelve null.
 * @param {Buffer} value
 * @param {Buffer | null} key
 */
function decryptSecret(value, key) {
  if (!value || !value.length) return null;
  const prefix = value.subarray(0, 3).toString('latin1');
  if (prefix === 'v10' || prefix === 'v11') {
    if (!key) return null;
    try {
      const nonce = value.subarray(3, 15);
      const tag = value.subarray(value.length - 16);
      const ciphertext = value.subarray(15, value.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
  if (prefix === 'v20') return null; // app-bound: clave del servicio de elevación, no disponible
  // Esquema clásico: todo el blob está protegido con DPAPI.
  const out = dpapi().unprotect(value);
  return out ? out.toString('utf8') : null;
}

/**
 * @param {string} browserId
 * @param {string} directory
 * @returns {{ entries: Array<{ url: string, username: string, password: string }>, skipped: number }}
 */
function readPasswords(browserId, directory) {
  const userDataDir = browserUserDataDir(browserId);
  if (!userDataDir) return { entries: [], skipped: 0 };
  const src = path.join(userDataDir, directory, 'Login Data');
  if (!fs.existsSync(src)) return { entries: [], skipped: 0 };
  const key = readMasterKey(browserId);
  let tmp = '';
  try {
    tmp = copyToTemp(src, 'login');
    const { DatabaseSync } = sqlite();
    const db = new DatabaseSync(tmp, { readOnly: true });
    let skipped = 0;
    const entries = [];
    try {
      const rows = db
        .prepare('SELECT origin_url, username_value, password_value FROM logins')
        .all();
      for (const r of rows) {
        const value = r.password_value ? Buffer.from(r.password_value) : null;
        const password = decryptSecret(value, key);
        if (password == null) {
          skipped += 1;
          continue;
        }
        if (!password && !r.username_value) continue;
        entries.push({
          url: String(r.origin_url || ''),
          username: String(r.username_value || ''),
          password,
        });
      }
    } finally {
      db.close();
    }
    return { entries, skipped };
  } catch {
    return { entries: [], skipped: 0 };
  } finally {
    safeUnlink(tmp);
  }
}

/* ----------------------------------------------------------------------------
 * Cookies (CDP contra el propio navegador en headless).
 * -------------------------------------------------------------------------- */

/**
 * Si el archivo viejo no se pudo borrar, solo vale uno reescrito después
 * de este instante. Si no, conectamos al puerto de una sesión anterior y
 * el pedido de cookies no vuelve nunca.
 * @param {string} portFile
 * @returns {number}
 */
function devToolsPortCutoff(portFile) {
  let cutoff = 0;
  try {
    if (!fs.existsSync(portFile)) return 0;
    cutoff = fs.statSync(portFile).mtimeMs;
    fs.unlinkSync(portFile);
    return 0;
  } catch {
    return cutoff;
  }
}

/** @param {string} portFile @param {number} timeoutMs @param {number} [staleCutoffMs] */
async function waitForDevToolsPort(portFile, timeoutMs, staleCutoffMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const st = fs.statSync(portFile);
      if (staleCutoffMs && st.mtimeMs <= staleCutoffMs) {
        await sleep(100);
        continue;
      }
      const port = parseInt(String(fs.readFileSync(portFile, 'utf8')).split('\n')[0].trim(), 10);
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      /* todavía arrancando */
    }
    await sleep(100);
  }
  throw new Error('Timeout esperando el puerto de depuración del navegador.');
}

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} en ${url}`);
    return await resp.json();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`Timeout leyendo ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function openCdp(wsUrl, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const pending = new Map();
    let nextId = 1;
    const openTimer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error('Timeout abriendo WebSocket CDP.'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(openTimer);
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              rej(new Error(`Timeout CDP: ${method}`));
            }, timeoutMs);
            const finish = (fn, value) => {
              clearTimeout(timer);
              fn(value);
            };
            pending.set(id, {
              res: (value) => finish(res, value),
              rej: (err) => finish(rej, err),
            });
            try {
              ws.send(JSON.stringify({ id, method, params: params || {} }));
            } catch (err) {
              pending.delete(id);
              finish(rej, err);
            }
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* noop */
          }
        },
      });
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'Error CDP'));
          else res(msg.result || {});
        }
      } catch {
        /* noop */
      }
    });
    const failPending = (err) => {
      for (const { rej } of pending.values()) {
        try {
          rej(err);
        } catch {
          /* noop */
        }
      }
      pending.clear();
    };
    ws.addEventListener('error', () => {
      clearTimeout(openTimer);
      const err = new Error('Error de WebSocket conectando al navegador.');
      failPending(err);
      reject(err);
    });
    ws.addEventListener('close', () => {
      failPending(new Error('WebSocket CDP cerrado.'));
    });
  });
}

async function fetchCookiesViaCdp(port, timeoutMs = 12000) {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs);
  const browserWs = version && version.webSocketDebuggerUrl;
  if (!browserWs) throw new Error('Sin endpoint WebSocket del navegador.');
  try {
    const cdp = await openCdp(browserWs, timeoutMs);
    try {
      const result = await cdp.send('Storage.getCookies');
      const cookies = Array.isArray(result.cookies) ? result.cookies : [];
      if (cookies.length > 0) return cookies;
    } finally {
      cdp.close();
    }
  } catch {
    /* fallback abajo */
  }
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs);
  const pageTarget = (Array.isArray(targets) ? targets : []).find(
    (t) => t && t.type === 'page' && t.webSocketDebuggerUrl,
  );
  if (!pageTarget) throw new Error('Sin targets de página en modo headless.');
  const cdp = await openCdp(pageTarget.webSocketDebuggerUrl, timeoutMs);
  try {
    const result = await cdp.send('Network.getAllCookies');
    return Array.isArray(result.cookies) ? result.cookies : [];
  } finally {
    cdp.close();
  }
}

/**
 * Lanza el navegador en headless contra su propio perfil y devuelve todas las
 * cookies del browser context.
 * @param {string} browserId
 * @param {string} directory
 * @param {{ autoClose?: boolean, relaunch?: boolean, closedBrowser?: boolean }} [opts]
 *   `relaunch: false` lo usa quien cierra el navegador una sola vez y lo
 *   reabre al terminar todos los perfiles. Si no, cada perfil lo reabría y
 *   el siguiente volvía a cerrarlo.
 * @returns {Promise<Array<object>>}
 */
async function fetchAllCookies(browserId, directory, opts) {
  if (process.platform !== 'win32') throw new Error('NOT_SUPPORTED_PLATFORM');
  const def = browserDef(browserId);
  const exe = findBrowserExecutable(browserId);
  const userDataDir = browserUserDataDir(browserId);
  if (!def || !exe) throw new Error('BROWSER_NOT_FOUND');
  if (!userDataDir || !fs.existsSync(userDataDir)) throw new Error('BROWSER_PROFILE_DIR_NOT_FOUND');

  const mayRelaunch = !opts || opts.relaunch !== false;
  let closedBrowser = false;
  if (await isBrowserRunning(def.processName)) {
    if (!(opts && opts.autoClose)) throw new Error('BROWSER_RUNNING');
    if (!(await closeBrowserForImport(def.processName))) throw new Error('BROWSER_CLOSE_FAILED');
    closedBrowser = true;
  }
  if (opts) opts.closedBrowser = closedBrowser;

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const portCutoff = devToolsPortCutoff(portFile);

  const args = [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${directory}`,
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--noerrdialogs',
    '--disable-session-crashed-bubble',
    'about:blank',
  ];
  const child = spawn(exe, args, { detached: false, stdio: 'ignore', windowsHide: true });
  try {
    const port = await waitForDevToolsPort(portFile, 15000, portCutoff);
    return await fetchCookiesViaCdp(port, 12000);
  } finally {
    await killPidTree(child.pid);
    try {
      if (!child.killed) child.kill();
    } catch {
      /* noop */
    }
    // La instancia headless también se llama chrome.exe / msedge.exe. Hay que
    // esperar a que suelte el perfil antes del próximo perfil o de reabrir.
    if (!(await waitImageExit(def.processName, 8000))) {
      await closeImage(def.processName);
    }
    if (closedBrowser && mayRelaunch) relaunchBrowser(browserId);
  }
}

module.exports = {
  BROWSERS,
  browserDef,
  browserUserDataDir,
  findBrowserExecutable,
  listInstalledBrowsers,
  listProfiles,
  listAllProfiles,
  isBrowserRunning,
  closeBrowserForImport,
  relaunchBrowser,
  readHistory,
  readBookmarks,
  readPasswords,
  fetchAllCookies,
  chromeTimeToUnixMs,
};

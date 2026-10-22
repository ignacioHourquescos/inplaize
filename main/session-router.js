'use strict';

/**
 * Router de sesiones por dominio: cuando una ventana abre un link hacia un
 * sitio para el que el usuario ya tiene sesión en otro acceso (otra partition),
 * la sub-pestaña se abre con esa partition para reutilizar la autenticación.
 * Si hay varias sesiones candidatas, se pregunta cuál usar (con opción de
 * recordar la elección por dominio).
 */

const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');
const { askChoice } = require('./choice-prompt');
const { loadShortcuts } = require('./shortcuts-store');
const { partitionFromSessionId } = require('./session-partition');

/** TLDs de dos niveles más comunes para aproximar el dominio registrable. */
const TWO_LEVEL_TLDS = new Set([
  'com.ar', 'com.br', 'com.mx', 'com.co', 'com.pe', 'com.uy', 'com.cl',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'co.kr', 'co.in', 'co.nz', 'co.za',
  'gob.ar', 'gov.ar', 'org.ar', 'net.ar', 'edu.ar',
]);

/**
 * Dominio base (registrable) aproximado de una URL: `www.linkedin.com` → `linkedin.com`,
 * `mail.google.com` → `google.com`, `algo.com.ar` → `algo.com.ar`.
 * @param {string} url
 * @returns {string} dominio en minúsculas, o '' si la URL no es http(s) válida
 */
function baseDomainOf(url) {
  let host = '';
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    host = u.hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Sesiones candidatas para un dominio según los accesos web del usuario.
 * @param {string} domain dominio base (salida de baseDomainOf)
 * @returns {Array<{ partition: string, label: string }>} dedupe por partition
 */
function candidateSessionsForDomain(domain) {
  if (!domain) return [];
  const seen = new Set();
  const out = [];
  let shortcuts = [];
  try {
    shortcuts = loadShortcuts();
  } catch {
    return [];
  }
  for (const s of shortcuts) {
    if (!s || s.type !== 'web' || !s.url) continue;
    if (baseDomainOf(s.url) !== domain) continue;
    const partition = partitionFromSessionId(s.sessionId);
    if (seen.has(partition)) continue;
    seen.add(partition);
    out.push({ partition, label: (s.name && String(s.name)) || partition });
  }
  return out;
}

function cookieInDomain(cookie, domain) {
  const d = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
  return d === domain || d.endsWith(`.${domain}`);
}

/**
 * ¿La partition tiene cookies persistidas para el dominio? Aproxima "hay sesión".
 * @param {string} partition
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
async function partitionHasCookiesForDomain(partition, domain) {
  try {
    const cookies = await session.fromPartition(partition).cookies.get({});
    return cookies.some((c) => cookieInDomain(c, domain));
  } catch {
    return false;
  }
}

/** Cookies que indican login real de Google (evita falsos positivos por NID/recaptcha). */
const GOOGLE_LOGIN_COOKIES = new Set([
  'SID', 'SSID', 'HSID', 'SAPISID', 'APISID', '__Secure-1PSID', '__Secure-3PSID',
]);

/**
 * Como partitionHasCookiesForDomain pero más estricta para dominios donde
 * cualquier página deja cookies de tracking sin haber login (google.com).
 * @param {string} partition
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
async function partitionHasLoginForDomain(partition, domain) {
  try {
    const cookies = await session.fromPartition(partition).cookies.get({});
    const inDomain = cookies.filter((c) => cookieInDomain(c, domain));
    if (domain === 'google.com') {
      return inDomain.some((c) => GOOGLE_LOGIN_COOKIES.has(String(c.name || '')));
    }
    return inDomain.length > 0;
  } catch {
    return false;
  }
}

/**
 * Copia las cookies de un dominio (y subdominios) de una partition a otra.
 * Misma mecánica que chrome-cookie-import: __Host- sin domain attribute,
 * Secure forzado cuando sameSite es no_restriction.
 * @param {string} fromPartition
 * @param {string} toPartition
 * @param {string} domain
 * @returns {Promise<number>} cantidad copiada
 */
async function copyDomainCookies(fromPartition, toPartition, domain) {
  const from = session.fromPartition(fromPartition);
  const to = session.fromPartition(toPartition);
  let cookies = [];
  try {
    cookies = await from.cookies.get({});
  } catch {
    return 0;
  }
  let copied = 0;
  for (const c of cookies) {
    if (!cookieInDomain(c, domain)) continue;
    const name = String(c.name || '');
    const rawDomain = String(c.domain || '');
    const hostForUrl = rawDomain.replace(/^\./, '');
    if (!hostForUrl) continue;
    const cookiePath = typeof c.path === 'string' && c.path ? c.path : '/';
    const sameSite = c.sameSite || 'unspecified';
    const secure = !!c.secure || sameSite === 'no_restriction';
    const isHostPrefixed = /^__Host-/.test(name);
    /** @type {Electron.CookiesSetDetails} */
    const details = {
      url: `${secure ? 'https' : 'http'}://${hostForUrl}${cookiePath}`,
      name,
      value: String(c.value || ''),
      path: cookiePath,
      secure,
      httpOnly: !!c.httpOnly,
      sameSite,
    };
    if (!isHostPrefixed && rawDomain) details.domain = rawDomain;
    if (!c.session && typeof c.expirationDate === 'number') {
      details.expirationDate = c.expirationDate;
    }
    try {
      await to.cookies.set(details);
      copied += 1;
    } catch {
      /* noop */
    }
  }
  try {
    await to.cookies.flushStore();
  } catch {
    /* noop */
  }
  return copied;
}

/**
 * Gmail, Ads, YouTube y accounts.google.com comparten el mismo login.
 * @param {string} domain
 * @returns {boolean}
 */
function isGoogleFamilyDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return false;
  if (d === 'google.com' || d.endsWith('.google.com')) return true;
  if (d === 'gmail.com' || d === 'googlemail.com' || d === 'youtube.com') return true;
  if (d.startsWith('google.')) return true;
  return false;
}

/**
 * Dominio cuyas cookies de login hay que mirar o copiar.
 * Para cualquier servicio de Google es `google.com` (SID, SAPISID, etc.).
 * @param {string} url
 * @returns {string}
 */
function loginCookieDomain(url) {
  const domain = baseDomainOf(url);
  if (isGoogleFamilyDomain(domain)) return 'google.com';
  return domain;
}

/**
 * Accesos que pueden prestar la sesión de esta URL de login.
 * En Google agrupa Gmail, Ads, YouTube y el resto de la familia.
 * @param {string} url
 * @returns {Array<{ partition: string, label: string }>}
 */
function candidateSessionsForLogin(url) {
  const domain = baseDomainOf(url);
  if (!domain) return [];
  if (!isGoogleFamilyDomain(domain)) return candidateSessionsForDomain(domain);

  const seen = new Set();
  const out = [];
  let shortcuts = [];
  try {
    shortcuts = loadShortcuts();
  } catch {
    return [];
  }
  for (const s of shortcuts) {
    if (!s || s.type !== 'web' || !s.url) continue;
    if (!isGoogleFamilyDomain(baseDomainOf(s.url))) continue;
    const partition = partitionFromSessionId(s.sessionId);
    if (seen.has(partition)) continue;
    seen.add(partition);
    out.push({ partition, label: (s.name && String(s.name)) || partition });
  }
  return out;
}

/**
 * ¿Es una URL de login/OAuth? Estos popups deben quedarse en la partition del
 * opener (el flujo devuelve el resultado a la ventana que lo abrió); redirigirlos
 * a otra sesión rompe el proceso.
 * @param {string} url
 * @returns {boolean}
 */
function isAuthUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (/^(accounts?|login|signin|sign-in|sso|auth|oauth|id|idp)\./.test(host)) return true;
  if (host === 'appleid.apple.com') return true;
  const p = u.pathname.toLowerCase();
  if ((host === 'github.com' || host === 'www.github.com') && p.startsWith('/login')) return true;
  if (host.endsWith('facebook.com') && (p.includes('/oauth') || p.includes('/dialog/'))) return true;
  return false;
}

function choicesFilePath() {
  return path.join(app.getPath('userData'), 'domain-session-choices.json');
}

/** @returns {Record<string, string>} dominio → partition recordada */
function loadDomainChoices() {
  try {
    const p = choicesFilePath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (raw && typeof raw === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
          if (typeof k === 'string' && typeof v === 'string') out[k] = v;
        }
        return out;
      }
    }
  } catch {
    /* noop */
  }
  return {};
}

/**
 * @param {string} domain
 * @param {string} partition
 */
function saveDomainChoice(domain, partition) {
  try {
    const next = { ...loadDomainChoices(), [domain]: partition };
    fs.writeFileSync(choicesFilePath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    /* noop */
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
/** @type {Map<string, { emails: string[], at: number }>} */
const googleEmailCache = new Map();
const GOOGLE_EMAIL_CACHE_MS = 10 * 60 * 1000;

function chromeLikeUserAgent() {
  const chrome = process.versions.chrome || '131.0.0.0';
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

/**
 * @param {unknown} node
 * @param {string[]} out
 * @param {number} depth
 */
function collectEmails(node, out, depth) {
  if (node == null || depth > 6 || out.length >= 3) return;
  if (typeof node === 'string') {
    const value = node.trim();
    if (value.length <= 120 && EMAIL_RE.test(value)) {
      const key = value.toLowerCase();
      if (!out.some((e) => e.toLowerCase() === key)) out.push(value);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectEmails(item, out, depth + 1);
  }
}

/**
 * @param {string} partition
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPartitionText(partition, url) {
  const ses = session.fromPartition(partition);
  const prevUa = ses.getUserAgent();
  ses.setUserAgent(chromeLikeUserAgent());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await ses.fetch(url, {
      credentials: 'include',
      signal: ctrl.signal,
    });
    if (!res || !res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    try {
      ses.setUserAgent(prevUa);
    } catch {
      /* noop */
    }
  }
}

/**
 * Mail de la cuenta de Google iniciada en esa partition.
 * @param {string} partition
 * @returns {Promise<string[]>}
 */
async function googleEmailsForPartition(partition) {
  if (!partition) return [];
  const hit = googleEmailCache.get(partition);
  if (hit && Date.now() - hit.at < GOOGLE_EMAIL_CACHE_MS) return hit.emails;

  const listBody = await fetchPartitionText(
    partition,
    'https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&mo=1&mn=1'
  );
  /** @type {string[]} */
  let emails = [];
  if (listBody) {
    const raw = listBody.replace(/^\)\]\}'\s*/, '').replace(/^while\s*\(\s*1\s*\)\s*;\s*/, '').trim();
    try {
      collectEmails(JSON.parse(raw), emails, 0);
    } catch {
      emails = [];
    }
  }
  if (emails.length === 0) {
    const atom = await fetchPartitionText(partition, 'https://mail.google.com/mail/u/0/feed/atom');
    const title = /<title>\s*(?:Gmail\s*-\s*)?([^<]+@[^<]+)\s*<\/title>/i.exec(atom || '');
    const value = title ? title[1].trim() : '';
    if (EMAIL_RE.test(value)) emails = [value];
  }
  if (emails.length) googleEmailCache.set(partition, { emails, at: Date.now() });
  return emails;
}

/**
 * @param {Array<{ id: string, label: string, hint?: string }>} choices
 */
async function attachGoogleEmails(choices) {
  await Promise.all(
    choices.map(async (choice) => {
      const emails = await googleEmailsForPartition(choice.id);
      if (emails.length) choice.hint = emails.join(' · ');
    })
  );
}

/**
 * Pregunta al usuario con qué sesión abrir el sitio.
 * @param {Electron.BrowserWindow | null} hostWindow
 * @param {string} domain
 * @param {Array<{ partition: string, label: string }>} candidates
 * @returns {Promise<string | null>} partition elegida, o null para usar la del opener
 */
async function askUserForSession(hostWindow, domain, candidates) {
  const choices = candidates.map((c) => ({ id: c.partition, label: c.label }));
  if (isGoogleFamilyDomain(domain)) {
    try {
      await attachGoogleEmails(choices);
    } catch {
      /* sin mail igual se puede elegir por nombre */
    }
  }
  let picked;
  try {
    picked = await askChoice({
      hostWindow,
      message: `¿Con qué sesión abrir ${domain}?`,
      detail: 'Tenés más de una sesión iniciada para este sitio.',
      choices,
      cancelLabel: 'Sesión de esta ventana',
      rememberLabel: 'Recordar para este sitio',
    });
  } catch {
    return null;
  }
  if (!picked || !picked.choiceId) return null;
  if (picked.remember) saveDomainChoice(domain, picked.choiceId);
  return picked.choiceId;
}

/**
 * Máquina de decisión completa. Devuelve la partition con la que abrir el link,
 * o null para mantener la partition del opener (comportamiento actual).
 * @param {string} url
 * @param {string} openerPartition
 * @param {Electron.BrowserWindow | null} hostWindow para anclar el diálogo
 * @returns {Promise<string | null>}
 */
async function resolveTargetPartition(url, openerPartition, hostWindow) {
  const domain = baseDomainOf(url);
  if (!domain) return null;

  const candidates = candidateSessionsForDomain(domain);
  if (candidates.length === 0) return null;
  // El opener ya es candidato para este dominio (ej. popup de Gmail desde Gmail):
  // no interferimos, el flujo actual ya comparte la sesión correcta.
  if (candidates.some((c) => c.partition === openerPartition)) return null;

  const withSession = [];
  for (const c of candidates) {
    if (await partitionHasLoginForDomain(c.partition, domain)) {
      withSession.push(c);
    }
  }
  if (withSession.length === 0) {
    // Nunca se usó ninguna: si hay un único acceso para el dominio igual lo
    // preferimos (ahí va a quedar la sesión cuando el usuario se loguee).
    return candidates.length === 1 ? candidates[0].partition : null;
  }
  if (withSession.length === 1) return withSession[0].partition;

  const remembered = loadDomainChoices()[domain];
  if (remembered && withSession.some((c) => c.partition === remembered)) {
    return remembered;
  }
  return askUserForSession(hostWindow, domain, withSession);
}

/**
 * Popup de login/OAuth abierto en la partition del opener sin sesión del sitio:
 * ofrece copiar la sesión de otro acceso a esta partition y recarga el popup,
 * así el flujo continúa ya autenticado sin romper el vínculo con el opener.
 * @param {Electron.BrowserWindow | null} hostWindow
 * @param {Electron.WebContents} wc webContents del popup de login
 * @param {string} url
 * @param {string} openerPartition
 */
async function maybeOfferSessionCopyForAuthTab(hostWindow, wc, url, openerPartition) {
  const pageDomain = baseDomainOf(url);
  if (!pageDomain || !openerPartition) return;
  const cookieDomain = loginCookieDomain(url);
  if (!cookieDomain) return;
  if (await partitionHasLoginForDomain(openerPartition, cookieDomain)) return;

  const candidates = candidateSessionsForLogin(url).filter(
    (c) => c.partition !== openerPartition
  );
  const donors = [];
  for (const c of candidates) {
    if (await partitionHasLoginForDomain(c.partition, cookieDomain)) donors.push(c);
  }
  if (donors.length === 0) return;

  const rememberKey = `auth:${cookieDomain}`;
  const remembered = loadDomainChoices()[rememberKey];
  let chosen = remembered && donors.some((d) => d.partition === remembered) ? remembered : null;

  if (!chosen) {
    const seenLabels = new Map();
    const choices = donors.map((d) => {
      const base = d.label || 'Usuario';
      const n = (seenLabels.get(base) || 0) + 1;
      seenLabels.set(base, n);
      const dup = donors.filter((x) => (x.label || 'Usuario') === base).length > 1;
      return { id: d.partition, label: dup ? `${base} (${n})` : base };
    });
    if (isGoogleFamilyDomain(pageDomain)) {
      try {
        await attachGoogleEmails(choices);
      } catch {
        /* sin mail igual se puede elegir por nombre */
      }
    }
    let picked;
    try {
      picked = await askChoice({
        hostWindow,
        message: '¿Con qué usuario querés iniciar?',
        detail: isGoogleFamilyDomain(pageDomain)
          ? 'Hay cuentas de Google ya iniciadas en otros accesos. Elegí una para entrar sin escribir el correo y la contraseña.'
          : `Hay sesiones de ${pageDomain} ya iniciadas en otros accesos. Elegí una para no tener que loguearte de nuevo.`,
        choices,
        cancelLabel: 'Usuario y contraseña',
        rememberLabel: 'Recordar para este sitio',
      });
    } catch {
      return;
    }
    if (!picked || !picked.choiceId) return;
    chosen = picked.choiceId;
    if (picked.remember) saveDomainChoice(rememberKey, chosen);
  }

  const copied = await copyDomainCookies(chosen, openerPartition, cookieDomain);
  if (copied > 0 && wc && !wc.isDestroyed()) {
    try {
      wc.reload();
    } catch {
      /* noop */
    }
  }
}

/**
 * ¿Puede el router llegar a redirigir este link a otra partition?
 * Chequeo sincrónico y barato para decidir el camino en setWindowOpenHandler.
 * @param {string} url
 * @param {string} openerPartition
 * @returns {boolean}
 */
function mayRouteToOtherSession(url, openerPartition) {
  const domain = baseDomainOf(url);
  if (!domain) return false;
  const candidates = candidateSessionsForDomain(domain);
  if (candidates.length === 0) return false;
  return !candidates.some((c) => c.partition === openerPartition);
}

/**
 * Si la página cae en un login (el acceso mismo redirige a Google, o un popup),
 * pregunta con qué usuario ya iniciado continuar.
 * @param {Electron.WebContents} webContents
 * @param {string} partition
 * @param {() => Electron.BrowserWindow | null} getHostWindow
 * @param {string} [initialUrl] por si la navegación arrancó antes de enganchar los eventos
 */
function attachLoginSessionOffer(webContents, partition, getHostWindow, initialUrl) {
  if (!webContents || webContents.isDestroyed() || !partition) return;
  if (webContents.__usualDeskLoginOfferAttached) return;
  webContents.__usualDeskLoginOfferAttached = true;

  /** @type {Set<string>} */
  const asked = new Set();
  let busy = false;

  const consider = (url, isMainFrame) => {
    if (isMainFrame === false) return;
    if (!webContents || webContents.isDestroyed()) return;
    if (!url || typeof url !== 'string') return;
    if (!isAuthUrl(url)) {
      if (!busy) asked.clear();
      return;
    }
    const key = loginCookieDomain(url) || baseDomainOf(url);
    if (!key || asked.has(key) || busy) return;
    asked.add(key);
    busy = true;
    const run = async () => {
      let host = null;
      try {
        host = typeof getHostWindow === 'function' ? getHostWindow() : null;
        if (host && host.isDestroyed()) host = null;
        if (host && !host.isVisible()) {
          await new Promise((resolve) => {
            let timer = null;
            const done = () => {
              if (timer) clearTimeout(timer);
              try {
                host.removeListener('show', done);
              } catch {
                /* noop */
              }
              resolve();
            };
            host.once('show', done);
            timer = setTimeout(done, 2000);
          });
          if (host.isDestroyed()) host = null;
        }
      } catch {
        host = null;
      }
      if (!webContents || webContents.isDestroyed()) return;
      await maybeOfferSessionCopyForAuthTab(host, webContents, url, partition);
    };
    run()
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  };

  webContents.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
    consider(url, isMainFrame);
  });
  webContents.on('did-redirect-navigation', (_e, url, _isInPlace, isMainFrame) => {
    consider(url, isMainFrame);
  });
  webContents.on('did-navigate', (_e, url) => {
    consider(url, true);
  });

  if (initialUrl && isAuthUrl(initialUrl)) {
    setImmediate(() => consider(initialUrl, true));
  }
}

module.exports = {
  baseDomainOf,
  candidateSessionsForDomain,
  partitionHasCookiesForDomain,
  partitionHasLoginForDomain,
  copyDomainCookies,
  isAuthUrl,
  maybeOfferSessionCopyForAuthTab,
  attachLoginSessionOffer,
  resolveTargetPartition,
  mayRouteToOtherSession,
  loadDomainChoices,
  saveDomainChoice,
};

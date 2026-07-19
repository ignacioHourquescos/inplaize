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
const { app, session, dialog } = require('electron');
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

/**
 * Pregunta al usuario con qué sesión abrir el sitio.
 * @param {Electron.BrowserWindow | null} hostWindow
 * @param {string} domain
 * @param {Array<{ partition: string, label: string }>} candidates
 * @returns {Promise<string | null>} partition elegida, o null para usar la del opener
 */
async function askUserForSession(hostWindow, domain, candidates) {
  const buttons = candidates.map((c) => c.label);
  buttons.push('Sesión de esta ventana');
  let result;
  try {
    const opts = {
      type: 'question',
      title: 'Elegir sesión',
      message: `¿Con qué sesión abrir ${domain}?`,
      detail: 'Tenés más de una sesión iniciada para este sitio.',
      buttons,
      cancelId: buttons.length - 1,
      noLink: true,
      checkboxLabel: 'Recordar para este sitio',
      checkboxChecked: false,
    };
    result = hostWindow && !hostWindow.isDestroyed()
      ? await dialog.showMessageBox(hostWindow, opts)
      : await dialog.showMessageBox(opts);
  } catch {
    return null;
  }
  const idx = result.response;
  if (idx < 0 || idx >= candidates.length) return null;
  const chosen = candidates[idx].partition;
  if (result.checkboxChecked) {
    saveDomainChoice(domain, chosen);
  }
  return chosen;
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
  const domain = baseDomainOf(url);
  if (!domain || !openerPartition) return;
  if (await partitionHasLoginForDomain(openerPartition, domain)) return;

  const candidates = candidateSessionsForDomain(domain).filter(
    (c) => c.partition !== openerPartition
  );
  const donors = [];
  for (const c of candidates) {
    if (await partitionHasLoginForDomain(c.partition, domain)) donors.push(c);
  }
  if (donors.length === 0) return;

  const rememberKey = `auth:${domain}`;
  const remembered = loadDomainChoices()[rememberKey];
  let chosen = remembered && donors.some((d) => d.partition === remembered) ? remembered : null;

  if (!chosen) {
    const buttons = donors.map((d) => d.label);
    buttons.push('Iniciar sesión manualmente');
    const opts = {
      type: 'question',
      title: 'Usar sesión existente',
      message: `¿Usar tu sesión de ${domain} ya iniciada?`,
      detail: 'Se copiará esa sesión a esta ventana para no tener que loguearte de nuevo.',
      buttons,
      cancelId: buttons.length - 1,
      noLink: true,
      checkboxLabel: 'Recordar para este sitio',
      checkboxChecked: false,
    };
    let result;
    try {
      result = hostWindow && !hostWindow.isDestroyed()
        ? await dialog.showMessageBox(hostWindow, opts)
        : await dialog.showMessageBox(opts);
    } catch {
      return;
    }
    if (result.response < 0 || result.response >= donors.length) return;
    chosen = donors[result.response].partition;
    if (result.checkboxChecked) saveDomainChoice(rememberKey, chosen);
  }

  const copied = await copyDomainCookies(chosen, openerPartition, domain);
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

module.exports = {
  baseDomainOf,
  candidateSessionsForDomain,
  partitionHasCookiesForDomain,
  partitionHasLoginForDomain,
  copyDomainCookies,
  isAuthUrl,
  maybeOfferSessionCopyForAuthTab,
  resolveTargetPartition,
  mayRouteToOtherSession,
  loadDomainChoices,
  saveDomainChoice,
};

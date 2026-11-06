'use strict';

/**
 * Orquesta la importación de un perfil completo de otro navegador hacia la app,
 * al estilo Comet: cookies, historial, marcadores y contraseñas. Combina el
 * motor de lectura (`browser-import`) con los almacenes de la app.
 *
 * Las lecturas de archivos (historial, marcadores, contraseñas) funcionan con
 * el navegador abierto, así que se hacen primero. Las cookies van al final
 * porque obligan a cerrar y reabrir el navegador; si el usuario eligió "sin
 * cookies" ese paso se omite y el resto se importa igual.
 */

const { session } = require('electron');
const engine = require('./browser-import');
const historyStore = require('./history-store');
const bookmarksStore = require('./bookmarks-store');
const passwordsStore = require('./passwords-store');
const { partitionFromSessionId } = require('./session-partition');
const { LOOSE_NAV_SESSION_ID } = require('./constants');

function mapSameSite(s) {
  switch (s) {
    case 'Strict':
      return 'strict';
    case 'Lax':
      return 'lax';
    case 'None':
      return 'no_restriction';
    default:
      return 'unspecified';
  }
}

/**
 * Inyecta TODAS las cookies en la partition (sin filtro de dominio).
 * @param {Array<object>} cookies
 * @param {string} targetPartition
 * @returns {Promise<number>} cuántas se setearon
 */
async function setAllCookies(cookies, targetPartition) {
  const ses = session.fromPartition(targetPartition);
  let imported = 0;
  for (const c of cookies) {
    if (!c || typeof c !== 'object') continue;
    const sameSite = mapSameSite(c.sameSite);
    const secure = !!c.secure || sameSite === 'no_restriction';
    const proto = secure ? 'https' : 'http';
    const rawDomain = String(c.domain || '');
    const host = rawDomain.replace(/^\./, '');
    if (!host) continue;
    const cookiePath = typeof c.path === 'string' && c.path ? c.path : '/';
    const name = String(c.name || '');
    const isHostPrefixed = /^__Host-/.test(name);
    /** @type {Electron.CookiesSetDetails} */
    const details = {
      url: `${proto}://${host}${cookiePath}`,
      name,
      value: String(c.value || ''),
      path: cookiePath,
      secure,
      httpOnly: !!c.httpOnly,
      sameSite,
    };
    if (!isHostPrefixed && rawDomain) details.domain = rawDomain;
    if (typeof c.expires === 'number' && c.expires > 0 && !c.session) {
      details.expirationDate = c.expires;
    }
    try {
      await ses.cookies.set(details);
      imported += 1;
    } catch {
      /* cookies individuales que Electron rechaza (dominios inválidos, etc.) */
    }
  }
  try {
    await ses.cookies.flushStore();
  } catch {
    /* noop */
  }
  return imported;
}

/**
 * @param {{
 *   browser: string,
 *   directory: string,
 *   partition?: string,
 *   autoClose?: boolean,
 *   parts?: { cookies?: boolean, history?: boolean, bookmarks?: boolean, passwords?: boolean },
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   partition: string,
 *   cookies: number,
 *   history: number,
 *   bookmarks: number,
 *   passwords: number,
 *   passwordsSkipped: number,
 *   passwordsVaultAvailable: boolean,
 *   cookiesError?: string,
 * }>}
 */
async function importFullProfile(opts) {
  const browser = String((opts && opts.browser) || 'chrome');
  const directory = String((opts && opts.directory) || 'Default');
  const partition =
    (opts && opts.partition) || partitionFromSessionId(LOOSE_NAV_SESSION_ID);
  const parts = Object.assign(
    { cookies: true, history: true, bookmarks: true, passwords: true },
    (opts && opts.parts) || {},
  );

  const summary = {
    ok: true,
    partition,
    cookies: 0,
    history: 0,
    bookmarks: 0,
    passwords: 0,
    passwordsSkipped: 0,
    passwordsVaultAvailable: passwordsStore.available(),
  };

  if (parts.history) {
    try {
      summary.history = historyStore.importEntries(engine.readHistory(browser, directory));
    } catch {
      /* noop */
    }
  }
  if (parts.bookmarks) {
    try {
      summary.bookmarks = bookmarksStore.importEntries(engine.readBookmarks(browser, directory));
    } catch {
      /* noop */
    }
  }
  if (parts.passwords) {
    try {
      const pw = engine.readPasswords(browser, directory);
      summary.passwordsSkipped = pw.skipped;
      const res = passwordsStore.importEntries(pw.entries);
      summary.passwords = res.imported;
      summary.passwordsVaultAvailable = res.available;
    } catch {
      /* noop */
    }
  }
  if (parts.cookies) {
    try {
      const cookies = await engine.fetchAllCookies(browser, directory, {
        autoClose: !!(opts && opts.autoClose),
      });
      summary.cookies = await setAllCookies(cookies, partition);
    } catch (err) {
      summary.cookiesError = (err && err.message) || 'IMPORT_FAILED';
    }
  }

  return summary;
}

module.exports = { importFullProfile, setAllCookies };

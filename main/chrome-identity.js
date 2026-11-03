'use strict';

/**
 * Identidad de navegador para las páginas embebidas. Electron es Chromium:
 * aunque el user agent diga "Chrome", los Client Hints (`Sec-CH-UA` y
 * `navigator.userAgentData.brands`) anuncian solo "Chromium" y Google (Meet,
 * Gemini, el login) responde con "instalá Chrome". Acá se completa la marca
 * "Google Chrome" en los tres lugares.
 */

const path = require('path');
const { session } = require('electron');

const CHROME_IDENTITY_PRELOAD = path.join(__dirname, 'chrome-identity-preload.js');

function chromeFullVersion() {
  return process.versions.chrome || '141.0.0.0';
}

function chromeMajorVersion() {
  return chromeFullVersion().split('.')[0];
}

function chromeLikeUserAgent() {
  const chrome = chromeFullVersion();
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function chPlatform() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

/** @param {string} version */
function brandsHeader(version) {
  return `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not_A Brand";v="24"`;
}

/**
 * Chrome manda `X-Client-Data` (sus experimentos activos) solo a los dominios
 * de Google; sin ese header Google asume otro navegador y ofrece "Descargar Chrome".
 */
const X_CLIENT_DATA = 'CIW2yQEIo7bJAQipncoBCMKeygEIlqHLAQiFoM0BCMW+zQE=';
const GOOGLE_HOST_RE = /(^|\.)(google\.[a-z.]+|youtube\.com|googleapis\.com|gstatic\.com|googleusercontent\.com|googlevideo\.com|ytimg\.com|doubleclick\.net)$/i;

/** @param {string} url */
function isGoogleUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && GOOGLE_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/** @type {WeakSet<Electron.Session>} */
const applied = new WeakSet();

/**
 * Idempotente por sesión. `webRequest.onBeforeSendHeaders` admite un solo
 * listener por sesión: si otro módulo lo necesita, tiene que pasar por acá.
 * @param {Electron.Session} ses
 */
function applyChromeIdentity(ses) {
  if (!ses || applied.has(ses)) return;
  applied.add(ses);
  const major = chromeMajorVersion();
  const full = chromeFullVersion();

  try {
    ses.setUserAgent(chromeLikeUserAgent());
  } catch {
    /* noop */
  }

  try {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders || {};
      for (const key of Object.keys(headers)) {
        const k = key.toLowerCase();
        if (k === 'sec-ch-ua') headers[key] = brandsHeader(major);
        else if (k === 'sec-ch-ua-full-version-list') headers[key] = brandsHeader(full);
      }
      const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
      // Con el user agent cambiado, Chromium deja de mandar los Client Hints;
      // Chrome los manda siempre por https, así que su ausencia lo delata.
      if (/^https:/i.test(details.url)) {
        if (!has('sec-ch-ua')) headers['sec-ch-ua'] = brandsHeader(major);
        if (!has('sec-ch-ua-mobile')) headers['sec-ch-ua-mobile'] = '?0';
        if (!has('sec-ch-ua-platform')) headers['sec-ch-ua-platform'] = `"${chPlatform()}"`;
      }
      if (isGoogleUrl(details.url) && !has('x-client-data')) {
        headers['X-Client-Data'] = X_CLIENT_DATA;
      }
      callback({ requestHeaders: headers });
    });
  } catch {
    /* noop */
  }

  try {
    ses.registerPreloadScript({ type: 'frame', filePath: CHROME_IDENTITY_PRELOAD });
  } catch {
    /* sin preload, los headers y el user agent ya cubren la mayoría de los chequeos */
  }
}

/** @param {string} partition */
function applyChromeIdentityToPartition(partition) {
  if (!partition) return;
  try {
    applyChromeIdentity(session.fromPartition(partition));
  } catch {
    /* noop */
  }
}

module.exports = {
  chromeLikeUserAgent,
  chromeMajorVersion,
  chromeFullVersion,
  applyChromeIdentity,
  applyChromeIdentityToPartition,
};

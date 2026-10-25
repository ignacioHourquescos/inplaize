'use strict';

const { log } = require('./logger');

/**
 * localhost / 127.0.0.1 / ::1 y un puerto. No es una búsqueda.
 * @param {string} hostname
 */
function isLoopbackHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Si `localhost` no conecta (en Windows a veces solo responde 127.0.0.1), reintenta por IPv4.
 * @param {string} raw
 * @returns {string}
 */
function ipv4LoopbackUrl(raw) {
  try {
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname) || url.hostname === '127.0.0.1') return '';
    url.hostname = '127.0.0.1';
    return url.href;
  } catch {
    return '';
  }
}

/**
 * Navega a la URL. Un fallo de red no cancela la ventana: Chromium deja esa dirección en pantalla.
 * @param {Electron.WebContents} wc
 * @param {string} url
 */
function waitForLoad(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    promise.then(
      () => finish('ok'),
      (err) => finish(err),
    );
    setTimeout(() => finish('timeout'), ms);
  });
}

/**
 * Un acceso guardado como "www.figma.com" no tiene esquema y Chromium lo
 * rechaza con ERR_INVALID_URL (la página queda en negro). Se completa con
 * https:// (http:// para localhost y direcciones de red local).
 * @param {string} raw
 * @returns {string}
 */
function withScheme(raw) {
  const text = String(raw || '').trim();
  if (!text) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/\s:]+:\d+(\/|$)/.test(text)) return text;
  if (text.startsWith('//')) return `https:${text}`;
  const host = text.split(/[/?#]/)[0].replace(/:\d+$/, '');
  const local = isLoopbackHost(host) || /^(10|192\.168)\.\d+\.\d+(\.\d+)?$/.test(host);
  return `${local ? 'http' : 'https'}://${text}`;
}

async function loadWebContentsUrl(wc, url) {
  const target = withScheme(url);
  if (!wc || wc.isDestroyed()) return;
  const first = wc.loadURL(target);
  const outcome = await waitForLoad(first, 4000);
  if (outcome === 'ok' || outcome === 'timeout') {
    if (outcome === 'timeout') first.catch(() => {});
    return;
  }
  const retry = ipv4LoopbackUrl(target);
  if (retry && !wc.isDestroyed()) {
    try {
      await wc.loadURL(retry);
      return;
    } catch {
      try {
        if (!wc.isDestroyed()) await wc.loadURL(target);
      } catch {
        /* la ventana sigue abierta en el error de red */
      }
    }
  }
  log(`Carga web falló (${target}): ${outcome && outcome.message ? outcome.message : outcome}`);
}

module.exports = {
  isLoopbackHost,
  withScheme,
  loadWebContentsUrl,
};

'use strict';

const { BrowserWindow } = require('electron');
const { loadAppSettings } = require('./app-settings-store');
const { log } = require('./logger');

const CHECK_EVERY_MS = 60 * 1000;
/** Las pestañas de navegación ocultas no se ven ni avisan: se duermen antes. */
const LOOSE_TAB_MAX_IDLE_MS = 10 * 60 * 1000;

/** @type {NodeJS.Timeout | null} */
let timer = null;

/**
 * Solo se duerme una página que nadie mira ni escucha y que no perdería nada:
 * sin sub-pestañas (pueden tener trabajo sin guardar) ni avisos activos.
 * @param {Electron.BrowserWindow} host
 * @param {number} idleMs
 * @param {number} now
 */
function canHibernate(host, idleMs, now) {
  if (!host || host.isDestroyed() || !host.__usualDeskDetachedChromeHost) return false;
  if (host.__usualDeskHibernated || host.__usualDeskHibernating) return false;
  if (host.__usualDeskEmbeddedDesktop || host.__usualDeskUrlPromptOpen) return false;
  if (host.isFocused()) return false;

  const lastActive = Number(host.__usualDeskLastActiveAt) || 0;
  if (now - lastActive < idleMs) return false;

  const state = host.__usualDeskTabState;
  if (!state || state.tabs.size !== 1) return false;

  const wc = host.__usualDeskHostedWebContents;
  if (!wc || wc.isDestroyed()) return false;
  try {
    if (wc.isFocused() || wc.isCurrentlyAudible()) return false;
  } catch {
    return false;
  }

  if (host.__usualDeskPageNotifies && host.__usualDeskNotificationsMuted !== true) return false;
  return true;
}

async function sweep() {
  const minutes = loadAppSettings().webIdleHibernateMinutes;
  if (!minutes) return;
  const idleMs = minutes * 60 * 1000;
  const now = Date.now();
  try {
    const slept = require('./loose-nav-window').sleepIdleTabs(Math.min(idleMs, LOOSE_TAB_MAX_IDLE_MS));
    if (slept) log(`Pestañas de navegación en reposo: ${slept}`);
  } catch (err) {
    log(`No se pudieron poner en reposo pestañas de navegación: ${err && err.message ? err.message : err}`);
  }
  const { hibernateHost } = require('./detached-web-frame');
  for (const host of BrowserWindow.getAllWindows()) {
    if (!canHibernate(host, idleMs, now)) continue;
    try {
      if (await hibernateHost(host)) {
        log(`Ventana web en reposo tras ${minutes} min sin uso: ${host.__usualDeskDetachedOwnMapKey || ''}`);
      }
    } catch (err) {
      log(`No se pudo poner en reposo una ventana web: ${err && err.message ? err.message : err}`);
    }
  }
}

function startWebHibernation() {
  if (timer) return;
  timer = setInterval(() => {
    sweep().catch(() => {});
  }, CHECK_EVERY_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { startWebHibernation };

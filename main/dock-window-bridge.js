'use strict';

/** @type {Electron.BrowserWindow | null} */
let dockWindow = null;

/** @type {Electron.BrowserWindow | null} */
let shellChromeWindow = null;

/**
 * @param {Electron.BrowserWindow | null} win
 */
function setDockWindow(win) {
  dockWindow = win;
}

/** @returns {Electron.BrowserWindow | null} */
function getDockWindow() {
  return dockWindow && !dockWindow.isDestroyed() ? dockWindow : null;
}

/**
 * Ventana contenedor web (franja horizontal de accesos).
 * @param {Electron.BrowserWindow | null} win
 */
function setShellChromeWindow(win) {
  shellChromeWindow = win;
}

/**
 * @param {string} shortcutId
 * @param {number | null} count
 */
function broadcastShortcutTitleBadge(shortcutId, count) {
  const w = dockWindow;
  if (w && !w.isDestroyed()) {
    try {
      w.webContents.send('shortcut-title-badge', { shortcutId, count });
    } catch {
      /* ventana cerrando */
    }
  }
  const sw = shellChromeWindow;
  if (sw && !sw.isDestroyed()) {
    try {
      sw.webContents.send('shell-title-badge', { shortcutId, count });
    } catch {
      /* ventana cerrando */
    }
  }
  try {
    require('./detached-web-frame').broadcastTitleBadgeToDetachedHosts(shortcutId, count);
  } catch {
    /* noop */
  }
}

/**
 * Lista de claves `${partition}::${urlKey}` con ventana web abierta (ver open-shortcut.js).
 * @param {string[]} keys
 */
function broadcastOpenWebWindowKeys(keys) {
  const w = dockWindow;
  if (!w || w.isDestroyed()) return;
  try {
    w.webContents.send('open-web-window-keys', { keys });
  } catch {
    /* ventana cerrando */
  }
}

module.exports = {
  setDockWindow,
  getDockWindow,
  setShellChromeWindow,
  broadcastShortcutTitleBadge,
  broadcastOpenWebWindowKeys,
};

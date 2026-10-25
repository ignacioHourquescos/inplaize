'use strict';

const http = require('http');
const { app, globalShortcut } = require('electron');
const { loadAppSettings } = require('./app-settings-store');
const { acceleratorFromHotkey } = require('./hotkey-accelerator');
const { log } = require('./logger');

/** El preview del onboarding (puerto 4173) pide el atajo prestado mientras dura la prueba. */
const PREVIEW_YIELD_URL = 'http://127.0.0.1:4173/hotkey-yield';

/** @type {string[]} */
let registeredAccelerators = [];

/** @type {{ state: object, onAccelerator: Function, ensureDockWindow: Function } | null} */
let shortcutContext = null;

function desiredAccelerator() {
  try {
    const acc = acceleratorFromHotkey(loadAppSettings().dockHotkey);
    if (acc) return acc;
  } catch {
    /* settings todavía no disponibles */
  }
  return 'Control+Alt+D';
}

/** True mientras el preview del navegador está en el paso del atajo. */
let previewYieldHeld = false;
/** @type {NodeJS.Timeout | null} */
let previewYieldTimer = null;

/**
 * @param {{ mainWindow: Electron.BrowserWindow | null }} state
 * @param {() => void | boolean} onAccelerator — p. ej. raiseAppFromGlobalHotkey
 * @param {() => void} ensureDockWindow
 */
function registerDockGlobalShortcut(state, onAccelerator, ensureDockWindow) {
  if (state && typeof onAccelerator === 'function' && typeof ensureDockWindow === 'function') {
    shortcutContext = { state, onAccelerator, ensureDockWindow };
  }
  ensurePreviewYieldWatch();
  if (previewYieldHeld) return false;
  const ctx = shortcutContext;
  if (!ctx) return false;

  for (const acc of registeredAccelerators) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
  }
  registeredAccelerators = [];

  const acc = desiredAccelerator();
  try {
    globalShortcut.unregister(acc);
  } catch {
    /* ignore */
  }

  const run = () => {
    setTimeout(() => {
      if (!ctx.state.mainWindow || ctx.state.mainWindow.isDestroyed()) {
        ctx.ensureDockWindow();
      }
      if (!ctx.state.mainWindow || ctx.state.mainWindow.isDestroyed()) return;
      ctx.onAccelerator();
    }, 20);
  };

  const ok = globalShortcut.register(acc, run);
  if (ok) {
    registeredAccelerators.push(acc);
    log(`Atajo global registrado: ${acc}`);
  } else {
    log(`No se pudo registrar el atajo ${acc} (¿otra app o el sistema lo usa?)`);
  }

  return ok;
}

function reregisterDockGlobalShortcut() {
  if (!shortcutContext) return false;
  return registerDockGlobalShortcut(
    shortcutContext.state,
    shortcutContext.onAccelerator,
    shortcutContext.ensureDockWindow,
  );
}

function applyPreviewYield(hold) {
  if (hold === previewYieldHeld) return;
  previewYieldHeld = hold;
  if (hold) {
    unregisterDockGlobalShortcut();
    log('Atajo en pausa: la prueba del onboarding está en el navegador');
    return;
  }
  if (!shortcutContext) return;
  registerDockGlobalShortcut(
    shortcutContext.state,
    shortcutContext.onAccelerator,
    shortcutContext.ensureDockWindow,
  );
}

function pollPreviewHotkeyYield() {
  const req = http.get(PREVIEW_YIELD_URL, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      let hold = false;
      try {
        hold = JSON.parse(Buffer.concat(chunks).toString('utf8')).hold === true;
      } catch {
        hold = false;
      }
      applyPreviewYield(hold);
    });
  });
  req.setTimeout(400, () => req.destroy());
  req.on('error', () => {
    if (previewYieldHeld) applyPreviewYield(false);
  });
}

/** Solo en desarrollo: el preview y la app no pueden registrar el mismo atajo. */
function ensurePreviewYieldWatch() {
  if (previewYieldTimer) return;
  let packaged = true;
  try {
    packaged = app.isPackaged === true;
  } catch {
    return;
  }
  if (packaged) return;
  previewYieldTimer = setInterval(pollPreviewHotkeyYield, 400);
  if (typeof previewYieldTimer.unref === 'function') previewYieldTimer.unref();
}

function unregisterDockGlobalShortcut() {
  for (const acc of registeredAccelerators) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
  }
  registeredAccelerators = [];
}

module.exports = {
  registerDockGlobalShortcut,
  reregisterDockGlobalShortcut,
  unregisterDockGlobalShortcut,
};

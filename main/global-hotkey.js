'use strict';

const { globalShortcut } = require('electron');
const { DOCK_TOGGLE_ACCELERATORS } = require('./constants');
const { log } = require('./logger');

/** @type {string[]} */
let registeredAccelerators = [];

/**
 * @param {{ mainWindow: Electron.BrowserWindow | null }} state
 * @param {() => void | boolean} onAccelerator — p. ej. raiseAppFromGlobalHotkey
 * @param {() => void} ensureDockWindow
 */
function registerDockGlobalShortcut(state, onAccelerator, ensureDockWindow) {
  for (const acc of registeredAccelerators) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
  }
  registeredAccelerators = [];

  for (const acc of DOCK_TOGGLE_ACCELERATORS) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
  }

  const run = () => {
    setTimeout(() => {
      if (!state.mainWindow || state.mainWindow.isDestroyed()) {
        ensureDockWindow();
      }
      if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
      onAccelerator();
    }, 20);
  };

  for (const acc of DOCK_TOGGLE_ACCELERATORS) {
    const ok = globalShortcut.register(acc, run);
    if (ok) {
      registeredAccelerators.push(acc);
      log(`Atajo global registrado: ${acc}`);
    } else {
      log(`No se pudo registrar el atajo ${acc} (¿otra app o el sistema lo usa?)`);
    }
  }

  if (registeredAccelerators.length === 0) {
    log(
      `Ningún atajo del dock pudo registrarse. Prueba cerrar otras apps o usa otro equipo. Intentados: ${DOCK_TOGGLE_ACCELERATORS.join(
        ', ',
      )}`,
    );
  }

  return registeredAccelerators.length > 0;
}

function unregisterDockGlobalShortcut() {
  for (const acc of [...registeredAccelerators, ...DOCK_TOGGLE_ACCELERATORS]) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
  }
  registeredAccelerators = [];
}

module.exports = { registerDockGlobalShortcut, unregisterDockGlobalShortcut };

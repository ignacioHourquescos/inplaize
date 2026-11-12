'use strict';

const { app, dialog } = require('electron');

/**
 * El dock vive en always-on-top nivel screen-saver. Mientras este contador
 * es > 0 no hay que volver a subirlo: un MessageBox nativo queda detrás y,
 * como es modal, la ventana deja de recibir clics. Se ve la app trabada.
 */
let dockSuspend = 0;
/** @type {WeakMap<Electron.BrowserWindow, boolean>} */
const wasOnTop = new WeakMap();

function systemDialogOpen() {
  return dockSuspend > 0;
}

/** @param {Electron.BrowserWindow | null | undefined} win */
function suspendDockTop(win) {
  dockSuspend += 1;
  if (!win || win.isDestroyed()) return;
  if (!wasOnTop.has(win)) {
    let on = false;
    try {
      on = win.isAlwaysOnTop();
    } catch {
      on = false;
    }
    wasOnTop.set(win, on);
  }
  try {
    win.setAlwaysOnTop(false);
  } catch {
    /* noop */
  }
}

/** @param {Electron.BrowserWindow | null | undefined} win */
function resumeDockTop(win) {
  dockSuspend = Math.max(0, dockSuspend - 1);
  if (dockSuspend > 0) return;
  if (!win || win.isDestroyed()) return;
  const on = wasOnTop.get(win) === true;
  wasOnTop.delete(win);
  if (!on) return;
  try {
    if (process.platform === 'win32') win.setAlwaysOnTop(true, 'screen-saver');
    else win.setAlwaysOnTop(true);
  } catch {
    try {
      win.setAlwaysOnTop(true);
    } catch {
      /* noop */
    }
  }
}

/**
 * MessageBox por encima del dock. Baja la capa mientras está abierto.
 * @param {Electron.BrowserWindow | null | undefined} host
 * @param {Electron.MessageBoxOptions} opts
 */
async function showAppMessageBox(host, opts) {
  const win = host && !host.isDestroyed() ? host : null;
  suspendDockTop(win);
  if (win) {
    try {
      win.show();
      win.moveTop();
      win.focus();
    } catch {
      /* noop */
    }
  }
  try {
    return win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
  } finally {
    resumeDockTop(win);
  }
}

/**
 * Lleva una BrowserWindow al frente; en Windows a menudo hace falta varios pasos.
 * @param {Electron.BrowserWindow} win
 */
function forceWindowForeground(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
  } catch {
    /* noop */
  }
  try {
    win.show();
  } catch {
    /* noop */
  }
  try {
    win.moveTop();
  } catch {
    /* noop */
  }
  try {
    app.focus({ steal: true });
  } catch {
    try {
      app.focus();
    } catch {
      /* noop */
    }
  }
  try {
    win.focus();
  } catch {
    /* noop */
  }
  if (process.platform === 'win32') {
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setAlwaysOnTop(false);
    } catch {
      try {
        win.setAlwaysOnTop(true);
        win.setAlwaysOnTop(false);
      } catch {
        /* noop */
      }
    }
    try {
      win.focus();
    } catch {
      /* noop */
    }
    setTimeout(() => {
      if (win.isDestroyed()) return;
      try {
        win.moveTop();
        win.focus();
      } catch {
        /* noop */
      }
    }, 100);
    setTimeout(() => {
      if (win.isDestroyed()) return;
      try {
        win.show();
        win.moveTop();
        win.focus();
      } catch {
        /* noop */
      }
    }, 220);
    setTimeout(() => {
      if (win.isDestroyed()) return;
      try {
        win.moveTop();
        win.focus();
      } catch {
        /* noop */
      }
    }, 400);
  }
}

/**
 * Trae al frente el dock sin apagar always-on-top. `forceWindowForeground`
 * lo deja detrás de la ventana web.
 * @param {Electron.BrowserWindow} win
 */
function raiseAlwaysOnTopWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
  } catch {
    /* noop */
  }
  try {
    win.show();
  } catch {
    /* noop */
  }
  try {
    if (process.platform === 'win32') win.setAlwaysOnTop(true, 'screen-saver');
    else win.setAlwaysOnTop(true);
  } catch {
    try {
      win.setAlwaysOnTop(true);
    } catch {
      /* noop */
    }
  }
  try {
    win.moveTop();
  } catch {
    /* noop */
  }
  try {
    win.focus();
  } catch {
    /* noop */
  }
}

module.exports = {
  forceWindowForeground,
  raiseAlwaysOnTopWindow,
  systemDialogOpen,
  suspendDockTop,
  resumeDockTop,
  showAppMessageBox,
};

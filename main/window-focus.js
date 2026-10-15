'use strict';

const { app } = require('electron');

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

module.exports = { forceWindowForeground, raiseAlwaysOnTopWindow };

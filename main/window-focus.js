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

module.exports = { forceWindowForeground };

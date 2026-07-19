'use strict';

/**
 * Chromium/Electron guarda el zoom por host (Ctrl+rueda / Ctrl+/-) en Preferences.
 * Si el usuario lo cambia sin querer, la UI del dock queda “alejada” respecto a
 * la franja de la ventana web. Forzamos 100% y bloqueamos atajos de zoom.
 *
 * @param {Electron.WebContents} webContents
 */
function lockWindowZoom(webContents) {
  if (!webContents || webContents.isDestroyed()) return;

  const reset = () => {
    if (webContents.isDestroyed()) return;
    try {
      if (typeof webContents.setZoomLevel === 'function') webContents.setZoomLevel(0);
      if (typeof webContents.setZoomFactor === 'function') webContents.setZoomFactor(1);
    } catch {
      /* noop */
    }
  };

  reset();
  webContents.on('dom-ready', reset);
  webContents.on('did-finish-load', reset);
  webContents.on('did-navigate', reset);
  webContents.on('zoom-changed', reset);

  try {
    if (typeof webContents.setVisualZoomLevelLimits === 'function') {
      webContents.setVisualZoomLevelLimits(1, 1);
    }
  } catch {
    /* noop */
  }

  webContents.on('before-input-event', (event, input) => {
    if (!input || !input.control) return;
    const key = String(input.key || '');
    if (key === '+' || key === '-' || key === '=' || key === '_' || key === 'Add' || key === 'Subtract') {
      event.preventDefault();
      reset();
    }
  });
}

module.exports = { lockWindowZoom };

'use strict';

const { screen } = require('electron');
const { DOCK_WINDOW_WIDTH, DOCK_COLLAPSED_TOP_HEIGHT } = require('./constants');
const { loadAppSettings } = require('./app-settings-store');

/**
 * @param {import('electron').Rectangle} wa workArea del monitor
 * @param {boolean} expanded
 * @param {'left'|'center'|'right'} [dockPosition]
 */
function dockWindowBoundsForWorkArea(wa, expanded, dockPosition) {
  const pos = dockPosition || loadAppSettings().dockPosition || 'left';
  if (expanded) {
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  }
  if (pos === 'center') {
    const w = DOCK_WINDOW_WIDTH;
    const x = wa.x + Math.floor((wa.width - w) / 2);
    return { x, y: wa.y, width: w, height: wa.height };
  }
  /* Izquierda / derecha: barra horizontal negra arriba — ventana dock ancha y baja */
  return {
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: DOCK_COLLAPSED_TOP_HEIGHT,
  };
}

/**
 * Con el sidebar abierto la ventana cubre el área de trabajo para poder
 * detectar clics “fuera” del panel; cerrado vuelve a la franja del dock.
 */
function applyDockWindowBounds(win, expanded) {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const wa = display.workArea;
  const b = dockWindowBoundsForWorkArea(wa, expanded);
  win.setBounds(b);
}

module.exports = {
  applyDockWindowBounds,
  dockWindowBoundsForWorkArea,
};

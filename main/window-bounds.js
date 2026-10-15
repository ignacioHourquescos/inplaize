'use strict';

const { screen } = require('electron');
const { DOCK_WINDOW_WIDTH } = require('./constants');
const { loadAppSettings } = require('./app-settings-store');

/**
 * @param {import('electron').Rectangle} wa workArea del monitor
 * @param {boolean} expanded
 * @param {'left'|'center'|'right'} [dockPosition]
 */
function dockWindowBoundsForWorkArea(wa, expanded, dockPosition) {
  const pos = dockPosition || loadAppSettings().dockPosition || 'left';
  // Izquierda/derecha: la ventana ocupa siempre el área de trabajo. Encogerla
  // a 1px y volver a estirarla al abrir el panel es lento en Windows. Cerrado,
  // el panel queda fuera de pantalla y la ventana es click-through.
  if (expanded || pos !== 'center') {
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  }
  const w = DOCK_WINDOW_WIDTH;
  const x = wa.x + Math.floor((wa.width - w) / 2);
  return { x, y: wa.y, width: w, height: wa.height };
}

/**
 * Ajusta la ventana del dock. Si ya tiene ese tamaño, no llama a setBounds.
 */
function applyDockWindowBounds(win, expanded) {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const wa = display.workArea;
  const b = dockWindowBoundsForWorkArea(wa, expanded);
  const cur = win.getBounds();
  if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return;
  win.setBounds(b);
}

module.exports = {
  applyDockWindowBounds,
  dockWindowBoundsForWorkArea,
};

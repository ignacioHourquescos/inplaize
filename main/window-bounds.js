'use strict';

const { screen } = require('electron');

/**
 * La ventana ocupa siempre el área de trabajo. Encogerla a 1px y volver a
 * estirarla al abrir el panel es lento en Windows. Cerrado, el panel queda
 * fuera de pantalla y la ventana es click-through.
 * @param {import('electron').Rectangle} wa workArea del monitor
 */
function dockWindowBoundsForWorkArea(wa) {
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
}

/**
 * Ajusta la ventana del dock. Si ya tiene ese tamaño, no llama a setBounds.
 */
function applyDockWindowBounds(win) {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const b = dockWindowBoundsForWorkArea(display.workArea);
  const cur = win.getBounds();
  if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return;
  win.setBounds(b);
}

module.exports = {
  applyDockWindowBounds,
  dockWindowBoundsForWorkArea,
};

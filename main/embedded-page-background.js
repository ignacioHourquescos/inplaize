'use strict';

/**
 * Placa detrás de una página embebida (BrowserView / WebContentsView).
 *
 * Esas vistas no pintan el canvas blanco de un navegador: html y body llegan
 * transparentes y se ve esta placa. Con negro —o el gris del chrome— los
 * sitios que no traen fondo propio se ven con fondo negro aunque Windows
 * esté en tema claro. #fff es el canvas por defecto. Si la página pide
 * color-scheme: dark, Chromium pinta su propio fondo oscuro encima.
 */
const EMBEDDED_PAGE_BACKGROUND = '#ffffff';

/**
 * @param {{ setBackgroundColor?: (color: string) => void } | null | undefined} view
 */
function setEmbeddedPageBackground(view) {
  try {
    if (view && typeof view.setBackgroundColor === 'function') {
      view.setBackgroundColor(EMBEDDED_PAGE_BACKGROUND);
    }
  } catch {
    /* noop */
  }
}

module.exports = {
  EMBEDDED_PAGE_BACKGROUND,
  setEmbeddedPageBackground,
};

'use strict';

const DOCK_WINDOW_WIDTH = 320;
/**
 * Ya no define el alto de la ventana. Izquierda/derecha ocupa siempre el área
 * de trabajo; encogerla a 1 px y estirarla al abrir el panel era lento en Windows.
 */
const DOCK_COLLAPSED_TOP_HEIGHT = 1;
/**
 * Atajos para traer la última ventana web (el primero que logre registrar Electron gana;
 * en Windows Ctrl+Alt+D a veces está tomado por el sistema u otra app).
 */
const DOCK_TOGGLE_ACCELERATORS = ['Control+Alt+D', 'Control+Shift+D'];
/** @deprecated usar DOCK_TOGGLE_ACCELERATORS */
const DOCK_TOGGLE_ACCELERATOR = DOCK_TOGGLE_ACCELERATORS[0];
const MAX_SHORTCUT_UNDO = 25;

/**
 * En instalaciones nuevas la barra arranca vacía: el onboarding guía al
 * usuario para que cree su primera ventana. Mantenemos `LOOSE_NAV_DEFAULT_SHORTCUT`
 * por separado solo para la migración suave de usuarios que ya tenían
 * shortcuts cargados antes de que existiera el acceso de "Navegación suelta".
 */
const DEFAULT_SHORTCUTS = [];

const LOOSE_NAV_DEFAULT_SHORTCUT = {
  id: 'loose-nav',
  name: 'Navegación suelta',
  type: 'loose',
  url: '',
  icon: 'assets/icons/loose-nav.svg',
};

/** URL al abrir el navegador si todavía no hay pestañas. El “+” pide el enlace en la pestaña. */
const LOOSE_NAV_NEW_TAB_URL = 'https://www.google.com';
/** Sesión persistente propia para la navegación suelta (cookies aisladas del resto). */
const LOOSE_NAV_SESSION_ID = 'loose-nav';

module.exports = {
  DOCK_WINDOW_WIDTH,
  DOCK_COLLAPSED_TOP_HEIGHT,
  DOCK_TOGGLE_ACCELERATOR,
  DOCK_TOGGLE_ACCELERATORS,
  MAX_SHORTCUT_UNDO,
  DEFAULT_SHORTCUTS,
  LOOSE_NAV_DEFAULT_SHORTCUT,
  LOOSE_NAV_NEW_TAB_URL,
  LOOSE_NAV_SESSION_ID,
};

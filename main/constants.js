'use strict';

const DOCK_WINDOW_WIDTH = 320;
/**
 * Izq./der. con panel cerrado: franja superior del BrowserWindow del dock.
 * El panel se muestra/oculta con el atajo global (Ctrl+Alt+D / Ctrl+Mayús+D).
 * Esta franja puede ser mínima (1 px).
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

/** URL inicial al pulsar “+” en la ventana de navegación suelta. */
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

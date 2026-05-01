'use strict';

const DOCK_WINDOW_WIDTH = 320;
/**
 * Modo barra superior (izq./der.): altura de la franja sensible al clic cuando el panel está cerrado.
 * Se mantiene apenas por encima de --edge-line-width (3 px) para no pisar la franja de iconos del
 * web-shell (que arranca con padding-y de 8 px). Si subís este valor, los iconos de arriba pierden
 * píxeles clickeables y se "comen" los clics.
 */
const DOCK_COLLAPSED_TOP_HEIGHT = 4;
/**
 * Atajos para traer la última ventana web (el primero que logre registrar Electron gana;
 * en Windows Ctrl+Alt+D a veces está tomado por el sistema u otra app).
 */
const DOCK_TOGGLE_ACCELERATORS = ['Control+Alt+D', 'Control+Shift+D'];
/** @deprecated usar DOCK_TOGGLE_ACCELERATORS */
const DOCK_TOGGLE_ACCELERATOR = DOCK_TOGGLE_ACCELERATORS[0];
const MAX_SHORTCUT_UNDO = 25;

const DEFAULT_SHORTCUTS = [
  { id: '1', name: 'Google', url: 'https://www.google.com', type: 'web' },
  { id: '2', name: 'YouTube', url: 'https://www.youtube.com', type: 'web' },
  { id: '3', name: 'Gmail', url: 'https://mail.google.com', type: 'web' },
  { id: '4', name: 'WhatsApp', url: 'https://web.whatsapp.com', type: 'web' },
  { id: '5', name: 'GitHub', url: 'https://github.com', type: 'web' },
  { id: '6', name: 'ChatGPT', url: 'https://chat.openai.com', type: 'web' },
  {
    id: 'loose-nav',
    name: 'Navegación suelta',
    type: 'loose',
    url: '',
    icon: 'assets/icons/loose-nav.svg',
  },
];

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
  LOOSE_NAV_NEW_TAB_URL,
  LOOSE_NAV_SESSION_ID,
};

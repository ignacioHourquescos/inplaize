'use strict';

const path = require('path');
const { BrowserWindow, app } = require('electron');
const { log } = require('./logger');
const { dockWindowBoundsForWorkArea, applyDockWindowBounds } = require('./window-bounds');
const { loadAppSettings } = require('./app-settings-store');
const { setDockWindow } = require('./dock-window-bridge');
const { lockWindowZoom } = require('./lock-window-zoom');
const { APP_NAME, appIconFile, brandWindow } = require('./app-identity');

/**
 * Raíz de la app (donde está package.json): preload e index.html siempre aquí,
 * no depender solo de __dirname por si el entry es main/index.js o hay empaquetado.
 */
function appRoot() {
  try {
    return app.getAppPath();
  } catch {
    return path.join(__dirname, '..');
  }
}

/**
 * @param {Electron.Display} display
 * @param {{ mainWindow: BrowserWindow | null, isExpanded: boolean }} state
 */
function createDockWindow(display, state) {
  const wa = display.workArea;
  const dockPos = loadAppSettings().dockPosition || 'left';
  const initial = dockWindowBoundsForWorkArea(wa, false, dockPos);
  const root = appRoot();
  log(
    `Dock window: ${initial.width}x${initial.height} at (${initial.x},${initial.y}) displayId=${display.id} dock=${dockPos}`,
  );

  const win = new BrowserWindow({
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    title: APP_NAME,
    icon: appIconFile(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // Vista previa de PDFs en el panel de inicio: el visor integrado de
      // Chromium no funciona en <iframe> dentro de Electron, así que se usa
      // un <webview> (requiere webviewTag) con plugins habilitados.
      plugins: true,
      webviewTag: true,
    },
  });

  brandWindow(win);
  win.setSkipTaskbar(true);

  if (process.platform === 'win32') {
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
    } catch {
      win.setAlwaysOnTop(true);
    }
  }
  win.moveTop();

  win.loadFile(path.join(root, 'index.html'));
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockWindowZoom(win.webContents);

  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.setBackgroundColor('#00000000');
  });

  win.setIgnoreMouseEvents(true, { forward: true });

  function rememberHomeIfShowing() {
    if (!state.isExpanded) return;
    try {
      require('./open-shortcut').markHomeAsLastFocusedSurface();
    } catch {
      /* noop */
    }
  }
  win.on('focus', rememberHomeIfShowing);
  try {
    win.webContents.on('focus', rememberHomeIfShowing);
  } catch {
    /* noop */
  }

  win.on('blur', () => {
    // Durante el drag nativo de un archivo, soltar sobre WhatsApp/mail enfoca
    // esa ventana. Si cerramos el panel acá, el HWND fullscreen se reacomoda
    // en medio de DoDragDrop y el drop se pierde.
    try {
      if (require('./downloads-manager').isNativeDragActive()) return;
    } catch {
      /* noop */
    }
    if (state.dockBlurIgnoreUntil && Date.now() < state.dockBlurIgnoreUntil) return;
    if (state.isExpanded) {
      state.isExpanded = false;
      applyDockWindowBounds(win, false);
      win.setIgnoreMouseEvents(true, { forward: true });
      win.webContents.send('sidebar-state', false);
    }
  });

  state.mainWindow = win;
  setDockWindow(win);

  return win;
}

module.exports = { createDockWindow };

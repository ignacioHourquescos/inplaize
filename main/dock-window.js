'use strict';

const path = require('path');
const { BrowserWindow, app } = require('electron');
const { log } = require('./logger');
const { dockWindowBoundsForWorkArea, applyDockWindowBounds } = require('./window-bounds');
const { loadAppSettings } = require('./app-settings-store');
const { setDockWindow } = require('./dock-window-bridge');

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
    },
  });

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

  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.setBackgroundColor('#00000000');
  });

  win.setIgnoreMouseEvents(true, { forward: true });

  win.on('blur', () => {
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

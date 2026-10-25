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
  /**
   * Con el navegador embebido, apretar un icono de la franja mueve el foco
   * entre el BrowserView y la barra. Eso dispara `blur` aunque el cursor
   * siga sobre el dock. Si cerramos en ese instante, mantener apretado el
   * globo apaga la página: la ventana se achica antes del mouseup y el click
   * ya no cae en el botón.
   * @param {Electron.BrowserWindow} target
   */
  function dockSurfaceHasFocus(target) {
    if (!target || target.isDestroyed()) return false;
    try {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && focused !== target) return false;
      if (focused === target) return true;
    } catch {
      /* noop */
    }
    try {
      if (target.isFocused()) return true;
    } catch {
      /* noop */
    }
    try {
      const top = target.webContents;
      if (top && !top.isDestroyed() && top.isFocused()) return true;
    } catch {
      /* noop */
    }
    try {
      const views = typeof target.getBrowserViews === 'function' ? target.getBrowserViews() : [];
      for (const view of views) {
        const wc = view && view.webContents;
        if (wc && !wc.isDestroyed() && wc.isFocused()) return true;
      }
    } catch {
      /* noop */
    }
    return false;
  }

  let blurCollapseTimer = null;
  function cancelBlurCollapse() {
    if (!blurCollapseTimer) return;
    clearTimeout(blurCollapseTimer);
    blurCollapseTimer = null;
  }

  function onDockFocus() {
    cancelBlurCollapse();
    rememberHomeIfShowing();
  }

  win.on('focus', onDockFocus);
  try {
    win.webContents.on('focus', onDockFocus);
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
    if (state.gestureCoachOpen) return;
    if (state.dockBlurIgnoreUntil && Date.now() < state.dockBlurIgnoreUntil) return;
    if (!state.isExpanded) return;
    cancelBlurCollapse();
    blurCollapseTimer = setTimeout(() => {
      blurCollapseTimer = null;
      if (!win || win.isDestroyed() || !state.isExpanded) return;
      try {
        if (require('./downloads-manager').isNativeDragActive()) return;
      } catch {
        /* noop */
      }
      if (state.gestureCoachOpen) return;
      if (state.dockBlurIgnoreUntil && Date.now() < state.dockBlurIgnoreUntil) return;
      if (dockSurfaceHasFocus(win)) return;
      state.isExpanded = false;
      applyDockWindowBounds(win, false);
      try {
        win.setIgnoreMouseEvents(true, { forward: true });
      } catch {
        /* noop */
      }
      try {
        win.webContents.send('sidebar-state', false);
      } catch {
        /* noop */
      }
    }, 180);
  });

  state.mainWindow = win;
  setDockWindow(win);

  return win;
}

module.exports = { createDockWindow };

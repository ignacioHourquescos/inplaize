'use strict';

const path = require('path');
const { BrowserWindow, app, screen } = require('electron');
const { log } = require('./logger');
const { dockWindowBoundsForWorkArea } = require('./window-bounds');
const { loadAppSettings } = require('./app-settings-store');

const WIN_SIZE = 36;

/** Margen por encima del borde superior de la taskbar (evita que Windows la pinte encima). */
const FLOAT_GAP = 40;

const DOCK_AVOID_MARGIN = 14;

/** Cada cuánto reubicar el punto según el monitor donde está el cursor (multi‑pantalla). */
const FOLLOW_CURSOR_MS = 2000;

/**
 * @param {Electron.Display} display
 */
function floatingIndicatorBounds(display) {
  const db = display.bounds;
  const wa = display.workArea;
  const top = wa.y - db.y;
  const left = wa.x - db.x;
  const bottom = db.y + db.height - wa.y - wa.height;
  const right = db.x + db.width - wa.x - wa.width;
  const cx = Math.round(db.x + (db.width - WIN_SIZE) / 2);

  const edges = [
    { name: 'bottom', v: bottom },
    { name: 'top', v: top },
    { name: 'left', v: left },
    { name: 'right', v: right },
  ];
  const best = edges.reduce((a, b) => (b.v > a.v ? b : a));

  if (best.v <= 0) {
    return fallbackFloatingAboveBottom(display);
  }

  switch (best.name) {
    case 'bottom': {
      const taskbarTopY = wa.y + wa.height;
      const y = Math.round(taskbarTopY - WIN_SIZE - FLOAT_GAP);
      return { x: cx, y, width: WIN_SIZE, height: WIN_SIZE };
    }
    case 'top': {
      const y = Math.round(wa.y + FLOAT_GAP);
      return { x: cx, y, width: WIN_SIZE, height: WIN_SIZE };
    }
    case 'left': {
      const x = Math.round(db.x + left + FLOAT_GAP);
      const y = Math.round(wa.y + (wa.height - WIN_SIZE) / 2);
      return { x, y, width: WIN_SIZE, height: WIN_SIZE };
    }
    case 'right': {
      const x = Math.round(wa.x + wa.width - FLOAT_GAP - WIN_SIZE);
      const y = Math.round(wa.y + (wa.height - WIN_SIZE) / 2);
      return { x, y, width: WIN_SIZE, height: WIN_SIZE };
    }
    default:
      return fallbackFloatingAboveBottom(display);
  }
}

function fallbackFloatingAboveBottom(display) {
  const b = display.bounds;
  const wa = display.workArea;
  return {
    x: Math.round(b.x + (b.width - WIN_SIZE) / 2),
    y: Math.round(wa.y + wa.height - WIN_SIZE - FLOAT_GAP),
    width: WIN_SIZE,
    height: WIN_SIZE,
  };
}

/**
 * @param {Electron.Rectangle} wa
 * @param {Electron.Rectangle} dot
 */
function avoidDockStripOverlap(wa, dot) {
  const pos = loadAppSettings().dockPosition || 'left';
  const dock = dockWindowBoundsForWorkArea(wa, false, pos);
  const overlaps =
    dot.x < dock.x + dock.width &&
    dot.x + dot.width > dock.x &&
    dot.y < dock.y + dock.height &&
    dot.y + dot.height > dock.y;
  if (!overlaps) return dot;

  const leftX = dock.x - DOCK_AVOID_MARGIN - WIN_SIZE;
  const rightX = dock.x + dock.width + DOCK_AVOID_MARGIN;
  const origCx = dot.x;
  const inWa = (x) => x >= wa.x && x + WIN_SIZE <= wa.x + wa.width;

  const candidates = [];
  if (inWa(leftX)) candidates.push({ x: leftX, d: Math.abs(leftX - origCx) });
  if (inWa(rightX)) candidates.push({ x: rightX, d: Math.abs(rightX - origCx) });
  if (candidates.length === 0) {
    const x = Math.max(wa.x, Math.min(origCx, wa.x + wa.width - WIN_SIZE));
    return { ...dot, x };
  }
  candidates.sort((a, b) => a.d - b.d);
  return { ...dot, x: candidates[0].x };
}

/**
 * Pantalla donde está el cursor: ahí es donde el usuario mira; en multi‑monitor el “principal” puede no ser esa.
 */
function boundsForTaskbarDot() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  let bounds = floatingIndicatorBounds(display);
  bounds = avoidDockStripOverlap(wa, bounds);
  return { display, bounds };
}

function applyIndicatorBounds(win) {
  if (!win || win.isDestroyed()) return;
  const { bounds } = boundsForTaskbarDot();
  win.setBounds(bounds);
}

function subscribeDisplayChanges(onMetricsChanged) {
  const handler = () => onMetricsChanged();
  screen.on('display-added', handler);
  screen.on('display-removed', handler);
  screen.on('display-metrics-changed', handler);
  return () => {
    screen.removeListener('display-added', handler);
    screen.removeListener('display-removed', handler);
    screen.removeListener('display-metrics-changed', handler);
  };
}

function appRoot() {
  try {
    return app.getAppPath();
  } catch {
    return path.join(__dirname, '..');
  }
}

/**
 * Punto rojo encima de la barra. Ratón encima (o clic) abre el menú.
 * @returns {{ window: Electron.BrowserWindow, dispose: () => void } | null}
 */
function createTaskbarIndicator() {
  if (process.platform !== 'win32') return null;

  const root = appRoot();
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: WIN_SIZE,
    height: WIN_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    thickFrame: false,
    webPreferences: {
      preload: path.join(root, 'main', 'taskbar-indicator-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  try {
    win.setAlwaysOnTop(true, 'pop-up-menu');
  } catch {
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
    } catch {
      win.setAlwaysOnTop(true);
    }
  }
  win.setSkipTaskbar(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Posición correcta ya, no dejar la ventana en (0,0) del monitor equivocado hasta que cargue el HTML
  applyIndicatorBounds(win);

  win.loadFile(path.join(root, 'taskbar-indicator.html'));

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`Taskbar indicator did-fail-load: ${code} ${desc} ${url || ''}`);
  });

  let metricsTimer = null;
  const scheduleMetrics = () => {
    if (metricsTimer) clearTimeout(metricsTimer);
    metricsTimer = setTimeout(() => {
      metricsTimer = null;
      applyIndicatorBounds(win);
    }, 120);
  };

  let unsubDisplay = subscribeDisplayChanges(scheduleMetrics);
  let followTimer = setInterval(() => {
    if (!win.isDestroyed()) applyIndicatorBounds(win);
  }, FOLLOW_CURSOR_MS);

  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (metricsTimer) clearTimeout(metricsTimer);
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
    if (unsubDisplay) {
      unsubDisplay();
      unsubDisplay = null;
    }
  }

  win.on('closed', cleanup);

  let loggedOnce = false;
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) {
      win.setBackgroundColor('#00000000');
      applyIndicatorBounds(win);
      const { bounds, display } = boundsForTaskbarDot();
      if (!loggedOnce) {
        loggedOnce = true;
        log(
          `Indicador visible: esquina ventana (${bounds.x}, ${bounds.y}) tamaño ${bounds.width}px — pantalla id=${display.id} (sigue al monitor del ratón)`,
        );
      }
      win.show();
      win.moveTop();
      try {
        win.setAlwaysOnTop(true, 'pop-up-menu');
      } catch {
        /* ignore */
      }
    }
  });

  log('Indicador: punto rojo sobre la barra; busca el centro inferior del monitor donde está el ratón');
  return {
    window: win,
    dispose: () => {
      if (!win.isDestroyed()) win.close();
    },
  };
}

module.exports = { createTaskbarIndicator };

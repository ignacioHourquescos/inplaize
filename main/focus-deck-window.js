'use strict';

const path = require('path');
const { BrowserWindow, app, screen } = require('electron');
const { log } = require('./logger');
const { loadAppSettings, saveAppSettings } = require('./app-settings-store');
const {
  FOCUS_DECK_WIDTH,
  FOCUS_DECK_HEIGHT,
  FOCUS_DECK_COMPACT_W,
  FOCUS_DECK_COMPACT_H,
} = require('./constants');
const { setFocusDeckWindow } = require('./dock-window-bridge');

/** Píxeles entre el borde inferior de la ventana y el borde inferior del área de trabajo (justo encima de la tarea). */
const FOCUS_DECK_DOCK_GAP = 2;

function focusDeckSize(expanded) {
  if (expanded) {
    return { width: FOCUS_DECK_WIDTH, height: FOCUS_DECK_HEIGHT };
  }
  return { width: FOCUS_DECK_COMPACT_W, height: FOCUS_DECK_COMPACT_H };
}

/**
 * Y fija: alineada al borde inferior del workArea (encima de la barra de tareas en el típico caso).
 * X acotada al workArea del monitor donde está la ventana.
 */
function snapFocusDeckVerticalAndClampX(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  const lockedY = Math.round(wa.y + wa.height - b.height - FOCUS_DECK_DOCK_GAP);
  const x = Math.min(Math.max(wa.x, b.x), wa.x + wa.width - b.width);
  if (b.x !== x || b.y !== lockedY) {
    win.setBounds({ x, y: lockedY, width: b.width, height: b.height }, false);
  }
}

function appRoot() {
  try {
    return app.getAppPath();
  } catch {
    return path.join(__dirname, '..');
  }
}

/**
 * @param {Electron.Display} display
 * @param {boolean} [expanded]
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function getFocusDeckBoundsForDisplay(display, expanded) {
  const wa = display.workArea;
  const settings = loadAppSettings();
  const isExpanded = expanded ?? settings.focusDeckExpanded === true;
  const { width: w, height: h } = focusDeckSize(isExpanded);
  let x =
    typeof settings.focusDeckX === 'number' && Number.isFinite(settings.focusDeckX)
      ? Math.round(settings.focusDeckX)
      : wa.x + Math.floor((wa.width - w) / 2);
  const y = Math.round(wa.y + wa.height - h - FOCUS_DECK_DOCK_GAP);
  x = Math.min(Math.max(wa.x, x), wa.x + wa.width - w);
  return { x, y, width: w, height: h };
}

/**
 * @param {Electron.BrowserWindow} win
 * @param {boolean} expanded
 */
function resizeFocusDeckToExpanded(win, expanded) {
  if (!win || win.isDestroyed()) return;
  const cur = win.getBounds();
  const { width: newW, height: newH } = focusDeckSize(expanded);
  const display = screen.getDisplayMatching(cur);
  const wa = display.workArea;
  const lockedY = Math.round(wa.y + wa.height - newH - FOCUS_DECK_DOCK_GAP);
  const cx = cur.x + cur.width / 2;
  let nx = Math.round(cx - newW / 2);
  nx = Math.min(Math.max(wa.x, nx), wa.x + wa.width - newW);
  win.setBounds({ x: nx, y: lockedY, width: newW, height: newH }, false);
}

/**
 * @param {Electron.BrowserWindow} win
 */
function applyFocusDeckAlwaysOnTop(win) {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'win32') {
    const levels = ['dock', 'screen-saver', 'pop-up-menu'];
    for (const level of levels) {
      try {
        win.setAlwaysOnTop(true, level);
        return;
      } catch {
        /* siguiente nivel */
      }
    }
  }
  win.setAlwaysOnTop(true);
}

/**
 * @param {{ mainWindow: Electron.BrowserWindow | null, focusDeckWindow?: Electron.BrowserWindow | null, focusDeckVisible?: boolean }} state
 */
function sendFocusDeckState(state) {
  const dock = state.mainWindow;
  const visible = !!(
    state.focusDeckVisible &&
    state.focusDeckWindow &&
    !state.focusDeckWindow.isDestroyed()
  );
  if (dock && !dock.isDestroyed()) {
    dock.webContents.send('focus-deck-state', visible);
  }
}

/**
 * @param {{ mainWindow: Electron.BrowserWindow | null, focusDeckWindow?: Electron.BrowserWindow | null, focusDeckVisible?: boolean }} state
 * @param {boolean} expanded
 */
function setFocusDeckExpanded(state, expanded) {
  const win = state.focusDeckWindow;
  if (!win || win.isDestroyed()) return;
  const next = expanded === true;
  resizeFocusDeckToExpanded(win, next);
  applyFocusDeckAlwaysOnTop(win);
  snapFocusDeckVerticalAndClampX(win);
  if (!win.isDestroyed()) {
    const nb = win.getBounds();
    saveAppSettings({ focusDeckExpanded: next, focusDeckX: nb.x });
  }
  try {
    win.webContents.send('focus-deck-expanded-state', next);
  } catch {
    /* */
  }
}

/**
 * @param {{ mainWindow: Electron.BrowserWindow | null, focusDeckWindow?: Electron.BrowserWindow | null, focusDeckVisible?: boolean }} state
 */
function createFocusDeckWindow(state) {
  const root = appRoot();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const b = getFocusDeckBoundsForDisplay(display);

  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(root, 'focus-deck-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  setFocusDeckWindow(win);

  win.setSkipTaskbar(true);
  applyFocusDeckAlwaysOnTop(win);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(root, 'focus-deck.html'));

  win.on('show', () => {
    applyFocusDeckAlwaysOnTop(win);
    if (!win.isDestroyed()) win.moveTop();
  });

  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) {
      win.setBackgroundColor('#00000000');
      const exp = loadAppSettings().focusDeckExpanded === true;
      try {
        win.webContents.send('focus-deck-expanded-state', exp);
      } catch {
        /* */
      }
    }
  });

  let moveRaf = 0;
  const scheduleSnap =
    typeof requestAnimationFrame === 'function'
      ? (fn) => requestAnimationFrame(fn)
      : (fn) => setImmediate(fn);
  win.on('move', () => {
    if (moveRaf) return;
    moveRaf = 1;
    scheduleSnap(() => {
      moveRaf = 0;
      snapFocusDeckVerticalAndClampX(win);
    });
  });

  let moveSaveTimer;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const nb = win.getBounds();
      saveAppSettings({ focusDeckX: nb.x });
    }, 400);
  });

  const onMetricsChanged = () => {
    snapFocusDeckVerticalAndClampX(win);
  };
  screen.on('display-metrics-changed', onMetricsChanged);
  win.on('closed', () => {
    screen.removeListener('display-metrics-changed', onMetricsChanged);
    setFocusDeckWindow(null);
    state.focusDeckWindow = null;
    state.focusDeckVisible = false;
    sendFocusDeckState(state);
  });

  state.focusDeckWindow = win;
  log(`Focus deck window: ${b.width}x${b.height} at (${b.x}, ${b.y})`);
  return win;
}

/**
 * @param {{ mainWindow: Electron.BrowserWindow | null, focusDeckWindow?: Electron.BrowserWindow | null, focusDeckVisible?: boolean }} state
 */
function showFocusDeck(state) {
  let win = state.focusDeckWindow;
  if (!win || win.isDestroyed()) {
    createFocusDeckWindow(state);
    win = state.focusDeckWindow;
  }
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const settings = loadAppSettings();
  const b = getFocusDeckBoundsForDisplay(display, settings.focusDeckExpanded === true);
  win.setBounds(b);
  snapFocusDeckVerticalAndClampX(win);
  applyFocusDeckAlwaysOnTop(win);
  win.show();
  win.moveTop();
  applyFocusDeckAlwaysOnTop(win);
  state.focusDeckVisible = true;
  sendFocusDeckState(state);
}

/**
 * @param {{ mainWindow: Electron.BrowserWindow | null, focusDeckWindow?: Electron.BrowserWindow | null, focusDeckVisible?: boolean }} state
 */
function hideFocusDeck(state) {
  const win = state.focusDeckWindow;
  if (win && !win.isDestroyed()) {
    win.hide();
  }
  state.focusDeckVisible = false;
  sendFocusDeckState(state);
}

/**
 * @param {{ mainWindow: Electron.BrowserWindow | null, focusDeckWindow?: Electron.BrowserWindow | null, focusDeckVisible?: boolean }} state
 */
function toggleFocusDeck(state) {
  if (state.focusDeckVisible && state.focusDeckWindow && !state.focusDeckWindow.isDestroyed()) {
    hideFocusDeck(state);
    return false;
  }
  showFocusDeck(state);
  return true;
}

module.exports = {
  toggleFocusDeck,
  showFocusDeck,
  hideFocusDeck,
  sendFocusDeckState,
  getFocusDeckBoundsForDisplay,
  setFocusDeckExpanded,
  focusDeckSize,
};

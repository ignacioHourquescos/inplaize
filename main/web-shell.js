'use strict';

const path = require('path');
const { app, BrowserWindow, BrowserView, session, screen } = require('electron');
const { webMapKey } = require('./web-map-key');
const { partitionFromSessionId } = require('./session-partition');
const {
  broadcastOpenWebWindowKeys,
  broadcastShortcutTitleBadge,
  setShellChromeWindow,
} = require('./dock-window-bridge');
const { loadShortcuts } = require('./shortcuts-store');
const { forceWindowForeground } = require('./window-focus');

/** Altura de la franja superior (accesos + botones ventana). */
const SHELL_CHROME_HEIGHT = 52;

function parseParenCount(title) {
  const m = String(title).match(/\((\d+)\)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/** @type {Electron.BrowserWindow | null} */
let shellWin = null;

/** @type {Map<string, { view: Electron.BrowserView, shortcutId: string, name: string, icon: string }>} */
const tabs = new Map();

/** @type {string | null} */
let activeMapKey = null;

function appRoot() {
  try {
    return app.getAppPath();
  } catch {
    return path.join(__dirname, '..');
  }
}

function chromeLikeUserAgent() {
  const chrome = process.versions.chrome;
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function isWhatsAppWeb(url) {
  try {
    return new URL(url).hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

/** @param {unknown} shortcut */
function iconFromShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return '';
  const icon = /** @type {{ icon?: string }} */ (shortcut).icon;
  return typeof icon === 'string' ? icon.trim() : '';
}

function syncKeysToDock() {
  broadcastOpenWebWindowKeys([...tabs.keys()]);
}

function buildChromePayload() {
  let focusState = { active: false, members: [] };
  try {
    focusState = require('./focus-mode').getState();
  } catch {
    /* noop */
  }
  const memberSet = new Set(focusState.members);
  const shortcuts = loadShortcuts();
  const items = shortcuts.map((s) => {
    const name = (s.name && String(s.name)) || '';
    const icon = iconFromShortcut(s);
    if (s.type === 'web') {
      const mk = webMapKey(s);
      return {
        id: String(s.id),
        type: 'web',
        name,
        icon,
        mapKey: mk,
        isOpen: tabs.has(mk),
        isActive: mk === activeMapKey,
        isFocusMember: memberSet.has(mk),
      };
    }
    return {
      id: String(s.id),
      type: 'app',
      name,
      icon,
      mapKey: null,
      isOpen: false,
      isActive: false,
      isFocusMember: false,
    };
  });
  return { items, focusMode: focusState };
}

function broadcastChromeIfOpen() {
  if (!shellWin || shellWin.isDestroyed()) return;
  try {
    broadcastChromeToRenderer();
  } catch {
    /* noop */
  }
}

function broadcastChromeToRenderer() {
  if (!shellWin || shellWin.isDestroyed()) return;
  shellWin.webContents.send('shell-chrome', buildChromePayload());
}

function layoutActiveView() {
  if (!shellWin || shellWin.isDestroyed() || !activeMapKey) return;
  const tab = tabs.get(activeMapKey);
  if (!tab) return;
  const [w, h] = shellWin.getContentSize();
  tab.view.setBounds({
    x: 0,
    y: SHELL_CHROME_HEIGHT,
    width: w,
    height: Math.max(0, h - SHELL_CHROME_HEIGHT),
  });
}

function detachAllBrowserViews() {
  if (!shellWin || shellWin.isDestroyed()) return;
  for (const { view } of tabs.values()) {
    try {
      shellWin.removeBrowserView(view);
    } catch {
      /* noop */
    }
  }
}

function attachActiveViewOnly() {
  detachAllBrowserViews();
  if (!shellWin || shellWin.isDestroyed() || !activeMapKey) return;
  const tab = tabs.get(activeMapKey);
  if (!tab) return;
  try {
    shellWin.addBrowserView(tab.view);
  } catch {
    return;
  }
  layoutActiveView();
}

function destroyTabView(mapKey) {
  const tab = tabs.get(mapKey);
  if (!tab) return;
  try {
    if (shellWin && !shellWin.isDestroyed()) {
      shellWin.removeBrowserView(tab.view);
    }
  } catch {
    /* noop */
  }
  const wc = tab.view.webContents;
  try {
    if (wc && !wc.isDestroyed() && typeof wc.destroy === 'function') {
      wc.destroy();
    }
  } catch {
    /* noop */
  }
  broadcastShortcutTitleBadge(tab.shortcutId, null);
  tabs.delete(mapKey);
}

function ensureShellWindow() {
  if (typeof BrowserView !== 'function') {
    throw new Error('BrowserView no está disponible en esta versión de Electron');
  }
  if (shellWin && !shellWin.isDestroyed()) return shellWin;

  const root = appRoot();
  const wa = screen.getPrimaryDisplay().workArea;
  const useFramelessChrome = process.platform === 'win32' || process.platform === 'linux';

  shellWin = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    show: false,
    title: 'UsualDesk — Web',
    frame: !useFramelessChrome,
    backgroundColor: '#1e1e24',
    webPreferences: {
      preload: path.join(root, 'web-shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  function sendShellMaximizedState() {
    if (!shellWin || shellWin.isDestroyed()) return;
    try {
      shellWin.webContents.send('shell-window-maximized', shellWin.isMaximized());
    } catch {
      /* noop */
    }
  }

  shellWin.on('maximize', sendShellMaximizedState);
  shellWin.on('unmaximize', sendShellMaximizedState);

  try {
    shellWin.removeMenu();
  } catch {
    try {
      shellWin.setMenu(null);
    } catch {
      /* noop */
    }
  }

  shellWin.on('resize', () => {
    layoutActiveView();
  });

  shellWin.on('closed', () => {
    setShellChromeWindow(null);
    const keys = [...tabs.keys()];
    for (const mk of keys) {
      destroyTabView(mk);
    }
    activeMapKey = null;
    shellWin = null;
    broadcastOpenWebWindowKeys([]);
  });

  setShellChromeWindow(shellWin);

  shellWin.loadFile(path.join(root, 'web-shell.html'));

  shellWin.webContents.once('did-finish-load', () => {
    broadcastChromeToRenderer();
  });

  shellWin.once('ready-to-show', () => {
    if (shellWin && !shellWin.isDestroyed()) {
      shellWin.show();
      sendShellMaximizedState();
    }
  });

  return shellWin;
}

/**
 * @param {import('./shortcuts-store').Shortcut | Record<string, unknown>} shortcut
 */
async function openOrFocusTab(shortcut) {
  const {
    installWebNotificationPermissionHandlers,
    attachWebShortcutEmbeddedWebContents,
  } = require('./open-shortcut');

  const partition = partitionFromSessionId(shortcut.sessionId);
  const mapKey = webMapKey(shortcut);
  const focusOverride = (() => {
    try {
      return require('./focus-mode').getRuntimeOverride(mapKey);
    } catch {
      return null;
    }
  })();
  const desiredNotificationsMuted = focusOverride
    ? focusOverride.notificationsMuted
    : shortcut.notificationsMuted === true;
  const desiredAudioMuted = focusOverride
    ? focusOverride.audioMuted
    : !!shortcut.audioMuted;

  installWebNotificationPermissionHandlers(partition);

  if (isWhatsAppWeb(shortcut.url)) {
    session.fromPartition(partition).setUserAgent(chromeLikeUserAgent());
  }

  if (tabs.has(mapKey)) {
    const entry = tabs.get(mapKey);
    if (entry) {
      entry.name = shortcut.name || entry.name;
      entry.icon = iconFromShortcut(shortcut);
      const wc = entry.view.webContents;
      if (!wc.isDestroyed()) {
        wc.__usualDeskNotificationsMuted = desiredNotificationsMuted;
        wc.setAudioMuted(desiredAudioMuted);
      }
    }
    activeMapKey = mapKey;
    const w = ensureShellWindow();
    attachActiveViewOnly();
    try {
      const wc = entry.view.webContents;
      if (!wc.isDestroyed()) {
        broadcastShortcutTitleBadge(shortcut.id, parseParenCount(wc.getTitle()));
      }
    } catch {
      /* noop */
    }
    broadcastChromeToRenderer();
    syncKeysToDock();
    forceWindowForeground(w);
    return;
  }

  const win = ensureShellWindow();
  const WEB_NOTIFICATION_FOCUS_PRELOAD = path.join(__dirname, 'web-notification-focus-preload.js');

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition,
      preload: WEB_NOTIFICATION_FOCUS_PRELOAD,
    },
  });
  try {
    if (typeof view.setBackgroundColor === 'function') {
      view.setBackgroundColor('#000000');
    }
  } catch {
    /* noop */
  }

  const wc = view.webContents;
  wc.__usualDeskWebMapKey = mapKey;
  wc.__usualDeskNotificationsMuted = desiredNotificationsMuted;

  attachWebShortcutEmbeddedWebContents(wc, shortcut, mapKey);

  wc.setAudioMuted(desiredAudioMuted);

  tabs.set(mapKey, {
    view,
    shortcutId: String(shortcut.id || ''),
    name: shortcut.name || 'Web',
    icon: iconFromShortcut(shortcut),
  });
  activeMapKey = mapKey;

  attachActiveViewOnly();
  broadcastChromeToRenderer();
  syncKeysToDock();

  wc.once('did-finish-load', () => {
    if (!wc.isDestroyed()) wc.setAudioMuted(desiredAudioMuted);
  });

  await wc.loadURL(shortcut.url || 'about:blank');

  if (win && !win.isDestroyed()) {
    forceWindowForeground(win);
  }
}

function selectTabByMapKey(mapKey) {
  if (!mapKey || !tabs.has(mapKey)) return false;
  activeMapKey = mapKey;
  attachActiveViewOnly();
  broadcastChromeToRenderer();
  if (shellWin && !shellWin.isDestroyed()) {
    forceWindowForeground(shellWin);
  }
  return true;
}

function closeTabByMapKey(mapKey) {
  if (!mapKey || !tabs.has(mapKey)) return false;
  destroyTabView(mapKey);

  if (activeMapKey === mapKey) {
    activeMapKey = tabs.size ? [...tabs.keys()][0] : null;
  }

  if (tabs.size === 0) {
    if (shellWin && !shellWin.isDestroyed()) {
      shellWin.close();
    }
    shellWin = null;
    activeMapKey = null;
    syncKeysToDock();
    return true;
  }

  attachActiveViewOnly();
  broadcastChromeToRenderer();
  syncKeysToDock();
  return true;
}

function focusTabByMapKey(mapKey) {
  if (!mapKey || typeof mapKey !== 'string') return false;
  if (!tabs.has(mapKey)) return false;
  activeMapKey = mapKey;
  const w = ensureShellWindow();
  attachActiveViewOnly();
  broadcastChromeToRenderer();
  if (w && !w.isDestroyed()) {
    forceWindowForeground(w);
  }
  return true;
}

function getOpenMapKeys() {
  return [...tabs.keys()];
}

/** @param {(wc: Electron.WebContents) => void} fn */
function forEachTabWebContents(fn) {
  for (const { view } of tabs.values()) {
    const wc = view.webContents;
    if (wc && !wc.isDestroyed()) fn(wc);
  }
}

function getWebContentsForMapKey(mapKey) {
  const tab = tabs.get(mapKey);
  if (!tab) return null;
  const wc = tab.view.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

function setTabAudioMuted(mapKey, muted) {
  const tab = tabs.get(mapKey);
  if (!tab) return;
  const wc = tab.view.webContents;
  if (wc && !wc.isDestroyed()) wc.setAudioMuted(!!muted);
}

function setTabNotificationsMuted(mapKey, muted) {
  const tab = tabs.get(mapKey);
  if (!tab) return;
  const wc = tab.view.webContents;
  if (wc && !wc.isDestroyed()) wc.__usualDeskNotificationsMuted = !!muted;
}

/**
 * Con BrowserView, el foco suele estar en el webContents de la pestaña, no en la ventana;
 * entonces isFocused() del BrowserWindow da false y Ctrl+Alt+D no minimizaba de forma fiable.
 */
function shellWindowOrContentsHasFocus() {
  if (!shellWin || shellWin.isDestroyed()) return false;
  try {
    if (shellWin.isFocused()) return true;
  } catch {
    return false;
  }
  try {
    const top = shellWin.webContents;
    if (top && !top.isDestroyed() && top.isFocused()) return true;
  } catch {
    /* noop */
  }
  for (const { view } of tabs.values()) {
    try {
      const wc = view.webContents;
      if (wc && !wc.isDestroyed() && wc.isFocused()) return true;
    } catch {
      /* noop */
    }
  }
  return false;
}

/**
 * Solo para el atajo global: siempre restaura y trae el contenedor al frente (no minimiza).
 */
function raiseShellFromGlobalHotkey() {
  if (!shellWin || shellWin.isDestroyed()) {
    ensureShellWindow();
  }
  if (!shellWin || shellWin.isDestroyed()) return;

  if (shellWin.isMinimized()) {
    shellWin.restore();
  }

  forceWindowForeground(shellWin);
  broadcastChromeToRenderer();
}

/** Panel lateral / botón: minimiza el shell si ya tiene el foco (pestaña o barra). */
function showOrToggleShellFromHotkey() {
  if (!shellWin || shellWin.isDestroyed()) {
    ensureShellWindow();
  }
  if (!shellWin || shellWin.isDestroyed()) return;

  if (shellWin.isMinimized()) {
    shellWin.restore();
  }

  const visible = shellWin.isVisible();
  const shellInUse = shellWindowOrContentsHasFocus();

  if (visible && !shellWin.isMinimized() && shellInUse) {
    shellWin.minimize();
    return;
  }

  forceWindowForeground(shellWin);
  broadcastChromeToRenderer();
}

function closeAndClearAll() {
  if (shellWin && !shellWin.isDestroyed()) {
    shellWin.close();
  }
  shellWin = null;
  tabs.clear();
  activeMapKey = null;
  broadcastOpenWebWindowKeys([]);
}

function registerShellIpc(ipcMain) {
  for (const ch of [
    'shell-get-chrome',
    'shell-activate-shortcut',
    'shell-close-tab',
    'shell-window-minimize',
    'shell-window-toggle-maximize',
    'shell-window-close',
  ]) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* noop */
    }
  }

  ipcMain.handle('shell-get-chrome', () => buildChromePayload());

  ipcMain.handle('shell-activate-shortcut', async (_event, id) => {
    if (id == null) return false;
    const list = loadShortcuts();
    const s = list.find((x) => String(x.id) === String(id));
    if (!s) return false;
    const { openShortcut } = require('./open-shortcut');
    await openShortcut(s);
    return true;
  });

  ipcMain.handle('shell-close-tab', (_event, mapKey) => closeTabByMapKey(String(mapKey || '')));

  ipcMain.handle('shell-window-minimize', () => {
    if (shellWin && !shellWin.isDestroyed()) shellWin.minimize();
    return true;
  });

  ipcMain.handle('shell-window-toggle-maximize', () => {
    if (!shellWin || shellWin.isDestroyed()) return false;
    if (shellWin.isMaximized()) shellWin.unmaximize();
    else shellWin.maximize();
    return shellWin.isMaximized();
  });

  ipcMain.handle('shell-window-close', () => {
    if (shellWin && !shellWin.isDestroyed()) shellWin.close();
    return true;
  });
}

module.exports = {
  openOrFocusTab,
  focusTabByMapKey,
  getOpenMapKeys,
  forEachTabWebContents,
  getWebContentsForMapKey,
  setTabAudioMuted,
  setTabNotificationsMuted,
  closeAndClearAll,
  registerShellIpc,
  showOrToggleShellFromHotkey,
  raiseShellFromGlobalHotkey,
  broadcastChromeIfOpen,
  closeTabByMapKey,
};

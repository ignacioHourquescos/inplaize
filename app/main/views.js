'use strict';

const path = require('path');
const { BrowserWindow, WebContentsView, screen, shell } = require('electron');
const session = require('./session');
const { partitionForProfile, partitionForShortcut, normalizeAddress } = require('../shared/model');

const STRIP_H = 58;
const BAR_H = 52;
const NEW_TAB = path.join(__dirname, '../renderer/new-tab.html');
const ICON = path.join(__dirname, '../../assets/icon.png');

/** @type {BrowserWindow | null} */
let dock = null;
/** @type {Map<string, WebContentsView>} */
const tabViews = new Map();
/** @type {Map<string, BrowserWindow>} */
const shortcutWins = new Map();
/** @type {BrowserWindow | null} */
let lastFocused = null;

function chromeHeight() {
  const snap = session.state;
  return snap.barOpen ? STRIP_H + BAR_H : STRIP_H;
}

function remember(win) {
  if (win && !win.isDestroyed()) lastFocused = win;
}

function navCaps(wc) {
  try {
    const history = wc.navigationHistory;
    if (history && typeof history.canGoBack === 'function') {
      return { canGoBack: history.canGoBack(), canGoForward: history.canGoForward() };
    }
  } catch {
    /* Electron viejo */
  }
  return {
    canGoBack: typeof wc.canGoBack === 'function' ? wc.canGoBack() : false,
    canGoForward: typeof wc.canGoForward === 'function' ? wc.canGoForward() : false,
  };
}

function isWebUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function displayAddress(wc) {
  try {
    const url = wc.getURL();
    return isWebUrl(url) ? url : '';
  } catch {
    return '';
  }
}

function shortcutIsFocused() {
  const id = session.state.focusedShortcutId;
  if (!id) return false;
  const win = shortcutWins.get(id);
  return !!(win && !win.isDestroyed() && win.isFocused());
}

function sendState() {
  if (!dock || dock.isDestroyed()) return;
  const snap = session.snapshot({ shortcutFocused: shortcutIsFocused() });
  const tab = session.activeTab();
  const view = tab ? tabViews.get(tab.id) : null;
  const wc = view && !view.webContents.isDestroyed() ? view.webContents : null;
  if (wc) {
    snap.nav = { ...navCaps(wc), address: displayAddress(wc) || (tab && tab.url) || '' };
  }
  dock.webContents.send('mvp:state', snap);
}

function layoutActive() {
  if (!dock || dock.isDestroyed()) return;
  const [width, height] = dock.getContentSize();
  const top = chromeHeight();
  for (const view of tabViews.values()) {
    try {
      view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    } catch {
      /* la vista se está cerrando */
    }
  }
}

function detachAll() {
  if (!dock || dock.isDestroyed()) return;
  for (const view of tabViews.values()) {
    try {
      dock.contentView.removeChildView(view);
    } catch {
      /* ya no está */
    }
  }
}

function showActive() {
  if (!dock || dock.isDestroyed()) return;
  detachAll();
  if (session.state.mode !== 'browse') return;
  const tab = session.activeTab();
  if (!tab) return;
  const view = ensureView(tab, session.state.activeProfileId);
  try {
    dock.contentView.addChildView(view);
  } catch {
    /* ya estaba */
  }
  layoutActive();
}

function refresh() {
  showActive();
  sendState();
}

function bindTab(view, profileId, tabId) {
  const wc = view.webContents;
  const publish = () => {
    if (wc.isDestroyed()) return;
    const url = displayAddress(wc);
    const title = url ? wc.getTitle() : 'Nueva pestaña';
    session.patchTab(profileId, tabId, { url, title: title || 'Nueva pestaña' });
  };
  wc.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) session.newTab(url);
    return { action: 'deny' };
  });
  wc.on('page-title-updated', publish);
  wc.on('did-navigate', publish);
  wc.on('did-navigate-in-page', publish);
  wc.on('did-finish-load', publish);
  wc.on('did-fail-load', (_event, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) publish();
  });
}

function ensureView(tab, profileId) {
  const existing = tabViews.get(tab.id);
  if (existing && !existing.webContents.isDestroyed()) return existing;
  const view = new WebContentsView({
    webPreferences: {
      partition: partitionForProfile(profileId),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  tabViews.set(tab.id, view);
  try {
    view.setBackgroundColor('#000000');
  } catch {
    /* versiones que no pintan el fondo de la vista */
  }
  bindTab(view, profileId, tab.id);
  if (tab.url && isWebUrl(tab.url)) view.webContents.loadURL(tab.url);
  else view.webContents.loadFile(NEW_TAB);
  return view;
}

function destroyTabView(tabId) {
  const view = tabViews.get(tabId);
  if (!view) return;
  tabViews.delete(tabId);
  if (dock && !dock.isDestroyed()) {
    try {
      dock.contentView.removeChildView(view);
    } catch {
      /* noop */
    }
  }
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch {
    /* la vista ya se cerró */
  }
}

function createDock() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  dock = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    backgroundColor: '#000000',
    title: 'inplaize',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dock.setMenuBarVisibility(false);
  dock.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('preload-error', preloadPath, error && error.message ? error.message : error);
  });
  dock.loadFile(path.join(__dirname, '../renderer/index.html'));
  dock.on('resize', layoutActive);
  dock.on('focus', () => remember(dock));
  dock.webContents.on('did-finish-load', sendState);
  dock.on('closed', () => {
    dock = null;
  });
  remember(dock);
  return dock;
}

function openShortcut(id) {
  const shortcut = session.state.shortcuts.find((item) => item.id === id);
  if (!shortcut) return;
  let win = shortcutWins.get(id);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    session.setFocusedShortcut(id);
    return;
  }
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: shortcut.name,
    icon: ICON,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      partition: partitionForShortcut(id),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  shortcutWins.set(id, win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.on('focus', () => {
    remember(win);
    session.setFocusedShortcut(id);
  });
  win.on('closed', () => {
    shortcutWins.delete(id);
    if (lastFocused === win) lastFocused = dock;
    session.noteShortcutOpen(id, false);
  });
  win.loadURL(shortcut.url);
  session.noteShortcutOpen(id, true);
  session.setFocusedShortcut(id);
}

function closeShortcut(id) {
  const win = shortcutWins.get(id);
  if (win && !win.isDestroyed()) win.close();
}

function navigate(text) {
  const url = normalizeAddress(text);
  if (!url) return { ok: false, error: 'Escribí un enlace o algo para buscar.' };
  if (session.state.mode !== 'browse' || !session.state.barOpen) {
    session.selectProfile(session.state.activeProfileId);
  }
  const tab = session.activeTab();
  if (!tab) return { ok: false };
  const view = ensureView(tab, session.state.activeProfileId);
  view.webContents.loadURL(url);
  session.patchTab(session.state.activeProfileId, tab.id, { url, title: hostTitle(url) });
  return { ok: true };
}

function hostTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

function goBackSafe(wc, direction) {
  try {
    const history = wc.navigationHistory;
    if (history && direction === 'back') history.goBack();
    else if (history && direction === 'forward') history.goForward();
    else if (direction === 'back') wc.goBack();
    else wc.goForward();
  } catch {
    /* sin historial */
  }
}

function browse(direction) {
  const tab = session.activeTab();
  const view = tab && tabViews.get(tab.id);
  const wc = view && view.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (direction === 'reload') {
    wc.reload();
    return;
  }
  const caps = navCaps(wc);
  if (direction === 'back' && caps.canGoBack) goBackSafe(wc, 'back');
  if (direction === 'forward' && caps.canGoForward) goBackSafe(wc, 'forward');
}

function windowAction(action) {
  if (!dock || dock.isDestroyed()) return;
  if (action === 'minimize') dock.minimize();
  if (action === 'maximize') {
    if (dock.isMaximized()) dock.unmaximize();
    else dock.maximize();
  }
  if (action === 'close') dock.close();
}

function hideAll() {
  const wins = [dock, ...shortcutWins.values()].filter((win) => win && !win.isDestroyed());
  for (const win of wins) win.hide();
}

function showAll() {
  const wins = [dock, ...shortcutWins.values()].filter((win) => win && !win.isDestroyed());
  for (const win of wins) {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  const target = lastFocused && !lastFocused.isDestroyed() ? lastFocused : dock;
  if (target && !target.isDestroyed()) target.focus();
}

function anyFocused() {
  return [dock, ...shortcutWins.values()].some((win) => win && !win.isDestroyed() && win.isFocused());
}

function toggleGlobal() {
  if (anyFocused()) hideAll();
  else showAll();
}

function showDock() {
  if (!dock || dock.isDestroyed()) return;
  if (dock.isMinimized()) dock.restore();
  if (!dock.isVisible()) dock.show();
  dock.focus();
}

function dropTabs(ids) {
  for (const id of ids) destroyTabView(id);
  refresh();
}

module.exports = {
  createDock,
  refresh,
  sendState,
  openShortcut,
  closeShortcut,
  navigate,
  browse,
  windowAction,
  toggleGlobal,
  showDock,
  destroyTabView,
  dropTabs,
  STRIP_H,
  BAR_H,
};

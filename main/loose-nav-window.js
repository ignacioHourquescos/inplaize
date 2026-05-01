'use strict';

/**
 * Navegación suelta: pestañas dinámicas que viven dentro de la ventana del dock,
 * justo debajo de la franja de iconos. El BrowserView se reposiciona usando
 * las coordenadas que el renderer del dock envía por IPC (`loose-nav-set-viewport-bounds`).
 */

const { BrowserView, session, shell, ipcMain } = require('electron');
const { LOOSE_NAV_NEW_TAB_URL, LOOSE_NAV_SESSION_ID } = require('./constants');
const { partitionFromSessionId } = require('./session-partition');
const { getDockWindow } = require('./dock-window-bridge');

/**
 * @typedef {{
 *   id: string,
 *   view: Electron.BrowserView,
 *   title: string,
 *   url: string,
 *   favicon: string,
 *   loading: boolean,
 *   canGoBack: boolean,
 *   canGoForward: boolean,
 * }} LooseTab
 */

/** @type {Map<string, LooseTab>} */
const tabs = new Map();
/** @type {string | null} */
let activeTabId = null;
let modeActive = false;
/** @type {{x: number, y: number, width: number, height: number} | null} */
let viewportBounds = null;

/** Callback que permite al módulo solicitar al resto del main expandir el dock. */
/** @type {(() => void) | null} */
let expandDockHook = null;

/** Callback para solicitar colapsar el dock desde aquí (al cerrar el modo explícitamente). */
/** @type {(() => void) | null} */
let collapseDockHook = null;

let tabSequence = 0;
function nextTabId() {
  tabSequence += 1;
  return `loose-${Date.now().toString(36)}-${tabSequence}`;
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

function loosePartition() {
  return partitionFromSessionId(LOOSE_NAV_SESSION_ID);
}

function buildStatePayload() {
  const items = [];
  for (const tab of tabs.values()) {
    items.push({
      id: tab.id,
      title: tab.title || tab.url || 'Pestaña',
      url: tab.url || '',
      favicon: tab.favicon || '',
      loading: !!tab.loading,
      canGoBack: !!tab.canGoBack,
      canGoForward: !!tab.canGoForward,
      isActive: tab.id === activeTabId,
    });
  }
  const active = activeTabId ? tabs.get(activeTabId) : null;
  return {
    active: modeActive,
    tabs: items,
    activeTabId,
    activeUrl: active ? active.url || '' : '',
    activeCanGoBack: !!(active && active.canGoBack),
    activeCanGoForward: !!(active && active.canGoForward),
    activeLoading: !!(active && active.loading),
  };
}

function broadcastState() {
  const dock = getDockWindow();
  if (!dock) return;
  try {
    dock.webContents.send('loose-nav-state', buildStatePayload());
  } catch {
    /* noop */
  }
}

function detachAllFromDock() {
  const dock = getDockWindow();
  if (!dock) return;
  for (const tab of tabs.values()) {
    try {
      dock.removeBrowserView(tab.view);
    } catch {
      /* noop */
    }
  }
}

function layoutActiveView() {
  const dock = getDockWindow();
  if (!dock || !modeActive || !activeTabId || !viewportBounds) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const { x, y, width, height } = viewportBounds;
  if (width <= 0 || height <= 0) return;
  try {
    tab.view.setBounds({
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height)),
    });
  } catch {
    /* noop */
  }
}

function attachActiveViewOnly() {
  const dock = getDockWindow();
  if (!dock) return;
  detachAllFromDock();
  if (!modeActive || !activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  try {
    dock.addBrowserView(tab.view);
  } catch {
    return;
  }
  layoutActiveView();
}

function destroyTabView(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const dock = getDockWindow();
  if (dock) {
    try {
      dock.removeBrowserView(tab.view);
    } catch {
      /* noop */
    }
  }
  const wc = tab.view.webContents;
  try {
    if (wc && !wc.isDestroyed() && typeof wc.destroy === 'function') {
      wc.destroy();
    }
  } catch {
    /* noop */
  }
  tabs.delete(tabId);
}

function attachTabEvents(tab) {
  const wc = tab.view.webContents;

  wc.on('page-title-updated', (_e, title) => {
    tab.title = String(title || '');
    broadcastState();
  });

  wc.on('page-favicon-updated', (_e, favicons) => {
    if (Array.isArray(favicons) && favicons.length) {
      tab.favicon = String(favicons[0] || '');
      broadcastState();
    }
  });

  wc.on('did-start-loading', () => {
    tab.loading = true;
    broadcastState();
  });

  wc.on('did-stop-loading', () => {
    tab.loading = false;
    try {
      tab.url = wc.getURL() || tab.url;
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
    } catch {
      /* noop */
    }
    broadcastState();
  });

  wc.on('did-navigate', (_e, url) => {
    tab.url = String(url || tab.url || '');
    try {
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
    } catch {
      /* noop */
    }
    broadcastState();
  });

  wc.on('did-navigate-in-page', (_e, url) => {
    tab.url = String(url || tab.url || '');
    try {
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
    } catch {
      /* noop */
    }
    broadcastState();
  });

  /** Ctrl+Click / target=_blank dentro de la navegación suelta → otra pestaña suelta. */
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!url || /^chrome[-:]/i.test(url) || url.startsWith('about:blank')) {
      return { action: 'deny' };
    }
    const background =
      disposition === 'background-tab' ||
      disposition === 'save-to-disk' ||
      disposition === 'other';
    setImmediate(() => {
      openTabFromUrl(url, { background }).catch(() => {});
    });
    return { action: 'deny' };
  });
}

/**
 * Crea una pestaña y opcionalmente la activa. Si el modo está activo,
 * se ajusta el BrowserView inmediatamente.
 * @param {string} url
 * @param {{ background?: boolean, activateMode?: boolean }} [opts]
 * @returns {Promise<string>} id de la pestaña creada
 */
async function openTabFromUrl(url, opts = {}) {
  const partition = loosePartition();
  try {
    session.fromPartition(partition).setUserAgent(chromeLikeUserAgent());
  } catch {
    /* noop */
  }

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition,
    },
  });
  try {
    if (typeof view.setBackgroundColor === 'function') {
      view.setBackgroundColor('#1e1e24');
    }
  } catch {
    /* noop */
  }

  const id = nextTabId();
  /** @type {LooseTab} */
  const tab = {
    id,
    view,
    title: 'Cargando…',
    url: String(url || ''),
    favicon: '',
    loading: true,
    canGoBack: false,
    canGoForward: false,
  };
  tabs.set(id, tab);
  attachTabEvents(tab);

  const shouldActivateMode = opts.activateMode !== false;
  if (shouldActivateMode && !modeActive) {
    modeActive = true;
    if (typeof expandDockHook === 'function') {
      try {
        expandDockHook();
      } catch {
        /* noop */
      }
    }
  }

  if (!opts.background || !activeTabId) {
    activeTabId = id;
    if (modeActive) attachActiveViewOnly();
  }

  broadcastState();

  try {
    await view.webContents.loadURL(url || LOOSE_NAV_NEW_TAB_URL);
  } catch {
    /* la página puede fallar, la pestaña queda igualmente */
  }

  return id;
}

/**
 * Entrada pública cuando el usuario pulsa el acceso de “Navegación suelta” en el dock.
 * Si no hay pestañas abiertas, crea una con la URL inicial.
 */
async function enterLooseNavMode() {
  modeActive = true;
  if (typeof expandDockHook === 'function') {
    try {
      expandDockHook();
    } catch {
      /* noop */
    }
  }
  if (tabs.size === 0) {
    await openTabFromUrl(LOOSE_NAV_NEW_TAB_URL, { activateMode: false });
  } else if (modeActive) {
    attachActiveViewOnly();
  }
  broadcastState();
}

/**
 * Cierra el modo (detach de la vista) pero mantiene las pestañas en memoria.
 * @param {{ collapseDock?: boolean }} [opts]
 */
function exitLooseNavMode(opts = {}) {
  if (!modeActive) return;
  modeActive = false;
  detachAllFromDock();
  broadcastState();
  if (opts.collapseDock && typeof collapseDockHook === 'function') {
    try {
      collapseDockHook();
    } catch {
      /* noop */
    }
  }
}

/**
 * Llamar cuando el sidebar del dock se colapsa (por cualquier razón):
 * ocultamos el BrowserView pero conservamos las pestañas.
 */
function onDockSidebarCollapsed() {
  if (!modeActive) return;
  modeActive = false;
  detachAllFromDock();
  broadcastState();
}

/**
 * Ajusta dónde debe pintarse el BrowserView activo dentro del dock.
 * El renderer del dock lo llama cada vez que cambia el tamaño del viewport.
 * @param {{x: number, y: number, width: number, height: number} | null} bounds
 */
function setViewportBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') {
    viewportBounds = null;
    return;
  }
  viewportBounds = {
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Number(bounds.width) || 0,
    height: Number(bounds.height) || 0,
  };
  layoutActiveView();
}

function selectTab(tabId) {
  if (!tabId || !tabs.has(tabId)) return false;
  activeTabId = tabId;
  if (modeActive) attachActiveViewOnly();
  broadcastState();
  return true;
}

function closeTab(tabId) {
  if (!tabId || !tabs.has(tabId)) return false;
  const wasActive = activeTabId === tabId;
  destroyTabView(tabId);

  if (wasActive) {
    activeTabId = tabs.size ? [...tabs.keys()][tabs.size - 1] : null;
  }

  if (tabs.size === 0) {
    modeActive = false;
    detachAllFromDock();
    broadcastState();
    if (typeof collapseDockHook === 'function') {
      try {
        collapseDockHook();
      } catch {
        /* noop */
      }
    }
    return true;
  }

  if (modeActive) attachActiveViewOnly();
  broadcastState();
  return true;
}

function activeTabWebContents() {
  if (!activeTabId) return null;
  const tab = tabs.get(activeTabId);
  if (!tab) return null;
  const wc = tab.view.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

function navigateActiveTo(url) {
  const wc = activeTabWebContents();
  if (!wc) return false;
  let target = String(url || '').trim();
  if (!target) return false;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    if (target.includes(' ') || !target.includes('.')) {
      target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
    } else {
      target = `https://${target}`;
    }
  }
  wc.loadURL(target).catch(() => {});
  return true;
}

function goBackActive() {
  const wc = activeTabWebContents();
  if (!wc) return false;
  try {
    if (wc.canGoBack()) wc.goBack();
  } catch {
    return false;
  }
  return true;
}

function goForwardActive() {
  const wc = activeTabWebContents();
  if (!wc) return false;
  try {
    if (wc.canGoForward()) wc.goForward();
  } catch {
    return false;
  }
  return true;
}

function reloadActive() {
  const wc = activeTabWebContents();
  if (!wc) return false;
  try {
    wc.reload();
  } catch {
    return false;
  }
  return true;
}

function closeAndClearAll() {
  modeActive = false;
  detachAllFromDock();
  for (const id of [...tabs.keys()]) destroyTabView(id);
  activeTabId = null;
  viewportBounds = null;
}

function isModeActive() {
  return modeActive;
}

function hasAnyTabs() {
  return tabs.size > 0;
}

/**
 * Registra los hooks que permiten al módulo pedir al resto del main
 * expandir/colapsar el dock cuando sea necesario.
 * @param {{ expandDock?: () => void, collapseDock?: () => void }} hooks
 */
function configureHooks(hooks) {
  if (!hooks || typeof hooks !== 'object') return;
  if (typeof hooks.expandDock === 'function') expandDockHook = hooks.expandDock;
  if (typeof hooks.collapseDock === 'function') collapseDockHook = hooks.collapseDock;
}

function registerLooseNavIpc() {
  const channels = [
    'loose-nav-open',
    'loose-nav-close',
    'loose-nav-select-tab',
    'loose-nav-close-tab',
    'loose-nav-new-tab',
    'loose-nav-navigate',
    'loose-nav-back',
    'loose-nav-forward',
    'loose-nav-reload',
    'loose-nav-open-external',
    'loose-nav-get-state',
    'loose-nav-set-viewport-bounds',
  ];
  for (const ch of channels) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* noop */
    }
  }

  ipcMain.handle('loose-nav-open', async () => {
    await enterLooseNavMode();
    return true;
  });

  ipcMain.handle('loose-nav-close', () => {
    exitLooseNavMode({ collapseDock: false });
    return true;
  });

  ipcMain.handle('loose-nav-select-tab', (_e, tabId) => selectTab(String(tabId || '')));
  ipcMain.handle('loose-nav-close-tab', (_e, tabId) => closeTab(String(tabId || '')));
  ipcMain.handle('loose-nav-new-tab', async (_e, payload) => {
    const target =
      payload && typeof payload === 'object' && typeof payload.url === 'string' && payload.url.trim()
        ? payload.url.trim()
        : LOOSE_NAV_NEW_TAB_URL;
    await openTabFromUrl(target);
    return true;
  });

  ipcMain.handle('loose-nav-navigate', (_e, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : String(payload || '');
    return navigateActiveTo(url);
  });

  ipcMain.handle('loose-nav-back', () => goBackActive());
  ipcMain.handle('loose-nav-forward', () => goForwardActive());
  ipcMain.handle('loose-nav-reload', () => reloadActive());

  ipcMain.handle('loose-nav-open-external', async (_e, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : String(payload || '');
    if (!url) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('loose-nav-get-state', () => buildStatePayload());

  ipcMain.handle('loose-nav-set-viewport-bounds', (_e, payload) => {
    setViewportBounds(payload);
    return true;
  });
}

module.exports = {
  enterLooseNavMode,
  exitLooseNavMode,
  openTabFromUrl,
  onDockSidebarCollapsed,
  setViewportBounds,
  isModeActive,
  hasAnyTabs,
  closeAndClearAll,
  registerLooseNavIpc,
  configureHooks,
};

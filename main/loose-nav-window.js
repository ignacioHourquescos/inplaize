'use strict';

/**
 * Navegación suelta: pestañas dinámicas que viven dentro de la ventana del dock,
 * justo debajo de la franja de iconos. El BrowserView se reposiciona usando
 * las coordenadas que el renderer del dock envía por IPC (`loose-nav-set-viewport-bounds`).
 */

const { BrowserView, shell, ipcMain } = require('electron');
const { LOOSE_NAV_NEW_TAB_URL } = require('./constants');
const { getDockWindow } = require('./dock-window-bridge');
const { setEmbeddedPageBackground } = require('./embedded-page-background');
const { applyChromeIdentityToPartition } = require('./chrome-identity');
const { isLoopbackHost, withScheme } = require('./load-web-url');
const browseProfiles = require('./browse-profiles');

/**
 * @typedef {{
 *   id: string,
 *   view: Electron.BrowserView,
 *   partition: string,
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
/** Última pestaña usada en cada sesión, para volver a ella desde el riel. */
/** @type {Map<string, string>} */
const lastTabBySession = new Map();
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

/** Cuenta con la que arranca una pestaña nueva si el usuario no elige otra. */
function defaultPartition() {
  return browseProfiles.defaultPartition();
}

/**
 * @type {{
 *   at: number,
 *   labels: Map<string, string>,
 *   defaultPartition: string,
 *   rail: ReturnType<typeof browseProfiles.railEntries>,
 * } | null}
 */
let profilesCache = null;

/** Los eventos de carga emiten estado muchas veces por segundo; los accesos salen de disco. */
function cachedProfiles() {
  if (!profilesCache || Date.now() - profilesCache.at > 3000) {
    profilesCache = {
      at: Date.now(),
      labels: new Map(),
      defaultPartition: browseProfiles.defaultPartition(),
      rail: browseProfiles.railEntries(),
    };
  }
  return profilesCache;
}

function refreshProfilesInBackground() {
  browseProfiles
    .refreshAccounts()
    .then(() => {
      profilesCache = null;
      broadcastState();
    })
    .catch(() => {});
}

function buildStatePayload() {
  const cache = cachedProfiles();
  const labelOf = (partition) => {
    if (!cache.labels.has(partition)) cache.labels.set(partition, browseProfiles.labelFor(partition));
    return cache.labels.get(partition);
  };
  const fallback = cache.defaultPartition;
  const items = [];
  /** @type {Record<string, number>} */
  const tabCounts = {};
  for (const tab of tabs.values()) {
    tabCounts[tab.partition] = (tabCounts[tab.partition] || 0) + 1;
    items.push({
      id: tab.id,
      partition: tab.partition,
      profileLabel: labelOf(tab.partition),
      profileAvatar: browseProfiles.avatarFor(tab.partition),
      isDefaultProfile: tab.partition === fallback,
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
  const activePartition = active ? active.partition : fallback;
  // Sesiones sin cuenta de Google (sin sesión, accesos) también van al riel si tienen pestañas.
  const railAccounts = [...cache.rail.accounts];
  const extra = new Set(Object.keys(tabCounts));
  extra.add(activePartition);
  for (const a of railAccounts) extra.delete(a.partition);
  for (const partition of extra) {
    railAccounts.push({
      partition,
      email: '',
      name: labelOf(partition),
      avatar: browseProfiles.avatarFor(partition),
    });
  }
  return {
    active: modeActive,
    tabs: items,
    tabCounts,
    activeTabId,
    activeUrl: active ? active.url || '' : '',
    activeCanGoBack: !!(active && active.canGoBack),
    activeCanGoForward: !!(active && active.canGoForward),
    activeLoading: !!(active && active.loading),
    accounts: { accounts: railAccounts, chrome: cache.rail.chrome },
    activePartition,
    activeProfile: {
      partition: activePartition,
      label: labelOf(activePartition),
      avatar: browseProfiles.avatarFor(activePartition),
    },
    defaultProfile: {
      partition: fallback,
      label: labelOf(fallback),
      avatar: browseProfiles.avatarFor(fallback),
    },
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
    require('./menu-overlay').raise(dock);
  } catch {
    /* noop */
  }
}

let urlPromptOpen = false;

function setUrlPromptOpen(open) {
  urlPromptOpen = open === true;
  if (urlPromptOpen) detachAllFromDock();
  else if (modeActive) attachActiveViewOnly();
}

function attachActiveViewOnly() {
  const dock = getDockWindow();
  if (!dock) return;
  detachAllFromDock();
  if (urlPromptOpen || !modeActive || !activeTabId) return;
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
      openTabFromUrl(url, { background, partition: tab.partition }).catch(() => {});
    });
    return { action: 'deny' };
  });

  /** El foco suele estar en la página: los atajos de la barra se atrapan acá. */
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    let action = '';
    if ((mod && key === 'l') || (input.alt && key === 'd') || key === 'f6') action = 'edit-address';
    else if (mod && key === 't') action = 'new-tab';
    else if (mod && key === 'w') action = 'close-tab';
    if (!action) return;
    event.preventDefault();
    if (action === 'close-tab') {
      closeTab(tab.id);
      return;
    }
    sendShortcutToDock(action);
  });
}

/** @param {'edit-address' | 'new-tab'} action */
function sendShortcutToDock(action) {
  const dock = getDockWindow();
  if (!dock) return;
  try {
    dock.webContents.focus();
    dock.webContents.send('loose-nav-shortcut', action);
  } catch {
    /* noop */
  }
}

/** @param {string} partition */
function createLooseView(partition) {
  applyChromeIdentityToPartition(partition);
  try {
    require('./downloads-manager').registerDownloadsForPartition(partition);
  } catch {
    /* descargas centralizadas: no crítico */
  }
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition,
    },
  });
  setEmbeddedPageBackground(view);
  return view;
}

/**
 * @param {LooseTab} tab
 * @param {string} url
 */
function wireTab(tab, url) {
  attachTabEvents(tab);
  try {
    require('./session-router').attachLoginSessionOffer(
      tab.view.webContents,
      tab.partition,
      () => getDockWindow(),
      url
    );
  } catch {
    /* el login sigue mostrándose si el aviso de usuario no se pudo enganchar */
  }
}

/**
 * Crea una pestaña y opcionalmente la activa. Si el modo está activo,
 * se ajusta el BrowserView inmediatamente.
 * @param {string} url
 * @param {{ background?: boolean, activateMode?: boolean, partition?: string }} [opts]
 * @returns {Promise<string>} id de la pestaña creada
 */
async function openTabFromUrl(url, opts = {}) {
  const partition = (typeof opts.partition === 'string' && opts.partition) || defaultPartition();
  const view = createLooseView(partition);

  const id = nextTabId();
  /** @type {LooseTab} */
  const tab = {
    id,
    view,
    partition,
    title: 'Cargando…',
    url: String(url || ''),
    favicon: '',
    loading: true,
    canGoBack: false,
    canGoForward: false,
  };
  insertTab(id, tab);
  wireTab(tab, url);

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
    setActiveTab(id);
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

/** @param {string | null} id */
function setActiveTab(id) {
  activeTabId = id;
  const tab = id ? tabs.get(id) : null;
  if (tab) lastTabBySession.set(tab.partition, tab.id);
}

/** @param {string} partition */
function tabIdsOfSession(partition) {
  return [...tabs.values()].filter((t) => t.partition === partition).map((t) => t.id);
}

/**
 * Cada sesión tiene sus pestañas: entrar a una vuelve a la última que se usó
 * ahí o, si no tiene, abre una nueva. La sesión elegida pasa a ser la predeterminada.
 * @param {string} partition
 */
async function switchToSession(partition) {
  if (!partition) return false;
  browseProfiles.setDefaultPartition(partition);
  profilesCache = null;
  const ids = tabIdsOfSession(partition);
  if (!ids.length) {
    await openTabFromUrl(LOOSE_NAV_NEW_TAB_URL, { partition });
    return true;
  }
  const last = lastTabBySession.get(partition);
  return selectTab(last && ids.includes(last) ? last : ids[ids.length - 1]);
}

/**
 * Entrada pública cuando el usuario pulsa el acceso de “Navegación suelta” en el dock.
 * Si no hay pestañas abiertas, crea una con la URL inicial.
 */
async function enterLooseNavMode() {
  modeActive = true;
  refreshProfilesInBackground();
  if (typeof expandDockHook === 'function') {
    try {
      expandDockHook();
    } catch {
      /* noop */
    }
  }
  try {
    require('./menu-overlay').preload(getDockWindow());
  } catch {
    /* noop */
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
  try {
    require('./menu-overlay').dismiss(getDockWindow());
  } catch {
    /* noop */
  }
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
  setActiveTab(tabId);
  if (modeActive) attachActiveViewOnly();
  broadcastState();
  return true;
}

/** Las pestañas nuevas van a la derecha, junto al "+", como en Chrome. */
function insertTab(id, tab) {
  tabs.set(id, tab);
}

function closeTab(tabId) {
  if (!tabId || !tabs.has(tabId)) return false;
  const partition = tabs.get(tabId).partition;
  const idx = [...tabs.keys()].indexOf(tabId);
  const sessionIdx = tabIdsOfSession(partition).indexOf(tabId);
  const wasActive = activeTabId === tabId;
  destroyTabView(tabId);
  if (lastTabBySession.get(partition) === tabId) lastTabBySession.delete(partition);

  if (wasActive) {
    // Primero la vecina de la misma sesión; si la sesión quedó vacía, cualquier otra.
    const sameSession = tabIdsOfSession(partition);
    const remaining = [...tabs.keys()];
    setActiveTab(
      sameSession[sessionIdx] || sameSession[sessionIdx - 1] || remaining[idx] || remaining[idx - 1] || null
    );
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

function googleSearchUrl(text) {
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/**
 * Lo que escribe el usuario en la barra: dirección o búsqueda.
 * `localhost:3000` y `192.168.0.10/x` son direcciones; `que es un dns` o `react`, búsquedas.
 * @param {string} raw
 */
function normalizeNavInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(about|data|mailto|view-source):/i.test(text)) return text;
  if (/\s/.test(text)) return googleSearchUrl(text);
  const host = text.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^[^@]*@/, '');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:]+\]$/i.test(host);
  const hasTld = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}$/i.test(host);
  if (isLoopbackHost(host) || isIp || hasTld) return withScheme(text);
  return googleSearchUrl(text);
}

function navigateActiveTo(url) {
  const wc = activeTabWebContents();
  if (!wc) return false;
  const target = normalizeNavInput(url);
  if (!target) return false;
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

function reloadTab(tabId) {
  const id = tabId && tabs.has(String(tabId)) ? String(tabId) : activeTabId;
  if (!id) return false;
  const tab = tabs.get(id);
  if (!tab) return false;
  const wc = tab.view.webContents;
  if (!wc || wc.isDestroyed()) return false;
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
  lastTabBySession.clear();
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
    'loose-nav-pick-profile',
    'loose-nav-use-account',
  ];
  for (const ch of channels) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* noop */
    }
  }

  setTimeout(refreshProfilesInBackground, 5000);

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
    const p = payload && typeof payload === 'object' ? payload : {};
    const raw = typeof p.url === 'string' ? p.url.trim() : '';
    const target = raw ? normalizeNavInput(raw) : LOOSE_NAV_NEW_TAB_URL;
    if (!target) return false;
    const picked = typeof p.partition === 'string' && p.partition ? p.partition : '';
    const current = activeTabId && tabs.get(activeTabId);
    await openTabFromUrl(target, { partition: picked || (current && current.partition) || defaultPartition() });
    return true;
  });

  ipcMain.handle('loose-nav-use-account', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    let partition = typeof p.partition === 'string' ? p.partition : '';
    if (!partition && typeof p.chromeDirectory === 'string' && p.chromeDirectory) {
      partition = (await browseProfiles.importChromeByDirectory(getDockWindow(), p.chromeDirectory)) || '';
      profilesCache = null;
    }
    if (!partition) {
      broadcastState();
      return false;
    }
    return switchToSession(partition);
  });

  ipcMain.handle('loose-nav-pick-profile', async () => {
    const partition = await browseProfiles.pickProfile(getDockWindow());
    profilesCache = null;
    broadcastState();
    if (!partition) return null;
    return browseProfiles.profileFor(partition);
  });

  ipcMain.handle('loose-nav-navigate', (_e, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : String(payload || '');
    return navigateActiveTo(url);
  });

  ipcMain.handle('loose-nav-back', () => goBackActive());
  ipcMain.handle('loose-nav-forward', () => goForwardActive());
  ipcMain.handle('loose-nav-reload', (_e, tabId) => reloadTab(tabId == null ? '' : String(tabId)));

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
  setUrlPromptOpen,
};

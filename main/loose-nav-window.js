'use strict';

/**
 * Navegación suelta: pestañas dinámicas que viven dentro de la ventana del dock,
 * justo debajo de la franja de iconos. El BrowserView se reposiciona usando
 * las coordenadas que el renderer del dock envía por IPC (`loose-nav-set-viewport-bounds`).
 */

const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserView, Menu, nativeImage, shell, ipcMain } = require('electron');
const { LOOSE_NAV_NEW_TAB_URL } = require('./constants');
const { getDockWindow } = require('./dock-window-bridge');
const { setEmbeddedPageBackground } = require('./embedded-page-background');
const { applyChromeIdentityToPartition } = require('./chrome-identity');
const { isLoopbackHost, withScheme } = require('./load-web-url');
const browseProfiles = require('./browse-profiles');
const historyStore = require('./history-store');
const { popupPageMenu, attachPageShortcuts, findInPage, stopFindInPage } = require('./page-menu');
const passwordManager = require('./password-manager');

/**
 * Registra una visita en el historial de la app (alimenta las sugerencias de la
 * barra de direcciones). "Sin sesión" (incógnito) no se registra.
 * @param {string} url @param {Electron.WebContents} [wc]
 */
function recordHistoryVisit(url, wc) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return;
  try {
    let title = '';
    try {
      title = wc && !wc.isDestroyed() ? wc.getTitle() : '';
    } catch {
      title = '';
    }
    historyStore.record(u, title);
  } catch {
    /* noop */
  }
}

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
 *   lastActiveAt: number,
 *   sleeping: boolean,
 *   pinned: boolean,
 *   freshLogin?: boolean,
 * }} LooseTab
 */

/** @type {Map<string, LooseTab>} */
const tabs = new Map();
/** Sitios silenciados con "Silenciar sitio": aplica a todas sus pestañas, también las nuevas. */
/** @type {Set<string>} */
const mutedSites = new Set();
const CLOSED_TABS_MAX = 10;
/** Cerradas recientemente, la última primero. */
/** @type {Array<{ url: string, title: string, partition: string }>} */
const closedTabs = [];
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

/** @type {ReturnType<typeof setTimeout> | null} */
let accountRefreshTimer = null;

/**
 * Tras iniciar sesión en Google en una sesión que todavía no tiene cuenta,
 * se vuelve a leer para que el perfil aparezca en el riel con su foto.
 * @param {LooseTab} tab
 */
function maybeRefreshAccountsAfterLogin(tab) {
  if (tab.partition === browseProfiles.guestPartition()) return;
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch {
    return;
  }
  if (!/(^|\.)google\.com$/i.test(host)) return;
  if (cachedProfiles().rail.accounts.some((a) => a.partition === tab.partition && a.email)) return;
  if (accountRefreshTimer) clearTimeout(accountRefreshTimer);
  accountRefreshTimer = setTimeout(() => {
    accountRefreshTimer = null;
    refreshProfilesInBackground();
  }, 1500);
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
    const wc = tab.view.webContents;
    const alive = !tab.sleeping && !!wc && !wc.isDestroyed();
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
      pinned: !!tab.pinned,
      audible: alive && wc.isCurrentlyAudible(),
      muted: mutedSites.has(siteKeyOf(tab)),
    });
  }
  const active = activeTabId ? tabs.get(activeTabId) : null;
  const activePartition = active ? active.partition : fallback;
  // Sesiones sin cuenta de Google (sin sesión, accesos) también van al riel si tienen pestañas.
  const railAccounts = [...cache.rail.accounts];
  const extra = new Set(Object.keys(tabCounts));
  extra.add(activePartition);
  extra.add(fallback);
  for (const a of railAccounts) extra.delete(a.partition);
  for (const partition of extra) {
    railAccounts.push({
      partition,
      email: '',
      name: labelOf(partition),
      avatar: browseProfiles.avatarFor(partition),
    });
  }
  const order = browseProfiles.profileOrder();
  if (order.length) {
    const rank = (partition) => {
      const i = order.indexOf(partition);
      return i < 0 ? order.length : i;
    };
    railAccounts.sort((a, b) => rank(a.partition) - rank(b.partition));
  } else {
    const defaultIdx = railAccounts.findIndex((a) => a.partition === fallback);
    if (defaultIdx > 0) railAccounts.unshift(...railAccounts.splice(defaultIdx, 1));
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

/**
 * Para abrir un modal HTML "sobre" la página: se saca una foto de la pestaña
 * activa (el dock la pone de fondo) y se despega la vista nativa, que si no lo tapa.
 * @param {boolean} cover
 * @returns {Promise<string>} data URL de la foto, o '' si no hay página
 */
async function coverActivePage(cover) {
  if (!cover) {
    setUrlPromptOpen(false);
    return '';
  }
  let shot = '';
  const wc = activeTabWebContents();
  if (wc && modeActive) {
    try {
      shot = (await wc.capturePage()).toDataURL();
    } catch {
      shot = '';
    }
  }
  setUrlPromptOpen(true);
  return shot;
}

function attachActiveViewOnly() {
  const dock = getDockWindow();
  if (!dock) return;
  detachAllFromDock();
  if (urlPromptOpen || !modeActive || !activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  if (tab.sleeping) wakeTab(tab);
  try {
    dock.addBrowserView(tab.view);
  } catch {
    return;
  }
  layoutActiveView();
}

function tabInUse(tab) {
  return modeActive && tab.id === activeTabId;
}

/**
 * Libera el proceso de una pestaña que no se ve; se recrea al volver a mostrarla.
 * @param {LooseTab} tab
 */
function sleepTab(tab) {
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
    if (wc && !wc.isDestroyed()) {
      tab.url = wc.getURL() || tab.url;
      wc.destroy();
    }
  } catch {
    /* noop */
  }
  tab.sleeping = true;
  tab.loading = false;
}

/** @param {LooseTab} tab */
function wakeTab(tab) {
  tab.sleeping = false;
  tab.lastActiveAt = Date.now();
  tab.view = createLooseView(tab.partition);
  wireTab(tab, tab.url);
  tab.view.webContents.loadURL(tab.url || LOOSE_NAV_NEW_TAB_URL).catch(() => {});
}

/**
 * @param {number} idleMs
 * @returns {number} pestañas puestas en reposo
 */
function sleepIdleTabs(idleMs) {
  const now = Date.now();
  let count = 0;
  for (const tab of tabs.values()) {
    if (tab.sleeping || tabInUse(tab) || now - tab.lastActiveAt < idleMs) continue;
    const wc = tab.view.webContents;
    try {
      if (!wc || wc.isDestroyed() || wc.isCurrentlyAudible()) continue;
    } catch {
      continue;
    }
    sleepTab(tab);
    count += 1;
  }
  return count;
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

/** @param {LooseTab} tab */
function siteKeyOf(tab) {
  try {
    const { protocol, host } = new URL(tab.url);
    if ((protocol === 'http:' || protocol === 'https:') && host) return host;
  } catch {
    /* sin URL válida: la pestaña es su propio "sitio" */
  }
  return `tab:${tab.id}`;
}

/** @param {LooseTab} tab */
function applySiteMute(tab) {
  const wc = tab.view.webContents;
  if (tab.sleeping || !wc || wc.isDestroyed()) return;
  wc.setAudioMuted(mutedSites.has(siteKeyOf(tab)));
}

function attachTabEvents(tab) {
  const wc = tab.view.webContents;

  wc.on('audio-state-changed', () => broadcastState());

  wc.on('page-title-updated', (_e, title) => {
    tab.title = String(title || '');
    if (tab.url && !/browse-guest/.test(String(tab.partition || ''))) {
      try {
        historyStore.record(tab.url, tab.title);
      } catch {
        /* noop */
      }
    }
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
      if (tab.title === 'Cargando…') tab.title = wc.getTitle() || tab.url;
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
    applySiteMute(tab);
    if (!/browse-guest/.test(String(tab.partition || ''))) recordHistoryVisit(tab.url, wc);
    maybeRefreshAccountsAfterLogin(tab);
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
    else if (mod && key === 'w') action = 'close-tab';
    else if ((mod && key === 'r') || key === 'f5') action = 'reload';
    else if (mod && input.shift && key === 't') action = 'reopen-tab';
    if (!action) return;
    event.preventDefault();
    if (action === 'close-tab') {
      closeTab(tab.id);
      return;
    }
    if (action === 'reopen-tab') {
      reopenClosedTab().catch(() => {});
      return;
    }
    if (action === 'reload') {
      reloadTab(tab.id);
      return;
    }
    sendShortcutToDock(action);
  });

  attachPageShortcuts(wc, pageMenuContext);
}

/** @type {import('./page-menu').PageMenuContext} */
const pageMenuContext = {
  get host() {
    return getDockWindow();
  },
  activeWebContents: () => activeTabWebContents(),
  openTab: (url, opts = {}) => {
    const current = activeTabId && tabs.get(activeTabId);
    return openTabFromUrl(url, {
      partition: (current && current.partition) || defaultPartition(),
      loadOptions: opts.loadOptions,
    });
  },
  newTab: () => sendShortcutToDock('new-tab'),
  openIncognitoTab: () => {
    openTabFromUrl(LOOSE_NAV_NEW_TAB_URL, { partition: browseProfiles.guestPartition() }).catch(() => {});
  },
  profileMenu: () => profileMenuItem(),
  recentlyClosed: () => closedTabs.map((t) => ({ title: t.title, url: t.url })),
  reopenClosed: (index) => {
    reopenClosedTab(index).catch(() => {});
  },
  addToShortcuts: (wc) => {
    pageMenuContext.sendToChrome('add-shortcut', { url: wc.getURL(), title: wc.getTitle() });
  },
  openPasswordManager: () => passwordManager.openPasswordManager(getDockWindow()),
  passwordSettings: () => passwordManager.settings(),
  setPasswordSettings: (patch) => passwordManager.updateSettings(patch),
  openHelp: () => {
    const manual = path.join(app.getAppPath(), 'landing', 'manual', 'index.html');
    pageMenuContext.openTab(pathToFileURL(manual).href).catch(() => {});
  },
  sendToChrome: (command, payload) => {
    const dock = getDockWindow();
    if (!dock) return;
    try {
      if (command === 'find-open') dock.webContents.focus();
      dock.webContents.send('loose-nav-page-command', { command, payload: payload ?? null });
    } catch {
      /* noop */
    }
  },
};

/** @param {'edit-address' | 'new-tab' | 'exit-profiles-edit'} action */
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
      preload: passwordManager.PAGE_PRELOAD,
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
  // Una cuenta nueva arranca vacía a propósito: no se ofrece copiar otra sesión.
  if (tab.freshLogin) return;
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
 * @param {{ background?: boolean, activateMode?: boolean, partition?: string, loadOptions?: Electron.LoadURLOptions, afterId?: string, freshLogin?: boolean }} [opts]
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
    lastActiveAt: Date.now(),
    sleeping: false,
    pinned: false,
    freshLogin: opts.freshLogin === true,
  };
  insertTab(id, tab, opts.afterId);
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
    await view.webContents.loadURL(url || LOOSE_NAV_NEW_TAB_URL, opts.loadOptions);
  } catch {
    /* la página puede fallar, la pestaña queda igualmente */
  }

  return id;
}

/** @param {string | null} id */
function setActiveTab(id) {
  const previous = activeTabId ? tabs.get(activeTabId) : null;
  if (previous) previous.lastActiveAt = Date.now();
  activeTabId = id;
  const tab = id ? tabs.get(id) : null;
  if (tab) {
    tab.lastActiveAt = Date.now();
    lastTabBySession.set(tab.partition, tab.id);
  }
}

/** Al ocultar la navegación, la pestaña que se veía empieza a contar como inactiva desde ahora. */
function stampActiveTab() {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  if (tab) tab.lastActiveAt = Date.now();
}

/** @param {string} partition */
function tabIdsOfSession(partition) {
  return [...tabs.values()].filter((t) => t.partition === partition).map((t) => t.id);
}

/**
 * Cada sesión tiene sus pestañas: entrar a una vuelve a la última que se usó
 * ahí o, si no tiene, abre una nueva.
 * @param {string} partition
 */
async function switchToSession(partition) {
  if (!partition) return false;
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
  stampActiveTab();
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
  stampActiveTab();
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
/** Sin `afterId` va al final; con `afterId`, justo a la derecha de esa pestaña. */
function insertTab(id, tab, afterId) {
  const entries = [...tabs.entries()];
  const idx = afterId ? entries.findIndex(([key]) => key === afterId) : -1;
  if (idx < 0) entries.push([id, tab]);
  else entries.splice(idx + 1, 0, [id, tab]);
  setTabOrder(entries);
}

/** Las fijadas siempre van primero; entre sí y entre las demás se respeta el orden. */
/** @param {[string, LooseTab][]} entries */
function setTabOrder(entries) {
  const ordered = [...entries.filter(([, t]) => t.pinned), ...entries.filter(([, t]) => !t.pinned)];
  tabs.clear();
  for (const [key, value] of ordered) tabs.set(key, value);
}

/** @param {LooseTab} tab */
function rememberClosedTab(tab) {
  const wc = tab.view.webContents;
  let url = tab.url;
  try {
    if (!tab.sleeping && wc && !wc.isDestroyed()) url = wc.getURL() || url;
  } catch {
    /* noop */
  }
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  closedTabs.unshift({ url, title: tab.title || url, partition: tab.partition });
  closedTabs.length = Math.min(closedTabs.length, CLOSED_TABS_MAX);
}

/** @param {number} [index] 0 = la última que se cerró */
function reopenClosedTab(index = 0) {
  const [entry] = closedTabs.splice(index, 1);
  if (!entry) return Promise.resolve(false);
  return openTabFromUrl(entry.url, { partition: entry.partition }).then(() => true);
}

function closeTab(tabId) {
  if (!tabId || !tabs.has(tabId)) return false;
  rememberClosedTab(tabs.get(tabId));
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

/** Pestañas que se ven en la tira: las de la misma sesión, en orden. */
/** @param {LooseTab} tab */
function stripTabsOf(tab) {
  return [...tabs.values()].filter((t) => t.partition === tab.partition);
}

/** @param {LooseTab} tab */
function duplicateTab(tab) {
  return openTabFromUrl(tab.url || LOOSE_NAV_NEW_TAB_URL, { partition: tab.partition, afterId: tab.id });
}

/** @param {LooseTab} tab */
function newTabRightOf(tab) {
  return openTabFromUrl(LOOSE_NAV_NEW_TAB_URL, { partition: tab.partition, afterId: tab.id });
}

/** @param {LooseTab} tab */
function togglePinTab(tab) {
  tab.pinned = !tab.pinned;
  setTabOrder([...tabs.entries()]);
  broadcastState();
}

/** @param {LooseTab} tab */
function toggleMuteSite(tab) {
  const key = siteKeyOf(tab);
  if (mutedSites.has(key)) mutedSites.delete(key);
  else mutedSites.add(key);
  for (const t of tabs.values()) applySiteMute(t);
  broadcastState();
}

/** Como Chrome: las fijadas no se cierran con "Cerrar las demás". */
/** @param {LooseTab} tab */
function closeOtherTabs(tab) {
  selectTab(tab.id);
  for (const t of stripTabsOf(tab)) {
    if (t.id !== tab.id && !t.pinned) closeTab(t.id);
  }
}

/** @param {LooseTab} tab */
function closeTabsRightOf(tab) {
  const strip = stripTabsOf(tab);
  const right = strip.slice(strip.indexOf(tab) + 1);
  if (right.some((t) => t.id === activeTabId)) selectTab(tab.id);
  for (const t of right) closeTab(t.id);
}

/** @param {string} dataUrl */
function menuIcon(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return undefined;
  const img = nativeImage.createFromDataURL(dataUrl);
  return img.isEmpty() ? undefined : img.resize({ width: 16, height: 16, quality: 'best' });
}

/**
 * Fila del perfil en el menú de la página, como la de Chrome: el perfil de la
 * pestaña y, adentro, los demás para cambiar.
 * @returns {Electron.MenuItemConstructorOptions}
 */
function profileMenuItem() {
  const { rail } = cachedProfiles();
  const current = activeTabId ? tabs.get(activeTabId) : null;
  const activePartition = current ? current.partition : defaultPartition();
  const nameOf = (a) => (a.incognito ? `${a.name} (incógnito)` : a.name || a.email);
  const activeAccount = rail.accounts.find((a) => a.partition === activePartition);
  const activeName = activeAccount ? nameOf(activeAccount) : browseProfiles.labelFor(activePartition);
  const signedIn = !!(activeAccount && activeAccount.email);
  const escape = (text) => String(text || '').replace(/&/g, '&&');

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const submenu = rail.accounts.map((a) => ({
    label: escape(a.partition === activePartition ? `${nameOf(a)}   ✓` : nameOf(a)),
    icon: menuIcon(a.avatar),
    click: () => {
      useAccount({ partition: a.partition }).catch(() => {});
    },
  }));
  if (rail.chrome.length) {
    submenu.push({ type: 'separator' });
    for (const c of rail.chrome) {
      submenu.push({
        label: escape(`${c.email || c.name} · traer desde Chrome`),
        icon: menuIcon(c.avatar),
        click: () => {
          useAccount({ chromeDirectory: c.directory }).catch(() => {});
        },
      });
    }
  }
  submenu.push(
    { type: 'separator' },
    {
      label: 'Elegir perfil para pestañas nuevas…',
      click: () => {
        browseProfiles
          .pickProfile(getDockWindow())
          .then(() => {
            profilesCache = null;
            broadcastState();
          })
          .catch(() => {});
      },
    }
  );
  return {
    label: escape(signedIn ? `${activeName}   ·   Sesión iniciada` : activeName),
    icon: menuIcon(activeAccount && activeAccount.avatar),
    submenu,
  };
}

/**
 * Menú de la pestaña (clic derecho), con las opciones de Chrome que aplican acá.
 * @param {string} tabId
 * @param {{ x?: number, y?: number }} [at] coordenadas en la página de la franja
 */
function popupTabMenu(tabId, at = {}) {
  const dock = getDockWindow();
  const tab = tabs.get(tabId);
  if (!dock || !tab) return false;
  const strip = stripTabsOf(tab);
  const hasOthers = strip.some((t) => t.id !== tab.id && !t.pinned);
  const hasRight = strip.indexOf(tab) < strip.length - 1;
  const muted = mutedSites.has(siteKeyOf(tab));
  const accel = (accelerator) => ({ accelerator, registerAccelerator: false });
  const run = (fn) => () => {
    if (tabs.get(tab.id) === tab) Promise.resolve(fn(tab)).catch(() => {});
  };
  const menu = Menu.buildFromTemplate([
    { label: 'Nueva pestaña a la derecha', click: run(newTabRightOf) },
    { type: 'separator' },
    { label: 'Volver a cargar', ...accel('Ctrl+R'), click: run((t) => reloadTab(t.id)) },
    { label: 'Duplicar', click: run(duplicateTab) },
    { label: tab.pinned ? 'No fijar' : 'Fijar', click: run(togglePinTab) },
    { label: muted ? 'Activar sonido del sitio' : 'Silenciar sitio', click: run(toggleMuteSite) },
    { type: 'separator' },
    { label: 'Cerrar', ...accel('Ctrl+W'), click: run((t) => closeTab(t.id)) },
    { label: 'Cerrar las demás pestañas', enabled: hasOthers, click: run(closeOtherTabs) },
    { label: 'Cerrar pestañas a la derecha', enabled: hasRight, click: run(closeTabsRightOf) },
  ]);
  const opts = { window: dock };
  if (Number.isFinite(at.x) && Number.isFinite(at.y)) {
    opts.x = Math.round(at.x);
    opts.y = Math.round(at.y);
  }
  menu.popup(opts);
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

/** @param {unknown} payload partition o perfil de Chrome a traer */
async function resolveAccountTarget(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  let partition = typeof p.partition === 'string' ? p.partition : '';
  if (!partition && typeof p.chromeDirectory === 'string' && p.chromeDirectory) {
    partition = (await browseProfiles.importChromeByDirectory(getDockWindow(), p.chromeDirectory)) || '';
    profilesCache = null;
  }
  return partition;
}

/**
 * Quita un perfil del riel (o deja de ofrecer uno de Chrome) y cierra sus pestañas.
 * @param {unknown} payload
 */
async function removeProfile(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (typeof p.chromeDirectory === 'string' && p.chromeDirectory) {
    browseProfiles.hideChromeProfile(p.chromeDirectory);
    profilesCache = null;
    broadcastState();
    return true;
  }
  const partition = typeof p.partition === 'string' ? p.partition : '';
  if (!(await browseProfiles.removeProfile(getDockWindow(), partition))) return false;
  profilesCache = null;
  const ids = tabIdsOfSession(partition);
  if (ids.length && ids.length === tabs.size) {
    await openTabFromUrl(LOOSE_NAV_NEW_TAB_URL, { partition: defaultPartition() });
  }
  for (const id of ids) closeTab(id);
  for (let i = closedTabs.length - 1; i >= 0; i -= 1) {
    if (closedTabs[i].partition === partition) closedTabs.splice(i, 1);
  }
  lastTabBySession.delete(partition);
  broadcastState();
  return true;
}

/** @param {unknown} partitions orden nuevo del riel */
function reorderProfiles(partitions) {
  const list = Array.isArray(partitions) ? partitions.filter((x) => typeof x === 'string' && x) : [];
  browseProfiles.setProfileOrder(list);
  broadcastState();
  return true;
}

async function addGoogleAccount() {
  sendShortcutToDock('exit-profiles-edit');
  const { partition, url } = browseProfiles.createAccountPartition();
  profilesCache = null;
  await openTabFromUrl(url, { partition, freshLogin: true });
}

/** @param {string} partition */
function restoreProfile(partition) {
  browseProfiles.unhideProfile(partition);
  profilesCache = null;
  broadcastState();
}

/** @param {string} directory */
async function restoreChromeProfile(directory) {
  sendShortcutToDock('exit-profiles-edit');
  browseProfiles.unhideChromeProfile(directory);
  await useAccount({ chromeDirectory: directory });
}

/**
 * Menú del "+" del riel en modo edición: cuenta nueva o volver a mostrar las quitadas.
 * @param {{ x?: number, y?: number }} [at]
 */
function popupAddProfileMenu(at = {}) {
  const dock = getDockWindow();
  if (!dock) return false;
  const escape = (text) => String(text || '').replace(/&/g, '&&');
  const run = (fn) => () => {
    Promise.resolve(fn()).catch(() => {});
  };
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [{ label: 'Iniciar sesión con otra cuenta de Google…', click: run(addGoogleAccount) }];
  const hidden = browseProfiles.hiddenProfiles();
  const hiddenChrome = browseProfiles.hiddenChromeProfiles();
  if (hidden.length || hiddenChrome.length) {
    template.push({ type: 'separator' }, { label: 'Volver a mostrar', enabled: false });
    for (const h of hidden) {
      template.push({ label: escape(h.label), click: run(() => restoreProfile(h.partition)) });
    }
    for (const c of hiddenChrome) {
      template.push({ label: escape(`${c.label} · traer desde Chrome`), click: run(() => restoreChromeProfile(c.directory)) });
    }
  }
  const opts = { window: dock };
  if (Number.isFinite(at.x) && Number.isFinite(at.y)) {
    opts.x = Math.round(at.x);
    opts.y = Math.round(at.y);
  }
  Menu.buildFromTemplate(template).popup(opts);
  return true;
}

/** @param {unknown} payload */
async function useAccount(payload) {
  const partition = await resolveAccountTarget(payload);
  if (!partition) {
    broadcastState();
    return false;
  }
  return switchToSession(partition);
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
    'loose-nav-set-default-profile',
    'loose-nav-page-menu',
    'loose-nav-tab-menu',
    'loose-nav-toggle-mute',
    'loose-nav-reopen-closed',
    'loose-nav-find',
    'loose-nav-find-stop',
    'loose-nav-remove-profile',
    'loose-nav-reorder-profiles',
    'loose-nav-add-profile-menu',
    'loose-nav-cover-page',
  ];
  for (const ch of channels) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* noop */
    }
  }

  passwordManager.registerPasswordIpc({ host: () => getDockWindow() });
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
    await openTabFromUrl(target, {
      partition: picked || (current && current.partition) || defaultPartition(),
      afterId: p.nextToActive && current ? current.id : undefined,
    });
    return true;
  });

  ipcMain.handle('loose-nav-use-account', (_e, payload) => useAccount(payload));
  ipcMain.handle('loose-nav-remove-profile', (_e, payload) => removeProfile(payload));
  ipcMain.handle('loose-nav-cover-page', (_e, cover) => coverActivePage(cover === true));
  ipcMain.handle('loose-nav-reorder-profiles', (_e, partitions) => reorderProfiles(partitions));
  ipcMain.handle('loose-nav-add-profile-menu', (_e, at) =>
    popupAddProfileMenu(at && typeof at === 'object' ? at : {})
  );

  ipcMain.handle('loose-nav-set-default-profile', async (_e, payload) => {
    const partition = await resolveAccountTarget(payload);
    if (partition) browseProfiles.setDefaultPartition(partition);
    profilesCache = null;
    broadcastState();
    return !!partition;
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

  ipcMain.handle('loose-nav-page-menu', (_e, at) => {
    popupPageMenu(pageMenuContext, at && typeof at === 'object' ? at : {});
    return true;
  });
  ipcMain.handle('loose-nav-tab-menu', (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    return popupTabMenu(String(p.tabId || ''), p);
  });
  ipcMain.handle('loose-nav-reopen-closed', () => reopenClosedTab());
  ipcMain.handle('loose-nav-toggle-mute', (_e, tabId) => {
    const tab = tabs.get(String(tabId || ''));
    if (!tab) return false;
    toggleMuteSite(tab);
    return true;
  });
  ipcMain.handle('loose-nav-find', (_e, arg) =>
    findInPage(activeTabWebContents(), arg && typeof arg === 'object' ? arg : null)
  );
  ipcMain.handle('loose-nav-find-stop', () => stopFindInPage(activeTabWebContents()));

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
  sleepIdleTabs,
};

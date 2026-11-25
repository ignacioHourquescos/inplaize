'use strict';

const path = require('path');
const { BrowserWindow, BrowserView, WebContentsView, session, app, ipcMain } = require('electron');
const { APP_NAME, appIconFile, brandWindow } = require('./app-identity');
const { webMapKey, normalizeUrlKey } = require('./web-map-key');
const { loadShortcuts } = require('./shortcuts-store');
const { lockWindowZoom } = require('./lock-window-zoom');
const { setEmbeddedPageBackground } = require('./embedded-page-background');
const { loadWebContentsUrl, withScheme } = require('./load-web-url');
const {
  navSnapshot,
  goBack,
  goForward,
  attachWindowHistoryNav,
  attachViewHistoryNav,
  attachPageHistoryNav,
} = require('./page-history-nav');
const { popupPageMenu, attachPageShortcuts, findInPage, stopFindInPage } = require('./page-menu');
const { applyTabNavigation, pickPageFavicon } = require('./web-favicon');
/** Debe coincidir con --ud-chrome-strip-h en chrome-strip.css. */
const DETACHED_CHROME_H = 58;
/** Pestañas y dirección en una fila. Debe coincidir con --ud-chrome-search-h. */
const DETACHED_TABSTRIP_H = 48;
/** La dirección se esconde al scrollear, pero la fila no cambia de alto. */
const DETACHED_TABS_ONLY_H = 48;

const WEB_NOTIFICATION_FOCUS_PRELOAD = path.join(__dirname, 'web-notification-focus-preload.js');

function appRoot() {
  try {
    return app.getAppPath();
  } catch {
    return path.join(__dirname, '..');
  }
}

function iconFromShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return '';
  const icon = shortcut.icon;
  return typeof icon === 'string' ? icon.trim() : '';
}

function buildDetachedChromePayload(activeMapKey) {
  const { getOpenWebWindowKeys } = require('./open-shortcut');
  const openKeys = new Set(getOpenWebWindowKeys());
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
    if (s.type === 'workspace') {
      const members = (Array.isArray(s.members) ? s.members : []).map((member) => ({
        id: String(member.id),
        type: member.type || 'web',
        name: (member.name && String(member.name)) || '',
        icon: iconFromShortcut(member),
        iconInverted: member.iconInverted === true,
        url: typeof member.url === 'string' ? member.url : '',
        sessionId: typeof member.sessionId === 'string' ? member.sessionId : '',
      }));
      const workspaceKey = `workspace:${s.id}`;
      return {
        id: String(s.id),
        type: 'workspace',
        name,
        icon: '',
        iconInverted: false,
        members,
        mapKey: workspaceKey,
        isOpen: openKeys.has(workspaceKey),
        isActive: activeMapKey === workspaceKey,
        isFocusMember: false,
      };
    }
    if (s.type === 'web') {
      const mk = webMapKey(s);
      return {
        id: String(s.id),
        type: 'web',
        name,
        icon,
        iconInverted: s.iconInverted === true,
        mapKey: mk,
        isOpen: openKeys.has(mk),
        isActive: mk === activeMapKey,
        isFocusMember: memberSet.has(mk),
      };
    }
    return {
      id: String(s.id),
      type: 'app',
      name,
      icon,
      iconInverted: s.iconInverted === true,
      mapKey: null,
      isOpen: false,
      isActive: false,
      isFocusMember: false,
    };
  });
  return { items, focusMode: focusState };
}

function broadcastChromeToAllDetachedHosts() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed() || !w.__usualDeskDetachedChromeHost) continue;
    const own = w.__usualDeskDetachedOwnMapKey;
    try {
      w.webContents.send('detached-chrome', buildDetachedChromePayload(typeof own === 'string' ? own : ''));
    } catch {
      /* noop */
    }
  }
}

function broadcastTitleBadgeToDetachedHosts(shortcutId, count) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed() || !w.__usualDeskDetachedChromeHost) continue;
    try {
      w.webContents.send('detached-title-badge', { shortcutId, count });
    } catch {
      /* noop */
    }
  }
}

/**
 * Estado de pestañas de una ventana host (pestaña principal + sub-pestañas dinámicas).
 * La principal es un BrowserView (legacy); las sub-pestañas son WebContentsView,
 * que permite adoptar el webContents invitado que Electron crea para window.open.
 * @typedef {{
 *   id: string,
 *   view: Electron.BrowserView | Electron.WebContentsView,
 *   title: string,
 *   url: string,
 *   favicon: string,
 *   loading: boolean,
 *   isMain: boolean,
 * }} DetachedTab
 * @typedef {{
 *   partition: string,
 *   tabs: Map<string, DetachedTab>,
 *   order: string[],
 *   activeId: string,
 *   mainId: string,
 * }} DetachedTabState
 */

let subTabSequence = 0;
function nextSubTabId() {
  subTabSequence += 1;
  return `subtab-${Date.now().toString(36)}-${subTabSequence}`;
}

/**
 * @param {Electron.BrowserWindow} host
 * @returns {DetachedTabState | null}
 */
function tabStateOf(host) {
  if (!host || host.isDestroyed()) return null;
  const state = host.__usualDeskTabState;
  return state && typeof state === 'object' ? state : null;
}

function activeHostWebContents(host) {
  const state = tabStateOf(host);
  if (!state) return null;
  const tab = state.tabs.get(state.activeId);
  if (!tab || !tab.view) return null;
  const wc = tab.view.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

function sendHostNav(host) {
  if (!host || host.isDestroyed()) return;
  try {
    host.webContents.send('detached-nav', navSnapshot(activeHostWebContents(host)));
  } catch {
    /* noop */
  }
}

function navigateHost(host, dir) {
  const wc = activeHostWebContents(host);
  const ok = dir === 'back' ? goBack(wc) : goForward(wc);
  if (ok && wc && !wc.isDestroyed()) {
    try {
      wc.focus();
    } catch {
      /* noop */
    }
  }
  return ok;
}

/**
 * @param {Electron.BrowserWindow} host
 * @returns {import('./page-menu').PageMenuContext}
 */
function pageMenuContextFor(host) {
  if (!host.__usualDeskPageMenuCtx) {
    host.__usualDeskPageMenuCtx = {
      host,
      allowFullScreen: true,
      activeWebContents: () => activeHostWebContents(host),
      openTab: (url, opts = {}) => openSubTabInHost(host, url, opts),
      sendToChrome: (command, payload) => {
        if (host.isDestroyed()) return;
        try {
          if (command === 'find-open') host.webContents.focus();
          host.webContents.send('detached-page-command', { command, payload: payload ?? null });
        } catch {
          /* noop */
        }
      },
    };
  }
  return host.__usualDeskPageMenuCtx;
}

function reloadHostTab(host, tabId) {
  const state = tabStateOf(host);
  if (!state) return false;
  const id = tabId && state.tabs.has(String(tabId)) ? String(tabId) : state.activeId;
  if (!id) return false;
  const tab = state.tabs.get(id);
  if (!tab || !tab.view) return false;
  const wc = tab.view.webContents;
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.reload();
    return true;
  } catch {
    return false;
  }
}

/** Historial propio de cada pestaña (principal o sub-pestaña). */
function bindHostPageNav(host, tab) {
  if (!host || !tab || !tab.view) return;
  const wc = tab.view.webContents;
  attachViewHistoryNav(tab.view, host);
  attachPageHistoryNav(wc, host, {
    isActive: () => {
      const state = tabStateOf(host);
      return !!state && state.activeId === tab.id;
    },
    onChange: () => {
      const state = tabStateOf(host);
      if (!state || state.activeId !== tab.id) return;
      sendHostNav(host);
    },
  });
}

/** Con una sola pestaña no hay barra de solapas ni dirección: la página sube. */
function hostShowsTabChrome(host) {
  if (!host || host.__usualDeskEmbeddedDesktop) return false;
  const state = tabStateOf(host);
  if (!state) return false;
  return state.order.length > 1;
}

function hostSearchRowVisible(host) {
  if (!host || host.__usualDeskEmbeddedDesktop) return false;
  /* La cruz cerró la fila: la página sube aunque haya más de una pestaña. */
  if (host.__usualDeskNavRowHidden) return false;
  if (hostShowsTabChrome(host)) return true;
  return !!(host.__usualDeskSearchRevealed || host.__usualDeskUrlCompose || host.__usualDeskAddressPeek);
}

function chromeHeightFor(host) {
  /* Sin pestañas extra ni buscador pedido, la página pega a la franja de iconos. */
  if (!hostSearchRowVisible(host)) {
    return DETACHED_CHROME_H;
  }
  if (host && host.__usualDeskUrlBarHidden && hostShowsTabChrome(host)) {
    return DETACHED_CHROME_H + DETACHED_TABS_ONLY_H;
  }
  return DETACHED_CHROME_H + DETACHED_TABSTRIP_H;
}

/** La cruz ocultó la fila de pestañas. El BrowserView no debe reservar ese alto. */
function setNavRowHidden(host, hidden) {
  if (!host || host.isDestroyed() || !host.__usualDeskDetachedChromeHost) return;
  const next = hidden === true;
  if (!!host.__usualDeskNavRowHidden === next) {
    layoutActiveTabView(host);
    return;
  }
  host.__usualDeskNavRowHidden = next;
  layoutActiveTabView(host);
}

/** El renderer muestra u oculta la fila de búsqueda; el BrowserView debe seguir ese alto. */
function setSearchRevealed(host, on) {
  if (!host || host.isDestroyed() || !host.__usualDeskDetachedChromeHost) return;
  const next = on === true;
  if (!!host.__usualDeskSearchRevealed === next) {
    layoutActiveTabView(host);
    return;
  }
  host.__usualDeskSearchRevealed = next;
  if (next) host.__usualDeskUrlBarHidden = false;
  layoutActiveTabView(host);
}

/** Compose desde Buscar: foco en la omnibox (misma fila que las pestañas). */
function setUrlCompose(host, on) {
  if (!host || host.isDestroyed() || !host.__usualDeskDetachedChromeHost) return;
  const next = on === true;
  if (!!host.__usualDeskUrlCompose === next) return;
  host.__usualDeskUrlCompose = next;
  if (next) {
    host.__usualDeskUrlBarHidden = false;
    host.__usualDeskSearchRevealed = true;
  }
  try {
    host.webContents.send('detached-url-compose', next);
  } catch {
    /* cerrando */
  }
  layoutActiveTabView(host);
}

/** La dirección se queda visible: es la app fijada, no una pestaña de la fila. */
function setUrlBarHidden(host, hidden) {
  if (!host || host.isDestroyed() || !host.__usualDeskDetachedChromeHost) return;
  if (!host.__usualDeskUrlBarHidden) return;
  void hidden;
  host.__usualDeskUrlBarHidden = false;
  try {
    host.webContents.send('detached-url-bar', false);
  } catch {
    /* la ventana se está cerrando */
  }
  layoutActiveTabView(host);
}

/** Lo que se escribe en la barra: dirección o búsqueda de Google. */
function addressToUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/\s/.test(text)) return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  const host = text.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^[^@]*@/, '');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isLocal = host === 'localhost' || host.endsWith('.localhost') || isIp;
  if (isLocal || host.includes('.')) return withScheme(text);
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function setHostUrlPromptOpen(host, open) {
  if (!host || host.isDestroyed()) return;
  host.__usualDeskUrlPromptOpen = open === true;
  if (host.__usualDeskUrlPromptOpen) {
    const state = tabStateOf(host);
    if (!state) return;
    for (const tab of state.tabs.values()) detachTabView(host, tab);
    return;
  }
  attachActiveTabViewOnly(host);
}

function placeActiveTabView(host, tab, top) {
  const [w, h] = host.getContentSize();
  const y = Math.max(0, Math.round(top));
  try {
    tab.view.setBounds({
      x: 0,
      y,
      width: Math.max(0, w),
      height: Math.max(0, h - y),
    });
  } catch {
    /* noop */
  }
}

function layoutActiveTabView(host) {
  if (host && (host.__usualDeskUrlPromptOpen || host.__usualDeskEmbeddedDesktop)) return;
  const state = tabStateOf(host);
  if (!state) return;
  const tab = state.tabs.get(state.activeId);
  if (!tab) return;
  placeActiveTabView(host, tab, chromeHeightFor(host));
  // El alto real del buscador manda: si la página quedó encima, se corre.
  host.webContents
    .executeJavaScript(
      `(() => {
        const bar = document.getElementById('shortcut-browser');
        if (!bar || bar.hidden) return 0;
        const rect = bar.getBoundingClientRect();
        return rect.height > 0 ? Math.round(rect.bottom) : 0;
      })()`,
      true,
    )
    .then((measured) => {
      if (host.isDestroyed()) return;
      const live = tabStateOf(host);
      const current = live && live.tabs.get(live.activeId);
      if (!current || current.id !== tab.id) return;
      if (host.__usualDeskNavRowHidden) {
        placeActiveTabView(host, current, chromeHeightFor(host));
        return;
      }
      if (!measured) return;
      placeActiveTabView(host, current, measured);
    })
    .catch(() => {});
  try {
    require('./menu-overlay').raise(host);
  } catch {
    /* noop */
  }
}

function setHostMenuDrawerOpen(host, open, editMode) {
  if (!host || host.isDestroyed()) return;
  host.__usualDeskMenuDrawerOpen = open === true;
  require('./menu-overlay').setOpen(host, open === true, {
    editMode: editMode === true,
    source: 'host',
  });
}

/**
 * La principal (BrowserView) usa add/removeBrowserView; las sub-pestañas
 * (WebContentsView) van por host.contentView. Ambas terminan en la misma jerarquía.
 * @param {Electron.BrowserWindow} host
 * @param {DetachedTab} tab
 */
function attachTabView(host, tab) {
  try {
    if (tab.isMain) host.addBrowserView(tab.view);
    else host.contentView.addChildView(tab.view);
  } catch {
    /* noop */
  }
}

/**
 * @param {Electron.BrowserWindow} host
 * @param {DetachedTab} tab
 */
function detachTabView(host, tab) {
  try {
    if (tab.isMain) host.removeBrowserView(tab.view);
    else host.contentView.removeChildView(tab.view);
  } catch {
    /* noop */
  }
}

/**
 * Los invitados de window.open nacen con el viewport que pidió la página
 * (p. ej. Gmail pide ~800px) y lo conservan hasta un resize real: se verían
 * con bordes. Doble setBounds con 1px de diferencia fuerza el resize del renderer.
 * @param {Electron.BrowserWindow} host
 * @param {DetachedTab} tab
 */
function kickTabViewResize(host, tab) {
  if (!host || host.isDestroyed() || !tab) return;
  const [w, h] = host.getContentSize();
  const top = chromeHeightFor(host);
  try {
    tab.view.setBounds({ x: 0, y: top, width: Math.max(0, w - 1), height: Math.max(0, h - top) });
    tab.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
  } catch {
    /* noop */
  }
}

/** Solo la pestaña activa queda attachada a la ventana (mismo patrón que loose-nav). */
function attachActiveTabViewOnly(host) {
  const state = tabStateOf(host);
  if (!state) return;
  if (host && (host.__usualDeskEmbeddedDesktop || host.__usualDeskHibernated)) {
    for (const tab of state.tabs.values()) detachTabView(host, tab);
    return;
  }
  if (host && host.__usualDeskUrlPromptOpen) {
    for (const tab of state.tabs.values()) detachTabView(host, tab);
    return;
  }
  for (const tab of state.tabs.values()) {
    if (tab.id === state.activeId) continue;
    detachTabView(host, tab);
  }
  const active = state.tabs.get(state.activeId);
  if (!active) return;
  attachTabView(host, active);
  layoutActiveTabView(host);
  if (!active.isMain) kickTabViewResize(host, active);
}

function tabPartition(tab, state) {
  try {
    const wc = tab && tab.view && tab.view.webContents;
    if (wc && !wc.isDestroyed() && wc.session && wc.session.partition) return wc.session.partition;
  } catch {
    /* la pestaña puede estar cerrándose */
  }
  return (state && state.partition) || '';
}

/** `persist:id` → id. La sesión por defecto no se guarda como perfil. */
function sessionIdFromPartition(partition) {
  const value = String(partition || '');
  if (!value.startsWith('persist:')) return '';
  const id = value.slice('persist:'.length);
  if (!id || id === 'dock-default') return '';
  return id;
}

function pageIsPinned(url, sessionId) {
  const key = normalizeUrlKey(url);
  if (!key) return false;
  const session = String(sessionId || '');
  return loadShortcuts().some((item) => {
    const pages = item && item.type === 'workspace' && Array.isArray(item.members)
      ? item.members
      : [item];
    return pages.some((page) => page
      && page.type === 'web'
      && normalizeUrlKey(page.url || '') === key
      && String(page.sessionId || '') === session);
  });
}

function pinTitleFor(tab) {
  const title = String((tab && tab.title) || '').trim();
  if (title && title !== 'Cargando…' && title !== 'Pestaña') return title.slice(0, 60);
  try {
    return new URL(tab.url).hostname.replace(/^www\./, '').slice(0, 60);
  } catch {
    return '';
  }
}

function buildTabsPayload(host) {
  const state = tabStateOf(host);
  if (!state) return { tabs: [] };
  const tabs = state.order
    .map((id) => state.tabs.get(id))
    .filter(Boolean)
    .map((tab) => {
      const url = tab.url || '';
      const sessionId = sessionIdFromPartition(tabPartition(tab, state));
      const canPin = /^https?:\/\//i.test(url);
      return {
        id: tab.id,
        title: tab.title || tab.url || 'Pestaña',
        favicon: tab.favicon || '',
        loading: !!tab.loading,
        url,
        isMain: !!tab.isMain,
        isActive: tab.id === state.activeId,
        canPin,
        pinned: canPin && pageIsPinned(url, sessionId),
        sessionId,
        pinTitle: pinTitleFor(tab),
      };
    });
  return {
    tabs,
    embedded: !!(host && host.__usualDeskEmbeddedDesktop),
    addressPeek: !!(host && host.__usualDeskAddressPeek) && !hostShowsTabChrome(host),
  };
}

function broadcastTabsToHost(host) {
  if (!host || host.isDestroyed()) return;
  try {
    host.webContents.send('detached-tabs', buildTabsPayload(host));
  } catch {
    /* noop */
  }
}

/** Cambios en el nº de pestañas alteran la altura del chrome → recolocar y repintar. */
function refreshHostTabsUi(host) {
  if (host && host.__usualDeskAddressPeek && hostShowsTabChrome(host)) {
    host.__usualDeskAddressPeek = false;
  }
  if (host && !hostShowsTabChrome(host) && host.__usualDeskUrlBarHidden) {
    host.__usualDeskUrlBarHidden = false;
    try {
      host.webContents.send('detached-url-bar', false);
    } catch {
      /* la ventana se está cerrando */
    }
  }
  attachActiveTabViewOnly(host);
  broadcastTabsToHost(host);
  sendHostNav(host);
}

/**
 * @param {Electron.BrowserWindow} host
 * @param {DetachedTab} tab
 */
function attachSubTabEvents(host, tab) {
  const wc = tab.view.webContents;
  bindHostPageNav(host, tab);
  attachPageShortcuts(wc, pageMenuContextFor(host));

  wc.on('page-title-updated', (_e, title) => {
    tab.title = String(title || '');
    broadcastTabsToHost(host);
  });

  wc.on('page-favicon-updated', (_e, favicons) => {
    const picked = pickPageFavicon(favicons, tab.url);
    if (!picked || picked === tab.favicon) return;
    tab.favicon = picked;
    broadcastTabsToHost(host);
  });

  wc.on('did-start-loading', () => {
    tab.loading = true;
    broadcastTabsToHost(host);
  });

  const rememberSubPage = () => {
    let next = tab.url;
    try {
      next = wc.getURL() || tab.url;
    } catch {
      /* noop */
    }
    if (applyTabNavigation(tab, next)) broadcastTabsToHost(host);
  };
  wc.on('did-navigate', rememberSubPage);
  wc.on('did-navigate-in-page', rememberSubPage);
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    rememberSubPage();
    broadcastTabsToHost(host);
  });

  /** Ctrl+Click / target=_blank desde una sub-pestaña → otra sub-pestaña de la misma ventana. */
  wc.setWindowOpenHandler((details) => subTabWindowOpenResponse(host, details));

  /** La página puede autocerrarse (window.close, p. ej. popups de OAuth): quitar la pestaña. */
  wc.once('destroyed', () => {
    removeSubTabFromState(host, tab.id);
  });
}

/**
 * Saca la pestaña del estado y reajusta la activa. No destruye el webContents
 * (para eso está closeHostTab); se usa también cuando la página se autocierra.
 * @param {Electron.BrowserWindow} host
 * @param {string} tabId
 */
function removeSubTabFromState(host, tabId) {
  const state = tabStateOf(host);
  if (!state || !state.tabs.has(tabId) || tabId === state.mainId) return;
  const tab = state.tabs.get(tabId);
  detachTabView(host, tab);
  state.tabs.delete(tabId);
  const idx = state.order.indexOf(tabId);
  if (idx >= 0) state.order.splice(idx, 1);
  if (state.activeId === tabId) {
    const prev = idx > 0 ? state.order[idx - 1] : state.order[0];
    state.activeId = prev && state.tabs.has(prev) ? prev : state.mainId;
  }
  refreshHostTabsUi(host);
}

/**
 * Respuesta compartida al `window.open` de servicios y sub-pestañas: en lugar de
 * `deny` (que hace que la página crea que hay un bloqueador de popups), devolvemos
 * `allow` con un `createWindow` que entrega el webContents de una sub-pestaña
 * nueva en la misma ventana. Así el opener recibe un WindowProxy válido.
 * @param {Electron.BrowserWindow} host
 * @param {Electron.HandlerDetails} details
 * @returns {Electron.WindowOpenHandlerResponse}
 */
function subTabWindowOpenResponse(host, details) {
  const { url, disposition } = details || {};
  if (!url || /^chrome[-:]/i.test(url) || url.startsWith('about:blank')) {
    return { action: 'deny' };
  }
  // Ctrl+click llega como 'background-tab', pero acá el usuario quiere ir
  // directo a la pestaña nueva: solo dejamos en background los casos raros.
  const background = disposition === 'save-to-disk' || disposition === 'other';

  // Router de sesiones: si el dominio destino corresponde a otros accesos del
  // usuario (otra partition con su sesión), resolvemos de forma asíncrona y
  // abrimos la pestaña con esa partition. Solo aplica a links reales
  // (foreground/background-tab, que son noopener: el opener recibe null igual);
  // los popups con script ('new-window', p. ej. OAuth) necesitan mantener el
  // vínculo con el opener y jamás se redirigen.
  const state = tabStateOf(host);
  const openerPartition = state ? state.partition : '';
  const isLinkDisposition = disposition === 'foreground-tab' || disposition === 'background-tab';
  let mayRoute = false;
  let isAuth = false;
  try {
    const router = require('./session-router');
    isAuth = router.isAuthUrl(url);
    mayRoute = isLinkDisposition && !isAuth && router.mayRouteToOtherSession(url, openerPartition);
  } catch {
    mayRoute = false;
  }
  if (mayRoute) {
    setImmediate(async () => {
      let partition = null;
      try {
        partition = await require('./session-router').resolveTargetPartition(url, openerPartition, host);
      } catch {
        partition = null;
      }
      openSubTabInHost(host, url, { background, partition: partition || undefined }).catch(() => {});
    });
    return { action: 'deny' };
  }

  return {
    action: 'allow',
    createWindow: (options) => {
      // Electron ya creó el webContents invitado (options.webContents) y exige
      // que la "ventana" resultante lo use; lo adoptamos en la vista de la pestaña.
      // Con rel="noopener" (p. ej. links de WhatsApp Web) no hay invitado previo
      // y nadie carga la URL por nosotros: la cargamos explícitamente.
      const guest = options && options.webContents ? options.webContents : null;
      const tab = createSubTabInHost(host, url, { background, existingWebContents: guest });
      if (!guest) {
        tab.view.webContents.loadURL(url).catch(() => {});
      }
      return tab.view.webContents;
    },
  };
}

/**
 * Crea la sub-pestaña de forma síncrona, sin cargar la URL: quien llama decide si
 * la carga él (openSubTabInHost) o si la carga Electron (flujo `createWindow`).
 * Si viene `existingWebContents` (invitado de window.open) se adopta tal cual:
 * ya hereda la partition/sesión del opener, que es lo que queremos.
 * `opts.partition` permite abrir la pestaña con otra sesión (router de sesiones).
 * @param {Electron.BrowserWindow} host
 * @param {string} url
 * @param {{ background?: boolean, existingWebContents?: Electron.WebContents | null, partition?: string }} [opts]
 * @returns {DetachedTab}
 */
function createSubTabInHost(host, url, opts = {}) {
  const state = tabStateOf(host);
  if (!state) throw new Error('host sin estado de pestañas');

  try {
    require('./downloads-manager').registerDownloadsForPartition(
      opts.partition || state.partition
    );
  } catch {
    /* descargas centralizadas: no crítico */
  }

  const view = new WebContentsView(
    opts.existingWebContents
      ? { webContents: opts.existingWebContents }
      : {
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            partition: opts.partition || state.partition,
            preload: WEB_NOTIFICATION_FOCUS_PRELOAD,
            /** Sub-pestaña en segundo plano: Chromium frena timers y animaciones para no gastar CPU. */
            backgroundThrottling: true,
          },
        }
  );
  setEmbeddedPageBackground(view);

  const tabPartition = opts.existingWebContents
    ? state.partition
    : opts.partition || state.partition;
  try {
    require('./session-router').attachLoginSessionOffer(
      view.webContents,
      tabPartition,
      () => (host && !host.isDestroyed() ? host : null),
      url
    );
  } catch {
    /* el login sigue mostrándose si el aviso de usuario no se pudo enganchar */
  }

  const id = nextSubTabId();
  /** @type {DetachedTab} */
  const tab = {
    id,
    view,
    title: 'Cargando…',
    url: String(url || ''),
    favicon: '',
    loading: true,
    isMain: false,
  };
  state.tabs.set(id, tab);
  state.order.push(id);
  attachSubTabEvents(host, tab);

  if (!opts.background) {
    state.activeId = id;
  }
  refreshHostTabsUi(host);

  if (!host.isDestroyed()) {
    if (host.isMinimized()) host.restore();
    if (!opts.background) host.focus();
  }

  // Electron aplica el tamaño pedido por window.open DESPUÉS de que createWindow
  // retorna; re-forzamos el layout en el siguiente tick y cuando el DOM esté listo.
  const kickIfActive = () => {
    const s = tabStateOf(host);
    if (!s || s.activeId !== id || !s.tabs.has(id)) return;
    kickTabViewResize(host, tab);
  };
  setImmediate(kickIfActive);
  view.webContents.once('dom-ready', kickIfActive);
  view.webContents.once('did-finish-load', kickIfActive);

  return tab;
}

/**
 * Abre una sub-pestaña en la ventana host con la misma partition del servicio,
 * de modo que comparte cookies/autenticación con la pestaña principal.
 * @param {Electron.BrowserWindow} host
 * @param {string} url
 * @param {{ background?: boolean }} [opts]
 * @returns {Promise<string>} id de la pestaña creada
 */
/**
 * @param {Electron.BrowserWindow} host
 * @param {string} url
 * @param {{ background?: boolean, partition?: string, loadOptions?: Electron.LoadURLOptions }} [opts]
 * @returns {Promise<string>} id de la pestaña creada
 */
async function openSubTabInHost(host, url, opts = {}) {
  const tab = createSubTabInHost(host, url, opts);
  try {
    await tab.view.webContents.loadURL(url, opts.loadOptions);
  } catch {
    /* la página puede fallar, la pestaña queda igualmente */
  }
  return tab.id;
}

/**
 * @param {Electron.BrowserWindow} host
 * @param {string} tabId
 */
function selectHostTab(host, tabId) {
  const state = tabStateOf(host);
  if (!state || !state.tabs.has(tabId)) return false;
  state.activeId = tabId;
  try {
    require('./embed-app-host').suspendOnHost(host);
  } catch {
    /* la página vuelve a verse aunque no haya una app embebida */
  }
  refreshHostTabsUi(host);
  return true;
}

/**
 * La ventana con la barra de inplaize donde tiene que vivir una app de escritorio.
 * @returns {Electron.BrowserWindow | null}
 */
function findForegroundChromeHost() {
  const { BrowserWindow } = require('electron');
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && focused.__usualDeskDetachedChromeHost) return focused;
  try {
    const last = require('./open-shortcut').getLastFocusedChromeWindow();
    if (last && !last.isDestroyed()) return last;
  } catch {
    /* todavía no hay ventanas web */
  }
  const wins = BrowserWindow.getAllWindows().filter(
    (win) => win && !win.isDestroyed() && win.__usualDeskDetachedChromeHost && win.isVisible(),
  );
  return wins.length ? wins[wins.length - 1] : null;
}

/**
 * true: la app de escritorio ocupa el hueco de la página y la barra queda.
 * @param {Electron.BrowserWindow} host
 * @param {boolean} covered
 */
function setEmbeddedDesktopCover(host, covered) {
  if (!host || host.isDestroyed() || !host.__usualDeskDetachedChromeHost) return;
  host.__usualDeskEmbeddedDesktop = covered === true;
  if (covered) host.__usualDeskAddressPeek = false;
  attachActiveTabViewOnly(host);
  broadcastTabsToHost(host);
}

/**
 * Cierra una sub-pestaña (la principal no se puede cerrar individualmente).
 * @param {Electron.BrowserWindow} host
 * @param {string} tabId
 */
function closeHostTab(host, tabId) {
  const state = tabStateOf(host);
  if (!state || !state.tabs.has(tabId)) return false;
  if (tabId === state.mainId) return false;

  const tab = state.tabs.get(tabId);
  removeSubTabFromState(host, tabId);
  const wc = tab.view.webContents;
  try {
    if (wc && !wc.isDestroyed() && typeof wc.destroy === 'function') wc.destroy();
  } catch {
    /* noop */
  }
  return true;
}

function destroyAllHostTabs(host) {
  const state = tabStateOf(host);
  if (!state) return;
  for (const tab of state.tabs.values()) {
    detachTabView(host, tab);
    const wc = tab.view.webContents;
    try {
      if (wc && !wc.isDestroyed() && typeof wc.destroy === 'function') wc.destroy();
    } catch {
      /* noop */
    }
  }
  state.tabs.clear();
  state.order = [];
}

function registerDetachedFrameIpc() {
  try {
    ipcMain.removeHandler('detached-frame-action');
  } catch {
    /* noop */
  }
  ipcMain.removeAllListeners('detached-url-bar');
  ipcMain.on('detached-url-bar', (event, hide) => {
    const sender = event.sender;
    const host = BrowserWindow.fromWebContents(sender);
    if (!host || host.isDestroyed() || !host.__usualDeskDetachedChromeHost) return;
    const state = tabStateOf(host);
    const active = state && state.tabs.get(state.activeId);
    if (!active || !active.view || active.view.webContents !== sender) return;
    setUrlBarHidden(host, hide === true);
  });
  ipcMain.handle('detached-frame-action', async (event, action, arg) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !win.__usualDeskDetachedChromeHost) return null;

    switch (action) {
      case 'get-chrome':
        return buildDetachedChromePayload(win.__usualDeskDetachedOwnMapKey);
      case 'reveal-address': {
        if (hostShowsTabChrome(win) || win.__usualDeskEmbeddedDesktop) return false;
        win.__usualDeskAddressPeek = true;
        refreshHostTabsUi(win);
        return true;
      }
      case 'hide-address': {
        if (!win.__usualDeskAddressPeek) return false;
        win.__usualDeskAddressPeek = false;
        refreshHostTabsUi(win);
        return true;
      }
      case 'set-url-compose': {
        setUrlCompose(win, arg === true);
        return true;
      }
      case 'set-search-revealed': {
        setSearchRevealed(win, arg === true);
        return true;
      }
      case 'set-nav-row-hidden': {
        setNavRowHidden(win, arg === true);
        return true;
      }
      case 'activate': {
        const id = arg == null ? '' : String(arg);
        if (!id) return false;
        const list = loadShortcuts();
        const { findShortcutById } = require('./shortcuts-store');
        const s = findShortcutById(list, id);
        if (!s) return false;
        const { openShortcut } = require('./open-shortcut');
        await openShortcut(s);
        return true;
      }
      case 'close-tab': {
        const mk = String(arg || '');
        if (!mk) return false;
        const { closeWebWindowByMapKey } = require('./open-shortcut');
        closeWebWindowByMapKey(mk);
        return true;
      }
      case 'get-tabs':
        return buildTabsPayload(win);
      case 'select-subtab':
        return selectHostTab(win, String(arg || ''));
      case 'close-subtab':
        return closeHostTab(win, String(arg || ''));
      case 'nav-back':
        return navigateHost(win, 'back');
      case 'nav-forward':
        return navigateHost(win, 'forward');
      case 'reload-tab':
        return reloadHostTab(win, arg == null ? '' : String(arg));
      case 'navigate': {
        const wc = activeHostWebContents(win);
        if (!wc) return false;
        const target = addressToUrl(arg);
        if (!target) return false;
        wc.loadURL(target).catch(() => {});
        try {
          wc.focus();
        } catch {
          /* noop */
        }
        return true;
      }
      case 'new-subtab': {
        const { LOOSE_NAV_NEW_TAB_URL } = require('./constants');
        const typed = addressToUrl(arg);
        try {
          require('./embed-app-host').suspendOnHost(win);
        } catch {
          /* sin app de escritorio encima, la pestaña se ve igual */
        }
        await openSubTabInHost(win, typed || LOOSE_NAV_NEW_TAB_URL);
        return true;
      }
      case 'nav-state':
        return navSnapshot(activeHostWebContents(win));
      case 'page-menu':
        popupPageMenu(pageMenuContextFor(win), arg && typeof arg === 'object' ? arg : {});
        return true;
      case 'find':
        return findInPage(activeHostWebContents(win), arg && typeof arg === 'object' ? arg : null);
      case 'find-stop':
        return stopFindInPage(activeHostWebContents(win));
      case 'minimize':
        if (!win.isDestroyed()) win.minimize();
        return true;
      case 'toggle-maximize':
        if (win.isDestroyed()) return false;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return win.isMaximized();
      case 'close-window':
        if (!win.isDestroyed()) win.close();
        return true;
      case 'menu-drawer': {
        const open = arg === true || !!(arg && arg.open === true);
        const editMode = !!(arg && arg.editMode === true);
        setHostMenuDrawerOpen(win, open, editMode);
        return true;
      }
      default:
        return null;
    }
  });
}

function isWhatsAppWeb(url) {
  try {
    return new URL(url).hostname === 'web.whatsapp.com';
  } catch {
    return false;
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

/**
 * Página del acceso (pestaña principal). Se crea al abrir la ventana y de nuevo al despertarla.
 * @param {Electron.BrowserWindow} host
 * @param {import('./shortcuts-store').Shortcut} shortcut
 * @param {string} mapKey
 * @returns {DetachedTab}
 */
function createMainPageView(host, shortcut, mapKey) {
  const { attachWebShortcutEmbeddedWebContents } = require('./open-shortcut');
  const state = tabStateOf(host);
  if (!state) throw new Error('host sin estado de pestañas');
  const { partition } = state;

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition,
      preload: WEB_NOTIFICATION_FOCUS_PRELOAD,
      /** Acceso en segundo plano: Chromium frena timers y animaciones para no gastar CPU. */
      backgroundThrottling: true,
    },
  });
  setEmbeddedPageBackground(view);

  const wc = view.webContents;
  host.__usualDeskHostedWebContents = wc;

  const prev = state.tabs.get(state.mainId);
  /** @type {DetachedTab} */
  const tab = {
    id: state.mainId,
    view,
    title: (prev && prev.title) || shortcut.name || 'Web',
    url: (prev && prev.url) || shortcut.url || '',
    favicon: (prev && prev.favicon) || '',
    loading: false,
    isMain: true,
  };
  if (prev && prev.workspaceUrl) tab.workspaceUrl = prev.workspaceUrl;
  if (prev && prev.partition) tab.partition = prev.partition;
  state.tabs.set(state.mainId, tab);
  bindHostPageNav(host, tab);
  attachPageShortcuts(wc, pageMenuContextFor(host));

  const rememberMainPage = () => {
    try {
      applyTabNavigation(tab, wc.getURL() || tab.url);
      const title = wc.getTitle();
      if (title) tab.title = title;
    } catch {
      /* la página puede estar cerrándose */
    }
    broadcastTabsToHost(host);
  };
  wc.on('page-title-updated', (_e, title) => {
    tab.title = String(title || tab.title || '');
    broadcastTabsToHost(host);
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    const picked = pickPageFavicon(favicons, tab.url);
    if (!picked || picked === tab.favicon) return;
    tab.favicon = picked;
    broadcastTabsToHost(host);
  });
  wc.on('did-navigate', rememberMainPage);
  wc.on('did-navigate-in-page', rememberMainPage);
  wc.on('did-stop-loading', rememberMainPage);

  attachWebShortcutEmbeddedWebContents(wc, shortcut, mapKey);
  try {
    require('./session-router').attachLoginSessionOffer(wc, partition, () =>
      host && !host.isDestroyed() ? host : null
    );
  } catch {
    /* el login sigue mostrándose si el aviso de usuario no se pudo enganchar */
  }

  wc.on('focus', () => {
    host.__usualDeskLastActiveAt = Date.now();
  });
  return tab;
}

/**
 * Libera el proceso de la página principal y deja una captura en su lugar.
 * La ventana sigue abierta (dock, Alt+Tab) y la página vuelve a cargarse al enfocarla.
 * @param {Electron.BrowserWindow} host
 * @returns {Promise<boolean>}
 */
async function hibernateHost(host) {
  const state = tabStateOf(host);
  if (!state || host.__usualDeskHibernated || host.__usualDeskHibernating) return false;
  const tab = state.tabs.get(state.mainId);
  const wc = tab && tab.view ? tab.view.webContents : null;
  if (!wc || wc.isDestroyed()) return false;

  host.__usualDeskHibernating = true;
  let snapshot = '';
  try {
    const image = await wc.capturePage();
    if (!image.isEmpty()) snapshot = `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`;
  } catch {
    /* sin captura queda el aviso sobre el fondo */
  }
  host.__usualDeskHibernating = false;

  // El usuario pudo volver a la ventana mientras se tomaba la captura.
  if (host.isDestroyed() || wc.isDestroyed() || host.isFocused() || state.tabs.size > 1) return false;

  let url = '';
  try {
    url = wc.getURL();
  } catch {
    url = '';
  }
  host.__usualDeskHibernated = { url: url || tab.url || '' };
  detachTabView(host, tab);
  try {
    wc.destroy();
  } catch {
    /* noop */
  }
  try {
    host.webContents.send('detached-hibernated', { snapshot });
  } catch {
    /* noop */
  }
  return true;
}

/**
 * Vuelve a crear la página hibernada en la misma dirección donde estaba.
 * @param {Electron.BrowserWindow} host
 * @returns {boolean}
 */
/** La ventana nace con show:false. Hay que mostrarla aunque ready-to-show ya haya pasado. */
function revealDetachedHost(host) {
  if (!host || host.isDestroyed()) return;
  try {
    if (host.isMinimized()) host.restore();
  } catch {
    /* noop */
  }
  try {
    if (!host.isMaximized()) host.maximize();
  } catch {
    /* noop */
  }
  try {
    host.show();
  } catch {
    /* noop */
  }
  try {
    require('./window-focus').forceWindowForeground(host);
  } catch {
    /* noop */
  }
}

function wakeHost(host) {
  if (!host || host.isDestroyed()) return false;
  const sleeping = host.__usualDeskHibernated;
  if (!sleeping) return false;
  host.__usualDeskHibernated = null;

  const mapKey = host.__usualDeskDetachedOwnMapKey;
  const stored = host.__usualDeskShortcut || {};
  const shortcut =
    loadShortcuts().find((s) => s && String(s.id) === String(stored.id)) || stored;
  const { audioMuted } = require('./open-shortcut').desiredWebMuteState(shortcut, mapKey);

  const tab = createMainPageView(host, shortcut, mapKey);
  const wc = tab.view.webContents;
  wc.setAudioMuted(audioMuted);
  wc.once('did-finish-load', () => {
    if (!wc.isDestroyed()) wc.setAudioMuted(audioMuted);
  });

  try {
    host.webContents.send('detached-hibernated', null);
  } catch {
    /* noop */
  }
  attachActiveTabViewOnly(host);
  broadcastTabsToHost(host);
  sendHostNav(host);
  loadWebContentsUrl(wc, sleeping.url || shortcut.url || 'about:blank').catch(() => {});
  return true;
}

/**
 * @param {import('./shortcuts-store').Shortcut} shortcut
 * @param {string} mapKey
 * @param {string} partition
 */
async function createDetachedWebHostWindow(shortcut, mapKey, partition) {
  const { setWebWindowForMapKey, deleteWebWindowForMapKey } = require('./open-shortcut');

  if (isWhatsAppWeb(shortcut.url)) {
    session.fromPartition(partition).setUserAgent(chromeLikeUserAgent());
  }

  const root = appRoot();
  const useFramelessChrome = process.platform === 'win32' || process.platform === 'linux';

  const host = new BrowserWindow({
    show: false,
    fullscreen: false,
    fullscreenable: false,
    frame: !useFramelessChrome,
    title: APP_NAME,
    icon: appIconFile(),
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(root, 'detached-web-frame-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /** Evita ralentizar timers/red LAN cuando el foco pasa al diálogo de impresión u otra ventana. */
      backgroundThrottling: false,
    },
  });

  host.__usualDeskDetachedChromeHost = true;
  host.__usualDeskSearchRevealed = false;
  host.__usualDeskUrlCompose = false;
  host.__usualDeskDetachedOwnMapKey = mapKey;
  brandWindow(host);
  attachWindowHistoryNav(host, () => activeHostWebContents(host));

  setWebWindowForMapKey(mapKey, host);

  try {
    host.removeMenu();
  } catch {
    try {
      host.setMenu(null);
    } catch {
      /* noop */
    }
  }

  host.__usualDeskShortcut = shortcut;
  host.__usualDeskLastActiveAt = Date.now();
  if (isWhatsAppWeb(shortcut.url)) host.__usualDeskPageNotifies = true;

  /** @type {DetachedTabState} */
  const tabState = {
    partition,
    tabs: new Map(),
    order: ['main'],
    activeId: 'main',
    mainId: 'main',
  };
  host.__usualDeskTabState = tabState;
  const wc = createMainPageView(host, shortcut, mapKey).view.webContents;

  wc.setAudioMuted(!!shortcut.audioMuted);

  const onResize = () => layoutActiveTabView(host);
  host.on('resize', onResize);

  const onUse = () => {
    host.__usualDeskLastActiveAt = Date.now();
    wakeHost(host);
  };
  host.on('focus', onUse);
  host.on('blur', () => {
    host.__usualDeskLastActiveAt = Date.now();
  });
  host.on('restore', onUse);

  host.on('close', () => {
    destroyAllHostTabs(host);
  });

  function sendMaximized() {
    if (!host || host.isDestroyed()) return;
    try {
      host.webContents.send('detached-window-maximized', host.isMaximized());
    } catch {
      /* noop */
    }
  }

  let revealed = false;
  const revealOnce = () => {
    if (revealed || host.isDestroyed()) return;
    revealed = true;
    revealDetachedHost(host);
    sendMaximized();
  };
  /* Antes de loadFile: ready-to-show suele dispararse mientras la promesa sigue en curso. */
  host.once('ready-to-show', revealOnce);
  host.on('maximize', sendMaximized);
  host.on('unmaximize', sendMaximized);

  try {
    await host.loadFile(path.join(root, 'detached-web-frame.html'));
    lockWindowZoom(host.webContents);
    try {
      require('./strip-chrome-lock-inject').attachStripChromeLock(host.webContents);
    } catch {
      /* noop */
    }

    attachActiveTabViewOnly(host);

    try {
      host.webContents.send('detached-chrome', buildDetachedChromePayload(mapKey));
    } catch {
      /* noop */
    }
    broadcastTabsToHost(host);

    if (!revealed) revealOnce();

    await loadWebContentsUrl(wc, shortcut.url || 'about:blank');
    if (!wc.isDestroyed()) {
      wc.setAudioMuted(!!shortcut.audioMuted);
    }

    wc.once('did-finish-load', () => {
      if (!wc.isDestroyed()) wc.setAudioMuted(!!shortcut.audioMuted);
    });

    broadcastChromeToAllDetachedHosts();
    return host;
  } catch (err) {
    try {
      deleteWebWindowForMapKey(mapKey);
    } catch {
      /* noop */
    }
    if (!host.isDestroyed()) host.destroy();
    throw err;
  }
}

/**
 * Acceso dueño de una ventana: una web por su clave, o el workspace si la ventana es suya.
 * @param {string} mk
 * @returns {string | null}
 */
function shortcutIdForHostMapKey(mk) {
  if (!mk || typeof mk !== 'string') return null;
  const list = loadShortcuts();
  if (mk.startsWith('workspace:')) {
    const id = mk.slice('workspace:'.length);
    const folder = list.find((x) => x && x.type === 'workspace' && String(x.id) === id);
    return folder && folder.id != null ? String(folder.id) : null;
  }
  const s = list.find((x) => x && x.type === 'web' && webMapKey(x) === mk);
  return s && s.id != null ? String(s.id) : null;
}

/** Acceso asociado a la ventana independiente enfocada (modo ventanas separadas). */
function getFocusedDetachedHostShortcutId() {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused.isDestroyed() || !focused.__usualDeskDetachedChromeHost) return null;
  const mk = focused.__usualDeskDetachedOwnMapKey;
  return shortcutIdForHostMapKey(typeof mk === 'string' ? mk : '');
}

module.exports = {
  createDetachedWebHostWindow,
  setHostUrlPromptOpen,
  registerDetachedFrameIpc,
  broadcastChromeToAllDetachedHosts,
  broadcastTitleBadgeToDetachedHosts,
  buildDetachedChromePayload,
  getFocusedDetachedHostShortcutId,
  shortcutIdForHostMapKey,
  openSubTabInHost,
  subTabWindowOpenResponse,
  selectHostTab,
  closeHostTab,
  chromeHeightFor,
  findForegroundChromeHost,
  setEmbeddedDesktopCover,
  hibernateHost,
  wakeHost,
};

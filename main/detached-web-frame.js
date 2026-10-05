'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, BrowserView, WebContentsView, session, app, ipcMain } = require('electron');
const { webMapKey } = require('./web-map-key');
const { loadShortcuts } = require('./shortcuts-store');
const { lockWindowZoom } = require('./lock-window-zoom');
/** Debe coincidir con --ud-chrome-strip-h en chrome-strip.css. */
const DETACHED_CHROME_H = 58;
/** Debe coincidir con la altura de .subtab-strip en web-shell.css. */
const DETACHED_TABSTRIP_H = 36;

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

/**
 * @param {import('./shortcuts-store').Shortcut | Record<string, unknown>} shortcut
 * @returns {string | null}
 */
function resolveShortcutIconPathForHost(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return null;
  const icon = typeof shortcut.icon === 'string' ? shortcut.icon.trim() : '';
  if (!icon || /^https?:\/\//i.test(icon) || icon.startsWith('data:')) return null;
  let root;
  try {
    root = app.getAppPath();
  } catch {
    root = path.join(__dirname, '..');
  }
  const normalized = icon.replace(/\\/g, '/');
  const abs = path.isAbsolute(icon) ? icon : path.join(root, normalized.replace(/^\//, ''));
  try {
    if (fs.existsSync(abs) && /\.(png|ico|jpe?g|gif|webp)$/i.test(abs)) return abs;
  } catch {
    return null;
  }
  return null;
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
    if (s.type === 'web') {
      const mk = webMapKey(s);
      return {
        id: String(s.id),
        type: 'web',
        name,
        icon,
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

function chromeHeightFor(host) {
  const state = tabStateOf(host);
  const showTabStrip = !!state && state.tabs.size > 1;
  return DETACHED_CHROME_H + (showTabStrip ? DETACHED_TABSTRIP_H : 0);
}

/** Ancho del drawer; debe coincidir con shell-home-menu.css (.dock-home-menu-drawer { width }). */
const MENU_DRAWER_W = 240;

function layoutActiveTabView(host) {
  const state = tabStateOf(host);
  if (!state) return;
  const tab = state.tabs.get(state.activeId);
  if (!tab) return;
  const [w, h] = host.getContentSize();
  const top = chromeHeightFor(host);
  const inset = host && host.__usualDeskMenuDrawerOpen ? MENU_DRAWER_W : 0;
  try {
    tab.view.setBounds({
      x: 0,
      y: top,
      width: Math.max(0, w - inset),
      height: Math.max(0, h - top),
    });
  } catch {
    /* noop */
  }
}

function setHostMenuDrawerOpen(host, open) {
  if (!host || host.isDestroyed()) return;
  host.__usualDeskMenuDrawerOpen = open === true;
  attachActiveTabViewOnly(host);
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

function buildTabsPayload(host) {
  const state = tabStateOf(host);
  if (!state) return { tabs: [] };
  const tabs = state.order
    .map((id) => state.tabs.get(id))
    .filter(Boolean)
    .map((tab) => ({
      id: tab.id,
      title: tab.title || tab.url || 'Pestaña',
      favicon: tab.favicon || '',
      loading: !!tab.loading,
      isMain: !!tab.isMain,
      isActive: tab.id === state.activeId,
    }));
  return { tabs };
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
  attachActiveTabViewOnly(host);
  broadcastTabsToHost(host);
}

/**
 * @param {Electron.BrowserWindow} host
 * @param {DetachedTab} tab
 */
function attachSubTabEvents(host, tab) {
  const wc = tab.view.webContents;

  wc.on('page-title-updated', (_e, title) => {
    tab.title = String(title || '');
    broadcastTabsToHost(host);
  });

  wc.on('page-favicon-updated', (_e, favicons) => {
    if (Array.isArray(favicons) && favicons.length) {
      tab.favicon = String(favicons[0] || '');
      broadcastTabsToHost(host);
    }
  });

  wc.on('did-start-loading', () => {
    tab.loading = true;
    broadcastTabsToHost(host);
  });

  wc.on('did-stop-loading', () => {
    tab.loading = false;
    try {
      tab.url = wc.getURL() || tab.url;
    } catch {
      /* noop */
    }
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
      if (isAuth) {
        // Popup de login sin sesión en esta partition: ofrecer copiar la sesión
        // de otro acceso (Google, etc.) y recargar, manteniendo el opener vivo.
        setImmediate(() => {
          try {
            require('./session-router')
              .maybeOfferSessionCopyForAuthTab(host, tab.view.webContents, url, openerPartition)
              .catch(() => {});
          } catch {
            /* noop */
          }
        });
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
  try {
    if (typeof view.setBackgroundColor === 'function') {
      view.setBackgroundColor('#000000');
    }
  } catch {
    /* noop */
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
 * @param {{ background?: boolean, partition?: string }} [opts]
 * @returns {Promise<string>} id de la pestaña creada
 */
async function openSubTabInHost(host, url, opts = {}) {
  const tab = createSubTabInHost(host, url, opts);
  try {
    await tab.view.webContents.loadURL(url);
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
  refreshHostTabsUi(host);
  return true;
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
  ipcMain.handle('detached-frame-action', async (event, action, arg) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !win.__usualDeskDetachedChromeHost) return null;

    switch (action) {
      case 'get-chrome':
        return buildDetachedChromePayload(win.__usualDeskDetachedOwnMapKey);
      case 'activate': {
        const id = arg == null ? '' : String(arg);
        if (!id) return false;
        const list = loadShortcuts();
        const s = list.find((x) => String(x.id) === id);
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
      case 'menu-drawer':
        setHostMenuDrawerOpen(win, arg === true);
        return true;
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
 * @param {import('./shortcuts-store').Shortcut} shortcut
 * @param {string} mapKey
 * @param {string} partition
 */
async function createDetachedWebHostWindow(shortcut, mapKey, partition) {
  const { attachWebShortcutEmbeddedWebContents, setWebWindowForMapKey, deleteWebWindowForMapKey } =
    require('./open-shortcut');

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
    title: shortcut.name || 'inplaze',
    icon: path.join(root, 'assets', 'icon.png'),
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
  host.__usualDeskDetachedOwnMapKey = mapKey;

  setWebWindowForMapKey(mapKey, host);

  const iconAbs = resolveShortcutIconPathForHost(shortcut);
  if (iconAbs) {
    try {
      host.setIcon(iconAbs);
    } catch {
      /* noop */
    }
  }

  try {
    host.removeMenu();
  } catch {
    try {
      host.setMenu(null);
    } catch {
      /* noop */
    }
  }

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
  try {
    if (typeof view.setBackgroundColor === 'function') {
      view.setBackgroundColor('#000000');
    }
  } catch {
    /* noop */
  }

  const wc = view.webContents;
  host.__usualDeskHostedWebContents = wc;

  /** @type {DetachedTabState} */
  const tabState = {
    partition,
    tabs: new Map(),
    order: ['main'],
    activeId: 'main',
    mainId: 'main',
  };
  tabState.tabs.set('main', {
    id: 'main',
    view,
    title: shortcut.name || 'Web',
    url: shortcut.url || '',
    favicon: '',
    loading: false,
    isMain: true,
  });
  host.__usualDeskTabState = tabState;

  attachWebShortcutEmbeddedWebContents(wc, shortcut, mapKey);

  wc.setAudioMuted(!!shortcut.audioMuted);

  const onResize = () => layoutActiveTabView(host);
  host.on('resize', onResize);

  host.on('close', () => {
    destroyAllHostTabs(host);
  });

  try {
    await host.loadFile(path.join(root, 'detached-web-frame.html'));
    lockWindowZoom(host.webContents);

    attachActiveTabViewOnly(host);

    host.webContents.once('did-finish-load', () => {
      try {
        host.webContents.send('detached-chrome', buildDetachedChromePayload(mapKey));
      } catch {
        /* noop */
      }
      broadcastTabsToHost(host);
    });

    function sendMaximized() {
      if (!host || host.isDestroyed()) return;
      try {
        host.webContents.send('detached-window-maximized', host.isMaximized());
      } catch {
        /* noop */
      }
    }

    host.on('maximize', sendMaximized);
    host.on('unmaximize', sendMaximized);

    host.once('ready-to-show', () => {
      if (!host.isDestroyed()) {
        host.maximize();
        host.show();
        sendMaximized();
      }
    });

    await wc.loadURL(shortcut.url || 'about:blank');
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

/** Acceso asociado a la ventana independiente enfocada (modo ventanas separadas). */
function getFocusedDetachedHostShortcutId() {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused.isDestroyed() || !focused.__usualDeskDetachedChromeHost) return null;
  const mk = focused.__usualDeskDetachedOwnMapKey;
  if (!mk || typeof mk !== 'string') return null;
  const list = loadShortcuts();
  const s = list.find((x) => x && x.type === 'web' && webMapKey(x) === mk);
  return s && s.id != null ? String(s.id) : null;
}

module.exports = {
  createDetachedWebHostWindow,
  registerDetachedFrameIpc,
  broadcastChromeToAllDetachedHosts,
  broadcastTitleBadgeToDetachedHosts,
  buildDetachedChromePayload,
  getFocusedDetachedHostShortcutId,
  openSubTabInHost,
  subTabWindowOpenResponse,
  selectHostTab,
  closeHostTab,
};

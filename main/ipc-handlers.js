'use strict';



const fs = require('fs');
const path = require('path');
const { ipcMain, BrowserWindow, dialog, app, shell } = require('electron');

const {

  loadShortcuts,

  saveShortcuts,

  broadcastShortcutsChanged,

  pushUndoBeforeChange,

} = require('./shortcuts-store');

const { loadAppSettings, saveAppSettings } = require('./app-settings-store');

const {
  openShortcut,
  getOpenWebWindowKeys,
  setWebShortcutAudioMuted,
  setWebShortcutNotificationsMuted,
  focusWebWindowByMapKey,
  focusWebWindowFromNotification,
  refreshWebNotificationPatches,
  closeAllDetachedWebWindows,
  focusLastWebWindowFromHotkey,
  anyWebWindowFocused,
  minimizeAllWebWindows,
  closeWebWindowByMapKey,
} = require('./open-shortcut');
const { webMapKey } = require('./web-map-key');
const focusMode = require('./focus-mode');
const { applyDockWindowBounds } = require('./window-bounds');
const { forceWindowForeground } = require('./window-focus');
const { registerShellIpc, closeAndClearAll: closeWebShell } = require('./web-shell');
const { registerDetachedFrameIpc } = require('./detached-web-frame');
const {
  registerLooseNavIpc,
  configureHooks: configureLooseNavHooks,
} = require('./loose-nav-window');
const {
  listChromeProfiles,
  isChromeRunning,
  findChromeExecutable,
  importGoogleCookiesFromChrome,
} = require('./chrome-cookie-import');
const { partitionFromSessionId } = require('./session-partition');
const { LOOSE_NAV_SESSION_ID } = require('./constants');



/**

 * @param {{ mainWindow: BrowserWindow | null, isExpanded: boolean }} state

 */

const IPC_CHANNELS = [

  'toggle-sidebar',

  'collapse-sidebar',

  'set-ignore-mouse',

  'get-shortcuts',

  'save-shortcuts',

  'pick-app-or-shortcut',

  'open-shortcut',

  'close-app',

  'get-user-data-path',

  'open-user-data-folder',

  'list-builtin-icons',

  'get-app-settings',

  'set-app-settings',

  'get-open-web-window-keys',

  'set-web-shortcut-muted',

  'set-web-shortcut-notifications-muted',

  'save-web-notification-dump',

  'focus-web-window-by-map-key',

  'dismiss-dock-in-app-notification',

  'shell-get-chrome',

  'shell-activate-shortcut',

  'shell-close-tab',

  'shell-window-minimize',

  'shell-window-toggle-maximize',

  'shell-window-close',

  'detached-frame-action',

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

  'focus-mode-toggle-member',

  'focus-mode-exit',

  'focus-mode-get-state',

  'close-web-window-by-map-key',

  'chrome-import-list-profiles',

  'chrome-import-status',

  'chrome-import-google-cookies',

];



function registerIpcHandlers(state) {

  /** IDs activos de avisos in-app; mientras exista alguno, el dock ocupa toda la pantalla. */
  const activeDockNotificationIds = new Set();

  function syncDockBoundsForInAppNotifications() {

    const dock = state.mainWindow;

    if (!dock || dock.isDestroyed()) return;

    if (state.isExpanded) return;

    const hasToasts = activeDockNotificationIds.size > 0;

    applyDockWindowBounds(dock, hasToasts);

    // Con avisos visibles debemos capturar el clic aunque la app esté en segundo plano.
    dock.setIgnoreMouseEvents(!hasToasts, hasToasts ? undefined : { forward: true });

  }

  for (const ch of IPC_CHANNELS) {

    try {

      ipcMain.removeHandler(ch);

    } catch {

      /* no registrado */

    }

  }

  registerShellIpc(ipcMain);
  registerDetachedFrameIpc();
  registerLooseNavIpc();

  function expandDockSidebar() {
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed()) return;
    if (state.isExpanded) {
      dock.webContents.send('sidebar-state', true);
      forceWindowForeground(dock);
      return;
    }
    state.isExpanded = true;
    applyDockWindowBounds(dock, true);
    try {
      dock.setIgnoreMouseEvents(false);
    } catch {
      /* noop */
    }
    dock.webContents.send('sidebar-state', true);
    forceWindowForeground(dock);
  }

  function collapseDockSidebar() {

    state.isExpanded = false;

    const dock = state.mainWindow;

    if (dock && !dock.isDestroyed()) {

      applyDockWindowBounds(dock, false);

      dock.setIgnoreMouseEvents(true, { forward: true });

      dock.webContents.send('sidebar-state', false);

    }

  }

  try {
    configureLooseNavHooks({
      expandDock: () => expandDockSidebar(),
      collapseDock: () => collapseDockSidebar(),
    });
  } catch {
    /* noop */
  }

  ipcMain.removeAllListeners('web-window-notification-click');

  ipcMain.on('web-window-notification-click', (event) => {

    collapseDockSidebar();

    const win = BrowserWindow.fromWebContents(event.sender);

    if (!win || win.isDestroyed()) return;

    if (win.isMinimized()) win.restore();

    if (win.isFullScreen()) win.setFullScreen(false);

    if (!win.isMaximized()) win.maximize();

    win.show();

    win.focus();

  });

  ipcMain.removeAllListeners('in-app-notification-show');

  ipcMain.on('in-app-notification-show', (event, payload) => {

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed() && win.__usualDeskNotificationsMuted === true) return;

    const dock = state.mainWindow;

    if (!dock || dock.isDestroyed()) return;

    const p = payload && typeof payload === 'object' ? payload : {};

    const id = p.id == null ? '' : String(p.id);

    if (id) activeDockNotificationIds.add(id);

    syncDockBoundsForInAppNotifications();

    const webMapKey = win && !win.isDestroyed() ? win.__usualDeskWebMapKey : '';

    const sourceName = win && !win.isDestroyed() ? win.__usualDeskShortcutLabel || 'Web' : 'Web';

    dock.webContents.send('dock-in-app-notification', {

      id: p.id,

      title: p.title != null ? String(p.title) : '',

      body: p.body != null ? String(p.body) : '',

      icon: p.icon != null ? String(p.icon) : '',

      image: p.image != null ? String(p.image) : '',

      tag: p.tag != null ? String(p.tag) : '',

      data: p.data ?? null,

      silent: !!p.silent,

      requireInteraction: !!p.requireInteraction,

      webMapKey: webMapKey || '',

      sourceName,

    });

  });

  ipcMain.removeAllListeners('in-app-notification-dismiss');

  ipcMain.on('in-app-notification-dismiss', (_event, id) => {

    const dock = state.mainWindow;

    if (!dock || dock.isDestroyed()) return;

    const k = id == null ? '' : String(id);

    if (k) activeDockNotificationIds.delete(k);

    syncDockBoundsForInAppNotifications();

    dock.webContents.send('dock-in-app-notification-dismiss', id);

  });



  /**
   * Atajo global (Ctrl+Alt+D y Ctrl+Mayús+D), modo ventanas separadas:
   * - Hay ventana web → última ventana al frente y se cierra el panel del dock si estaba abierto.
   * - No hay ninguna → abre o cierra el panel (barra negra con accesos), para poder iniciar sin ventanas.
   * Modo shell → sigue levantando el contenedor web.
   */
  function raiseAppFromGlobalHotkey() {
    if (loadAppSettings().webHostMode === 'shell') {
      try {
        require('./web-shell').showOrToggleShellFromHotkey();
      } catch {
        /* noop */
      }
      if (state.isExpanded) {
        state.isExpanded = false;
        const win = state.mainWindow;
        if (win && !win.isDestroyed()) {
          applyDockWindowBounds(win, false);
          win.webContents.send('sidebar-state', false);
        }
      }
      return;
    }

    const dockWin = state.mainWindow;
    if (!dockWin || dockWin.isDestroyed()) return;

    if (anyWebWindowFocused()) {
      minimizeAllWebWindows();
      if (state.isExpanded) {
        state.isExpanded = false;
        applyDockWindowBounds(dockWin, false);
        dockWin.webContents.send('sidebar-state', false);
      }
      return;
    }

    const focusedWeb = focusLastWebWindowFromHotkey();
    if (focusedWeb) {
      if (state.isExpanded) {
        state.isExpanded = false;
        applyDockWindowBounds(dockWin, false);
        dockWin.webContents.send('sidebar-state', false);
      }
      return;
    }

    state.isExpanded = !state.isExpanded;
    applyDockWindowBounds(dockWin, state.isExpanded);
    dockWin.webContents.send('sidebar-state', state.isExpanded);
    if (state.isExpanded) {
      forceWindowForeground(dockWin);
      if (process.platform === 'win32') {
        setTimeout(() => {
          if (!dockWin.isDestroyed()) forceWindowForeground(dockWin);
        }, 90);
        setTimeout(() => {
          if (!dockWin.isDestroyed()) forceWindowForeground(dockWin);
        }, 260);
      }
    }
  }

  function toggleDockSidebar() {
    if (loadAppSettings().webHostMode === 'shell') {
      try {
        require('./web-shell').showOrToggleShellFromHotkey();
      } catch {
        /* noop */
      }
      if (state.isExpanded) {
        state.isExpanded = false;
        const win = state.mainWindow;
        if (win && !win.isDestroyed()) {
          applyDockWindowBounds(win, false);
          win.webContents.send('sidebar-state', false);
        }
      }
      return false;
    }

    state.isExpanded = !state.isExpanded;

    const win = state.mainWindow;

    if (win && !win.isDestroyed()) {

      applyDockWindowBounds(win, state.isExpanded);

      win.webContents.send('sidebar-state', state.isExpanded);

      if (state.isExpanded) {
        forceWindowForeground(win);
      }

    }

    return state.isExpanded;

  }



  ipcMain.handle('toggle-sidebar', () => toggleDockSidebar());



  ipcMain.handle('collapse-sidebar', () => {

    collapseDockSidebar();

    return true;

  });



  ipcMain.handle('set-ignore-mouse', (event, ignore) => {

    const win = BrowserWindow.fromWebContents(event.sender);

    if (!win || win.isDestroyed()) return;

    win.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);

  });



  ipcMain.handle('get-shortcuts', () => loadShortcuts());



  ipcMain.handle('save-shortcuts', (_event, shortcuts) => {

    pushUndoBeforeChange();

    saveShortcuts(shortcuts);

    broadcastShortcutsChanged();

    return true;

  });



  ipcMain.handle('pick-app-or-shortcut', async () => {

    const parent =

      BrowserWindow.getFocusedWindow() || state.mainWindow || BrowserWindow.getAllWindows()[0];

    const filters =

      process.platform === 'win32'

        ? [

            { name: 'Programa o acceso directo', extensions: ['exe', 'lnk'] },

            { name: 'Ejecutable (.exe)', extensions: ['exe'] },

            { name: 'Acceso directo (.lnk)', extensions: ['lnk'] },

          ]

        : [{ name: 'Aplicación', extensions: ['exe', 'app', 'App'] }];

    const { canceled, filePaths } = await dialog.showOpenDialog(parent || undefined, {

      title: 'Elegir programa o acceso directo',

      filters,

      properties: ['openFile'],

    });

    if (canceled || !filePaths?.[0]) return null;

    return filePaths[0];

  });



  ipcMain.handle('open-shortcut', async (_event, shortcut) => {

    await openShortcut(shortcut);

  });



  ipcMain.handle('get-open-web-window-keys', () => getOpenWebWindowKeys());



  ipcMain.handle('set-web-shortcut-muted', (_event, payload) => {

    const shortcut = payload && typeof payload === 'object' ? payload.shortcut : null;

    const muted = !!(payload && payload.muted);

    if (!shortcut || shortcut.type !== 'web') return false;

    setWebShortcutAudioMuted(shortcut, muted);

    return true;

  });



  ipcMain.handle('set-web-shortcut-notifications-muted', (_event, payload) => {

    const shortcut = payload && typeof payload === 'object' ? payload.shortcut : null;

    const muted = !!(payload && payload.muted);

    if (!shortcut || shortcut.type !== 'web') return false;

    setWebShortcutNotificationsMuted(shortcut, muted);

    return true;

  });



  ipcMain.handle('save-web-notification-dump', (_event, text) => {

    const p = path.join(app.getPath('userData'), 'last-web-notification-dump.txt');

    fs.writeFileSync(p, String(text ?? ''), 'utf-8');

    return p;

  });



  ipcMain.handle('close-app', () => {

    app.quit();

  });



  ipcMain.handle('get-user-data-path', () => app.getPath('userData'));



  ipcMain.handle('open-user-data-folder', async () => {

    const p = app.getPath('userData');

    const err = await shell.openPath(p);

    if (err) throw new Error(err);

    return true;

  });



  ipcMain.handle('list-builtin-icons', () => {

    const dir = path.join(app.getAppPath(), 'assets', 'icons');

    if (!fs.existsSync(dir)) return [];

    return fs

      .readdirSync(dir)

      .filter((f) => /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(f))

      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

      .map((file) => {

        const base = path.basename(file, path.extname(file));

        return {

          file,

          relPath: `assets/icons/${file}`.replace(/\\/g, '/'),

          title: base.replace(/[-_]/g, ' '),

        };

      });

  });



  ipcMain.handle('get-app-settings', () => loadAppSettings());



  ipcMain.handle('set-app-settings', (_event, partial) => {

    const p = partial && typeof partial === 'object' ? partial : {};

    const prev = loadAppSettings();

    const next = saveAppSettings(p);

    if (
      Object.prototype.hasOwnProperty.call(p, 'webHostMode') &&
      prev.webHostMode !== next.webHostMode
    ) {
      try {
        closeWebShell();
      } catch {
        /* noop */
      }
      try {
        closeAllDetachedWebWindows();
      } catch {
        /* noop */
      }
      refreshWebNotificationPatches();
    }

    if (Object.prototype.hasOwnProperty.call(p, 'inAppWebNotifications')) {

      refreshWebNotificationPatches();

    }

    const win = state.mainWindow;

    if (win && !win.isDestroyed()) {

      applyDockWindowBounds(win, state.isExpanded);

    }

    if (win && !win.isDestroyed()) {

      win.webContents.send('app-settings-changed', next);

    }

    return next;

  });



  ipcMain.handle('focus-web-window-by-map-key', async (_event, payload) => {

    collapseDockSidebar();

    const mapKey =
      payload && typeof payload === 'object'
        ? (typeof payload.mapKey === 'string' ? payload.mapKey : '')
        : (typeof payload === 'string' ? payload : '');

    if (!mapKey) return false;

    const notification =
      payload && typeof payload === 'object' && payload.notification && typeof payload.notification === 'object'
        ? payload.notification
        : null;

    if (notification) {
      return focusWebWindowFromNotification(mapKey, notification);
    }
    return focusWebWindowByMapKey(mapKey);

  });



  ipcMain.handle('close-web-window-by-map-key', (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const mapKey = typeof raw.mapKey === 'string' ? raw.mapKey : String(payload || '');
    if (!mapKey) return false;
    if (loadAppSettings().webHostMode === 'shell') {
      try {
        const shell = require('./web-shell');
        if (typeof shell.closeTabByMapKey === 'function') {
          return shell.closeTabByMapKey(mapKey);
        }
      } catch {
        /* noop */
      }
    }
    try {
      closeWebWindowByMapKey(mapKey);
    } catch {
      /* noop */
    }
    return true;
  });

  ipcMain.handle('focus-mode-get-state', () => focusMode.getState());

  ipcMain.handle('focus-mode-exit', () => {
    focusMode.exitFocusMode();
    return focusMode.getState();
  });

  ipcMain.handle('focus-mode-toggle-member', async (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const shortcutId = raw.shortcutId == null ? '' : String(raw.shortcutId);
    if (!shortcutId) return focusMode.getState();
    const list = loadShortcuts();
    const shortcut = list.find((s) => String(s.id) === shortcutId);
    if (!shortcut || shortcut.type !== 'web') return focusMode.getState();
    const mk = webMapKey(shortcut);
    if (!mk) return focusMode.getState();
    focusMode.toggleMember(mk);
    // Si tras alternar el shortcut quedó DENTRO de la colección y aún no
    // estaba abierto, lo abrimos para que reciba sonido/notifs acorde.
    if (focusMode.isMember(mk)) {
      const keys = new Set(getOpenWebWindowKeys());
      if (!keys.has(mk)) {
        try {
          await openShortcut(shortcut);
        } catch {
          /* noop */
        }
      }
    }
    return focusMode.getState();
  });

  ipcMain.handle('chrome-import-status', () => {
    return {
      platformSupported: process.platform === 'win32',
      chromeFound: !!findChromeExecutable(),
      chromeRunning: isChromeRunning(),
    };
  });

  ipcMain.handle('chrome-import-list-profiles', () => {
    try {
      return listChromeProfiles();
    } catch {
      return [];
    }
  });

  ipcMain.handle('chrome-import-google-cookies', async (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const profileDirectory =
      typeof raw.profileDirectory === 'string' && raw.profileDirectory
        ? raw.profileDirectory
        : 'Default';
    // Por ahora siempre importamos a la partition de Navegación suelta (la que usa
    // el login de Cursor y demás pestañas dentro del dock).
    const targetPartition = partitionFromSessionId(LOOSE_NAV_SESSION_ID);
    try {
      const result = await importGoogleCookiesFromChrome({
        profileDirectory,
        targetPartition,
      });
      return { ok: true, ...result, targetPartition };
    } catch (err) {
      const code =
        err && typeof err.message === 'string' ? err.message : 'IMPORT_FAILED';
      return { ok: false, error: code };
    }
  });

  ipcMain.handle('dismiss-dock-in-app-notification', (_event, id) => {

    const k = id == null ? '' : String(id);

    if (k) activeDockNotificationIds.delete(k);

    syncDockBoundsForInAppNotifications();

    return true;

  });



  return { toggleDockSidebar, raiseAppFromGlobalHotkey };

}



module.exports = { registerIpcHandlers };


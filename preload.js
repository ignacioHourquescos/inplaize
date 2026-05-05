const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usualDesk', {
  toggleSidebar: () => ipcRenderer.invoke('toggle-sidebar'),
  collapseSidebar: () => ipcRenderer.invoke('collapse-sidebar'),
  expandSidebar: () => ipcRenderer.invoke('expand-sidebar'),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  saveShortcuts: (shortcuts) => ipcRenderer.invoke('save-shortcuts', shortcuts),
  openShortcut: (shortcut) => ipcRenderer.invoke('open-shortcut', shortcut),
  setWebShortcutMuted: (shortcut, muted) =>
    ipcRenderer.invoke('set-web-shortcut-muted', { shortcut, muted }),
  setWebShortcutNotificationsMuted: (shortcut, muted) =>
    ipcRenderer.invoke('set-web-shortcut-notifications-muted', { shortcut, muted }),
  getOpenWebWindowKeys: () => ipcRenderer.invoke('get-open-web-window-keys'),
  pickAppOrShortcut: () => ipcRenderer.invoke('pick-app-or-shortcut'),
  closeApp: () => ipcRenderer.invoke('close-app'),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  openUserDataFolder: () => ipcRenderer.invoke('open-user-data-folder'),
  listBuiltinIcons: () => ipcRenderer.invoke('list-builtin-icons'),
  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  setAppSettings: (partial) => ipcRenderer.invoke('set-app-settings', partial),
  onSidebarState: (callback) => {
    ipcRenderer.on('sidebar-state', (_event, state) => callback(state));
  },
  onShortcutsChanged: (callback) => {
    ipcRenderer.on('shortcuts-changed', () => callback());
  },
  onOpenAddShortcutModal: (callback) => {
    ipcRenderer.on('open-add-shortcut-modal', () => callback());
  },
  onShortcutTitleBadge: (callback) => {
    ipcRenderer.on('shortcut-title-badge', (_event, payload) => callback(payload));
  },
  onAppSettingsChanged: (callback) => {
    ipcRenderer.on('app-settings-changed', (_event, settings) => callback(settings));
  },
  onOpenWebWindowKeys: (callback) => {
    ipcRenderer.on('open-web-window-keys', (_event, payload) => {
      const keys = payload && Array.isArray(payload.keys) ? payload.keys : [];
      callback(keys);
    });
  },
  focusWebWindowByMapKey: (mapKey, notification) =>
    ipcRenderer.invoke('focus-web-window-by-map-key', { mapKey, notification }),
  getFocusModeState: () => ipcRenderer.invoke('focus-mode-get-state'),
  toggleFocusModeMember: (shortcutId) =>
    ipcRenderer.invoke('focus-mode-toggle-member', { shortcutId }),
  exitFocusMode: () => ipcRenderer.invoke('focus-mode-exit'),
  onFocusModeChanged: (callback) => {
    ipcRenderer.on('focus-mode-changed', (_event, state) => callback(state));
  },
  closeWebWindowByMapKey: (mapKey) =>
    ipcRenderer.invoke('close-web-window-by-map-key', { mapKey }),
  onDockInAppNotification: (callback) => {
    ipcRenderer.on('dock-in-app-notification', (_event, payload) => callback(payload));
  },
  onDockInAppNotificationDismiss: (callback) => {
    ipcRenderer.on('dock-in-app-notification-dismiss', (_event, id) => callback(id));
  },
  dismissDockInAppNotification: (id) => ipcRenderer.invoke('dismiss-dock-in-app-notification', id),

  /* ---- Navegación suelta (pestañas dentro del dock) ---- */
  looseNavOpen: () => ipcRenderer.invoke('loose-nav-open'),
  looseNavClose: () => ipcRenderer.invoke('loose-nav-close'),
  looseNavSelectTab: (tabId) => ipcRenderer.invoke('loose-nav-select-tab', tabId),
  looseNavCloseTab: (tabId) => ipcRenderer.invoke('loose-nav-close-tab', tabId),
  looseNavNewTab: (url) => ipcRenderer.invoke('loose-nav-new-tab', url ? { url } : {}),
  looseNavNavigate: (url) => ipcRenderer.invoke('loose-nav-navigate', { url }),
  looseNavBack: () => ipcRenderer.invoke('loose-nav-back'),
  looseNavForward: () => ipcRenderer.invoke('loose-nav-forward'),
  looseNavReload: () => ipcRenderer.invoke('loose-nav-reload'),
  looseNavOpenExternal: (url) => ipcRenderer.invoke('loose-nav-open-external', { url }),
  looseNavGetState: () => ipcRenderer.invoke('loose-nav-get-state'),
  looseNavSetViewportBounds: (bounds) =>
    ipcRenderer.invoke('loose-nav-set-viewport-bounds', bounds),
  onLooseNavState: (callback) => {
    ipcRenderer.on('loose-nav-state', (_event, payload) => callback(payload));
  },

  /* ---- Importar cookies de Google desde Chrome ---- */
  getChromeImportStatus: () => ipcRenderer.invoke('chrome-import-status'),
  listChromeProfiles: () => ipcRenderer.invoke('chrome-import-list-profiles'),
  importChromeGoogleCookies: (profileDirectory) =>
    ipcRenderer.invoke('chrome-import-google-cookies', { profileDirectory }),
});

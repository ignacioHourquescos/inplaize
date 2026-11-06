const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('usualDesk', {
  collapseSidebar: () => ipcRenderer.invoke('collapse-sidebar'),
  dockWindowMinimize: () => ipcRenderer.invoke('dock-window-minimize'),
  dockWindowToggleMaximize: () => ipcRenderer.invoke('dock-window-toggle-maximize'),
  expandSidebar: () => ipcRenderer.invoke('expand-sidebar'),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  saveShortcuts: (shortcuts) => ipcRenderer.invoke('save-shortcuts', shortcuts),
  openShortcut: (shortcut) => ipcRenderer.invoke('open-shortcut', shortcut),
  openPastedUrl: (url) => ipcRenderer.invoke('open-pasted-url', url),
  showUrlPrompt: () => ipcRenderer.invoke('url-prompt-show'),
  openAppBrowser: () => ipcRenderer.invoke('app-browser-open'),
  setUrlPromptOpen: (open) => ipcRenderer.invoke('url-prompt-open', open === true),
  setWebShortcutMuted: (shortcut, muted) =>
    ipcRenderer.invoke('set-web-shortcut-muted', { shortcut, muted }),
  setWebShortcutNotificationsMuted: (shortcut, muted) =>
    ipcRenderer.invoke('set-web-shortcut-notifications-muted', { shortcut, muted }),
  getOpenWebWindowKeys: () => ipcRenderer.invoke('get-open-web-window-keys'),
  pickAppOrShortcut: () => ipcRenderer.invoke('pick-app-or-shortcut'),
  closeApp: () => ipcRenderer.invoke('close-app'),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openUserDataFolder: () => ipcRenderer.invoke('open-user-data-folder'),
  listBuiltinIcons: () => ipcRenderer.invoke('list-builtin-icons'),
  fetchWebFavicon: (pageUrl) => ipcRenderer.invoke('fetch-web-favicon', pageUrl),
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
  onOpenSettingsModal: (callback) => {
    ipcRenderer.on('open-settings-modal', () => callback());
  },
  onOpenAppearanceModal: (callback) => {
    ipcRenderer.on('open-appearance-modal', () => callback());
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
  peekSuggestedShortcutEditorTarget: () =>
    ipcRenderer.invoke('peek-suggested-shortcut-editor-target'),
  onOpenShortcutEditor: (callback) => {
    ipcRenderer.on('open-shortcut-editor', (_event, payload) => callback(payload));
  },
  notifyShortcutsEditMode: (on) => ipcRenderer.invoke('notify-shortcuts-edit-mode', on === true),
  onDockOpenWelcomeHome: (callback) => {
    ipcRenderer.on('dock-open-welcome-home', (_event, view) => callback(view));
  },
  onExitShortcutEditMode: (callback) => {
    ipcRenderer.on('exit-shortcut-edit-mode', () => callback());
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
  looseNavNewTab: (url, profile) =>
    ipcRenderer.invoke('loose-nav-new-tab', {
      ...(url ? { url } : {}),
      ...(profile && profile.partition
        ? { partition: String(profile.partition) }
        : {}),
      ...(profile && profile.nextToActive ? { nextToActive: true } : {}),
    }),
  looseNavPickProfile: () => ipcRenderer.invoke('loose-nav-pick-profile'),
  looseNavUseAccount: (target) =>
    ipcRenderer.invoke('loose-nav-use-account', {
      partition: target && target.partition ? String(target.partition) : '',
      chromeDirectory: target && target.chromeDirectory ? String(target.chromeDirectory) : '',
    }),
  looseNavSetDefaultProfile: (target) =>
    ipcRenderer.invoke('loose-nav-set-default-profile', {
      partition: target && target.partition ? String(target.partition) : '',
      chromeDirectory: target && target.chromeDirectory ? String(target.chromeDirectory) : '',
    }),
  onLooseNavShortcut: (callback) => {
    ipcRenderer.on('loose-nav-shortcut', (_event, action) => callback(String(action || '')));
  },
  looseNavNavigate: (url) => ipcRenderer.invoke('loose-nav-navigate', { url }),
  looseNavBack: () => ipcRenderer.invoke('loose-nav-back'),
  looseNavForward: () => ipcRenderer.invoke('loose-nav-forward'),
  looseNavReload: (tabId) => ipcRenderer.invoke('loose-nav-reload', tabId ? String(tabId) : null),
  looseNavOpenExternal: (url) => ipcRenderer.invoke('loose-nav-open-external', { url }),
  looseNavGetState: () => ipcRenderer.invoke('loose-nav-get-state'),
  looseNavOpenPageMenu: (x, y) => ipcRenderer.invoke('loose-nav-page-menu', { x, y }),
  looseNavFindInPage: (text, opts) =>
    ipcRenderer.invoke('loose-nav-find', {
      text: String(text || ''),
      forward: !(opts && opts.forward === false),
      newSearch: !!(opts && opts.newSearch === true),
    }),
  looseNavStopFindInPage: () => ipcRenderer.invoke('loose-nav-find-stop'),
  onLooseNavPageCommand: (callback) => {
    ipcRenderer.on('loose-nav-page-command', (_event, msg) => callback(msg));
  },
  looseNavSetViewportBounds: (bounds) =>
    ipcRenderer.invoke('loose-nav-set-viewport-bounds', bounds),
  setMenuOverlayOpen: (open, editMode) =>
    ipcRenderer.invoke('menu-overlay-set-open', {
      open: open === true,
      editMode: editMode === true,
    }),
  hideMenuOverlay: () => ipcRenderer.invoke('menu-overlay-hide'),
  onMenuOverlayApply: (callback) => {
    ipcRenderer.on('menu-overlay-apply', (_event, open) => callback(open === true));
  },
  onLooseNavState: (callback) => {
    ipcRenderer.on('loose-nav-state', (_event, payload) => callback(payload));
  },

  /* ---- Importar cookies de Google desde Chrome ---- */
  getChromeImportStatus: () => ipcRenderer.invoke('chrome-import-status'),
  listChromeProfiles: () => ipcRenderer.invoke('chrome-import-list-profiles'),
  importChromeGoogleCookies: (profileDirectory) =>
    ipcRenderer.invoke('chrome-import-google-cookies', { profileDirectory }),
  importChromeSessionsForShortcuts: (profileDirectory, shortcutIds) =>
    ipcRenderer.invoke('chrome-import-sessions-for-shortcuts', { profileDirectory, shortcutIds }),

  /* ---- Importar perfil completo de otro navegador (estilo Comet) ---- */
  listBrowserImportProfiles: () => ipcRenderer.invoke('browser-import-list-profiles'),
  runBrowserImport: (browser, directory, parts) =>
    ipcRenderer.invoke('browser-import-run', { browser, directory, parts: parts || null }),

  /* ---- Historial, marcadores y contraseñas ---- */
  suggestHistory: (query, limit) => ipcRenderer.invoke('history-suggest', { query, limit }),
  recordHistory: (url, title) => ipcRenderer.invoke('history-record', { url, title }),
  listHistory: (query, limit) => ipcRenderer.invoke('history-list', { query, limit }),
  removeHistory: (url) => ipcRenderer.invoke('history-remove', url),
  clearHistory: () => ipcRenderer.invoke('history-clear'),
  listBookmarks: () => ipcRenderer.invoke('bookmarks-list'),
  addBookmark: (url, title) => ipcRenderer.invoke('bookmarks-add', { url, title }),
  removeBookmark: (id) => ipcRenderer.invoke('bookmarks-remove', id),
  hasBookmark: (url) => ipcRenderer.invoke('bookmarks-has', url),
  passwordsForHost: (url) => ipcRenderer.invoke('passwords-for-host', url),
  savePassword: (origin, username, password) =>
    ipcRenderer.invoke('passwords-save', { origin, username, password }),
  listPasswords: () => ipcRenderer.invoke('passwords-list'),
  removePassword: (id) => ipcRenderer.invoke('passwords-remove', id),

  /* ---- Descargas centralizadas en el dock ---- */
  getDownloads: () => ipcRenderer.invoke('downloads-get-history'),
  openDownloadFile: (id) => ipcRenderer.invoke('downloads-open-file', id),
  markDownloadOpened: (id) => ipcRenderer.invoke('downloads-mark-opened', id),
  showDownloadInFolder: (id) => ipcRenderer.invoke('downloads-show-in-folder', id),
  removeDownload: (id) => ipcRenderer.invoke('downloads-remove', id),
  clearDownloads: () => ipcRenderer.invoke('downloads-clear'),
  cancelDownload: (id) => ipcRenderer.invoke('downloads-cancel', id),
  saveDownloadImageEdit: (id, dataUrl) => ipcRenderer.invoke('downloads-save-image-edit', id, dataUrl),
  ingestDroppedFiles: (paths) => ipcRenderer.invoke('downloads-ingest-dropped-files', paths),
  getDownloadThumbnail: (id) => ipcRenderer.invoke('downloads-get-thumbnail', id),
  getDownloadFileIcon: (id) => ipcRenderer.invoke('downloads-get-file-icon', id),
  startDownloadDrag: (id, anchor) => ipcRenderer.send('downloads-drag-start', {
    id,
    anchor: anchor || null,
  }),
  onDownloadStarted: (callback) => {
    ipcRenderer.on('dock-download-started', (_event, payload) => callback(payload));
  },
  onDownloadUpdated: (callback) => {
    ipcRenderer.on('dock-download-updated', (_event, payload) => callback(payload));
  },
  onDownloadDone: (callback) => {
    ipcRenderer.on('dock-download-done', (_event, payload) => callback(payload));
  },
  getPhoneUploadInfo: () => ipcRenderer.invoke('phone-upload-get-info'),

  /* ---- Cajón mágico (comprimir/convertir archivos con ffmpeg) ---- */
  magicTransform: (filePath, action, target) =>
    ipcRenderer.invoke('magic-transform', { filePath, action, target }),
  // En Electron moderno `File.path` no existe: la ruta real de un archivo
  // soltado se resuelve en el preload con webUtils.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  /* ---- Sticky notes (notas adhesivas en la pantalla de inicio) ---- */
  getStickyNotes: () => ipcRenderer.invoke('get-sticky-notes'),
  saveStickyNotes: (payload) => ipcRenderer.invoke('save-sticky-notes', payload),
  onStickyNotesChanged: (callback) => {
    ipcRenderer.on('sticky-notes-changed', () => callback());
  },

  /* ---- Tareas (pantalla del icono de inplaize) ---- */
  getTodos: () => ipcRenderer.invoke('get-todos'),
  saveTodos: (payload) => ipcRenderer.invoke('save-todos', payload),
  holdDockBlur: (ms) => ipcRenderer.invoke('hold-dock-blur', ms),
  setDocModalOpen: (open) => ipcRenderer.send('doc-modal-open', open === true),
  exportDocumentPdf: (payload) => ipcRenderer.invoke('export-document-pdf', payload),
  onGestureCoachShow: (callback) => {
    ipcRenderer.on('gesture-coach-show', () => callback());
  },
  closeGestureCoach: (opts) => ipcRenderer.invoke('gesture-coach-close', opts || {}),
  setOnboardingActive: (on) => ipcRenderer.invoke('set-onboarding-active', on === true),
  setOnboardingHotkeyTrial: (on) => ipcRenderer.invoke('set-onboarding-hotkey-trial', on === true),
  moveOnboardingCursor: (point) => ipcRenderer.invoke('onboarding-move-cursor', point),
  onOnboardingHotkeyPress: (callback) => {
    ipcRenderer.on('onboarding-hotkey-press', () => callback());
  },
  onTodosChanged: (callback) => {
    ipcRenderer.on('todos-changed', () => callback());
  },
});

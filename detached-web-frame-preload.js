const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('usualDeskDetached', {
  frameAction: (action, arg) => ipcRenderer.invoke('detached-frame-action', action, arg ?? null),
  goBack: () => ipcRenderer.invoke('detached-frame-action', 'nav-back'),
  goForward: () => ipcRenderer.invoke('detached-frame-action', 'nav-forward'),
  getNavState: () => ipcRenderer.invoke('detached-frame-action', 'nav-state'),
  onNavState: (cb) => {
    ipcRenderer.on('detached-nav', (_e, state) => cb(state));
  },
  openDockWelcomeHome: (view) =>
    ipcRenderer.invoke('dock-open-welcome-home', view === 'downloads' ? 'downloads' : 'todos'),
  openPastedUrl: (url) => ipcRenderer.invoke('open-pasted-url', url),
  showUrlPrompt: () => ipcRenderer.invoke('url-prompt-show'),
  openAppBrowser: () => ipcRenderer.invoke('app-browser-open'),
  setUrlPromptOpen: (open) => ipcRenderer.invoke('url-prompt-open', open === true),
  openAddShortcut: () => ipcRenderer.invoke('chrome-open-add-shortcut'),
  openAppearance: () => ipcRenderer.invoke('chrome-open-appearance'),
  openSettings: () => ipcRenderer.invoke('chrome-open-settings'),
  enterShortcutsEditMode: () => ipcRenderer.invoke('chrome-enter-shortcuts-edit-mode'),
  collapseDockSidebar: () => ipcRenderer.invoke('collapse-sidebar'),
  closeApp: () => ipcRenderer.invoke('close-app'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  notifyShellMenuDrawer: (open, editMode) =>
    ipcRenderer.invoke('detached-frame-action', 'menu-drawer', {
      open: open === true,
      editMode: editMode === true,
    }),
  onMenuOverlayApply: (callback) => {
    ipcRenderer.on('menu-overlay-apply', (_event, open) => callback(open === true));
  },
  requestShortcutEditor: () => ipcRenderer.invoke('detached-request-shortcut-editor'),
  requestExitShortcutEditMode: () => ipcRenderer.invoke('chrome-request-exit-shortcut-edit-mode'),
  onShortcutsEditModeSync: (cb) => {
    ipcRenderer.on('shortcuts-edit-mode-sync', (_e, on) => cb(on === true));
  },
  onChrome: (cb) => {
    ipcRenderer.on('detached-chrome', (_e, payload) => cb(payload));
  },
  onTabs: (cb) => {
    ipcRenderer.on('detached-tabs', (_e, payload) => cb(payload));
  },
  onTitleBadge: (cb) => {
    ipcRenderer.on('detached-title-badge', (_e, payload) => cb(payload));
  },
  onWindowMaximized: (cb) => {
    ipcRenderer.on('detached-window-maximized', (_e, maximized) => cb(maximized === true));
  },
  onShortcutsChanged: (cb) => {
    ipcRenderer.on('shortcuts-changed', () => cb());
  },
  getFocusModeState: () => ipcRenderer.invoke('focus-mode-get-state'),
  toggleFocusModeMember: (shortcutId) =>
    ipcRenderer.invoke('focus-mode-toggle-member', { shortcutId }),
  exitFocusMode: () => ipcRenderer.invoke('focus-mode-exit'),
  onFocusModeChanged: (cb) => {
    ipcRenderer.on('focus-mode-changed', (_event, state) => cb(state));
  },
  framelessChrome: process.platform === 'win32' || process.platform === 'linux',
  ingestDroppedFiles: (paths) => ipcRenderer.invoke('downloads-ingest-dropped-files', paths),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});

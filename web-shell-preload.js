const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Windows/Linux: ventana sin marco y controles en la página (coincide con main/web-shell.js). */
const framelessChrome = process.platform === 'win32' || process.platform === 'linux';

contextBridge.exposeInMainWorld('usualDeskShell', {
  framelessChrome,
  getChromeState: () => ipcRenderer.invoke('shell-get-chrome'),
  activateShortcut: (id) => ipcRenderer.invoke('shell-activate-shortcut', id),
  closeTab: (mapKey) => ipcRenderer.invoke('shell-close-tab', mapKey),
  windowMinimize: () => ipcRenderer.invoke('shell-window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('shell-window-toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('shell-window-close'),
  openDockWelcomeHome: () => ipcRenderer.invoke('dock-open-welcome-home'),
  openAddShortcut: () => ipcRenderer.invoke('chrome-open-add-shortcut'),
  openSettings: () => ipcRenderer.invoke('chrome-open-settings'),
  enterShortcutsEditMode: () => ipcRenderer.invoke('chrome-enter-shortcuts-edit-mode'),
  collapseDockSidebar: () => ipcRenderer.invoke('collapse-sidebar'),
  closeApp: () => ipcRenderer.invoke('close-app'),
  notifyShellMenuDrawer: (open) => ipcRenderer.invoke('shell-menu-drawer-state', open === true),
  requestShortcutEditor: () => ipcRenderer.invoke('shell-request-shortcut-editor'),
  requestExitShortcutEditMode: () => ipcRenderer.invoke('chrome-request-exit-shortcut-edit-mode'),
  onShortcutsEditModeSync: (callback) => {
    ipcRenderer.on('shortcuts-edit-mode-sync', (_event, on) => callback(on === true));
  },
  onChrome: (callback) => {
    ipcRenderer.on('shell-chrome', (_event, payload) => callback(payload));
  },
  onShortcutsChanged: (callback) => {
    ipcRenderer.on('shortcuts-changed', () => callback());
  },
  onWindowMaximized: (callback) => {
    ipcRenderer.on('shell-window-maximized', (_event, maximized) => callback(maximized === true));
  },
  onTitleBadge: (callback) => {
    ipcRenderer.on('shell-title-badge', (_event, payload) => callback(payload));
  },
  getFocusModeState: () => ipcRenderer.invoke('focus-mode-get-state'),
  toggleFocusModeMember: (shortcutId) =>
    ipcRenderer.invoke('focus-mode-toggle-member', { shortcutId }),
  exitFocusMode: () => ipcRenderer.invoke('focus-mode-exit'),
  onFocusModeChanged: (callback) => {
    ipcRenderer.on('focus-mode-changed', (_event, state) => callback(state));
  },
  ingestDroppedFiles: (paths) => ipcRenderer.invoke('downloads-ingest-dropped-files', paths),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});

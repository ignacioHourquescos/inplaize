const { contextBridge, ipcRenderer } = require('electron');

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
});

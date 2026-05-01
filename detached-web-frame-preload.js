const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usualDeskDetached', {
  frameAction: (action, arg) => ipcRenderer.invoke('detached-frame-action', action, arg ?? null),
  onChrome: (cb) => {
    ipcRenderer.on('detached-chrome', (_e, payload) => cb(payload));
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
});

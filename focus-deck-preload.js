const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusDeck', {
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  openShortcut: (shortcut) => ipcRenderer.invoke('open-shortcut', shortcut),
  close: () => ipcRenderer.invoke('focus-deck-close'),
  setExpanded: (expanded) => ipcRenderer.invoke('focus-deck-set-expanded', expanded),
  getUiState: () => ipcRenderer.invoke('focus-deck-get-ui-state'),
  getTitleBadges: () => ipcRenderer.invoke('get-title-badges'),
  onShortcutsChanged: (callback) => {
    ipcRenderer.on('shortcuts-changed', () => callback());
  },
  onShortcutTitleBadge: (callback) => {
    ipcRenderer.on('shortcut-title-badge', (_event, payload) => callback(payload));
  },
  onExpandedState: (callback) => {
    ipcRenderer.on('focus-deck-expanded-state', (_event, expanded) => callback(expanded));
  },
});

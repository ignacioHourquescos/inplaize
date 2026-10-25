'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuOverlay', {
  ready: () => ipcRenderer.invoke('menu-overlay-ready'),
  reportOpen: (open) => ipcRenderer.send('menu-overlay-report', open === true),
  onState: (callback) => {
    ipcRenderer.on('menu-overlay-state', (_event, state) => callback(state || {}));
  },
  openAddShortcut: () => ipcRenderer.invoke('chrome-open-add-shortcut'),
  openAppearance: () => ipcRenderer.invoke('chrome-open-appearance'),
  openSettings: () => ipcRenderer.invoke('chrome-open-settings'),
  enterShortcutsEditMode: () => ipcRenderer.invoke('chrome-enter-shortcuts-edit-mode'),
  exitShortcutsEditMode: () => ipcRenderer.invoke('chrome-request-exit-shortcut-edit-mode'),
  quitApp: () => ipcRenderer.invoke('close-app'),
  onShortcutsEditModeSync: (callback) => {
    ipcRenderer.on('shortcuts-edit-mode-sync', (_event, on) => callback(on === true));
  },
});

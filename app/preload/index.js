'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mvp', {
  getState: () => ipcRenderer.invoke('mvp:get-state'),
  onState: (callback) => {
    ipcRenderer.on('mvp:state', (_event, snapshot) => callback(snapshot));
  },
  home: () => ipcRenderer.invoke('mvp:home'),
  toggleBar: () => ipcRenderer.invoke('mvp:toggle-bar'),
  setEditing: (on) => ipcRenderer.invoke('mvp:editing', on),
  selectProfile: (id) => ipcRenderer.invoke('mvp:select-profile', id),
  addProfile: (name) => ipcRenderer.invoke('mvp:add-profile', name),
  removeProfile: (id) => ipcRenderer.invoke('mvp:remove-profile', id),
  addShortcut: (payload) => ipcRenderer.invoke('mvp:add-shortcut', payload),
  removeShortcut: (id) => ipcRenderer.invoke('mvp:remove-shortcut', id),
  reorderShortcuts: (ids) => ipcRenderer.invoke('mvp:reorder-shortcuts', ids),
  openShortcut: (id) => ipcRenderer.invoke('mvp:open-shortcut', id),
  closeShortcut: (id) => ipcRenderer.invoke('mvp:close-shortcut', id),
  saveNotes: (notes) => ipcRenderer.invoke('mvp:save-notes', notes),
  newTab: () => ipcRenderer.invoke('mvp:new-tab'),
  closeTab: (id) => ipcRenderer.invoke('mvp:close-tab', id),
  selectTab: (id) => ipcRenderer.invoke('mvp:select-tab', id),
  navigate: (text) => ipcRenderer.invoke('mvp:navigate', text),
  back: () => ipcRenderer.invoke('mvp:back'),
  forward: () => ipcRenderer.invoke('mvp:forward'),
  reload: () => ipcRenderer.invoke('mvp:reload'),
  window: (action) => ipcRenderer.invoke('mvp:window', action),
  quit: () => ipcRenderer.invoke('mvp:quit'),
});

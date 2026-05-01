'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usualDeskTaskbarDot', {
  openDock: () => ipcRenderer.invoke('expand-dock-sidebar'),
});

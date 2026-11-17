'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profileRailPopup', {
  onData: (cb) => {
    ipcRenderer.on('profile-rail-popup-data', (_e, data) => {
      if (typeof cb === 'function') cb(data);
    });
  },
  choose: (id) => ipcRenderer.send('profile-rail-popup-result', id),
  cancel: () => ipcRenderer.send('profile-rail-popup-result', null),
  ready: () => ipcRenderer.send('profile-rail-popup-ready'),
  reportHeight: (height) => ipcRenderer.send('profile-rail-popup-height', height),
});

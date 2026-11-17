'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stripSearchPopup', {
  onData: (cb) => {
    ipcRenderer.on('strip-search-popup-data', (_e, data) => {
      if (typeof cb === 'function') cb(data);
    });
  },
  submit: (value) => ipcRenderer.send('strip-search-popup-result', { value: String(value || ''), commit: true }),
  cancel: () => ipcRenderer.send('strip-search-popup-result', { value: '', commit: false }),
  ready: () => ipcRenderer.send('strip-search-popup-ready'),
  reportHeight: (height) => ipcRenderer.send('strip-search-popup-height', height),
});

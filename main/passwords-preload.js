'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('passwords', {
  get: () => ipcRenderer.invoke('passwords-get'),
  reveal: (id) => ipcRenderer.invoke('passwords-reveal', String(id || '')),
  copyPassword: (id) => ipcRenderer.invoke('passwords-copy', { field: 'password', id: String(id || '') }),
  copyText: (text) => ipcRenderer.invoke('passwords-copy', { field: 'text', text: String(text || '') }),
  save: (entry) => ipcRenderer.invoke('passwords-manager-save', entry),
  remove: (id) => ipcRenderer.invoke('passwords-delete', String(id || '')),
  removeNeverSave: (origin) => ipcRenderer.invoke('passwords-never-remove', String(origin || '')),
  setSettings: (patch) => ipcRenderer.invoke('passwords-settings', patch),
  onChanged: (callback) => {
    ipcRenderer.on('passwords-changed', () => callback());
  },
});

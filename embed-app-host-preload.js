const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('embedAppHost', {
  action: (action) => ipcRenderer.invoke('embed-app-host-action', action),
  onStatus: (cb) => {
    ipcRenderer.on('embed-app-status', (_event, payload) => cb(payload));
  },
  onMaximized: (cb) => {
    ipcRenderer.on('embed-app-maximized', (_event, maximized) => cb(maximized === true));
  },
});

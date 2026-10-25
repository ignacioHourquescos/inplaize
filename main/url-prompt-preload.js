const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('urlPrompt', {
  submit: (url) => ipcRenderer.invoke('url-prompt-submit', url),
  cancel: () => ipcRenderer.send('url-prompt-cancel'),
});

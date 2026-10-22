'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('choicePrompt', {
  ready() {
    ipcRenderer.send('choice-prompt-ready');
  },
  onData(cb) {
    ipcRenderer.on('choice-prompt-data', (_event, data) => cb(data));
  },
  resize(width, height) {
    ipcRenderer.send('choice-prompt-resize', { width, height });
  },
  choose(choiceId, remember) {
    ipcRenderer.send('choice-prompt-result', { choiceId, remember });
  },
});

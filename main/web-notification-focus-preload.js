'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__usualDeskOnNotificationClick', () => {
  ipcRenderer.send('web-window-notification-click');
});

contextBridge.exposeInMainWorld('__usualDeskSaveNotificationDump', (text) =>
  ipcRenderer.invoke('save-web-notification-dump', text),
);

contextBridge.exposeInMainWorld('__usualDeskEmitInAppNotification', (id, data) => {
  ipcRenderer.send('in-app-notification-show', { id, ...(data && typeof data === 'object' ? data : {}) });
});

contextBridge.exposeInMainWorld('__usualDeskDismissInAppNotification', (id) => {
  ipcRenderer.send('in-app-notification-dismiss', id);
});

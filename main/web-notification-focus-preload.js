'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__usualDeskOnNotificationClick', () => {
  ipcRenderer.send('web-window-notification-click');
});

contextBridge.exposeInMainWorld('__usualDeskNoteNotification', () => {
  ipcRenderer.send('web-notification-shown');
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

/**
 * La dirección no se esconde al scrollear: en un acceso fijado esa barra
 * es la app (favicon + URL), no una pestaña más de la fila.
 */

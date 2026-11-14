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
 * La barra de dirección del acceso se comporta como un header de página:
 * baja el scroll y se esconde; sube, o volvés arriba, y reaparece.
 * Solo avisa a la ventana del acceso; el resto de las páginas lo ignora.
 */
(function watchPageScrollForUrlBar() {
  const DOWN = 28;
  const UP = 16;
  const tops = new WeakMap();
  let pending = 0;
  let hidden = false;
  let ignoreUntil = 0;

  function notify(hide) {
    if (hide === hidden) return;
    hidden = hide;
    pending = 0;
    try {
      ipcRenderer.send('detached-url-bar', hide);
    } catch {
      /* la página se está cerrando */
    }
  }

  function scrollerTop(target) {
    if (!target || target === document || target === document.documentElement || target === document.body) {
      const root = document.scrollingElement || document.documentElement;
      return root ? root.scrollTop || 0 : 0;
    }
    return typeof target.scrollTop === 'number' ? target.scrollTop : 0;
  }

  function isMainScroller(target) {
    if (!target || target === document || target === document.documentElement || target === document.body) {
      return true;
    }
    return typeof target.clientHeight === 'number' && target.clientHeight >= window.innerHeight * 0.55;
  }

  window.addEventListener('resize', () => {
    ignoreUntil = Date.now() + 280;
  });

  document.addEventListener('scroll', (event) => {
    if (Date.now() < ignoreUntil) return;
    const target = event.target;
    if (!isMainScroller(target)) return;
    const top = scrollerTop(target);
    const prev = tops.has(target) ? tops.get(target) : top;
    tops.set(target, top);
    if (top <= 2) {
      notify(false);
      return;
    }
    pending += top - prev;
    if (pending > DOWN) notify(true);
    else if (pending < -UP) notify(false);
  }, { capture: true, passive: true });
})();

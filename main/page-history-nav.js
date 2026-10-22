'use strict';

/**
 * Historial de la página embebida (BrowserView / WebContentsView).
 * Los botones de la franja, Alt+← / Alt+→ y los botones atrás/adelante del mouse
 * operan sobre la pestaña activa de esa ventana.
 */

function navSnapshot(wc) {
  if (!wc || wc.isDestroyed()) return { canGoBack: false, canGoForward: false };
  try {
    return { canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}

function goBack(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    if (!wc.canGoBack()) return false;
    wc.goBack();
    return true;
  } catch {
    return false;
  }
}

function goForward(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    if (!wc.canGoForward()) return false;
    wc.goForward();
    return true;
  } catch {
    return false;
  }
}

function isAltArrow(input) {
  if (!input || input.type !== 'keyDown') return false;
  if (!input.alt || input.control || input.meta || input.shift) return false;
  return input.key === 'ArrowLeft' || input.key === 'ArrowRight';
}

/**
 * Mouse atrás/adelante y Alt+flechas cuando el foco está en la franja.
 * Guarda el mismo `act` en la ventana para que la vista no navegue dos veces
 * si el evento llega también al BrowserView.
 * @param {Electron.BrowserWindow} win
 * @param {() => Electron.WebContents | null} getWebContents
 */
function attachWindowHistoryNav(win, getWebContents) {
  if (!win || win.isDestroyed() || win.__usualDeskWindowHistoryNav) return;
  win.__usualDeskWindowHistoryNav = true;

  let lastAt = 0;
  const act = (dir, event) => {
    const now = Date.now();
    if (now - lastAt < 200) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      return false;
    }
    const wc = typeof getWebContents === 'function' ? getWebContents() : null;
    const ok = dir === 'back' ? goBack(wc) : goForward(wc);
    if (!ok) return false;
    lastAt = now;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    return true;
  };
  win.__usualDeskHistoryAct = act;

  win.on('app-command', (event, cmd) => {
    if (cmd === 'browser-backward') act('back', event);
    else if (cmd === 'browser-forward') act('forward', event);
  });

  const chromeWc = win.webContents;
  if (chromeWc && !chromeWc.isDestroyed()) {
    chromeWc.on('before-input-event', (event, input) => {
      if (!isAltArrow(input)) return;
      act(input.key === 'ArrowLeft' ? 'back' : 'forward', event);
    });
  }
}

/**
 * El BrowserView a veces se queda con el botón atrás del mouse y la ventana no lo ve.
 * @param {Electron.BrowserView | Electron.WebContentsView} view
 * @param {Electron.BrowserWindow} win
 */
function attachViewHistoryNav(view, win) {
  if (!view || !win || view.__usualDeskViewHistoryNav) return;
  view.__usualDeskViewHistoryNav = true;
  if (typeof view.on !== 'function') return;
  try {
    view.on('app-command', (event, cmd) => {
      const act = win.__usualDeskHistoryAct;
      if (typeof act !== 'function') return;
      if (cmd === 'browser-backward') act('back', event);
      else if (cmd === 'browser-forward') act('forward', event);
    });
  } catch {
    /* WebContentsView no publica app-command; la ventana igual lo escucha. */
  }
}

/**
 * Alt+flechas con el foco en la página, y aviso cuando cambia el historial.
 * @param {Electron.WebContents} wc
 * @param {Electron.BrowserWindow} win
 * @param {{ isActive?: () => boolean, onChange?: (state: { canGoBack: boolean, canGoForward: boolean }) => void }} [hooks]
 */
function attachPageHistoryNav(wc, win, hooks = {}) {
  if (!wc || wc.isDestroyed() || wc.__usualDeskPageHistoryNav) return;
  wc.__usualDeskPageHistoryNav = true;

  const isActive = typeof hooks.isActive === 'function' ? hooks.isActive : null;
  const onChange = typeof hooks.onChange === 'function' ? hooks.onChange : null;

  const push = () => {
    if (wc.isDestroyed()) return;
    if (isActive && !isActive()) return;
    if (onChange) onChange(navSnapshot(wc));
  };
  wc.on('did-navigate', push);
  wc.on('did-navigate-in-page', push);
  wc.on('did-stop-loading', push);

  wc.on('before-input-event', (event, input) => {
    if (!isAltArrow(input)) return;
    if (isActive && !isActive()) return;
    const act = win && win.__usualDeskHistoryAct;
    if (typeof act !== 'function') return;
    act(input.key === 'ArrowLeft' ? 'back' : 'forward', event);
  });
}

module.exports = {
  navSnapshot,
  goBack,
  goForward,
  attachWindowHistoryNav,
  attachViewHistoryNav,
  attachPageHistoryNav,
};

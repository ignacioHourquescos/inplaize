'use strict';

/**
 * El menú de las ventanas web no puede ser un drawer HTML: la página es una
 * vista nativa y tapa el documento. Achicar esa vista para dejarle sitio
 * reacomoda la página (WhatsApp, sobre todo) y la animación se siente a tirones.
 * Este panel es otra vista, del mismo ancho del drawer, que se desliza por
 * encima. La página conserva su tamaño.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const { lockWindowZoom } = require('./lock-window-zoom');

/** Debe coincidir con .dock-home-menu-drawer { width } en shell-home-menu.css. */
const MENU_W = 240;
const SLIDE_MS = 280;

/** @type {WeakMap<Electron.BrowserWindow, OverlayEntry>} */
const overlays = new WeakMap();

/**
 * @typedef {{
 *   view: Electron.WebContentsView,
 *   open: boolean,
 *   ready: boolean,
 *   animating: boolean,
 *   token: number,
 *   editMode: boolean,
 * }} OverlayEntry
 */

function appRoot() {
  const besideMain = path.join(__dirname, '..');
  try {
    const root = app.getAppPath();
    if (root && fs.existsSync(path.join(root, 'menu-overlay.html'))) return root;
  } catch {
    /* el html vive junto al main cuando la app no está empaquetada así */
  }
  return besideMain;
}

function bez(t, p1, p2) {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function bezDeriv(t, p1, p2) {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** cubic-bezier(0.4, 0, 0.2, 1), la misma curva del drawer CSS. */
function ease(t) {
  let s = t;
  for (let i = 0; i < 5; i += 1) {
    const x = bez(s, 0.4, 0.2) - t;
    const dx = bezDeriv(s, 0.4, 0.2);
    if (Math.abs(dx) < 1e-4) break;
    s = Math.min(1, Math.max(0, s - x / dx));
  }
  return bez(s, 0, 1);
}

function contentBox(host) {
  const [w, h] = host.getContentSize();
  const width = Math.min(MENU_W, Math.max(0, w));
  return {
    width,
    h: Math.max(0, h),
    shownX: Math.max(0, w - width),
    hiddenX: Math.max(0, w),
  };
}

function hostForContents(contents) {
  if (!contents) return null;
  for (const win of BrowserWindow.getAllWindows()) {
    const entry = overlays.get(win);
    if (entry && entry.view.webContents === contents) return win;
  }
  return null;
}

function pushState(entry) {
  if (!entry.ready) return;
  const wc = entry.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send('menu-overlay-state', {
      open: entry.open === true,
      editMode: entry.editMode === true,
    });
  } catch {
    /* la vista se está cerrando */
  }
}

function syncHost(host, open) {
  if (!host || host.isDestroyed()) return;
  try {
    host.webContents.send('menu-overlay-apply', open === true);
  } catch {
    /* noop */
  }
}

function park(entry, host) {
  try {
    entry.view.setVisible(false);
  } catch {
    /* noop */
  }
  try {
    host.contentView.removeChildView(entry.view);
  } catch {
    /* noop */
  }
}

function raise(host) {
  const entry = overlays.get(host);
  if (!entry || host.isDestroyed()) return;
  if (!entry.open && !entry.animating) return;
  try {
    const kids = host.contentView.children;
    if (kids.length && kids[kids.length - 1] === entry.view) return;
    host.contentView.addChildView(entry.view);
  } catch {
    /* noop */
  }
}

function snapOpen(host) {
  const entry = overlays.get(host);
  if (!entry || !entry.open || entry.animating || host.isDestroyed()) return;
  try {
    if (!entry.view.getVisible()) return;
    const box = contentBox(host);
    entry.view.setBounds({ x: box.shownX, y: 0, width: box.width, height: box.h });
    raise(host);
  } catch {
    /* noop */
  }
}

function slide(host) {
  const entry = overlays.get(host);
  if (!entry || host.isDestroyed()) return;
  entry.token += 1;
  const token = entry.token;
  const startBox = contentBox(host);
  let startX = startBox.hiddenX;
  try {
    if (entry.view.getVisible()) startX = entry.view.getBounds().x;
  } catch {
    startX = startBox.hiddenX;
  }
  entry.animating = true;
  try {
    entry.view.setBounds({ x: startX, y: 0, width: startBox.width, height: startBox.h });
    host.contentView.addChildView(entry.view);
    entry.view.setVisible(true);
  } catch {
    entry.animating = false;
    return;
  }

  const t0 = Date.now();
  const step = () => {
    if (entry.token !== token || host.isDestroyed()) return;
    const box = contentBox(host);
    const t = Math.min(1, (Date.now() - t0) / SLIDE_MS);
    const endX = entry.open ? box.shownX : box.hiddenX;
    const x = Math.round(startX + (endX - startX) * ease(t));
    try {
      entry.view.setBounds({ x, y: 0, width: box.width, height: box.h });
      raise(host);
    } catch {
      /* noop */
    }
    if (t < 1) {
      setTimeout(step, 16);
      return;
    }
    entry.animating = false;
    if (!entry.open) {
      park(entry, host);
      return;
    }
    try {
      entry.view.setBounds({ x: box.shownX, y: 0, width: box.width, height: box.h });
    } catch {
      /* noop */
    }
  };
  setTimeout(step, 16);
}

function ensure(host) {
  const existing = overlays.get(host);
  if (existing) return existing;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(appRoot(), 'menu-overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor('#ff000000');
  view.setVisible(false);
  /** @type {OverlayEntry} */
  const entry = {
    view,
    open: false,
    ready: false,
    animating: false,
    token: 0,
    editMode: host.__menuOverlayEditMode === true,
  };
  overlays.set(host, entry);
  lockWindowZoom(view.webContents);
  view.webContents.loadFile(path.join(appRoot(), 'menu-overlay.html')).catch((err) => {
    console.error('menu-overlay', err);
  });
  host.on('resize', () => snapOpen(host));
  host.on('closed', () => {
    entry.token += 1;
    overlays.delete(host);
  });
  return entry;
}

function preload(host) {
  if (!host || host.isDestroyed()) return;
  ensure(host);
}

/**
 * @param {Electron.BrowserWindow} host
 * @param {boolean} open
 * @param {{ editMode?: boolean, source?: 'host' | 'overlay' }} [opts]
 */
function setOpen(host, open, opts = {}) {
  if (!host || host.isDestroyed()) return;
  const entry = ensure(host);
  if (opts.editMode != null) entry.editMode = opts.editMode === true;
  const next = open === true;
  const source = opts.source === 'overlay' ? 'overlay' : 'host';
  if (entry.open === next && !entry.animating) {
    if (next) {
      raise(host);
      snapOpen(host);
    }
    pushState(entry);
    if (source === 'overlay') syncHost(host, next);
    return;
  }
  entry.open = next;
  pushState(entry);
  if (source === 'overlay') syncHost(host, next);
  if (!entry.ready) return;
  slide(host);
}

/** Oculta el panel sin cambiar el estado del botón en la ventana (al salir de navegación suelta). */
function dismiss(host) {
  const entry = host ? overlays.get(host) : null;
  if (!entry || !host || host.isDestroyed()) return;
  entry.token += 1;
  entry.open = false;
  entry.animating = false;
  park(entry, host);
  pushState(entry);
}

function setEditMode(host, on) {
  if (!host || host.isDestroyed()) return;
  host.__menuOverlayEditMode = on === true;
  const entry = overlays.get(host);
  if (!entry) return;
  entry.editMode = on === true;
  const wc = entry.view.webContents;
  if (!entry.ready || !wc || wc.isDestroyed()) return;
  try {
    wc.send('shortcuts-edit-mode-sync', on === true);
  } catch {
    /* noop */
  }
}

function registerMenuOverlayIpc() {
  for (const ch of ['menu-overlay-ready', 'menu-overlay-set-open', 'menu-overlay-hide']) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* noop */
    }
  }
  ipcMain.removeAllListeners('menu-overlay-report');

  ipcMain.handle('menu-overlay-ready', (event) => {
    const host = hostForContents(event.sender);
    const entry = host ? overlays.get(host) : null;
    if (!entry) return { open: false, editMode: false };
    entry.ready = true;
    if (entry.open) slide(host);
    return { open: entry.open === true, editMode: entry.editMode === true };
  });

  ipcMain.on('menu-overlay-report', (event, open) => {
    const host = hostForContents(event.sender);
    if (!host) return;
    setOpen(host, open === true, { source: 'overlay' });
  });

  ipcMain.handle('menu-overlay-set-open', (event, payload) => {
    const host = BrowserWindow.fromWebContents(event.sender);
    if (!host || host.isDestroyed()) return false;
    const open = payload === true || !!(payload && payload.open === true);
    const editMode = !!(payload && payload.editMode === true);
    setOpen(host, open, { editMode, source: 'host' });
    return true;
  });

  ipcMain.handle('menu-overlay-hide', (event) => {
    const host = BrowserWindow.fromWebContents(event.sender);
    if (host) dismiss(host);
    return true;
  });
}

module.exports = {
  preload,
  setOpen,
  raise,
  dismiss,
  setEditMode,
  registerMenuOverlayIpc,
  MENU_W,
};

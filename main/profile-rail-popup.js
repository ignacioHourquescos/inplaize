'use strict';

/**
 * Menú de perfiles sobre la página (BrowserView) sin achicarla ni empujarla:
 * ventana hija frameless con el mismo slide-in del riel.
 */

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { brandWindow } = require('./app-identity');

let ipcReady = false;

/** @type {{ win: Electron.BrowserWindow, resolve: (id: unknown) => void, settled: boolean, payload: object } | null} */
let active = null;

function ensureIpc() {
  if (ipcReady) return;
  ipcReady = true;

  ipcMain.on('profile-rail-popup-ready', (event) => {
    if (!active || event.sender !== active.win.webContents) return;
    event.sender.send('profile-rail-popup-data', active.payload);
  });

  ipcMain.on('profile-rail-popup-height', (event, height) => {
    if (!active || event.sender !== active.win.webContents) return;
    const win = active.win;
    if (win.isDestroyed()) return;
    const h = Math.max(48, Math.min(360, Math.round(Number(height) || 0)));
    const b = win.getBounds();
    if (Math.abs(b.height - h) < 2) {
      if (!win.isVisible()) win.show();
      return;
    }
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
    if (!win.isVisible()) win.show();
  });

  ipcMain.on('profile-rail-popup-result', (event, id) => {
    if (!active || event.sender !== active.win.webContents) return;
    settle(id);
  });
}

function settle(id) {
  if (!active || active.settled) return;
  active.settled = true;
  const { win, resolve } = active;
  active = null;
  try {
    if (win && !win.isDestroyed()) win.close();
  } catch {
    /* noop */
  }
  resolve(id == null || id === '' ? null : id);
}

/**
 * @param {Electron.BrowserWindow} host
 * @param {{
 *   x?: number,
 *   y?: number,
 *   width?: number,
 *   items?: Array<{ id?: number, label?: string, detail?: string, icon?: string, shown?: boolean, active?: boolean }>,
 * }} payload
 * @returns {Promise<unknown>}
 */
function showProfileRailPopup(host, payload) {
  ensureIpc();
  if (!host || host.isDestroyed()) return Promise.resolve(null);
  if (active) settle(null);

  const items = payload && Array.isArray(payload.items) ? payload.items.slice(0, 24) : [];
  if (!items.length) return Promise.resolve(null);

  const content = host.getContentBounds();
  // Ancho que manda el renderer (logo → línea violeta); sin tope chico que lo achique distinto en cada ventana.
  const width = Math.max(180, Math.min(content.width, Math.round(Number(payload.width) || 280)));
  const x = content.x + Math.max(0, Math.round(Number(payload.x) || 0));
  const y = content.y + Math.max(0, Math.round(Number(payload.y) || 0));
  const guessH = Math.min(360, 16 + items.length * 52);

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: host,
      modal: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      width,
      height: guessH,
      x,
      y,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'profile-rail-popup-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    brandWindow(win);
    active = {
      win,
      resolve,
      settled: false,
      payload: { items },
    };

    win.on('blur', () => settle(null));
    win.on('closed', () => {
      if (active && active.win === win) settle(null);
    });

    win.loadFile(path.join(__dirname, 'profile-rail-popup.html')).catch(() => settle(null));
  });
}

module.exports = { showProfileRailPopup };

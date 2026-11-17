'use strict';

/**
 * Buscador de la franja: panel hijo con slide-in sobre la página, sin empujar
 * el BrowserView. Ancho = columna logo → línea violeta.
 */

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { brandWindow } = require('./app-identity');

let ipcReady = false;

/** @type {{ win: Electron.BrowserWindow, resolve: Function, settled: boolean, payload: object } | null} */
let active = null;

function ensureIpc() {
  if (ipcReady) return;
  ipcReady = true;

  ipcMain.on('strip-search-popup-ready', (event) => {
    if (!active || event.sender !== active.win.webContents) return;
    event.sender.send('strip-search-popup-data', active.payload);
  });

  ipcMain.on('strip-search-popup-height', (event, height) => {
    if (!active || event.sender !== active.win.webContents) return;
    const win = active.win;
    if (win.isDestroyed()) return;
    const h = Math.max(48, Math.min(120, Math.round(Number(height) || 56)));
    const b = win.getBounds();
    if (Math.abs(b.height - h) >= 2) {
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
    }
    if (!win.isVisible()) win.show();
  });

  ipcMain.on('strip-search-popup-result', (event, result) => {
    if (!active || event.sender !== active.win.webContents) return;
    settle(result && typeof result === 'object' ? result : { value: '', commit: false });
  });
}

function settle(result) {
  if (!active || active.settled) return;
  active.settled = true;
  const { win, resolve } = active;
  active = null;
  try {
    if (win && !win.isDestroyed()) win.close();
  } catch {
    /* noop */
  }
  resolve(result || { value: '', commit: false });
}

/**
 * @param {Electron.BrowserWindow} host
 * @param {{ x?: number, y?: number, width?: number, seed?: string, placeholder?: string }} payload
 * @returns {Promise<{ value: string, commit: boolean }>}
 */
function showStripSearchPopup(host, payload) {
  ensureIpc();
  if (!host || host.isDestroyed()) return Promise.resolve({ value: '', commit: false });
  if (active) settle({ value: '', commit: false });

  const content = host.getContentBounds();
  const width = Math.max(180, Math.min(content.width, Math.round(Number(payload.width) || 280)));
  const x = content.x + Math.max(0, Math.round(Number(payload.x) || 0));
  const y = content.y + Math.max(0, Math.round(Number(payload.y) || 0));

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
      height: 56,
      x,
      y,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'strip-search-popup-preload.js'),
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
      payload: {
        seed: typeof payload.seed === 'string' ? payload.seed : '',
        placeholder:
          typeof payload.placeholder === 'string' && payload.placeholder
            ? payload.placeholder
            : 'Buscá en Google o escribí un enlace',
      },
    };

    win.on('blur', () => settle({ value: '', commit: false }));
    win.on('closed', () => {
      if (active && active.win === win) settle({ value: '', commit: false });
    });

    win.loadFile(path.join(__dirname, 'strip-search-popup.html')).catch(() =>
      settle({ value: '', commit: false }),
    );
  });
}

module.exports = { showStripSearchPopup };

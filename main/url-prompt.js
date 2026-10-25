'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');

const PROMPT_W = 720;
const PROMPT_H = 96;

/** @type {Electron.BrowserWindow | null} */
let promptWin = null;
let ipcReady = false;
let allowBlurClose = false;

function visibleArea(host) {
  const bounds = host && !host.isDestroyed() ? host.getBounds() : null;
  const display = bounds
    ? screen.getDisplayMatching(bounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  if (!bounds) return wa;
  const x = Math.max(wa.x, bounds.x);
  const y = Math.max(wa.y, bounds.y);
  const right = Math.min(wa.x + wa.width, bounds.x + bounds.width);
  const bottom = Math.min(wa.y + wa.height, bounds.y + bounds.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function placePrompt(win, host) {
  const area = visibleArea(host);
  const width = Math.min(PROMPT_W, Math.max(320, area.width - 48));
  const height = PROMPT_H;
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  win.setBounds({
    x: Math.round(Math.max(area.x, Math.min(x, maxX))),
    y: Math.round(Math.max(area.y, Math.min(y, maxY))),
    width,
    height,
  });
}

function closePrompt() {
  allowBlurClose = false;
  const win = promptWin;
  promptWin = null;
  if (win && !win.isDestroyed()) win.close();
}

function ensureIpc() {
  if (ipcReady) return;
  ipcReady = true;

  ipcMain.handle('url-prompt-submit', async (event, raw) => {
    if (!promptWin || promptWin.isDestroyed() || event.sender !== promptWin.webContents) {
      return { ok: false, error: 'No se pudo abrir' };
    }
    try {
      const { openPastedUrl } = require('./open-shortcut');
      const res = await openPastedUrl(raw);
      if (res && res.ok) closePrompt();
      return res || { ok: false, error: 'No se pudo abrir' };
    } catch {
      return { ok: false, error: 'No se pudo abrir el enlace' };
    }
  });

  ipcMain.on('url-prompt-cancel', (event) => {
    if (!promptWin || promptWin.isDestroyed() || event.sender !== promptWin.webContents) return;
    closePrompt();
  });
}

/**
 * Barra chica, centrada en la ventana y dentro del área de trabajo
 * (no tapa la barra de tareas ni el resto de la pantalla).
 * @param {Electron.BrowserWindow | null} host
 */
function showUrlPrompt(host) {
  ensureIpc();
  const parent = host && !host.isDestroyed() ? host : null;
  if (promptWin && !promptWin.isDestroyed()) {
    placePrompt(promptWin, parent);
    promptWin.focus();
    return true;
  }

  allowBlurClose = false;
  const win = new BrowserWindow({
    width: PROMPT_W,
    height: PROMPT_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    parent: parent || undefined,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'url-prompt-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  promptWin = win;
  placePrompt(win, parent);

  win.on('blur', () => {
    if (!allowBlurClose || promptWin !== win) return;
    closePrompt();
  });
  win.on('closed', () => {
    if (promptWin === win) promptWin = null;
  });

  win.loadFile(path.join(__dirname, 'url-prompt.html')).then(() => {
    if (win.isDestroyed()) return;
    placePrompt(win, parent);
    win.show();
    win.focus();
    setTimeout(() => {
      if (promptWin === win) allowBlurClose = true;
    }, 250);
  }).catch(() => closePrompt());
  return true;
}

module.exports = { showUrlPrompt };

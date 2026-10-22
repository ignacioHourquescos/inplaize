'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { brandWindow } = require('./app-identity');

const CARD_WIDTH = 400;

let ipcReady = false;

/** @type {Array<{ opts: object, resolve: (value: { choiceId: string | null, remember: boolean }) => void, settled: boolean }>} */
const queue = [];

/** @type {{ win: Electron.BrowserWindow, job: { opts: object, resolve: Function, settled: boolean }, host: Electron.BrowserWindow | null } | null} */
let active = null;

function ensureIpc() {
  if (ipcReady) return;
  ipcReady = true;

  ipcMain.on('choice-prompt-ready', (event) => {
    if (!active || event.sender !== active.win.webContents) return;
    event.sender.send('choice-prompt-data', viewPayload(active.job.opts));
  });

  ipcMain.on('choice-prompt-resize', (event, size) => {
    if (!active || event.sender !== active.win.webContents) return;
    const win = active.win;
    if (win.isDestroyed()) return;
    const host = active.host && !active.host.isDestroyed() ? active.host : null;
    const area = host
      ? host.getBounds()
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const display = screen.getDisplayMatching(area);
    const maxWidth = Math.max(280, display.workArea.width - 24);
    const maxHeight = Math.max(180, display.workArea.height - 24);
    const width = Math.min(
      maxWidth,
      Math.max(320, Math.round(size && size.width ? size.width : CARD_WIDTH))
    );
    const height = Math.min(
      maxHeight,
      Math.max(160, Math.round(size && size.height ? size.height : 280))
    );
    const x = Math.round(area.x + (area.width - width) / 2);
    const y = Math.round(area.y + Math.max(24, (area.height - height) / 2));
    win.setBounds({
      x: Math.max(display.workArea.x, x),
      y: Math.max(display.workArea.y, y),
      width,
      height,
    });
    if (active) {
      active.job.shown = true;
      clearShowTimer(active.job);
    }
    if (!win.isVisible()) {
      win.show();
      win.setAlwaysOnTop(true, 'floating');
      win.focus();
    }
  });

  ipcMain.on('choice-prompt-result', (event, result) => {
    if (!active || event.sender !== active.win.webContents) return;
    settle(result);
  });
}

/**
 * @param {object} opts
 */
function viewPayload(opts) {
  const choices = Array.isArray(opts.choices) ? opts.choices : [];
  return {
    message: typeof opts.message === 'string' ? opts.message : '',
    detail: typeof opts.detail === 'string' ? opts.detail : '',
    choices: choices
      .filter((c) => c && typeof c.id === 'string')
      .map((c) => ({
        id: c.id,
        label: typeof c.label === 'string' && c.label ? c.label : 'Usuario',
        hint: typeof c.hint === 'string' ? c.hint : '',
      })),
    cancelLabel: typeof opts.cancelLabel === 'string' && opts.cancelLabel ? opts.cancelLabel : 'Cancelar',
    rememberLabel: typeof opts.rememberLabel === 'string' ? opts.rememberLabel : '',
  };
}

function clearShowTimer(job) {
  if (job && job.showTimer) {
    clearTimeout(job.showTimer);
    job.showTimer = null;
  }
}

/**
 * @param {{ choiceId?: unknown, remember?: unknown } | null} result
 */
function settle(result) {
  const current = active;
  if (!current || current.job.settled) return;
  current.job.settled = true;
  current.job.shown = true;
  clearShowTimer(current.job);
  active = null;

  const allowed = new Set(
    (Array.isArray(current.job.opts.choices) ? current.job.opts.choices : [])
      .filter((c) => c && typeof c.id === 'string')
      .map((c) => c.id)
  );
  const rawId = result && typeof result.choiceId === 'string' ? result.choiceId : null;
  const choiceId = rawId && allowed.has(rawId) ? rawId : null;
  const remember = !!(result && result.remember && choiceId);
  try {
    current.job.resolve({ choiceId, remember });
  } catch {
    /* noop */
  }
  if (current.win && !current.win.isDestroyed()) {
    current.win.close();
  }
  pump();
}

function pump() {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  openJob(job);
}

/**
 * @param {{ opts: object, resolve: Function, settled: boolean }} job
 */
function openJob(job) {
  ensureIpc();
  const host =
    job.opts.hostWindow && !job.opts.hostWindow.isDestroyed() ? job.opts.hostWindow : null;
  const win = new BrowserWindow({
    width: CARD_WIDTH + 56,
    height: 320,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    parent: host || undefined,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'choice-prompt-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  brandWindow(win);
  active = { win, job, host };
  const showTimer = setTimeout(() => {
    if (active && active.win === win && !job.shown) settle(null);
  }, 8000);
  job.showTimer = showTimer;

  win.on('closed', () => {
    clearShowTimer(job);
    if (!active || active.win !== win) return;
    active = null;
    if (!job.settled) {
      job.settled = true;
      try {
        job.resolve({ choiceId: null, remember: false });
      } catch {
        /* noop */
      }
    }
    pump();
  });

  win.loadFile(path.join(__dirname, 'choice-prompt.html')).catch(() => {
    settle(null);
  });
}

/**
 * Tarjeta propia para elegir una opción (en lugar del diálogo nativo de Windows).
 * @param {{
 *   hostWindow?: Electron.BrowserWindow | null,
 *   message: string,
 *   detail?: string,
 *   choices: Array<{ id: string, label: string }>,
 *   cancelLabel: string,
 *   rememberLabel?: string,
 * }} opts
 * @returns {Promise<{ choiceId: string | null, remember: boolean }>}
 */
function askChoice(opts) {
  return new Promise((resolve) => {
    queue.push({ opts: opts || {}, resolve, settled: false });
    pump();
  });
}

module.exports = { askChoice };

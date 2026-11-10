'use strict';

/**
 * Gestor de contraseñas de la navegación suelta: ofrece guardar los logins que
 * detecta el preload de las pestañas, los completa al volver al sitio y abre
 * la ventana para verlos, editarlos o borrarlos.
 */

const path = require('path');
const { BrowserWindow, ipcMain, clipboard } = require('electron');
const { brandWindow } = require('./app-identity');
const { askChoice } = require('./choice-prompt');
const store = require('./password-store');

const PAGE_PRELOAD = path.join(__dirname, 'password-autofill-preload.js');
/** Si la clave copiada sigue en el portapapeles a los 30 s, se borra. */
const CLIPBOARD_CLEAR_MS = 30 * 1000;

/** @type {Electron.BrowserWindow | null} */
let managerWin = null;
/** @type {() => Electron.BrowserWindow | null} */
let hostWindow = () => null;
/** Logins con el aviso abierto, para no preguntar dos veces por el mismo. */
const asking = new Set();

/** @param {Electron.WebContents} wc */
function originOfSender(wc) {
  try {
    return store.originOf(wc.getURL());
  } catch {
    return '';
  }
}

/** @param {string} origin */
function siteLabel(origin) {
  try {
    return new URL(origin).host.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

/** @param {string} origin @param {string} username @param {string} password */
async function offerToSave(origin, username, password) {
  if (!store.settings().offerToSave || store.isNeverSave(origin) || !store.canEncrypt()) return;
  const action = store.pendingAction(origin, username, password);
  if (action === 'none') return;
  const key = `${origin}\n${username}`;
  if (asking.has(key)) return;
  asking.add(key);
  try {
    const site = siteLabel(origin);
    const { choiceId } = await askChoice({
      hostWindow: hostWindow(),
      message: action === 'update' ? '¿Actualizar la contraseña?' : '¿Guardar la contraseña?',
      detail: `${site} · ${username || 'sin usuario'}`,
      choices: [
        {
          id: 'save',
          label: action === 'update' ? 'Actualizar' : 'Guardar',
          hint: 'Se completa sola la próxima vez',
        },
        { id: 'never', label: 'Nunca para este sitio', hint: site },
      ],
      cancelLabel: 'Ahora no',
    });
    if (choiceId === 'save') store.upsert(origin, username, password);
    else if (choiceId === 'never') store.addNeverSave(origin);
  } finally {
    asking.delete(key);
  }
}

/** @param {Electron.IpcMainEvent | Electron.IpcMainInvokeEvent} event */
function fromManager(event) {
  return !!managerWin && !managerWin.isDestroyed() && event.sender === managerWin.webContents;
}

function managerPayload() {
  return {
    credentials: store.list(),
    neverSave: store.neverSaveList(),
    settings: store.settings(),
    canEncrypt: store.canEncrypt(),
  };
}

let clipboardTimer = null;

/** @param {string} text */
function copySecret(text) {
  clipboard.writeText(text);
  if (clipboardTimer) clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(() => {
    clipboardTimer = null;
    if (clipboard.readText() === text) clipboard.clear();
  }, CLIPBOARD_CLEAR_MS);
}

/** @param {Electron.BrowserWindow | null} parent */
function openPasswordManager(parent) {
  if (managerWin && !managerWin.isDestroyed()) {
    if (managerWin.isMinimized()) managerWin.restore();
    managerWin.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    show: false,
    title: 'Gestor de contraseñas',
    autoHideMenuBar: true,
    backgroundColor: '#121216',
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'passwords-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  brandWindow(win);
  win.setMenu(null);
  managerWin = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (managerWin === win) managerWin = null;
  });
  win.loadFile(path.join(__dirname, 'passwords.html')).catch(() => {});
}

let ipcRegistered = false;

/** @param {{ host?: () => Electron.BrowserWindow | null }} [opts] */
function registerPasswordIpc(opts = {}) {
  if (typeof opts.host === 'function') hostWindow = opts.host;
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('password-captured', (event, payload) => {
    const origin = originOfSender(event.sender);
    const p = payload && typeof payload === 'object' ? payload : {};
    const password = typeof p.password === 'string' ? p.password : '';
    const username = typeof p.username === 'string' ? p.username.trim().slice(0, 320) : '';
    if (!origin || !password || password.length > 512) return;
    offerToSave(origin, username, password).catch(() => {});
  });

  ipcMain.handle('password-fill-request', (event) => {
    const origin = originOfSender(event.sender);
    if (!origin || !store.settings().autofill) return [];
    return store.forOrigin(origin);
  });

  ipcMain.on('password-filled', (_event, id) => {
    if (typeof id === 'string') store.markUsed(id);
  });

  ipcMain.handle('passwords-get', (event) => (fromManager(event) ? managerPayload() : null));

  ipcMain.handle('passwords-reveal', (event, id) =>
    fromManager(event) && typeof id === 'string' ? store.reveal(id) : ''
  );

  ipcMain.handle('passwords-copy', (event, payload) => {
    if (!fromManager(event)) return false;
    const p = payload && typeof payload === 'object' ? payload : {};
    if (p.field === 'password') copySecret(store.reveal(String(p.id || '')));
    else clipboard.writeText(String(p.text || ''));
    return true;
  });

  ipcMain.handle('passwords-manager-save', (event, payload) => {
    if (!fromManager(event)) return { ok: false };
    const p = payload && typeof payload === 'object' ? payload : {};
    const password = typeof p.password === 'string' ? p.password : '';
    const username = typeof p.username === 'string' ? p.username.trim() : '';
    try {
      if (p.id) {
        store.update(String(p.id), { username, password });
      } else {
        const raw = String(p.site || '').trim();
        const origin = store.originOf(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (!origin) return { ok: false, error: 'El sitio no es una dirección válida' };
        if (!password) return { ok: false, error: 'Falta la contraseña' };
        store.upsert(origin, username, password);
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    return { ok: true };
  });

  ipcMain.handle('passwords-delete', (event, id) =>
    fromManager(event) && typeof id === 'string' ? store.remove(id) : false
  );

  ipcMain.handle('passwords-never-remove', (event, origin) => {
    if (!fromManager(event) || typeof origin !== 'string') return false;
    store.removeNeverSave(origin);
    return true;
  });

  ipcMain.handle('passwords-settings', (event, patch) => {
    if (!fromManager(event) || !patch || typeof patch !== 'object') return false;
    const next = {};
    if (typeof patch.offerToSave === 'boolean') next.offerToSave = patch.offerToSave;
    if (typeof patch.autofill === 'boolean') next.autofill = patch.autofill;
    store.updateSettings(next);
    return true;
  });
}

module.exports = {
  PAGE_PRELOAD,
  openPasswordManager,
  registerPasswordIpc,
  settings: store.settings,
  updateSettings: store.updateSettings,
};

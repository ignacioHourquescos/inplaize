'use strict';

/**
 * Identidad fija de la app en el sistema (barra de tareas, Alt+Tab, título nativo).
 * El título de cada sitio sigue viviendo en las pestañas; la ventana del SO no lo hereda.
 */

const fs = require('fs');
const path = require('path');
const { app, nativeImage, shell } = require('electron');

const APP_NAME = 'inplaize';
const APP_ID = 'com.inplaize.app';

function appRoot() {
  const unpacked = path.join(__dirname, '..');
  try {
    const fromApp = app.getAppPath();
    if (fromApp && fs.existsSync(path.join(fromApp, 'package.json'))) return fromApp;
  } catch {
    /* desarrollo: la raíz es la carpeta de este archivo */
  }
  return unpacked;
}

function appIconIco() {
  return path.join(appRoot(), 'assets', 'icon.ico');
}

function appIconFile() {
  const ico = appIconIco();
  const png = path.join(appRoot(), 'assets', 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return ico;
}

/**
 * En desarrollo el proceso es electron.exe, y Windows pinta ESE ícono en la barra.
 * El de la ventana solo aparece en la miniatura. La barra usa el acceso del menú
 * Inicio cuyo AppUserModelID coincide con el de la app.
 * @returns {boolean}
 */
function installWindowsTaskbarShortcut() {
  if (process.platform !== 'win32' || app.isPackaged) return false;
  const ico = appIconIco();
  if (!fs.existsSync(ico)) return false;
  const root = appRoot();
  const shortcutPath = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'inplaize.lnk',
  );
  const options = {
    target: process.execPath,
    cwd: root,
    args: `"${root}"`,
    description: APP_NAME,
    icon: ico,
    iconIndex: 0,
    appUserModelId: APP_ID,
  };
  const op = fs.existsSync(shortcutPath) ? 'replace' : 'create';
  try {
    return shell.writeShortcutLink(shortcutPath, op, options);
  } catch {
    return false;
  }
}

/** @type {Electron.NativeImage | null} */
let cachedIcon = null;

function appIconImage() {
  if (cachedIcon && !cachedIcon.isEmpty()) return cachedIcon;
  try {
    const img = nativeImage.createFromPath(appIconFile());
    if (!img.isEmpty()) cachedIcon = img;
    return img;
  } catch {
    return nativeImage.createEmpty();
  }
}

/**
 * Título e ícono de inplaize. Ignora el <title> de la página cargada en la ventana.
 * @param {Electron.BrowserWindow | null | undefined} win
 */
function brandWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const img = appIconImage();
    if (img && !img.isEmpty()) win.setIcon(img);
  } catch {
    /* noop */
  }
  const lockTitle = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (win.isDestroyed()) return;
    try {
      if (win.getTitle() !== APP_NAME) win.setTitle(APP_NAME);
    } catch {
      /* noop */
    }
  };
  lockTitle();
  win.on('page-title-updated', lockTitle);
  if (process.platform === 'win32' && typeof win.setAppDetails === 'function') {
    try {
      win.setAppDetails({
        appId: APP_ID,
        appIconPath: appIconIco(),
        appIconIndex: 0,
        relaunchDisplayName: APP_NAME,
        relaunchCommand: `"${process.execPath}" ${app.isPackaged ? '' : `"${appRoot()}"`}`.trim(),
      });
    } catch {
      /* noop */
    }
  }
}

module.exports = {
  APP_NAME,
  APP_ID,
  appIconFile,
  appIconIco,
  brandWindow,
  installWindowsTaskbarShortcut,
};

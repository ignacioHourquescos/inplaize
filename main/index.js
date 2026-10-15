'use strict';

require('./configure-user-data');

const fs = require('fs');
const path = require('path');
const { app, screen, BrowserWindow, shell, powerMonitor } = require('electron');
const { log } = require('./logger');
const { APP_ID, appIconIco, installWindowsTaskbarShortcut } = require('./app-identity');

/** Nombre fijo antes de ready: si no, Windows muestra el del ejecutable (Electron) o uno viejo. */
app.setName('inplaize');
/** Windows: nombre/icono correctos en toasts y mejor correlación ventana ↔ notificación (mismo appId que electron-builder). */
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}
const { createDockWindow } = require('./dock-window');
const { registerIpcHandlers } = require('./ipc-handlers');
const { registerDockGlobalShortcut, unregisterDockGlobalShortcut } = require('./global-hotkey');

const state = {
  mainWindow: null,
  isExpanded: false,
};

function createWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  createDockWindow(display, state);
}

/**
 * Inicio con Windows: un .lnk en la carpeta Inicio es más fiable que solo el registro Run.
 * En modo desarrollo, el ejecutable es electron.exe y hay que pasar la ruta del proyecto.
 */
function enableAutoStart() {
  try {
    if (process.platform === 'win32' && app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: false });
      } catch {
        /* evita doble inicio si quedó una entrada vieja en el registro */
      }
      const startupDir = path.join(
        process.env.APPDATA,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
      );
      const shortcutPath = path.join(startupDir, 'inplaize.lnk');
      const exe = process.execPath;
      const options = {
        target: exe,
        cwd: path.dirname(exe),
        description: 'inplaize',
        icon: appIconIco(),
        iconIndex: 0,
        appUserModelId: APP_ID,
      };
      const op = fs.existsSync(shortcutPath) ? 'update' : 'create';
      const ok = shell.writeShortcutLink(shortcutPath, op, options);
      log(`Inicio automático (Windows): acceso directo ${op} → ${shortcutPath} (ok=${ok})`);
      return;
    }

    const settings = {
      openAtLogin: true,
      name: 'inplaize',
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(__dirname, '..')],
    };
    app.setLoginItemSettings(settings);
    const st = app.getLoginItemSettings();
    log(
      `Inicio automático: openAtLogin=${st.openAtLogin} ejecutable=${st.executablePath || '(n/d)'}`,
    );
  } catch (err) {
    log(`No se pudo configurar el inicio automático: ${err?.message || err}`);
  }
}

app.whenReady().then(() => {
  if (process.platform === 'win32' && !app.isPackaged) {
    const ok = installWindowsTaskbarShortcut();
    log(`Acceso de barra de tareas (inplaize): ok=${ok}`);
  }
  const { raiseAppFromGlobalHotkey } = registerIpcHandlers(state);
  log(`App started — userData: ${app.getPath('userData')}`);
  enableAutoStart();

  createWindow();

  registerDockGlobalShortcut(state, raiseAppFromGlobalHotkey, createWindow);

  try {
    powerMonitor.on('resume', () => {
      registerDockGlobalShortcut(state, raiseAppFromGlobalHotkey, createWindow);
    });
  } catch {
    /* powerMonitor no disponible en algunos entornos */
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  unregisterDockGlobalShortcut();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

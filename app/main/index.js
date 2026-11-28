'use strict';

const path = require('path');
const { app, globalShortcut } = require('electron');

const ACCELERATORS = ['Control+Alt+D', 'Control+Shift+D'];

app.setName('inplaize');
app.setPath('userData', path.join(app.getPath('appData'), 'inplaize-mvp'));

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  const session = require('./session');
  const views = require('./views');
  const { registerIpc } = require('./ipc');

  app.on('second-instance', () => {
    views.showDock();
  });

  app.whenReady().then(() => {
    session.init(app.getPath('userData'));
    session.setNotifier(() => views.refresh());
    registerIpc();
    views.createDock();

    for (const accelerator of ACCELERATORS) {
      try {
        if (globalShortcut.register(accelerator, () => views.toggleGlobal())) break;
      } catch {
        /* el sistema se quedó con esa combinación */
      }
    }

    if (process.env.INPLAIZE_SMOKE === '1') {
      console.log('mvp-ready');
      setTimeout(() => app.exit(0), 700);
    }

    if (process.env.INPLAIZE_SHOT) {
      const { BrowserWindow } = require('electron');
      const fs = require('fs');
      setTimeout(async () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) {
          app.exit(1);
          return;
        }
        const home = await win.webContents.capturePage();
        fs.writeFileSync(process.env.INPLAIZE_SHOT, home.toPNG());
        await win.webContents.executeJavaScript(`document.getElementById('chevron').click()`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const bar = await win.webContents.capturePage();
        fs.writeFileSync(process.env.INPLAIZE_SHOT.replace(/\.png$/, '-bar.png'), bar.toPNG());
        console.log('mvp-shot');
        app.exit(0);
      }, 900);
    }
  });

  app.on('will-quit', () => {
    try {
      session.persist();
    } catch {
      /* sin carpeta de datos */
    }
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

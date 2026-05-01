'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, BrowserView, session, app, ipcMain } = require('electron');
const { webMapKey } = require('./web-map-key');
const { loadShortcuts } = require('./shortcuts-store');
const DETACHED_CHROME_H = 52;

const WEB_NOTIFICATION_FOCUS_PRELOAD = path.join(__dirname, 'web-notification-focus-preload.js');

function appRoot() {
  try {
    return app.getAppPath();
  } catch {
    return path.join(__dirname, '..');
  }
}

function iconFromShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return '';
  const icon = shortcut.icon;
  return typeof icon === 'string' ? icon.trim() : '';
}

/**
 * @param {import('./shortcuts-store').Shortcut | Record<string, unknown>} shortcut
 * @returns {string | null}
 */
function resolveShortcutIconPathForHost(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return null;
  const icon = typeof shortcut.icon === 'string' ? shortcut.icon.trim() : '';
  if (!icon || /^https?:\/\//i.test(icon) || icon.startsWith('data:')) return null;
  let root;
  try {
    root = app.getAppPath();
  } catch {
    root = path.join(__dirname, '..');
  }
  const normalized = icon.replace(/\\/g, '/');
  const abs = path.isAbsolute(icon) ? icon : path.join(root, normalized.replace(/^\//, ''));
  try {
    if (fs.existsSync(abs) && /\.(png|ico|jpe?g|gif|webp)$/i.test(abs)) return abs;
  } catch {
    return null;
  }
  return null;
}

function buildDetachedChromePayload(activeMapKey) {
  const { getOpenWebWindowKeys } = require('./open-shortcut');
  const openKeys = new Set(getOpenWebWindowKeys());
  let focusState = { active: false, members: [] };
  try {
    focusState = require('./focus-mode').getState();
  } catch {
    /* noop */
  }
  const memberSet = new Set(focusState.members);
  const shortcuts = loadShortcuts();
  const items = shortcuts.map((s) => {
    const name = (s.name && String(s.name)) || '';
    const icon = iconFromShortcut(s);
    if (s.type === 'web') {
      const mk = webMapKey(s);
      return {
        id: String(s.id),
        type: 'web',
        name,
        icon,
        mapKey: mk,
        isOpen: openKeys.has(mk),
        isActive: mk === activeMapKey,
        isFocusMember: memberSet.has(mk),
      };
    }
    return {
      id: String(s.id),
      type: 'app',
      name,
      icon,
      mapKey: null,
      isOpen: false,
      isActive: false,
      isFocusMember: false,
    };
  });
  return { items, focusMode: focusState };
}

function broadcastChromeToAllDetachedHosts() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed() || !w.__usualDeskDetachedChromeHost) continue;
    const own = w.__usualDeskDetachedOwnMapKey;
    try {
      w.webContents.send('detached-chrome', buildDetachedChromePayload(typeof own === 'string' ? own : ''));
    } catch {
      /* noop */
    }
  }
}

function broadcastTitleBadgeToDetachedHosts(shortcutId, count) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed() || !w.__usualDeskDetachedChromeHost) continue;
    try {
      w.webContents.send('detached-title-badge', { shortcutId, count });
    } catch {
      /* noop */
    }
  }
}

function layoutDetachedView(hostWin, view) {
  if (!hostWin || hostWin.isDestroyed() || !view) return;
  const [w, h] = hostWin.getContentSize();
  view.setBounds({
    x: 0,
    y: DETACHED_CHROME_H,
    width: w,
    height: Math.max(0, h - DETACHED_CHROME_H),
  });
}

function registerDetachedFrameIpc() {
  try {
    ipcMain.removeHandler('detached-frame-action');
  } catch {
    /* noop */
  }
  ipcMain.handle('detached-frame-action', async (event, action, arg) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !win.__usualDeskDetachedChromeHost) return null;

    switch (action) {
      case 'get-chrome':
        return buildDetachedChromePayload(win.__usualDeskDetachedOwnMapKey);
      case 'activate': {
        const id = arg == null ? '' : String(arg);
        if (!id) return false;
        const list = loadShortcuts();
        const s = list.find((x) => String(x.id) === id);
        if (!s) return false;
        const { openShortcut } = require('./open-shortcut');
        await openShortcut(s);
        return true;
      }
      case 'close-tab': {
        const mk = String(arg || '');
        if (!mk) return false;
        const { closeWebWindowByMapKey } = require('./open-shortcut');
        closeWebWindowByMapKey(mk);
        return true;
      }
      case 'minimize':
        if (!win.isDestroyed()) win.minimize();
        return true;
      case 'toggle-maximize':
        if (win.isDestroyed()) return false;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return win.isMaximized();
      case 'close-window':
        if (!win.isDestroyed()) win.close();
        return true;
      default:
        return null;
    }
  });
}

function isWhatsAppWeb(url) {
  try {
    return new URL(url).hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

function chromeLikeUserAgent() {
  const chrome = process.versions.chrome;
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

/**
 * @param {import('./shortcuts-store').Shortcut} shortcut
 * @param {string} mapKey
 * @param {string} partition
 */
async function createDetachedWebHostWindow(shortcut, mapKey, partition) {
  const { attachWebShortcutEmbeddedWebContents, setWebWindowForMapKey, deleteWebWindowForMapKey } =
    require('./open-shortcut');

  if (isWhatsAppWeb(shortcut.url)) {
    session.fromPartition(partition).setUserAgent(chromeLikeUserAgent());
  }

  const root = appRoot();
  const useFramelessChrome = process.platform === 'win32' || process.platform === 'linux';

  const host = new BrowserWindow({
    show: false,
    fullscreen: false,
    fullscreenable: false,
    frame: !useFramelessChrome,
    title: shortcut.name || 'inplaze',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(root, 'detached-web-frame-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  host.__usualDeskDetachedChromeHost = true;
  host.__usualDeskDetachedOwnMapKey = mapKey;

  setWebWindowForMapKey(mapKey, host);

  const iconAbs = resolveShortcutIconPathForHost(shortcut);
  if (iconAbs) {
    try {
      host.setIcon(iconAbs);
    } catch {
      /* noop */
    }
  }

  try {
    host.removeMenu();
  } catch {
    try {
      host.setMenu(null);
    } catch {
      /* noop */
    }
  }

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition,
      preload: WEB_NOTIFICATION_FOCUS_PRELOAD,
    },
  });
  try {
    if (typeof view.setBackgroundColor === 'function') {
      view.setBackgroundColor('#000000');
    }
  } catch {
    /* noop */
  }

  const wc = view.webContents;
  host.__usualDeskHostedWebContents = wc;

  attachWebShortcutEmbeddedWebContents(wc, shortcut, mapKey);

  wc.setAudioMuted(!!shortcut.audioMuted);

  const onResize = () => layoutDetachedView(host, view);
  host.on('resize', onResize);

  host.on('close', () => {
    try {
      host.removeBrowserView(view);
    } catch {
      /* noop */
    }
    try {
      if (!wc.isDestroyed() && typeof wc.destroy === 'function') wc.destroy();
    } catch {
      /* noop */
    }
  });

  try {
    await host.loadFile(path.join(root, 'detached-web-frame.html'));

    try {
      host.addBrowserView(view);
    } catch {
      /* noop */
    }
    layoutDetachedView(host, view);

    host.webContents.once('did-finish-load', () => {
      try {
        host.webContents.send('detached-chrome', buildDetachedChromePayload(mapKey));
      } catch {
        /* noop */
      }
    });

    function sendMaximized() {
      if (!host || host.isDestroyed()) return;
      try {
        host.webContents.send('detached-window-maximized', host.isMaximized());
      } catch {
        /* noop */
      }
    }

    host.on('maximize', sendMaximized);
    host.on('unmaximize', sendMaximized);

    host.once('ready-to-show', () => {
      if (!host.isDestroyed()) {
        host.maximize();
        host.show();
        sendMaximized();
      }
    });

    await wc.loadURL(shortcut.url || 'about:blank');
    if (!wc.isDestroyed()) {
      wc.setAudioMuted(!!shortcut.audioMuted);
    }

    wc.once('did-finish-load', () => {
      if (!wc.isDestroyed()) wc.setAudioMuted(!!shortcut.audioMuted);
    });

    broadcastChromeToAllDetachedHosts();
    return host;
  } catch (err) {
    try {
      deleteWebWindowForMapKey(mapKey);
    } catch {
      /* noop */
    }
    if (!host.isDestroyed()) host.destroy();
    throw err;
  }
}

module.exports = {
  createDetachedWebHostWindow,
  registerDetachedFrameIpc,
  broadcastChromeToAllDetachedHosts,
  broadcastTitleBadgeToDetachedHosts,
  buildDetachedChromePayload,
};

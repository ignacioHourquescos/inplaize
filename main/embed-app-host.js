'use strict';

/**
 * Abre un ejecutable de escritorio dentro de la ventana que ya tiene la barra
 * de inplaize. Electron no acepta ser hija (recrea el HWND y se sale): queda
 * owned, debajo de la barra, sin botón propio en la barra de tareas.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const { log } = require('./logger');
const { brandWindow, appIconFile } = require('./app-identity');
const { forceWindowForeground } = require('./window-focus');
const win32 = require('./win32-window');

/** Alto de la barra propia, en píxeles CSS. Tiene que coincidir con embed-app-host.css. */
const EMBED_CHROME_DIP = 40;

const FIND_TIMEOUT_MS = 20000;
const FIT_INTERVAL_MS = 100;

/** @type {Map<string, EmbedSession>} */
const sessions = new Map();

let ipcReady = false;
let quitHooked = false;

/**
 * @typedef {object} AppLaunch
 * @property {string} target
 * @property {string[]} args
 * @property {string} cwd
 * @property {string[]} names
 * @property {string} label
 * @property {string} key
 */

/**
 * @typedef {object} EmbedSession
 * @property {string} key
 * @property {AppLaunch} launch
 * @property {Electron.BrowserWindow} win
 * @property {bigint} hostHwnd
 * @property {bigint} guest
 * @property {import('./win32-window').captureWindowChrome extends Function ? ReturnType<typeof import('./win32-window').captureWindowChrome> | null : null} saved
 * @property {boolean} closing
 * @property {boolean} detached
 * @property {number} adoptAttempts
 * @property {number} startedAt
 * @property {boolean} spawned
 * @property {boolean} shared
 * @property {boolean} suspended
 * @property {'child' | 'owned'} embedMode
 * @property {ReturnType<typeof setInterval> | null} timer
 * @property {{ title: string, text: string, error: boolean }} status
 */

function note(msg) {
  const line = `[embed-app] ${msg}`;
  log(line);
  console.log(line);
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match = re.exec(text);
  while (match) {
    out.push(match[1] != null ? match[1] : match[2]);
    match = re.exec(text);
  }
  return out;
}

/**
 * @param {import('./shortcuts-store').Shortcut | Record<string, unknown>} shortcut
 * @returns {AppLaunch}
 */
function resolveLaunch(shortcut) {
  let target = shortcut && typeof shortcut.url === 'string' ? shortcut.url.trim() : '';
  if (!target) throw new Error('El acceso no tiene ejecutable');

  let args = [];
  let cwd = '';
  if (path.extname(target).toLowerCase() === '.lnk') {
    const link = shell.readShortcutLink(target);
    if (!link || !link.target) throw new Error('No se pudo leer el acceso directo');
    target = link.target;
    cwd = typeof link.cwd === 'string' ? link.cwd : '';
    args = splitArgs(typeof link.args === 'string' ? link.args : '');
  }

  if (!fs.existsSync(target)) throw new Error(`No existe el ejecutable: ${target}`);
  if (!cwd || !fs.existsSync(cwd)) cwd = path.dirname(target);

  const names = new Set();
  names.add(path.basename(target).toLowerCase());
  for (const arg of args) {
    const found = String(arg).match(/([^\\/:*?"<>|\s]+\.exe)/i);
    if (found) names.add(found[1].toLowerCase());
  }

  const label =
    shortcut && typeof shortcut.name === 'string' && shortcut.name.trim()
      ? shortcut.name.trim()
      : path.parse(target).name;

  return {
    target,
    args,
    cwd,
    names: [...names],
    label,
    key: path.resolve(target).toLowerCase(),
  };
}

/**
 * El .lnk de Insomnia apunta a Insomnia.exe, pero la ventana vive en
 * app-x.y.z\insomnia-x.y.z.exe, al lado. Aceptamos ese ejecutable versionado.
 * @param {string} image
 * @param {AppLaunch} launch
 */
function imageMatches(image, launch) {
  if (!image) return false;
  const base = path.basename(image).toLowerCase();
  if (launch.names.includes(base)) return true;

  const stem = path.parse(launch.target).name.toLowerCase();
  const imageStem = path.parse(base).name.toLowerCase();
  const root = path.dirname(launch.target).toLowerCase();
  const img = image.toLowerCase();
  const underRoot = img.startsWith(`${root}\\`) || img.startsWith(`${root}/`);
  if (!underRoot) return false;
  return imageStem === stem || imageStem.startsWith(`${stem}-`) || imageStem.startsWith(`${stem}.`);
}

/**
 * @param {AppLaunch} launch
 * @param {bigint} [ignore]
 */
function findGuestWindow(launch, ignore) {
  const skip = ignore || 0n;
  const rows = win32.listTopLevelWindows().filter((row) => {
    if (row.hwnd === skip) return false;
    if (row.pid === process.pid) return false;
    if (row.owner) return false;
    if (row.height < 300) return false;
    return imageMatches(row.image, launch);
  });
  rows.sort((a, b) => b.width * b.height - a.width * a.height);
  return rows[0] || null;
}

function ensureIpc() {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle('embed-app-host-action', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const session = win && sessionsByWindow(win);
    if (!win || win.isDestroyed() || !session) return null;
    if (action === 'minimize') {
      win.minimize();
      return true;
    }
    if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    }
    if (action === 'close') {
      win.close();
      return true;
    }
    return null;
  });
}

function ensureQuitHook() {
  if (quitHooked) return;
  quitHooked = true;
  app.on('before-quit', () => {
    for (const session of sessions.values()) {
      session.detached = true;
      detachGuest(session);
    }
  });
}

/**
 * @param {Electron.BrowserWindow} win
 * @returns {EmbedSession | null}
 */
function sessionsByWindow(win) {
  for (const session of sessions.values()) {
    if (session.win === win) return session;
  }
  return null;
}

/**
 * @param {EmbedSession} session
 */
function publish(session) {
  const win = session.win;
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send('embed-app-status', session.status);
      win.webContents.send('embed-app-maximized', win.isMaximized());
    } catch {
      /* la página todavía no escucha */
    }
  };
  send();
  win.webContents.once('did-finish-load', send);
}

/**
 * @param {EmbedSession} session
 * @param {string} text
 * @param {boolean} [error]
 */
function setStatus(session, text, error) {
  session.status = { title: session.launch.label, text, error: !!error };
  publish(session);
}

/**
 * @param {EmbedSession} session
 */
function detachGuest(session) {
  const guest = session.guest;
  const saved = session.saved;
  session.guest = 0n;
  session.saved = null;
  if (!guest || !win32.isAlive(guest)) return;
  try {
    win32.restoreTopLevel(guest, saved);
    note(`ventana devuelta al escritorio hwnd=${guest}`);
  } catch (err) {
    note(`no se pudo devolver la ventana: ${err && err.message ? err.message : err}`);
  }
}

/**
 * @param {EmbedSession} session
 * @returns {boolean}
 */
function guestIsInside(session) {
  if (!session.guest || !win32.isAlive(session.guest)) return false;
  if (session.embedMode === 'owned') return win32.getOwner(session.guest) === session.hostHwnd;
  return win32.getParent(session.guest) === session.hostHwnd;
}

/**
 * @param {EmbedSession} session
 * @param {number} scale
 * @returns {number}
 */
function chromePixels(session, scale) {
  let dip = EMBED_CHROME_DIP;
  if (session.shared) {
    try {
      dip = require('./detached-web-frame').chromeHeightFor(session.win);
    } catch {
      dip = 58;
    }
  }
  return Math.max(1, Math.round(dip * scale));
}

/**
 * @param {EmbedSession} session
 * @param {boolean} [activate]
 */
function fitGuest(session, activate) {
  const win = session.win;
  if (!win || win.isDestroyed() || !session.guest || !win32.isAlive(session.guest)) return;
  if (win.isMinimized() || session.suspended) return;
  if (!guestIsInside(session)) return;
  win32.unmaximize(session.guest);

  const client = win32.clientSize(session.hostHwnd);
  const bounds = win.getContentBounds();
  if (!client.width || !client.height || !bounds.width) return;

  const scale = client.width / bounds.width;
  const chrome = chromePixels(session, scale);
  let width = client.width;
  let height = Math.max(1, client.height - chrome);
  let x = 0;
  let y = chrome;
  if (session.shared && win.__usualDeskMenuDrawerOpen) {
    width = Math.max(1, width - Math.round(240 * scale));
  }
  if (session.embedMode === 'owned') {
    const origin = win32.clientOrigin(session.hostHwnd);
    x += origin.x;
    y += origin.y;
  }

  const current =
    session.embedMode === 'owned'
      ? (() => {
          const rect = win32.windowRect(session.guest);
          if (!rect) return null;
          return {
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
          };
        })()
      : win32.childRect(session.hostHwnd, session.guest);
  const same =
    current && current.x === x && current.y === y && current.width === width && current.height === height;
  if (same && !activate) return;

  win32.moveChild(session.guest, x, y, width, height, activate === true);
}

/**
 * @param {EmbedSession} session
 * @param {{ hwnd: bigint, title: string, width: number, height: number, image: string }} row
 */
function adoptGuest(session, row) {
  if (session.guest && session.guest !== row.hwnd && win32.isAlive(session.guest)) {
    detachGuest(session);
  }
  session.guest = row.hwnd;
  session.hadGuest = true;
  session.missingSince = 0;
  if (!session.saved) session.saved = win32.captureWindowChrome(row.hwnd);

  const className = row.className || win32.windowClass(row.hwnd);
  session.embedMode = className === 'Chrome_WidgetWin_1' ? 'owned' : 'child';
  const attached =
    session.embedMode === 'owned'
      ? win32.attachOwned(row.hwnd, session.hostHwnd, session.saved)
      : win32.attachChild(row.hwnd, session.hostHwnd, session.saved);
  note(
    `${session.embedMode} hwnd=${row.hwnd} parent=${attached} esperado=${session.hostHwnd} title="${row.title}" ${row.width}x${row.height}`,
  );
  if (attached !== session.hostHwnd) {
    session.adoptAttempts += 1;
    throw new Error('Windows no dejó meter la ventana dentro de inplaize');
  }
  session.adoptAttempts = 0;
  session.suspended = false;
  if (session.shared) {
    try {
      require('./detached-web-frame').setEmbeddedDesktopCover(session.win, true);
    } catch {
      /* la barra sigue; la página puede quedar debajo */
    }
  }
  fitGuest(session, true);
  try {
    session.win.setSkipTaskbar(true);
  } catch {
    /* noop */
  }
  setStatus(session, '');
}

/**
 * @param {EmbedSession} session
 */
function tick(session) {
  const win = session.win;
  if (!win || win.isDestroyed() || session.closing || session.detached) return;

  try {
    tickInner(session, win);
  } catch (err) {
    note(`tick: ${err && err.message ? err.message : err}`);
  }
}

/**
 * @param {EmbedSession} session
 * @param {Electron.BrowserWindow} win
 */
function tickInner(session, win) {
  if (!session.shared) {
    try {
      win.setSkipTaskbar(true);
    } catch {
      /* noop */
    }
  }
  const hostHwnd = win32.hwndFromBrowserWindow(win);
  if (hostHwnd && hostHwnd !== session.hostHwnd) {
    note(`el marco cambió de hwnd ${session.hostHwnd} a ${hostHwnd}`);
    session.hostHwnd = hostHwnd;
  }
  if (!session.shared) {
    try {
      win32.hideFromTaskbar(session.hostHwnd);
    } catch {
      /* noop */
    }
  }

  if (session.guest && !win32.isAlive(session.guest)) {
    note('la ventana anterior desapareció, busco otra');
    session.guest = 0n;
    session.saved = null;
    session.missingSince = Date.now();
  }

  if (session.suspended) {
    if (session.hadGuest && !session.guest && session.missingSince && Date.now() - session.missingSince > 8000) {
      releaseShared(session);
    }
    return;
  }

  if (session.guest && win32.isAlive(session.guest)) {
    if (guestIsInside(session)) {
      const current = win32.windowRect(session.guest);
      const better = findGuestWindow(session.launch, session.guest);
      const currentArea = current
        ? Math.max(0, current.right - current.left) * Math.max(0, current.bottom - current.top)
        : 0;
      const currentHeight = current ? current.bottom - current.top : 0;
      if (better && currentHeight > 0 && currentHeight < 320 && better.width * better.height > currentArea * 1.4) {
        note(`cambio a una ventana más grande: ${better.title}`);
        try {
          adoptGuest(session, better);
        } catch (err) {
          note(err && err.message ? err.message : String(err));
        }
      } else {
        fitGuest(session, false);
      }
      return;
    }

    if (session.adoptAttempts > 40) session.adoptAttempts = 0;
    try {
      adoptGuest(session, {
        hwnd: session.guest,
        title: session.launch.label,
        width: 0,
        height: 0,
        image: session.launch.target,
        className: win32.windowClass(session.guest),
      });
    } catch (err) {
      note(err && err.message ? err.message : String(err));
    }
    return;
  }

  const found = findGuestWindow(session.launch);
  if (found) {
    if (session.adoptAttempts > 40) session.adoptAttempts = 0;
    try {
      adoptGuest(session, found);
    } catch (err) {
      note(err && err.message ? err.message : String(err));
    }
    return;
  }

  if (
    session.hadGuest &&
    session.missingSince &&
    Date.now() - session.missingSince > 8000 &&
    !win.isDestroyed()
  ) {
    if (session.shared) {
      releaseShared(session);
      return;
    }
    win.close();
    return;
  }

  if (!session.spawned && !session.hadGuest) {
    session.spawned = true;
    try {
      const child = spawn(session.launch.target, session.launch.args, {
        detached: true,
        stdio: 'ignore',
        cwd: session.launch.cwd,
        windowsHide: false,
      });
      child.on('error', (err) => {
        note(`no arrancó: ${err.message}`);
        setStatus(session, 'No se pudo abrir la aplicación.', true);
      });
      child.unref();
      note(`lanzado ${session.launch.target}`);
    } catch (err) {
      note(`spawn falló: ${err && err.message ? err.message : err}`);
      setStatus(session, 'No se pudo abrir la aplicación.', true);
      return;
    }
  }

  if (Date.now() - session.startedAt > FIND_TIMEOUT_MS) {
    setStatus(session, 'La aplicación no mostró una ventana.', true);
  }
}

/**
 * La app se cerró: la ventana de inplaize sigue, con su barra y la página.
 * @param {EmbedSession} session
 */
function releaseShared(session) {
  session.detached = true;
  session.suspended = true;
  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }
  const win = session.win;
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  if (!win || win.isDestroyed() || !session.shared) return;
  const still = [...sessions.values()].some((other) => other.win === win && !other.detached);
  if (still) return;
  try {
    require('./detached-web-frame').setEmbeddedDesktopCover(win, false);
  } catch {
    /* la página vuelve en el próximo foco */
  }
}

/**
 * @param {Electron.BrowserWindow} win
 */
function ensureHostHooks(win) {
  if (!win || win.__embedHooks) return;
  win.__embedHooks = true;
  const refit = () => {
    for (const session of sessions.values()) {
      if (session.win === win && !session.suspended && !session.detached) fitGuest(session, false);
    }
  };
  win.on('resize', refit);
  win.on('move', refit);
  win.on('maximize', refit);
  win.on('unmaximize', refit);
  win.on('restore', refit);
}

/**
 * El usuario volvió a una página: la app queda escondida y la barra sigue.
 * @param {Electron.BrowserWindow} win
 */
function suspendOnHost(win) {
  if (!win || win.isDestroyed()) return;
  let touched = false;
  for (const session of sessions.values()) {
    if (session.win !== win || session.detached) continue;
    touched = true;
    session.suspended = true;
    if (session.guest && win32.isAlive(session.guest)) win32.showWindow(session.guest, false);
  }
  if (!touched) return;
  try {
    require('./detached-web-frame').setEmbeddedDesktopCover(win, false);
  } catch {
    /* la página se vuelve a enganchar sola */
  }
}

/**
 * @param {EmbedSession} session
 */
function showSession(session) {
  const win = session.win;
  if (!win || win.isDestroyed()) return;
  session.suspended = false;
  for (const other of sessions.values()) {
    if (other === session || other.win !== win || other.detached) continue;
    other.suspended = true;
    if (other.guest && win32.isAlive(other.guest)) win32.showWindow(other.guest, false);
  }
  if (session.shared && guestIsInside(session)) {
    try {
      require('./detached-web-frame').setEmbeddedDesktopCover(win, true);
    } catch {
      /* noop */
    }
  }
  if (win.isMinimized()) win.restore();
  forceWindowForeground(win);
  if (session.guest && win32.isAlive(session.guest) && guestIsInside(session)) {
    win32.showWindow(session.guest, true);
    fitGuest(session, true);
  }
}

/**
 * @param {AppLaunch} launch
 * @param {Electron.BrowserWindow | null} [existingWin]
 * @returns {EmbedSession}
 */
function createSession(launch, existingWin) {
  ensureIpc();
  ensureQuitHook();

  const shared = !!(existingWin && !existingWin.isDestroyed() && existingWin.__usualDeskDetachedChromeHost);
  const root = path.join(__dirname, '..');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;

  const win = shared
    ? existingWin
    : new BrowserWindow({
    x: area.x,
    y: area.y,
    width: Math.max(960, area.width),
    height: Math.max(640, area.height),
    show: false,
    frame: false,
    title: launch.label,
    icon: appIconFile(),
    backgroundColor: '#1e1e24',
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, 'embed-app-host-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (!shared) {
    brandWindow(win);
    try {
      win.removeMenu();
    } catch {
      try {
        win.setMenu(null);
      } catch {
        /* noop */
      }
    }
    win.setSkipTaskbar(true);
  }

  /** @type {EmbedSession} */
  const session = {
    key: launch.key,
    launch,
    win,
    hostHwnd: win32.hwndFromBrowserWindow(win),
    guest: 0n,
    saved: null,
    closing: false,
    detached: false,
    adoptAttempts: 0,
    hadGuest: false,
    missingSince: 0,
    startedAt: Date.now(),
    spawned: false,
    shared,
    suspended: false,
    embedMode: 'child',
    timer: null,
    status: { title: launch.label, text: `Abriendo ${launch.label}…`, error: false },
  };
  sessions.set(launch.key, session);
  ensureHostHooks(win);

  win.on('resize', () => fitGuest(session, false));
  win.on('maximize', () => {
    fitGuest(session, false);
    publish(session);
  });
  win.on('unmaximize', () => {
    fitGuest(session, false);
    publish(session);
  });
  win.on('restore', () => fitGuest(session, false));
  if (!shared) {
    win.on('show', () => {
      try {
        win.setSkipTaskbar(true);
      } catch {
        /* noop */
      }
      fitGuest(session, false);
    });
  }

  if (!shared) win.on('close', (event) => {
    if (session.detached) return;
    if (session.closing) return;
    if (!session.guest || !win32.isAlive(session.guest)) return;
    event.preventDefault();
    session.closing = true;
    const guest = session.guest;
    note(`cerrar hwnd=${guest}`);
    win32.requestClose(guest);
    const started = Date.now();
    const wait = setInterval(() => {
      const alive = win32.isAlive(guest);
      if (!alive || Date.now() - started > 2000) {
        clearInterval(wait);
        if (alive) detachGuest(session);
        else session.guest = 0n;
        if (!win.isDestroyed()) win.destroy();
      }
    }, 80);
  });

  win.on('closed', () => {
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    if (!session.detached && session.guest && win32.isAlive(session.guest)) {
      if (session.shared) win32.requestClose(session.guest);
      else detachGuest(session);
    }
    if (sessions.get(launch.key) === session) sessions.delete(launch.key);
  });

  if (!shared) {
    win.loadFile(path.join(root, 'embed-app-host.html'));
    win.webContents.once('did-finish-load', () => publish(session));
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.maximize();
      win.show();
      win.setSkipTaskbar(true);
      try {
        win32.hideFromTaskbar(win32.hwndFromBrowserWindow(win));
      } catch {
        /* noop */
      }
      forceWindowForeground(win);
      publish(session);
    });
  } else if (win.isMinimized()) {
    win.restore();
  }
  if (shared) forceWindowForeground(win);

  session.timer = setInterval(() => tick(session), FIT_INTERVAL_MS);
  tick(session);
  return session;
}

/**
 * Si no hay una ventana web abierta, esta trae la misma barra de inplaize
 * y la app queda debajo. No tapa la barra de otra ventana.
 * @returns {Electron.BrowserWindow}
 */
function createEmbedChromeHost() {
  const root = path.join(__dirname, '..');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: Math.max(960, area.width),
    height: Math.max(640, area.height),
    show: false,
    frame: false,
    title: 'inplaize',
    icon: appIconFile(),
    backgroundColor: '#1e1e24',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, 'detached-web-frame-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.__usualDeskDetachedChromeHost = true;
  win.__usualDeskDetachedOwnMapKey = '';
  brandWindow(win);
  try {
    win.removeMenu();
  } catch {
    try {
      win.setMenu(null);
    } catch {
      /* noop */
    }
  }
  win.loadFile(path.join(root, 'detached-web-frame.html'));
  const sendChrome = () => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(
        'detached-chrome',
        require('./detached-web-frame').buildDetachedChromePayload(''),
      );
    } catch {
      /* la página todavía no escucha */
    }
  };
  win.webContents.once('did-finish-load', sendChrome);
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (!win.isMaximized()) win.maximize();
    win.show();
    sendChrome();
  });
  return win;
}

/**
 * @param {import('./shortcuts-store').Shortcut | Record<string, unknown>} shortcut
 * @returns {Promise<boolean>}
 */
async function openEmbeddedApp(shortcut) {
  if (process.platform !== 'win32') return false;
  const launch = resolveLaunch(shortcut);
  const existing = sessions.get(launch.key);
  if (existing && existing.win && !existing.win.isDestroyed()) {
    note(`ya abierta, foco: ${launch.label}`);
    showSession(existing);
    return true;
  }

  let chrome = null;
  try {
    chrome = require('./detached-web-frame').findForegroundChromeHost();
  } catch {
    chrome = null;
  }
  if (!chrome) chrome = createEmbedChromeHost();
  note(`embeber ${launch.label} ← ${launch.target} (bajo la barra)`);
  createSession(launch, chrome);
  return true;
}

module.exports = { openEmbeddedApp, suspendOnHost, EMBED_CHROME_DIP };

'use strict';

/**
 * Importación de cookies desde Google Chrome local hacia la `session` de una
 * partition de la app (para evitar el primer login de Gmail/Google).
 *
 * Estrategia:
 *  - Se lanza una instancia transitoria de Chrome contra el mismo `--user-data-dir`
 *    del usuario, en modo `--headless=new`, con `--remote-debugging-port=0` y
 *    `--remote-allow-origins=*` (imprescindible desde Chrome 111+, sin él Chrome
 *    cierra la conexión WS de Node por origen no autorizado).
 *  - Chrome escribe el puerto en `<userDataDir>/DevToolsActivePort`.
 *  - Conectamos por WebSocket (CDP) y pedimos primero `Storage.getCookies`
 *    (browser-level), con fallback a `Network.getAllCookies` sobre el target
 *    de página. Algunas builds no exponen Network en el endpoint browser.
 *  - Filtramos a dominios de Google y las inyectamos con `session.cookies.set`.
 *  - Se registra el detalle de la importación en `<userData>/chrome-import.log`
 *    para poder diagnosticar si Google sigue pidiendo login.
 *  - Cerramos Chrome.
 *
 * Esto funciona en Chrome 127+ (App-Bound Encryption) porque el `chrome.exe`
 * que lanzamos es el mismo binario que tiene su propia clave de IElevator;
 * desde dentro del propio Chrome la desencriptación es transparente.
 *
 * Sólo soportado en Windows en esta versión.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { session, app } = require('electron');

/**
 * Logger persistente de la importación a `<userData>/chrome-import.log`.
 * Sirve para diagnosticar por qué el usuario sigue sin sesión después de importar
 * (cookies efectivamente leídas, fallos al setearlas, etc.). Se reescribe en cada intento.
 */
let _logBuffer = [];
let _logPath = '';
function logReset() {
  _logBuffer = [];
  try {
    _logPath = path.join(app.getPath('userData'), 'chrome-import.log');
  } catch {
    _logPath = '';
  }
}
function logLine(...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}`;
  _logBuffer.push(line);
}
function logFlush() {
  if (!_logPath) return;
  try {
    fs.writeFileSync(_logPath, _logBuffer.join('\n') + '\n', 'utf8');
  } catch {
    /* noop */
  }
}

/** Hostnames cuyas cookies se importan. Lista conservadora a dominios Google/YouTube. */
function isImportableHostname(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase().replace(/^\./, '');
  if (!h) return false;
  return (
    h === 'google.com' ||
    h.endsWith('.google.com') ||
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'gstatic.com' ||
    h.endsWith('.gstatic.com') ||
    h === 'googleusercontent.com' ||
    h.endsWith('.googleusercontent.com') ||
    h === 'googleapis.com' ||
    h.endsWith('.googleapis.com')
  );
}

function defaultChromeUserDataDir() {
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  return path.join(local, 'Google', 'Chrome', 'User Data');
}

function findChromeExecutable() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    process.env['ProgramFiles'] &&
      path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] &&
      path.join(
        process.env['ProgramFiles(x86)'],
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      ),
    process.env['LOCALAPPDATA'] &&
      path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* noop */
    }
  }
  return null;
}

function isChromeRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    return /chrome\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** Lee `Local State` y devuelve [{ directory, name, userName }]. */
function listChromeProfiles() {
  const userDataDir = defaultChromeUserDataDir();
  if (!userDataDir) return [];
  const localStatePath = path.join(userDataDir, 'Local State');
  try {
    const raw = fs.readFileSync(localStatePath, 'utf8');
    const data = JSON.parse(raw);
    const cache = (data && data.profile && data.profile.info_cache) || {};
    return Object.entries(cache)
      .map(([directory, info]) => {
        const i = info && typeof info === 'object' ? info : {};
        return {
          directory,
          name: typeof i.name === 'string' && i.name ? i.name : directory,
          userName: typeof i.user_name === 'string' ? i.user_name : '',
        };
      })
      .sort((a, b) => {
        if (a.directory === 'Default') return -1;
        if (b.directory === 'Default') return 1;
        return a.directory.localeCompare(b.directory);
      });
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForDevToolsPort(portFile, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(portFile)) {
        const txt = fs.readFileSync(portFile, 'utf8');
        const portStr = String(txt).split('\n')[0].trim();
        const port = parseInt(portStr, 10);
        if (Number.isFinite(port) && port > 0) return port;
      }
    } catch {
      /* noop, retry */
    }
    await sleep(100);
  }
  throw new Error('Timeout esperando que Chrome inicie el puerto de depuración.');
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} en ${url}`);
  return resp.json();
}

/**
 * Cliente CDP minimalista: abre el WS y permite enviar comandos secuenciales.
 * Implementado a mano para evitar dependencias y poder controlar el header `Origin`,
 * imprescindible desde Chrome 111+ que rechaza orígenes no autorizados.
 */
function openCdp(wsUrl, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      // El `WebSocket` global de Node (WHATWG) no permite forzar headers; la admisión
      // del Origin la garantiza el flag `--remote-allow-origins=*` en el chrome.exe.
      ws = new WebSocket(wsUrl);
    } catch (err) {
      reject(err);
      return;
    }

    const pending = new Map();
    let nextId = 1;

    const openTimer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error('Timeout abriendo WebSocket CDP.'));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(openTimer);
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            try {
              ws.send(JSON.stringify({ id, method, params: params || {} }));
            } catch (err) {
              pending.delete(id);
              rej(err);
            }
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* noop */
          }
        },
      });
    });

    ws.addEventListener('message', (ev) => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (!data) return;
        const msg = JSON.parse(data);
        if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'Error CDP'));
          else res(msg.result || {});
        }
      } catch {
        /* noop */
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(openTimer);
      for (const { rej } of pending.values()) {
        try {
          rej(new Error('Error de WebSocket CDP.'));
        } catch {
          /* noop */
        }
      }
      pending.clear();
      reject(new Error('Error de WebSocket conectando a Chrome.'));
    });

    ws.addEventListener('close', () => {
      for (const { rej } of pending.values()) {
        try {
          rej(new Error('WebSocket CDP cerrado.'));
        } catch {
          /* noop */
        }
      }
      pending.clear();
    });
  });
}

/**
 * Pide cookies a Chrome. Intenta primero `Storage.getCookies` en el endpoint browser-level
 * (compatible y devuelve TODAS las cookies del browser context). Si falla, cae a
 * `Network.getAllCookies` sobre el target de página.
 * @param {number} port - puerto de remote debugging
 * @returns {Promise<Array<object>>}
 */
async function fetchCookiesFromChrome(port, timeoutMs = 12000) {
  // 1) browser-level WS
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const browserWs = version && version.webSocketDebuggerUrl;
  if (!browserWs) throw new Error('No se obtuvo el endpoint WebSocket browser de Chrome.');

  let lastErr = null;
  try {
    const cdp = await openCdp(browserWs, timeoutMs);
    try {
      const result = await cdp.send('Storage.getCookies');
      const cookies = Array.isArray(result.cookies) ? result.cookies : [];
      logLine('CDP Storage.getCookies →', String(cookies.length), 'cookies');
      if (cookies.length > 0) return cookies;
      lastErr = new Error('Storage.getCookies devolvió 0 cookies');
    } finally {
      cdp.close();
    }
  } catch (err) {
    lastErr = err;
    logLine('CDP Storage.getCookies falló:', err && err.message ? err.message : String(err));
  }

  // 2) page-level WS de about:blank → Network.getAllCookies
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const list = Array.isArray(targets) ? targets : [];
    const pageTarget = list.find((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
    if (!pageTarget) throw new Error('Sin targets de página en Chrome headless.');
    const cdp = await openCdp(pageTarget.webSocketDebuggerUrl, timeoutMs);
    try {
      const result = await cdp.send('Network.getAllCookies');
      const cookies = Array.isArray(result.cookies) ? result.cookies : [];
      logLine('CDP Network.getAllCookies (page) →', String(cookies.length), 'cookies');
      return cookies;
    } finally {
      cdp.close();
    }
  } catch (err) {
    logLine('CDP Network.getAllCookies falló:', err && err.message ? err.message : String(err));
    throw lastErr || err;
  }
}

function mapCdpSameSite(s) {
  switch (s) {
    case 'Strict':
      return 'strict';
    case 'Lax':
      return 'lax';
    case 'None':
      return 'no_restriction';
    default:
      return 'unspecified';
  }
}

/**
 * @param {{ profileDirectory?: string, targetPartition: string }} opts
 * @returns {Promise<{ imported: number, total: number, considered: number }>}
 */
async function importGoogleCookiesFromChrome(opts) {
  if (process.platform !== 'win32') {
    throw new Error('NOT_SUPPORTED_PLATFORM');
  }
  const targetPartition = opts && typeof opts.targetPartition === 'string' ? opts.targetPartition : '';
  if (!targetPartition) throw new Error('MISSING_PARTITION');
  const profileDirectory =
    opts && typeof opts.profileDirectory === 'string' && opts.profileDirectory
      ? opts.profileDirectory
      : 'Default';

  logReset();
  logLine('Inicio importación. profileDirectory=', profileDirectory, 'partition=', targetPartition);

  const chromeExe = findChromeExecutable();
  if (!chromeExe) {
    logLine('CHROME_NOT_FOUND');
    logFlush();
    throw new Error('CHROME_NOT_FOUND');
  }

  const userDataDir = defaultChromeUserDataDir();
  if (!userDataDir || !fs.existsSync(userDataDir)) {
    logLine('CHROME_PROFILE_DIR_NOT_FOUND');
    logFlush();
    throw new Error('CHROME_PROFILE_DIR_NOT_FOUND');
  }

  if (isChromeRunning()) {
    logLine('CHROME_RUNNING');
    logFlush();
    throw new Error('CHROME_RUNNING');
  }

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  try {
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {
    /* noop */
  }

  const args = [
    '--remote-debugging-port=0',
    // Imprescindible desde Chrome 111+: sin esto Chrome rechaza la conexión WS de Node
    // por origen no autorizado y `Network.getAllCookies` nunca llega a ejecutarse.
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDirectory}`,
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI,InterestFeedContentSuggestions',
    'about:blank',
  ];
  logLine('Lanzando Chrome:', chromeExe, args.join(' '));

  const child = spawn(chromeExe, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  const killChild = () => {
    try {
      if (!child.killed) child.kill();
    } catch {
      /* noop */
    }
    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        /* noop */
      }
    }
  };

  let cookies = [];
  try {
    const port = await waitForDevToolsPort(portFile, 12000);
    logLine('Puerto CDP =', String(port));
    cookies = await fetchCookiesFromChrome(port, 12000);
  } finally {
    killChild();
  }

  const ses = session.fromPartition(targetPartition);
  let imported = 0;
  let considered = 0;
  /** @type {Map<string, number>} */
  const failuresByReason = new Map();
  /** @type {Map<string, number>} */
  const importedByDomain = new Map();

  for (const c of cookies) {
    if (!c || typeof c !== 'object') continue;
    if (!isImportableHostname(c.domain)) continue;
    considered += 1;

    const sameSite = mapCdpSameSite(c.sameSite);
    const secure = !!c.secure || sameSite === 'no_restriction';
    const proto = secure ? 'https' : 'http';
    const rawDomain = String(c.domain || '');
    const hostForUrl = rawDomain.replace(/^\./, '');
    if (!hostForUrl) continue;
    const cookiePath = typeof c.path === 'string' && c.path ? c.path : '/';
    const url = `${proto}://${hostForUrl}${cookiePath}`;

    const name = String(c.name || '');
    // Las cookies con prefijo __Host- exigen sin domain attribute, path '/' y Secure.
    const isHostPrefixed = /^__Host-/.test(name);

    /** @type {Electron.CookiesSetDetails} */
    const details = {
      url,
      name,
      value: String(c.value || ''),
      path: cookiePath,
      secure,
      httpOnly: !!c.httpOnly,
      sameSite,
    };
    if (!isHostPrefixed && rawDomain) {
      details.domain = rawDomain;
    }
    if (typeof c.expires === 'number' && c.expires > 0 && !c.session) {
      details.expirationDate = c.expires;
    }

    try {
      await ses.cookies.set(details);
      imported += 1;
      const key = rawDomain || hostForUrl;
      importedByDomain.set(key, (importedByDomain.get(key) || 0) + 1);
    } catch (err) {
      const reason = err && err.message ? err.message : 'desconocido';
      failuresByReason.set(reason, (failuresByReason.get(reason) || 0) + 1);
      logLine('FALLA set cookie', name, 'domain=', rawDomain, 'path=', cookiePath, '→', reason);
    }
  }

  try {
    await ses.cookies.flushStore();
  } catch {
    /* noop */
  }

  logLine('Resumen:', JSON.stringify({
    total: cookies.length,
    considered,
    imported,
    importedByDomain: Object.fromEntries(importedByDomain),
    failuresByReason: Object.fromEntries(failuresByReason),
  }));
  logFlush();

  return { imported, total: cookies.length, considered, logPath: _logPath };
}

module.exports = {
  listChromeProfiles,
  isChromeRunning,
  findChromeExecutable,
  defaultChromeUserDataDir,
  importGoogleCookiesFromChrome,
};

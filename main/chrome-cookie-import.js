'use strict';

/**
 * Importación de cookies desde Google Chrome local hacia la `session` de una
 * partition de la app (para evitar el primer login de Gmail/Google).
 *
 * Estrategia:
 *  - Chrome no comparte su perfil: si el usuario lo tiene abierto hay que
 *    cerrarlo. Con `autoCloseChrome` lo cerramos nosotros (pidiendo primero un
 *    cierre normal para que guarde la sesión) y al terminar lo reabrimos con
 *    `--restore-last-session`, así el usuario recupera sus pestañas.
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
const { session, app, dialog } = require('electron');
const { toSetDetails, removeCookies } = require('./cookie-jar');

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

/** @param {string[]} args */
function taskkillChrome(args) {
  try {
    execFileSync('taskkill', ['/IM', 'chrome.exe', '/T', ...args], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // taskkill devuelve error si algún proceso hijo no tiene ventana; los que
    // importan (el proceso browser) sí la tienen y reciben el cierre igual.
  }
}

/** @param {number} timeoutMs */
async function waitForChromeExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isChromeRunning()) {
      // Chrome libera el lock del perfil un instante después de que el
      // proceso desaparece; sin este margen la instancia headless arranca
      // contra un perfil todavía tomado y no ve ninguna cookie.
      await sleep(800);
      return true;
    }
    await sleep(250);
  }
  return false;
}

/**
 * Cierra Chrome para poder leer su perfil. Primero pide un cierre normal (así
 * guarda la sesión y no aparece el aviso de "Chrome no se cerró
 * correctamente"); si se resiste, lo fuerza.
 * @returns {Promise<boolean>} true si quedó cerrado
 */
async function closeChromeForImport() {
  if (process.platform !== 'win32') return false;
  if (!isChromeRunning()) return true;
  logLine('Chrome abierto: pidiendo cierre normal');
  taskkillChrome([]);
  if (await waitForChromeExit(12000)) return true;
  logLine('Chrome sigue abierto: cierre forzado');
  taskkillChrome(['/F']);
  return waitForChromeExit(6000);
}

/**
 * Chrome no deja leer su perfil mientras está abierto. En vez de mandar al
 * usuario a cerrar ventana por ventana, pedimos permiso una sola vez y lo
 * cerramos nosotros.
 * @param {Electron.BrowserWindow | null} [host]
 * @returns {Promise<boolean>} false si el usuario prefiere no cerrarlo
 */
async function confirmChromeCloseForImport(host) {
  if (!isChromeRunning()) return true;
  const opts = {
    type: /** @type {const} */ ('question'),
    message: 'Hay que cerrar Google Chrome un momento',
    detail:
      'Para traer tu cuenta necesitamos leer la sesión de Chrome, y eso solo se puede con Chrome cerrado. '
      + 'Lo cerramos y lo volvemos a abrir con las mismas pestañas apenas termine.',
    buttons: ['Cerrar Chrome y continuar', 'Cancelar'],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = host && !host.isDestroyed()
    ? await dialog.showMessageBox(host, opts)
    : await dialog.showMessageBox(opts);
  return response === 0;
}

/**
 * Vuelve a abrir Chrome restaurando lo que el usuario tenía. Se llama solo si
 * lo cerramos nosotros para importar.
 */
function relaunchChrome() {
  const exe = findChromeExecutable();
  if (!exe) return false;
  try {
    const child = spawn(exe, ['--restore-last-session'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    logLine('Chrome reabierto con la sesión anterior');
    return true;
  } catch (err) {
    logLine('No se pudo reabrir Chrome:', err && err.message ? err.message : String(err));
    return false;
  }
}

/** Lee `Local State` y devuelve [{ directory, name, userName, picturePath }]. */
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
        const pictureFile =
          typeof i.gaia_picture_file_name === 'string' && i.gaia_picture_file_name
            ? i.gaia_picture_file_name
            : 'Google Profile Picture.png';
        const picturePath = path.join(userDataDir, directory, pictureFile);
        return {
          directory,
          name: typeof i.name === 'string' && i.name ? i.name : directory,
          userName: typeof i.user_name === 'string' ? i.user_name : '',
          picturePath: fs.existsSync(picturePath) ? picturePath : '',
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

/**
 * Lanza Chrome headless con el perfil dado y devuelve TODAS las cookies del
 * browser context. Valida plataforma, binario, perfil y que Chrome esté cerrado.
 * Asume que el log ya fue reseteado por el caller.
 * @param {string} profileDirectory
 * @param {{ autoCloseChrome?: boolean }} [opts] con `autoCloseChrome` cerramos
 *   Chrome nosotros y lo reabrimos al terminar, en vez de pedirle al usuario
 *   que lo haga a mano.
 * @returns {Promise<Array<object>>}
 */
async function fetchAllCookiesFromChromeProfile(profileDirectory, opts) {
  const autoCloseChrome = !!(opts && opts.autoCloseChrome);
  if (process.platform !== 'win32') {
    throw new Error('NOT_SUPPORTED_PLATFORM');
  }

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

  let reopenChrome = false;
  if (isChromeRunning()) {
    if (!autoCloseChrome) {
      logLine('CHROME_RUNNING');
      logFlush();
      throw new Error('CHROME_RUNNING');
    }
    if (!(await closeChromeForImport())) {
      logLine('CHROME_CLOSE_FAILED');
      logFlush();
      throw new Error('CHROME_CLOSE_FAILED');
    }
    reopenChrome = true;
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

  try {
    const port = await waitForDevToolsPort(portFile, 12000);
    logLine('Puerto CDP =', String(port));
    return await fetchCookiesFromChrome(port, 12000);
  } finally {
    killChild();
    if (reopenChrome) {
      // La instancia headless tiene que soltar el perfil antes de devolvérselo
      // al Chrome del usuario; si se superponen, el nuevo se cierra solo.
      await waitForChromeExit(8000);
      relaunchChrome();
    }
  }
}

/**
 * Inyecta en la partition las cookies que pasen el filtro de hostname.
 * @param {Array<object>} cookies cookies crudas de CDP
 * @param {string} targetPartition
 * @param {(hostname: string) => boolean} domainFilter
 * @returns {Promise<{ imported: number, considered: number }>}
 */
async function setCookiesIntoPartition(cookies, targetPartition, domainFilter) {
  const ses = session.fromPartition(targetPartition);
  let imported = 0;
  let considered = 0;
  /** @type {Map<string, number>} */
  const failuresByReason = new Map();
  /** @type {Map<string, number>} */
  const importedByDomain = new Map();

  // Traer el perfil es reemplazar la sesión, no sumarse a la que haya. Si queda
  // la anterior, el login viejo sobrevive en las cookies que la nueva no pisa.
  const removed = await removeCookies(ses, (c) => domainFilter(c.domain));
  logLine('Cookies previas borradas de la partition:', String(removed));

  for (const c of cookies) {
    if (!c || typeof c !== 'object') continue;
    if (!domainFilter(c.domain)) continue;
    considered += 1;

    const details = toSetDetails(c);
    if (!details) continue;

    try {
      await ses.cookies.set(details);
      imported += 1;
      const key = String(c.domain || '');
      importedByDomain.set(key, (importedByDomain.get(key) || 0) + 1);
    } catch (err) {
      const reason = err && err.message ? err.message : 'desconocido';
      failuresByReason.set(reason, (failuresByReason.get(reason) || 0) + 1);
      logLine('FALLA set cookie', details.name, 'domain=', String(c.domain || ''), 'path=', details.path, '→', reason);
    }
  }

  try {
    await ses.cookies.flushStore();
  } catch {
    /* noop */
  }

  logLine('Resumen partition', targetPartition, ':', JSON.stringify({
    considered,
    imported,
    removed,
    importedByDomain: Object.fromEntries(importedByDomain),
    failuresByReason: Object.fromEntries(failuresByReason),
  }));

  return { imported, considered };
}

/**
 * @param {{ profileDirectory?: string, targetPartition: string, autoCloseChrome?: boolean }} opts
 * @returns {Promise<{ imported: number, total: number, considered: number }>}
 */
async function importGoogleCookiesFromChrome(opts) {
  const targetPartition = opts && typeof opts.targetPartition === 'string' ? opts.targetPartition : '';
  if (!targetPartition) throw new Error('MISSING_PARTITION');
  const profileDirectory =
    opts && typeof opts.profileDirectory === 'string' && opts.profileDirectory
      ? opts.profileDirectory
      : 'Default';

  logReset();
  logLine('Inicio importación. profileDirectory=', profileDirectory, 'partition=', targetPartition);

  const cookies = await fetchAllCookiesFromChromeProfile(profileDirectory, {
    autoCloseChrome: !!(opts && opts.autoCloseChrome),
  });
  const { imported, considered } = await setCookiesIntoPartition(
    cookies,
    targetPartition,
    isImportableHostname
  );
  logFlush();

  return { imported, total: cookies.length, considered, logPath: _logPath };
}

module.exports = {
  listChromeProfiles,
  isChromeRunning,
  closeChromeForImport,
  confirmChromeCloseForImport,
  findChromeExecutable,
  defaultChromeUserDataDir,
  importGoogleCookiesFromChrome,
};

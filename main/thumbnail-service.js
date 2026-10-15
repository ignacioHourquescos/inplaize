'use strict';

/**
 * Generación de miniaturas de documentos gestionada por la propia app (sin
 * depender del shell de Windows). Rasteriza la primera página/planilla de PDF,
 * XLSX, XLS y CSV a un PNG usando una ventana oculta (ver `thumbnailer/`).
 *
 * Diseño:
 *  - Una única ventana oculta (offscreen) hace el render con pdf.js / SheetJS.
 *  - Los trabajos se serializan en una cola simple (una miniatura a la vez).
 *  - El PNG se cachea en `userData/thumbnails/<hash>.png`, con hash de la ruta +
 *    mtime + tamaño, de modo que si el archivo cambia se regenera.
 *  - La API pública devuelve una URL `file://` a la miniatura cacheada.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { log } = require('./logger');
const { APP_NAME, appIconFile, brandWindow } = require('./app-identity');

/** Extensiones soportadas → tipo de render. */
const KIND_BY_EXT = new Map([
  ['pdf', 'pdf'],
  ['xlsx', 'xlsx'],
  ['xlsm', 'xlsx'],
  ['xls', 'xls'],
  ['csv', 'csv'],
]);

/** Fotos: miniatura chica del sistema, no el archivo original. */
const IMAGE_THUMB_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const IMAGE_THUMB_PX = 256;

const JOB_TIMEOUT_MS = 20000;
/** Cierra la ventana oculta tras un rato sin trabajos (libera memoria y evita
 *  que una ventana invisible mantenga viva la app). */
const IDLE_CLOSE_MS = 30000;

/** @type {BrowserWindow|null} */
let win = null;
let winReady = null; // Promise<void>
let ipcRegistered = false;
let jobSeq = 0;
let idleTimer = null;

/** @type {Map<string, {resolve:Function, timer:NodeJS.Timeout}>} */
const pendingJobs = new Map();

/** Cola de tareas pendientes (se procesan de a una). */
const queue = [];
let processing = false;

/** @type {Map<string, string>} clave de caché → ruta PNG (memo en RAM). */
const memCache = new Map();

/** @type {Map<string, Promise<string|null>>} trabajos en vuelo por clave. */
const inFlight = new Map();

function thumbsDir() {
  const dir = path.join(app.getPath('userData'), 'thumbnails');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* noop */
  }
  return dir;
}

function extOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

/** @returns {boolean} ¿la app puede generar miniatura de este archivo? */
function isSupported(filePath) {
  const ext = extOf(filePath);
  return KIND_BY_EXT.has(ext) || IMAGE_THUMB_EXTS.has(ext);
}

/** Miniatura de imagen cacheada. No decodifica el archivo entero en el dock. */
async function makeImageThumb(filePath, cacheKey, cachePath) {
  try {
    const image = await nativeImage.createThumbnailFromPath(filePath, {
      width: IMAGE_THUMB_PX,
      height: IMAGE_THUMB_PX,
    });
    if (!image || image.isEmpty()) return null;
    fs.writeFileSync(cachePath, image.toPNG());
    memCache.set(cacheKey, cachePath);
    return fileUrl(cachePath);
  } catch (err) {
    log(`thumbnail-service: imagen ${path.basename(filePath)}: ${err?.message || err}`);
    return null;
  }
}

function cacheKeyFor(filePath, stat) {
  const h = crypto.createHash('sha1');
  h.update(String(filePath));
  h.update('|');
  h.update(String(stat.mtimeMs));
  h.update('|');
  h.update(String(stat.size));
  return h.digest('hex');
}

function fileUrl(p) {
  const norm = String(p).replace(/\\/g, '/');
  return `file:///${encodeURI(norm).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

function registerIpcOnce() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on('thumb-result', (_event, result) => {
    const { jobId } = result || {};
    const job = pendingJobs.get(String(jobId));
    if (!job) return;
    pendingJobs.delete(String(jobId));
    clearTimeout(job.timer);
    job.resolve(result || { error: 'EMPTY' });
  });
}

function cancelIdleClose() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleClose() {
  cancelIdleClose();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (queue.length || pendingJobs.size || processing) return;
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* noop */
      }
    }
  }, IDLE_CLOSE_MS);
}

function ensureWindow() {
  cancelIdleClose();
  if (win && !win.isDestroyed()) return winReady;
  registerIpcOnce();

  win = new BrowserWindow({
    show: false,
    title: APP_NAME,
    icon: appIconFile(),
    skipTaskbar: true,
    width: 320,
    height: 320,
    webPreferences: {
      preload: path.join(__dirname, 'thumbnailer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  brandWindow(win);

  win.on('closed', () => {
    win = null;
    winReady = null;
  });

  winReady = win.webContents
    .loadFile(path.join(__dirname, 'thumbnailer', 'thumbnailer.html'))
    .catch((err) => {
      log(`thumbnail-service: no se pudo cargar la ventana: ${err?.message || err}`);
    });

  return winReady;
}

/** Envía un trabajo a la ventana oculta y espera el PNG (dataURL). */
async function runJob(filePath, kind) {
  await ensureWindow();
  if (!win || win.isDestroyed()) return { error: 'NO_WINDOW' };

  const jobId = `thumb_${(jobSeq += 1)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingJobs.delete(jobId);
      resolve({ error: 'TIMEOUT' });
    }, JOB_TIMEOUT_MS);
    pendingJobs.set(jobId, { resolve, timer });
    try {
      win.webContents.send('thumb-job', { jobId, filePath, kind });
    } catch (err) {
      clearTimeout(timer);
      pendingJobs.delete(jobId);
      resolve({ error: String((err && err.message) || err) });
    }
  });
}

function processQueue() {
  if (processing) return;
  const task = queue.shift();
  if (!task) return;
  processing = true;

  (async () => {
    let out = null;
    try {
      const result = await runJob(task.filePath, task.kind);
      if (result && result.dataUrl) {
        const match = /^data:image\/png;base64,(.+)$/i.exec(result.dataUrl);
        if (match) {
          fs.writeFileSync(task.cachePath, Buffer.from(match[1], 'base64'));
          memCache.set(task.cacheKey, task.cachePath);
          out = fileUrl(task.cachePath);
        }
      } else if (result && result.error) {
        log(`thumbnail-service: fallo (${task.kind}) ${path.basename(task.filePath)}: ${result.error}`);
      }
    } catch (err) {
      log(`thumbnail-service: excepción: ${err?.message || err}`);
    } finally {
      task.resolve(out);
      processing = false;
      if (queue.length) processQueue();
      else scheduleIdleClose();
    }
  })();
}

/**
 * Devuelve una URL `file://` a la miniatura del archivo (generándola y
 * cacheándola si hace falta), o null si no se soporta / no se pudo generar.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function getThumbnail(filePath) {
  const p = String(filePath || '');
  if (!p || !isSupported(p)) return null;

  let stat;
  try {
    stat = fs.statSync(p);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  const cacheKey = cacheKeyFor(p, stat);
  const cachePath = path.join(thumbsDir(), `${cacheKey}.png`);

  if (memCache.has(cacheKey)) return fileUrl(memCache.get(cacheKey));
  if (fs.existsSync(cachePath)) {
    memCache.set(cacheKey, cachePath);
    return fileUrl(cachePath);
  }

  // Dedup: si ya hay un trabajo en vuelo para este mismo archivo (los
  // re-render del home piden la miniatura muchas veces), reusamos su promesa en
  // lugar de encolar duplicados que saturarían la cola serial.
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const ext = extOf(p);
  const kind = KIND_BY_EXT.get(ext);
  const promise = (
    IMAGE_THUMB_EXTS.has(ext)
      ? makeImageThumb(p, cacheKey, cachePath)
      : new Promise((resolve) => {
          queue.push({ filePath: p, kind, cacheKey, cachePath, resolve });
          processQueue();
        })
  ).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, promise);
  return promise;
}

module.exports = {
  isSupported,
  getThumbnail,
};

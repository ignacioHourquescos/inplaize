'use strict';

/**
 * Descargas centralizadas en el dock.
 *
 * Cada servicio corre en su propia `session.fromPartition(...)`. Aquí
 * enganchamos el evento `will-download` de cada partición (una sola vez) para:
 *  - Guardar el archivo directo en la carpeta Descargas del sistema (sin diálogo
 *    "Guardar como"), resolviendo colisiones con sufijos " (1)", " (2)", …
 *  - Mantener un historial en memoria de todas las descargas.
 *  - Reenviar inicio/progreso/fin al renderer del dock, que muestra toasts y un
 *    panel de historial (mismo patrón que las notificaciones in-app).
 *
 * Además, un watcher de las carpetas Descargas y Escritorio (`watchDownloadsFolder`)
 * incorpora al historial cualquier archivo que aparezca ahí aunque no lo haya
 * bajado inplaize (Chrome, Quick Share, programas que guardan en el escritorio, etc.).
 *
 * El historial es en memoria: se pierde al cerrar la app (decisión del plan).
 */

const path = require('path');
const fs = require('fs');
const { app, session, shell, BrowserWindow, nativeImage } = require('electron');

const { getDockWindow } = require('./dock-window-bridge');
const { appIconFile } = require('./app-identity');
const { log } = require('./logger');

/** Particiones ya enganchadas (evita registrar `will-download` dos veces). */
const registeredPartitions = new Set();

/**
 * @typedef {Object} DownloadRecord
 * @property {string} id
 * @property {string} filename
 * @property {string} savePath
 * @property {string} url
 * @property {string} sourceName
 * @property {'progressing'|'completed'|'cancelled'|'interrupted'|'paused'} state
 * @property {number} receivedBytes
 * @property {number} totalBytes
 * @property {number} startedAt
 * @property {number} [lastOpenedAt] Última vez que el usuario reabrió el archivo.
 * @property {boolean} paused
 */

/** @type {DownloadRecord[]} Historial (más reciente primero). */
const history = [];

/** @type {Map<string, Electron.DownloadItem>} Items vivos por id (para cancelar/pausar). */
const liveItems = new Map();

let _idSeq = 0;
function nextId() {
  _idSeq += 1;
  return `dl_${Date.now()}_${_idSeq}`;
}

/**
 * Devuelve una ruta libre en la carpeta destino resolviendo colisiones con
 * sufijos incrementales: `archivo.pdf` → `archivo (1).pdf` → `archivo (2).pdf`.
 * @param {string} dir
 * @param {string} filename
 * @returns {string}
 */
function uniqueDestPath(dir, filename) {
  const safeName = filename && typeof filename === 'string' ? filename : 'descarga';
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let candidate = path.join(dir, safeName);
  let n = 0;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

/**
 * Nombre visible del origen de la descarga (el acceso web que la disparó).
 * @param {Electron.DownloadItem} item
 * @returns {string}
 */
function sourceNameForItem(item) {
  try {
    const wc = item.getWebContents();
    if (!wc || wc.isDestroyed()) return 'Web';
    const win = BrowserWindow.fromWebContents(wc);
    if (win && !win.isDestroyed() && win.__usualDeskShortcutLabel) {
      return String(win.__usualDeskShortcutLabel);
    }
  } catch {
    /* noop */
  }
  return 'Web';
}

/**
 * @param {DownloadRecord} rec
 * @returns {Object} payload serializable para el renderer
 */
function toPayload(rec) {
  return {
    id: rec.id,
    filename: rec.filename,
    savePath: rec.savePath,
    url: rec.url,
    sourceName: rec.sourceName,
    state: rec.state,
    receivedBytes: rec.receivedBytes,
    totalBytes: rec.totalBytes,
    startedAt: rec.startedAt,
    lastOpenedAt: rec.lastOpenedAt || 0,
    paused: rec.paused,
  };
}

/**
 * @param {string} channel
 * @param {Object} payload
 */
function sendToDock(channel, payload) {
  const dock = getDockWindow();
  if (!dock || dock.isDestroyed()) return;
  try {
    dock.webContents.send(channel, payload);
  } catch {
    /* ventana cerrando */
  }
}

/**
 * Engancha las descargas de una partición. Idempotente por partición.
 * @param {string} partition
 */
function registerDownloadsForPartition(partition) {
  if (!partition || typeof partition !== 'string') return;
  if (registeredPartitions.has(partition)) return;
  registeredPartitions.add(partition);

  let ses;
  try {
    ses = session.fromPartition(partition);
  } catch {
    registeredPartitions.delete(partition);
    return;
  }

  ses.on('will-download', (_event, item) => {
    let downloadsDir;
    try {
      downloadsDir = app.getPath('downloads');
    } catch {
      downloadsDir = app.getPath('temp');
    }
    const filename = item.getFilename() || 'descarga';
    const dest = uniqueDestPath(downloadsDir, filename);
    try {
      item.setSavePath(dest);
    } catch {
      /* si falla, Chromium usa su propio diálogo/destino por defecto */
    }

    /** @type {DownloadRecord} */
    const rec = {
      id: nextId(),
      filename: path.basename(dest),
      savePath: dest,
      url: item.getURL() || '',
      sourceName: sourceNameForItem(item),
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes() || 0,
      startedAt: Date.now(),
      paused: false,
    };
    history.unshift(rec);
    liveItems.set(rec.id, item);
    sendToDock('dock-download-started', toPayload(rec));

    item.on('updated', (__e, updatedState) => {
      rec.receivedBytes = item.getReceivedBytes() || 0;
      rec.totalBytes = item.getTotalBytes() || rec.totalBytes;
      rec.paused = item.isPaused();
      if (updatedState === 'interrupted') {
        rec.state = 'interrupted';
      } else if (rec.paused) {
        rec.state = 'paused';
      } else {
        rec.state = 'progressing';
      }
      sendToDock('dock-download-updated', toPayload(rec));
    });

    item.once('done', (__e, doneState) => {
      rec.receivedBytes = item.getReceivedBytes() || rec.receivedBytes;
      rec.paused = false;
      if (doneState === 'completed') {
        rec.state = 'completed';
        rec.savePath = item.getSavePath() || rec.savePath;
        rec.filename = path.basename(rec.savePath);
        if (!rec.totalBytes) rec.totalBytes = rec.receivedBytes;
      } else if (doneState === 'cancelled') {
        rec.state = 'cancelled';
      } else {
        rec.state = 'interrupted';
      }
      liveItems.delete(rec.id);
      sendToDock('dock-download-done', toPayload(rec));
    });
  });
}

/* ---------------------------------------------------------------------------
 * Descargas "externas": archivos que no pasaron por `will-download` (watcher de
 * la carpeta Descargas, subidas desde el teléfono). Comparten el mismo
 * historial y los mismos canales hacia el renderer.
 * ------------------------------------------------------------------------- */

/**
 * Registra en el historial un archivo externo. Si `state` es `progressing`
 * emite `dock-download-started`; si es `completed` emite directo el `done`.
 * @param {{ filename: string, savePath: string, sourceName?: string, totalBytes?: number, state?: 'progressing'|'completed', startedAt?: number }} info
 * @returns {string} id del registro
 */
function addExternalDownload(info) {
  /** @type {DownloadRecord} */
  const rec = {
    id: nextId(),
    filename: String(info.filename || path.basename(info.savePath) || 'archivo'),
    savePath: String(info.savePath || ''),
    url: '',
    sourceName: String(info.sourceName || 'Sistema'),
    state: info.state === 'completed' ? 'completed' : 'progressing',
    receivedBytes: info.state === 'completed' ? Number(info.totalBytes) || 0 : 0,
    totalBytes: Number(info.totalBytes) || 0,
    startedAt: Number(info.startedAt) || Date.now(),
    paused: false,
  };
  history.unshift(rec);
  if (rec.state === 'completed') {
    sendToDock('dock-download-done', toPayload(rec));
  } else {
    sendToDock('dock-download-started', toPayload(rec));
  }
  return rec.id;
}

/**
 * Actualiza el progreso de una descarga externa en curso.
 * @param {string} id
 * @param {number} receivedBytes
 */
function updateExternalDownload(id, receivedBytes) {
  const rec = findRecord(id);
  if (!rec || rec.state !== 'progressing') return;
  rec.receivedBytes = Number(receivedBytes) || rec.receivedBytes;
  sendToDock('dock-download-updated', toPayload(rec));
}

/**
 * Cierra una descarga externa (completada o interrumpida).
 * @param {string} id
 * @param {{ ok: boolean, savePath?: string }} result
 */
function finishExternalDownload(id, result) {
  const rec = findRecord(id);
  if (!rec) return;
  if (result && result.savePath) {
    rec.savePath = result.savePath;
    rec.filename = path.basename(result.savePath);
  }
  if (result && result.ok) {
    rec.state = 'completed';
    try {
      rec.receivedBytes = rec.totalBytes = fs.statSync(rec.savePath).size;
    } catch {
      if (!rec.totalBytes) rec.totalBytes = rec.receivedBytes;
    }
  } else {
    rec.state = 'interrupted';
  }
  rec.paused = false;
  sendToDock('dock-download-done', toPayload(rec));
}

/**
 * ¿La ruta ya está registrada en el historial? (dedupe entre el watcher y las
 * descargas propias de inplaize, que caen en la misma carpeta).
 * @param {string} fullPath
 * @returns {boolean}
 */
function isPathTracked(fullPath) {
  const norm = path.resolve(String(fullPath || '')).toLowerCase();
  return history.some((r) => path.resolve(r.savePath || '').toLowerCase() === norm);
}

/* ---------------------------------------------------------------------------
 * Watcher de Descargas y del Escritorio.
 * ------------------------------------------------------------------------- */

/** Extensiones de archivos temporales de descargas en curso de otros programas. */
const TEMP_DOWNLOAD_EXTS = new Set([
  '.crdownload', // Chrome/Edge
  '.part', // Firefox
  '.partial', // Internet Explorer / legacy Edge
  '.opdownload', // Opera
  '.download', // Safari y otros
  '.tmp',
  '.uploading', // subidas desde el teléfono (este mismo módulo)
]);

/** Nombres de sistema que no son archivos del usuario (Escritorio y Descargas). */
const IGNORED_WATCHER_NAMES = new Set(['desktop.ini', 'thumbs.db']);

/** Accesos directos: en el Escritorio son íconos de programas, no archivos. */
const IGNORED_WATCHER_EXTS = new Set(['.lnk', '.url']);

/** ¿Nombre que debe ignorar el watcher? (temporales, ocultos, lock de Office, accesos). */
function isIgnoredWatcherName(name) {
  const n = String(name || '');
  if (!n || n.startsWith('.') || n.startsWith('~$')) return true;
  if (IGNORED_WATCHER_NAMES.has(n.toLowerCase())) return true;
  const ext = path.extname(n).toLowerCase();
  if (IGNORED_WATCHER_EXTS.has(ext)) return true;
  return TEMP_DOWNLOAD_EXTS.has(ext);
}

/** @type {Map<string, { timer: NodeJS.Timeout, lastSize: number, stableTicks: number }>} */
const pendingWatched = new Map();

/**
 * Espera a que el archivo deje de crecer (otros navegadores lo escriben de a
 * pedazos) y recién ahí lo registra en el historial como completado.
 * @param {string} fullPath
 * @param {string} [sourceName]
 */
function trackWatchedFileWhenStable(fullPath, sourceName) {
  if (pendingWatched.has(fullPath)) return;
  const entry = { timer: null, lastSize: -1, stableTicks: 0 };
  pendingWatched.set(fullPath, entry);

  const poll = () => {
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      pendingWatched.delete(fullPath); // borrado o renombrado mientras esperábamos
      return;
    }
    if (!stat.isFile()) {
      pendingWatched.delete(fullPath);
      return;
    }
    if (stat.size === entry.lastSize) {
      entry.stableTicks += 1;
    } else {
      entry.stableTicks = 0;
      entry.lastSize = stat.size;
    }
    // Dos lecturas iguales seguidas (~1.6 s) = escritura terminada.
    if (entry.stableTicks >= 2) {
      pendingWatched.delete(fullPath);
      if (isPathTracked(fullPath)) return;
      addExternalDownload({
        filename: path.basename(fullPath),
        savePath: fullPath,
        sourceName: sourceName || 'Sistema',
        totalBytes: stat.size,
        state: 'completed',
      });
      return;
    }
    entry.timer = setTimeout(poll, 800);
  };
  entry.timer = setTimeout(poll, 800);
}

let watcherStarted = false;

/**
 * Siembra y observa una carpeta de usuario (solo el primer nivel).
 * Los archivos nuevos quedan en el mismo historial que las descargas.
 * @param {string} dir
 * @param {{ seedCount: number, sourceName: string }} opts
 */
function watchUserFolder(dir, opts) {
  const sourceName = opts.sourceName || 'Sistema';
  const seedCount = opts.seedCount;

  // Siembra inicial: los N archivos más recientes, para que el panel no
  // arranque vacío (el historial vive en memoria y se pierde al cerrar).
  if (seedCount > 0) {
    try {
      const seeded = fs
        .readdirSync(dir)
        .filter((name) => !isIgnoredWatcherName(name))
        .map((name) => {
          const full = path.join(dir, name);
          try {
            const st = fs.statSync(full);
            return st.isFile() ? { full, name, mtime: st.mtimeMs, size: st.size } : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, seedCount);
      // Se insertan de más viejo a más nuevo para que el orden por startedAt quede bien.
      for (const f of seeded.reverse()) {
        if (isPathTracked(f.full)) continue;
        /** @type {DownloadRecord} */
        const rec = {
          id: nextId(),
          filename: f.name,
          savePath: f.full,
          url: '',
          sourceName,
          state: 'completed',
          receivedBytes: f.size,
          totalBytes: f.size,
          startedAt: Math.round(f.mtime),
          paused: false,
        };
        history.unshift(rec);
      }
    } catch {
      /* carpeta ilegible: seguimos solo con el watcher */
    }
  }

  try {
    fs.watch(dir, (_eventType, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (isIgnoredWatcherName(name)) return;
      const fullPath = path.join(dir, name);
      if (isPathTracked(fullPath)) return;
      if (!fs.existsSync(fullPath)) return; // 'rename' también dispara al borrar
      trackWatchedFileWhenStable(fullPath, sourceName);
    });
  } catch {
    /* fs.watch no disponible: el resto de la app sigue funcionando */
  }
}

/**
 * Observa Descargas y Escritorio e incorpora al historial cualquier archivo
 * nuevo. Idempotente. Cada carpeta siembra sus propios N archivos más recientes,
 * así un archivo del escritorio no queda tapado por descargas más nuevas.
 * Lo que guarda la app (descargas, teléfono, cajón, soltar) sigue yendo a Descargas.
 * @param {{ seedCount?: number }} [opts]
 */
function watchDownloadsFolder(opts = {}) {
  if (watcherStarted) return;
  watcherStarted = true;

  const seedCount = Number.isFinite(opts.seedCount) ? opts.seedCount : 20;
  /** @type {{ dir: string, sourceName: string }[]} */
  const roots = [];
  const seen = new Set();
  const addRoot = (kind, sourceName) => {
    let dir;
    try {
      dir = app.getPath(kind);
    } catch {
      return;
    }
    const norm = path.resolve(String(dir || '')).toLowerCase();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    roots.push({ dir, sourceName });
  };
  addRoot('downloads', 'Sistema');
  addRoot('desktop', 'Escritorio');

  for (const root of roots) {
    watchUserFolder(root.dir, { seedCount, sourceName: root.sourceName });
  }
}

/** @returns {Object[]} historial serializado (más reciente primero). */
function getHistory() {
  return history.map(toPayload);
}

/**
 * @param {string} id
 * @returns {DownloadRecord | undefined}
 */
function findRecord(id) {
  return history.find((r) => r.id === id);
}

/**
 * Ruta en disco de una descarga completada (para generar su miniatura).
 * @param {string} id
 * @returns {string|null}
 */
function getSavePath(id) {
  const rec = findRecord(id);
  if (!rec || rec.state !== 'completed' || !rec.savePath) return null;
  return rec.savePath;
}

/**
 * Abre el archivo descargado con la app por defecto del sistema.
 * @param {string} id
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function openFile(id) {
  const rec = findRecord(id);
  if (!rec || rec.state !== 'completed') return { ok: false, error: 'NOT_AVAILABLE' };
  if (!fs.existsSync(rec.savePath)) return { ok: false, error: 'FILE_MISSING' };
  const err = await shell.openPath(rec.savePath);
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/**
 * Marca un registro como reabierto: sella `lastOpenedAt` con la hora actual y
 * notifica al dock para reordenar/reclasificar el home. No toca `startedAt`, así
 * conserva la fecha real de descarga.
 * @param {string} id
 * @returns {{ ok: boolean }}
 */
function markOpened(id) {
  const rec = findRecord(id);
  if (!rec) return { ok: false };
  rec.lastOpenedAt = Date.now();
  sendToDock('dock-download-updated', toPayload(rec));
  return { ok: true };
}

/**
 * Muestra el archivo en su carpeta (Explorer).
 * @param {string} id
 * @returns {{ ok: boolean, error?: string }}
 */
function showInFolder(id) {
  const rec = findRecord(id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (!fs.existsSync(rec.savePath)) return { ok: false, error: 'FILE_MISSING' };
  shell.showItemInFolder(rec.savePath);
  return { ok: true };
}

/**
 * Cancela una descarga en curso.
 * @param {string} id
 * @returns {{ ok: boolean }}
 */
function cancelDownload(id) {
  const item = liveItems.get(id);
  if (item) {
    try {
      item.cancel();
    } catch {
      /* noop */
    }
  }
  return { ok: true };
}

/**
 * Quita una entrada del historial (no borra el archivo del disco). Si estaba en
 * curso, la cancela primero.
 * @param {string} id
 * @returns {{ ok: boolean }}
 */
function removeItem(id) {
  cancelDownload(id);
  const idx = history.findIndex((r) => r.id === id);
  if (idx >= 0) history.splice(idx, 1);
  liveItems.delete(id);
  return { ok: true };
}

/**
 * Sobrescribe una imagen descargada con la versión editada en el drawer.
 * Recibe un data URL (base64) generado por el canvas del renderer.
 * @param {string} id
 * @param {string} dataUrl
 * @returns {{ ok: boolean, error?: string }}
 */
function saveImageEdit(id, dataUrl) {
  const rec = findRecord(id);
  if (!rec || rec.state !== 'completed') return { ok: false, error: 'NOT_AVAILABLE' };
  if (!fs.existsSync(rec.savePath)) return { ok: false, error: 'FILE_MISSING' };
  const match = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) return { ok: false, error: 'BAD_DATA' };
  try {
    fs.writeFileSync(rec.savePath, Buffer.from(match[1], 'base64'));
    rec.totalBytes = rec.receivedBytes = fs.statSync(rec.savePath).size;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** True mientras DoDragDrop está en curso (el blur del dock no debe cerrar el panel). */
let nativeDragActive = false;

/**
 * Tras el drag, el renderer manda setIgnoreMouse encolados durante DoDragDrop.
 * Si los aplicamos, el dock fullscreen vuelve a tapar a WhatsApp.
 */
let passthroughFrozenUntil = 0;

/** @type {((win: Electron.BrowserWindow | null) => void) | null} */
let nativeDragEndHandler = null;

function isNativeDragActive() {
  return nativeDragActive;
}

function isPassthroughFrozen() {
  return nativeDragActive || Date.now() < passthroughFrozenUntil;
}

/** @param {(win: Electron.BrowserWindow | null) => void} fn */
function setNativeDragEndHandler(fn) {
  nativeDragEndHandler = typeof fn === 'function' ? fn : null;
}

/** Icono chico y síncrono. startDrag no puede esperar una miniatura. */
let cachedDragIcon = null;
function dragIconSync() {
  if (cachedDragIcon && !cachedDragIcon.isEmpty()) return cachedDragIcon;
  try {
    const img = nativeImage.createFromPath(appIconFile());
    if (img && !img.isEmpty()) {
      cachedDragIcon = img.resize({ width: 48, height: 48 });
      return cachedDragIcon;
    }
  } catch {
    /* sin ícono de app */
  }
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    buf[i * 4] = 0x6c;
    buf[i * 4 + 1] = 0x5c;
    buf[i * 4 + 2] = 0xfc;
    buf[i * 4 + 3] = 0xff;
  }
  cachedDragIcon = nativeImage.createFromBitmap(buf, { width: size, height: size });
  return cachedDragIcon;
}

/**
 * Rectángulo del tile en coordenadas de la ventana. Fuera de esa región el
 * HWND fullscreen del dock no existe para el mouse, así el drop cae en
 * WhatsApp, el mail o el escritorio que se ven detrás.
 * @param {Electron.BrowserWindow} win
 * @param {{ x?: number, y?: number, width?: number, height?: number } | null} anchor
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function dragHoleShape(win, anchor) {
  const bounds = win.getBounds();
  const maxW = Math.max(1, bounds.width);
  const maxH = Math.max(1, bounds.height);
  let x = Math.round(Number(anchor && anchor.x) || 0);
  let y = Math.round(Number(anchor && anchor.y) || 0);
  let width = Math.round(Number(anchor && anchor.width) || 0);
  let height = Math.round(Number(anchor && anchor.height) || 0);
  if (width < 8 || height < 8) return { x: 0, y: 0, width: 1, height: 1 };
  x = Math.max(0, Math.min(x, maxW - 1));
  y = Math.max(0, Math.min(y, maxH - 1));
  width = Math.max(1, Math.min(width, maxW - x));
  height = Math.max(1, Math.min(height, maxH - y));
  return { x, y, width, height };
}

/**
 * Inicia un drag & drop nativo del archivo descargado (arrastrar desde el home
 * de descargas hacia una ventana web —WhatsApp, Gmail…— o cualquier app del
 * sistema, como si viniera del Explorador).
 *
 * Tiene que ser síncrono: en Windows `startDrag` llama a DoDragDrop y, si se
 * espera una miniatura antes, el botón ya no cuenta como apretado y el drop
 * llega vacío.
 * @param {Electron.WebContents} sender webContents que origina el drag
 * @param {string} id
 * @param {{ x?: number, y?: number, width?: number, height?: number } | null} [anchor]
 * @returns {{ ok: boolean, error?: string }}
 */
function startNativeDrag(sender, id, anchor) {
  const rec = findRecord(id);
  if (!rec || rec.state !== 'completed') return { ok: false, error: 'NOT_AVAILABLE' };
  if (!fs.existsSync(rec.savePath)) return { ok: false, error: 'FILE_MISSING' };

  const win = BrowserWindow.fromWebContents(sender);
  const icon = dragIconSync();
  if (!icon || icon.isEmpty()) return { ok: false, error: 'NO_ICON' };

  let shaped = false;
  nativeDragActive = true;
  if (
    win &&
    !win.isDestroyed() &&
    process.platform === 'win32' &&
    typeof win.setShape === 'function'
  ) {
    try {
      win.setShape([dragHoleShape(win, anchor)]);
      shaped = true;
    } catch (err) {
      log(`downloads: setShape falló: ${err && err.message ? err.message : err}`);
    }
  }
  try {
    sender.startDrag({
      file: rec.savePath,
      files: [rec.savePath],
      icon,
    });
    return { ok: true };
  } catch (err) {
    const error = String((err && err.message) || err);
    log(`downloads: startDrag falló: ${error}`);
    return { ok: false, error };
  } finally {
    passthroughFrozenUntil = Date.now() + 200;
    if (shaped && win && !win.isDestroyed()) {
      try {
        win.setShape([]);
      } catch {
        /* noop */
      }
    }
    nativeDragActive = false;
    try {
      if (nativeDragEndHandler) nativeDragEndHandler(win || null);
    } catch {
      /* noop */
    }
  }
}

/**
 * Vacía el historial (no borra archivos). Las descargas en curso siguen.
 * @returns {{ ok: boolean }}
 */
function clear() {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].state !== 'progressing' && history[i].state !== 'paused') {
      history.splice(i, 1);
    }
  }
  return { ok: true };
}

/**
 * Copia archivos soltados en el dock a la carpeta Descargas del sistema y los
 * registra en el historial (misma zona que las descargas de navegador/teléfono).
 * @param {string[]} paths rutas absolutas de archivos locales
 * @returns {Promise<{ ok: boolean, count?: number, error?: string }>}
 */
async function ingestDroppedPaths(paths) {
  const list = Array.isArray(paths) ? paths.filter((p) => p && typeof p === 'string') : [];
  if (!list.length) return { ok: false, error: 'NO_FILES' };

  let downloadsDir;
  try {
    downloadsDir = app.getPath('downloads');
  } catch {
    downloadsDir = app.getPath('temp');
  }
  const normDownloads = path.resolve(downloadsDir).toLowerCase();
  let count = 0;

  for (const srcPath of list) {
    let stat;
    try {
      stat = fs.statSync(srcPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const normSrc = path.resolve(srcPath).toLowerCase();
    if (isPathTracked(srcPath)) {
      count += 1;
      continue;
    }

    // Ya está en Descargas: solo registrarlo en el historial.
    if (normSrc.startsWith(`${normDownloads}${path.sep}`)) {
      addExternalDownload({
        filename: path.basename(srcPath),
        savePath: srcPath,
        sourceName: 'Arrastrar y soltar',
        totalBytes: stat.size,
        state: 'completed',
      });
      count += 1;
      continue;
    }

    const dest = uniqueDestPath(downloadsDir, path.basename(srcPath));
    const recId = addExternalDownload({
      filename: path.basename(dest),
      savePath: dest,
      sourceName: 'Arrastrar y soltar',
      totalBytes: stat.size,
      state: 'progressing',
    });

    try {
      await fs.promises.copyFile(srcPath, dest);
      finishExternalDownload(recId, { ok: true, savePath: dest });
      count += 1;
    } catch {
      finishExternalDownload(recId, { ok: false });
    }
  }

  return { ok: count > 0, count };
}

module.exports = {
  registerDownloadsForPartition,
  watchDownloadsFolder,
  addExternalDownload,
  updateExternalDownload,
  finishExternalDownload,
  isPathTracked,
  uniqueDestPath,
  getHistory,
  getSavePath,
  openFile,
  markOpened,
  showInFolder,
  cancelDownload,
  removeItem,
  clear,
  saveImageEdit,
  startNativeDrag,
  isNativeDragActive,
  isPassthroughFrozen,
  setNativeDragEndHandler,
  ingestDroppedPaths,
};

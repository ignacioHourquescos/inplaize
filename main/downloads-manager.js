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
 * Además, un watcher de la carpeta Descargas del sistema (`watchDownloadsFolder`)
 * incorpora al historial cualquier archivo que aparezca ahí aunque no lo haya
 * bajado inplaize (Chrome, Quick Share, subidas desde el teléfono, etc.).
 *
 * El historial es en memoria: se pierde al cerrar la app (decisión del plan).
 */

const path = require('path');
const fs = require('fs');
const { app, session, shell, BrowserWindow, nativeImage } = require('electron');

const { getDockWindow } = require('./dock-window-bridge');

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
 * Watcher de la carpeta Descargas del sistema.
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

/** ¿Nombre que debe ignorar el watcher? (temporales, ocultos, lock de Office). */
function isIgnoredWatcherName(name) {
  const n = String(name || '');
  if (!n || n.startsWith('.') || n.startsWith('~$')) return true;
  return TEMP_DOWNLOAD_EXTS.has(path.extname(n).toLowerCase());
}

/** @type {Map<string, { timer: NodeJS.Timeout, lastSize: number, stableTicks: number }>} */
const pendingWatched = new Map();

/**
 * Espera a que el archivo deje de crecer (otros navegadores lo escriben de a
 * pedazos) y recién ahí lo registra en el historial como completado.
 * @param {string} fullPath
 */
function trackWatchedFileWhenStable(fullPath) {
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
        sourceName: 'Sistema',
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
 * Observa la carpeta Descargas del sistema e incorpora al historial cualquier
 * archivo nuevo, venga de donde venga. Idempotente. Además siembra el
 * historial con los archivos más recientes ya presentes en la carpeta.
 * @param {{ seedCount?: number }} [opts]
 */
function watchDownloadsFolder(opts = {}) {
  if (watcherStarted) return;
  watcherStarted = true;

  let downloadsDir;
  try {
    downloadsDir = app.getPath('downloads');
  } catch {
    return;
  }

  // Siembra inicial: los N archivos más recientes, para que el panel no
  // arranque vacío (el historial vive en memoria y se pierde al cerrar).
  const seedCount = Number.isFinite(opts.seedCount) ? opts.seedCount : 20;
  if (seedCount > 0) {
    try {
      const seeded = fs
        .readdirSync(downloadsDir)
        .filter((name) => !isIgnoredWatcherName(name))
        .map((name) => {
          const full = path.join(downloadsDir, name);
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
          sourceName: 'Sistema',
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
    fs.watch(downloadsDir, (eventType, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (isIgnoredWatcherName(name)) return;
      const fullPath = path.join(downloadsDir, name);
      if (isPathTracked(fullPath)) return;
      if (!fs.existsSync(fullPath)) return; // 'rename' también dispara al borrar
      trackWatchedFileWhenStable(fullPath);
    });
  } catch {
    /* fs.watch no disponible: el resto de la app sigue funcionando */
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

/**
 * Inicia un drag & drop nativo del archivo descargado (arrastrar desde el home
 * de descargas hacia una ventana web —WhatsApp, Gmail…— o cualquier app del
 * sistema, como si viniera del Explorador).
 * @param {Electron.WebContents} sender webContents que origina el drag
 * @param {string} id
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function startNativeDrag(sender, id) {
  const rec = findRecord(id);
  if (!rec || rec.state !== 'completed') return { ok: false, error: 'NOT_AVAILABLE' };
  if (!fs.existsSync(rec.savePath)) return { ok: false, error: 'FILE_MISSING' };

  // Icono que acompaña al cursor: miniatura real del archivo (Windows/macOS la
  // resuelve el shell para cualquier tipo); si falla, un placeholder mínimo.
  let icon = null;
  try {
    icon = await nativeImage.createThumbnailFromPath(rec.savePath, { width: 64, height: 64 });
  } catch {
    /* sin miniatura disponible */
  }
  if (!icon || icon.isEmpty()) {
    try {
      icon = await app.getFileIcon(rec.savePath, { size: 'normal' });
    } catch {
      icon = nativeImage.createEmpty();
    }
  }

  try {
    sender.startDrag({ file: rec.savePath, icon });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
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
  openFile,
  showInFolder,
  cancelDownload,
  removeItem,
  clear,
  saveImageEdit,
  startNativeDrag,
  ingestDroppedPaths,
};

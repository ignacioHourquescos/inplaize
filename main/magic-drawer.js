'use strict';

/**
 * Cajón mágico: transformaciones de archivos por drag & drop en el home.
 *
 * Cada trabajo corre ffmpeg (binario de `ffmpeg-static`, empaquetado con la
 * app) y se registra como una "descarga externa" en `downloads-manager`, así
 * el progreso, el toast y la tile en la grilla salen gratis con la
 * infraestructura existente.
 *
 * Acciones soportadas:
 *  - compress-image  (target: 'light' | 'medium' | 'max')
 *  - compress-video  (target: 'light' | 'medium' | 'max')
 *  - convert         (target: 'png' | 'jpg' | 'webp' | 'mp4' | 'webm' | 'gif' | 'mp3' | 'wav')
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app } = require('electron');

const downloads = require('./downloads-manager');

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'avif']);
// GIF se trata como video: sus conversiones útiles son GIF→MP4/WebM.
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv', 'gif']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma', 'opus']);

/** @param {string} filePath @returns {'image'|'video'|'audio'|null} */
function fileKind(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

/** Ruta al binario de ffmpeg (fuera del asar cuando la app está empaquetada). */
function resolveFfmpegPath() {
  let p;
  try {
    p = require('ffmpeg-static');
  } catch {
    return null;
  }
  if (typeof p !== 'string' || !p) return null;
  if (p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(p) ? p : null;
}

/** Calidad JPEG de ffmpeg (mjpeg): menor = mejor. */
const JPEG_Q = { light: 3, medium: 5, max: 8 };
/** Calidad WebP (0-100): mayor = mejor. */
const WEBP_QUALITY = { light: 85, medium: 75, max: 60 };
/** CRF x264: mayor = más compresión. */
const VIDEO_CRF = { light: 24, medium: 28, max: 32 };

/** Escala a dimensiones pares (requisito de yuv420p). */
const EVEN_SCALE = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

/**
 * Args de ffmpeg + nombre de salida para una acción.
 * @returns {{ args: string[], outName: string } | { error: string }}
 */
function buildJob(filePath, action, target) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const base = path.basename(filePath, path.extname(filePath));
  const kind = fileKind(filePath);

  if (action === 'compress-image') {
    if (kind !== 'image') return { error: 'WRONG_TYPE' };
    const level = ['light', 'medium', 'max'].includes(target) ? target : 'medium';
    if (ext === 'jpg' || ext === 'jpeg') {
      return {
        outName: `${base} (comprimida).jpg`,
        args: ['-q:v', String(JPEG_Q[level])],
      };
    }
    // PNG/BMP/etc → WebP (conserva transparencia y comprime mucho mejor).
    return {
      outName: `${base} (comprimida).webp`,
      args: ['-c:v', 'libwebp', '-quality', String(WEBP_QUALITY[level])],
    };
  }

  if (action === 'compress-video') {
    if (kind !== 'video') return { error: 'WRONG_TYPE' };
    const level = ['light', 'medium', 'max'].includes(target) ? target : 'medium';
    return {
      outName: `${base} (comprimido).mp4`,
      args: [
        '-vf', EVEN_SCALE,
        '-c:v', 'libx264',
        '-crf', String(VIDEO_CRF[level]),
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
      ],
    };
  }

  if (action === 'convert') {
    const t = String(target || '').toLowerCase();
    if (t === ext) return { error: 'SAME_FORMAT' };
    switch (t) {
      case 'png':
        if (kind !== 'image') return { error: 'WRONG_TYPE' };
        return { outName: `${base}.png`, args: [] };
      case 'jpg':
        if (kind !== 'image') return { error: 'WRONG_TYPE' };
        return { outName: `${base}.jpg`, args: ['-q:v', '3'] };
      case 'webp':
        if (kind !== 'image') return { error: 'WRONG_TYPE' };
        return { outName: `${base}.webp`, args: ['-c:v', 'libwebp', '-quality', '90'] };
      case 'mp4':
        if (kind !== 'video') return { error: 'WRONG_TYPE' };
        return {
          outName: `${base}.mp4`,
          args: [
            '-vf', EVEN_SCALE,
            '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '160k',
            '-movflags', '+faststart',
          ],
        };
      case 'webm':
        if (kind !== 'video') return { error: 'WRONG_TYPE' };
        return {
          outName: `${base}.webm`,
          args: [
            '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0',
            '-deadline', 'good', '-cpu-used', '4',
            '-c:a', 'libopus',
          ],
        };
      case 'gif':
        if (kind !== 'video') return { error: 'WRONG_TYPE' };
        return {
          outName: `${base}.gif`,
          args: [
            '-filter_complex',
            "[0:v]fps=12,scale='min(480,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
          ],
        };
      case 'mp3':
        if (kind !== 'video' && kind !== 'audio') return { error: 'WRONG_TYPE' };
        return { outName: `${base}.mp3`, args: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'] };
      case 'wav':
        if (kind !== 'audio') return { error: 'WRONG_TYPE' };
        return { outName: `${base}.wav`, args: ['-vn'] };
      default:
        return { error: 'BAD_TARGET' };
    }
  }

  return { error: 'BAD_ACTION' };
}

/** Parsea "HH:MM:SS.xx" de la salida de ffmpeg a segundos. */
function parseFfmpegTime(str) {
  const m = /(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(String(str || ''));
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Un solo trabajo a la vez (v1): los drops mientras corre uno se rechazan. */
let activeJob = false;

function isBusy() {
  return activeJob;
}

/**
 * Lanza una transformación. Devuelve enseguida el id del registro en el
 * historial de descargas; el progreso y el fin llegan al renderer por los
 * canales `dock-download-*` de siempre.
 *
 * @param {{ filePath: string, action: string, target?: string }} payload
 * @returns {{ ok: true, id: string, filename: string } | { ok: false, error: string }}
 */
function transformFile(payload) {
  const filePath = String((payload && payload.filePath) || '');
  const action = String((payload && payload.action) || '');
  const target = payload && payload.target;

  if (activeJob) return { ok: false, error: 'BUSY' };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'FILE_MISSING' };

  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) return { ok: false, error: 'FFMPEG_MISSING' };

  const job = buildJob(filePath, action, target);
  if (job.error) return { ok: false, error: job.error };

  let inputSize = 0;
  try {
    inputSize = fs.statSync(filePath).size;
  } catch {
    /* progreso indeterminado */
  }

  let downloadsDir;
  try {
    downloadsDir = app.getPath('downloads');
  } catch {
    downloadsDir = app.getPath('temp');
  }
  const outPath = downloads.uniqueDestPath(downloadsDir, job.outName);

  // El registro previo del path evita que el watcher de Descargas duplique la
  // entrada cuando ffmpeg empiece a escribir el archivo.
  const id = downloads.addExternalDownload({
    filename: path.basename(outPath),
    savePath: outPath,
    sourceName: 'Cajón mágico',
    totalBytes: inputSize,
    state: 'progressing',
  });

  activeJob = true;

  const args = ['-hide_banner', '-y', '-i', filePath, ...job.args, outPath];
  let child;
  try {
    child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    activeJob = false;
    downloads.finishExternalDownload(id, { ok: false });
    return { ok: false, error: String((err && err.message) || err) };
  }

  // Progreso: ffmpeg imprime "Duration: .." del input y luego líneas "time=.."
  // del avance. El porcentaje se mapea contra el tamaño del archivo original.
  let durationSec = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (!durationSec) {
      const dm = /Duration:\s*([\d:.]+)/.exec(text);
      if (dm) durationSec = parseFfmpegTime(dm[1]);
    }
    const tm = /time=\s*([\d:.]+)/.exec(text);
    if (tm && durationSec > 0 && inputSize > 0) {
      const pct = Math.max(0, Math.min(1, parseFfmpegTime(tm[1]) / durationSec));
      downloads.updateExternalDownload(id, Math.round(pct * inputSize));
    }
  });

  const finish = (ok) => {
    activeJob = false;
    if (!ok) {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath); // salida parcial
      } catch {
        /* noop */
      }
    }
    downloads.finishExternalDownload(id, { ok, savePath: outPath });
  };

  child.once('error', () => finish(false));
  child.once('close', (code) => finish(code === 0 && fs.existsSync(outPath)));

  return { ok: true, id, filename: path.basename(outPath) };
}

module.exports = { transformFile, fileKind, isBusy };

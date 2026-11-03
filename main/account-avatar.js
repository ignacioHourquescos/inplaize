'use strict';

/**
 * Fotos redondas de las cuentas de Google para el menú de perfiles (16 px,
 * dibujadas a 32 px para pantallas con escala) y para el chip de la barra.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, nativeImage, session } = require('electron');

const SIZE = 32;

function avatarsDir() {
  return path.join(app.getPath('userData'), 'browse-avatars');
}

/** @param {string} email */
function avatarFile(email) {
  const hash = crypto.createHash('sha1').update(String(email).toLowerCase()).digest('hex');
  return path.join(avatarsDir(), `${hash}.png`);
}

function hueOf(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/**
 * Recorta en círculo (con borde suavizado). Sin foto, un círculo de color
 * (gris si no hay semilla: "Sin sesión").
 * @param {Electron.NativeImage | null} image
 * @param {string} seed para el color de respaldo
 * @returns {Electron.NativeImage}
 */
function circleIcon(image, seed) {
  /** @type {Buffer} */
  let buf;
  if (image && !image.isEmpty()) {
    buf = Buffer.from(image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toBitmap());
  } else {
    const [r, g, b] = seed ? hslToRgb(hueOf(seed), 0.55, 0.45) : hslToRgb(0, 0, 0.58);
    buf = Buffer.alloc(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; i++) {
      buf[i * 4] = b;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = r;
      buf[i * 4 + 3] = 255;
    }
  }
  const c = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const coverage = Math.max(0, Math.min(1, c - d + 0.5));
      if (coverage >= 1) continue;
      const i = (y * SIZE + x) * 4;
      // Bitmap premultiplicado: se escalan los cuatro canales.
      for (let k = 0; k < 4; k++) buf[i + k] = Math.round(buf[i + k] * coverage);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE, scaleFactor: 2 });
}

/**
 * Foto de la cuenta: del caché en disco o descargada de Google con la sesión
 * de esa partition.
 * @param {string} email
 * @param {string} [photoUrl]
 * @param {string} [partition]
 * @returns {Promise<Electron.NativeImage | null>}
 */
async function loadAccountPhoto(email, photoUrl, partition) {
  const file = avatarFile(email);
  try {
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
  } catch {
    /* se vuelve a descargar */
  }
  if (!photoUrl || !/^https:\/\//i.test(photoUrl)) return null;
  try {
    const ses = partition ? session.fromPartition(partition) : session.defaultSession;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    let res;
    try {
      res = await ses.fetch(photoUrl, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return null;
    const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
    if (img.isEmpty()) return null;
    const small = img.resize({ width: 64, height: 64, quality: 'best' });
    fs.mkdirSync(avatarsDir(), { recursive: true });
    fs.writeFileSync(file, small.toPNG());
    return small;
  } catch {
    return null;
  }
}

/**
 * Guarda como foto de la cuenta una imagen local (la de un perfil de Chrome).
 * @param {string} email
 * @param {string} filePath
 */
function cachePhotoFromFile(email, filePath) {
  if (!email || !filePath) return;
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return;
    fs.mkdirSync(avatarsDir(), { recursive: true });
    fs.writeFileSync(avatarFile(email), img.resize({ width: 64, height: 64, quality: 'best' }).toPNG());
  } catch {
    /* noop */
  }
}

module.exports = {
  circleIcon,
  loadAccountPhoto,
  cachePhotoFromFile,
};

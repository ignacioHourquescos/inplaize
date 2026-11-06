'use strict';

/**
 * Bóveda de contraseñas de la app: credenciales que el usuario guarda al
 * loguearse y las importadas de otros navegadores. Se usa para autocompletar
 * formularios de login en la navegación suelta.
 *
 * Seguridad: el archivo `<userData>/passwords.dat` se cifra con `safeStorage`
 * de Electron (en Windows respaldado por DPAPI, ligado a la cuenta de usuario).
 * Si el cifrado no está disponible NO se guarda nada en claro: la bóveda queda
 * deshabilitada y las operaciones devuelven un error controlado.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/** @typedef {{ id: string, origin: string, host: string, username: string, password: string, updated: number }} Credential */

/** @type {Credential[] | null} */
let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), 'passwords.dat');
}

function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function makeId() {
  return `pw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** @returns {Credential[]} */
function load() {
  if (cache) return cache;
  cache = [];
  if (!available()) return cache;
  try {
    const buf = fs.readFileSync(filePath());
    const json = safeStorage.decryptString(buf);
    const raw = JSON.parse(json);
    if (Array.isArray(raw)) {
      for (const c of raw) {
        if (!c || typeof c !== 'object') continue;
        const origin = String(c.origin || '');
        cache.push({
          id: String(c.id || makeId()),
          origin,
          host: String(c.host || hostOf(origin)),
          username: String(c.username || ''),
          password: String(c.password || ''),
          updated: Number(c.updated) || Date.now(),
        });
      }
    }
  } catch {
    /* primer uso o archivo ilegible */
  }
  return cache;
}

function save() {
  if (!available()) return false;
  try {
    const buf = safeStorage.encryptString(JSON.stringify(load()));
    fs.writeFileSync(filePath(), buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guarda/actualiza una credencial (clave: host + usuario).
 * @param {{ origin: string, username: string, password: string }} cred
 * @returns {Credential | null}
 */
function upsert(cred) {
  if (!available()) return null;
  const origin = String((cred && cred.origin) || '');
  const host = hostOf(origin);
  const username = String((cred && cred.username) || '');
  const password = String((cred && cred.password) || '');
  if (!host || !password) return null;
  const items = load();
  const existing = items.find((c) => c.host === host && c.username === username);
  if (existing) {
    existing.password = password;
    existing.origin = origin || existing.origin;
    existing.updated = Date.now();
    save();
    return { ...existing };
  }
  const entry = { id: makeId(), origin, host, username, password, updated: Date.now() };
  items.push(entry);
  save();
  return { ...entry };
}

/**
 * Credenciales para un host (para autocompletar). Más recientes primero.
 * @param {string} url o host
 * @returns {Array<{ id: string, username: string, password: string }>}
 */
function forHost(url) {
  const host = hostOf(url) || String(url || '').toLowerCase().replace(/^www\./, '');
  if (!host) return [];
  return load()
    .filter((c) => c.host === host)
    .sort((a, b) => b.updated - a.updated)
    .map((c) => ({ id: c.id, username: c.username, password: c.password }));
}

/** Lista para mostrar en Ajustes: nunca devuelve la contraseña en claro. */
function listForDisplay() {
  return load()
    .slice()
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((c) => ({ id: c.id, host: c.host, origin: c.origin, username: c.username }));
}

/** @param {string} id */
function remove(id) {
  const items = load();
  const idx = items.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  save();
  return true;
}

/**
 * Mezcla credenciales importadas (dedupe por host+usuario).
 * @param {Array<{ url?: string, origin?: string, username: string, password: string }>} entries
 * @returns {{ imported: number, available: boolean }}
 */
function importEntries(entries) {
  if (!available()) return { imported: 0, available: false };
  if (!Array.isArray(entries) || entries.length === 0) return { imported: 0, available: true };
  const items = load();
  let imported = 0;
  for (const e of entries) {
    const origin = String((e && (e.origin || e.url)) || '');
    const host = hostOf(origin);
    const username = String((e && e.username) || '');
    const password = String((e && e.password) || '');
    if (!host || !password) continue;
    const existing = items.find((c) => c.host === host && c.username === username);
    if (existing) {
      existing.password = password;
      existing.updated = Date.now();
    } else {
      items.push({ id: makeId(), origin, host, username, password, updated: Date.now() });
    }
    imported += 1;
  }
  if (imported) save();
  return { imported, available: true };
}

module.exports = {
  available,
  upsert,
  forHost,
  listForDisplay,
  remove,
  importEntries,
};

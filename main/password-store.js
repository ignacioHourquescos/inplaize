'use strict';

/**
 * Contraseñas guardadas de la navegación suelta. Las claves se cifran con
 * safeStorage (DPAPI en Windows): el archivo solo se puede leer con esta
 * cuenta de usuario en esta máquina.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage, BrowserWindow } = require('electron');

/**
 * @typedef {{ id: string, origin: string, username: string, secret: string, createdAt: number, updatedAt: number, usedAt: number }} StoredCredential
 * @typedef {{ offerToSave: boolean, autofill: boolean }} PasswordSettings
 * @typedef {{ credentials: StoredCredential[], neverSave: string[], settings: PasswordSettings }} PasswordFile
 */

const DEFAULT_SETTINGS = { offerToSave: true, autofill: true };

function filePath() {
  return path.join(app.getPath('userData'), 'passwords.json');
}

/** @type {PasswordFile | null} */
let cache = null;

/** @returns {PasswordFile} */
function load() {
  if (cache) return cache;
  /** @type {PasswordFile} */
  let data = { credentials: [], neverSave: [], settings: { ...DEFAULT_SETTINGS } };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf-8'));
    data = {
      credentials: Array.isArray(raw.credentials)
        ? raw.credentials.filter((c) => c && typeof c.origin === 'string' && typeof c.secret === 'string')
        : [],
      neverSave: Array.isArray(raw.neverSave) ? raw.neverSave.filter((o) => typeof o === 'string') : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) },
    };
  } catch {
    /* primer uso */
  }
  cache = data;
  return data;
}

function save() {
  if (!cache) return;
  try {
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    /* noop */
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('passwords-changed');
  }
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** @param {string} password */
function seal(password) {
  if (!canEncrypt()) throw new Error('El cifrado del sistema no está disponible');
  return safeStorage.encryptString(password).toString('base64');
}

/** @param {string} secret */
function unseal(secret) {
  try {
    return safeStorage.decryptString(Buffer.from(secret, 'base64'));
  } catch {
    return '';
  }
}

/** @param {string} url */
function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
  } catch {
    return '';
  }
}

function settings() {
  return { ...load().settings };
}

/** @param {Partial<PasswordSettings>} patch */
function updateSettings(patch) {
  const data = load();
  data.settings = { ...data.settings, ...patch };
  save();
}

/** @param {string} origin */
function isNeverSave(origin) {
  return load().neverSave.includes(origin);
}

/** @param {string} origin */
function addNeverSave(origin) {
  const data = load();
  if (!data.neverSave.includes(origin)) data.neverSave.push(origin);
  save();
}

/** @param {string} origin */
function removeNeverSave(origin) {
  const data = load();
  data.neverSave = data.neverSave.filter((o) => o !== origin);
  save();
}

/** @param {string} origin @param {string} username */
function find(origin, username) {
  return load().credentials.find((c) => c.origin === origin && c.username === username) || null;
}

/**
 * Qué haría falta para guardar este login: nada (ya está igual), guardarlo o actualizarlo.
 * @param {string} origin @param {string} username @param {string} password
 * @returns {'none' | 'save' | 'update'}
 */
function pendingAction(origin, username, password) {
  const existing = find(origin, username);
  if (!existing) return 'save';
  return unseal(existing.secret) === password ? 'none' : 'update';
}

/** @param {string} origin @param {string} username @param {string} password */
function upsert(origin, username, password) {
  const data = load();
  const now = Date.now();
  const existing = find(origin, username);
  if (existing) {
    existing.secret = seal(password);
    existing.updatedAt = now;
  } else {
    data.credentials.push({
      id: crypto.randomUUID(),
      origin,
      username,
      secret: seal(password),
      createdAt: now,
      updatedAt: now,
      usedAt: now,
    });
  }
  save();
}

/** Logins para completar en una página: el último usado primero. */
/** @param {string} origin */
function forOrigin(origin) {
  return load()
    .credentials.filter((c) => c.origin === origin)
    .sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0))
    .map((c) => ({ id: c.id, username: c.username, password: unseal(c.secret) }))
    .filter((c) => c.password);
}

/** @param {string} id */
function markUsed(id) {
  const c = load().credentials.find((x) => x.id === id);
  if (!c) return;
  c.usedAt = Date.now();
  save();
}

/** Lista para el gestor, sin las claves. */
function list() {
  return load()
    .credentials.map((c) => ({ id: c.id, origin: c.origin, username: c.username, updatedAt: c.updatedAt }))
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
}

/** @param {string} id */
function reveal(id) {
  const c = load().credentials.find((x) => x.id === id);
  return c ? unseal(c.secret) : '';
}

/** @param {string} id @param {{ username?: string, password?: string }} patch */
function update(id, patch) {
  const c = load().credentials.find((x) => x.id === id);
  if (!c) return false;
  if (typeof patch.username === 'string') c.username = patch.username.trim();
  if (typeof patch.password === 'string' && patch.password) c.secret = seal(patch.password);
  c.updatedAt = Date.now();
  save();
  return true;
}

/** @param {string} id */
function remove(id) {
  const data = load();
  const before = data.credentials.length;
  data.credentials = data.credentials.filter((c) => c.id !== id);
  if (data.credentials.length !== before) save();
  return data.credentials.length !== before;
}

function neverSaveList() {
  return [...load().neverSave].sort();
}

module.exports = {
  originOf,
  canEncrypt,
  settings,
  updateSettings,
  isNeverSave,
  addNeverSave,
  removeNeverSave,
  pendingAction,
  upsert,
  forOrigin,
  markUsed,
  list,
  reveal,
  update,
  remove,
  neverSaveList,
};

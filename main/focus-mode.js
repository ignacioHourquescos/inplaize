'use strict';

/**
 * Modo foco: colección efímera de shortcuts web cuyo audio y notificaciones
 * pasan al primer plano. Todo lo que quede fuera se silencia y se bloquea.
 *
 * Reglas:
 *   - Click con botón derecho sobre un icono → `toggleMember(mapKey)`:
 *       · si el icono NO estaba en la colección → lo añade (activando el
 *         modo si hiciera falta).
 *       · si YA estaba en la colección → lo saca. Si la colección queda
 *         vacía, se sale del modo foco y se restaura el snapshot.
 *     Funciona también sobre iconos de ventanas cerradas (se abren al
 *     añadirse).
 *   - Left-click de activación sobre cualquier icono (manejado en los
 *     renderers) llama a `exitFocusMode()` y restaura el snapshot.
 *
 * Snapshot: al activar el modo se captura `audioMuted` / `notificationsMuted`
 * de TODOS los shortcuts web. Al salir se restauran tal cual estaban.
 *
 * Sólo runtime; no se persiste nada a disco.
 */

const { BrowserWindow } = require('electron');
const { loadShortcuts } = require('./shortcuts-store');
const { webMapKey } = require('./web-map-key');

/** @type {Set<string>} mapKeys dentro de la colección de foco. */
const collection = new Set();

/** @type {Record<string, { audioMuted: boolean, notificationsMuted: boolean, shortcut: any }> | null} */
let snapshot = null;

function isActive() {
  return snapshot !== null;
}

function getMembers() {
  return [...collection];
}

function getState() {
  return { active: isActive(), members: getMembers() };
}

function snapshotAllWebShortcuts() {
  const list = loadShortcuts();
  /** @type {Record<string, { audioMuted: boolean, notificationsMuted: boolean, shortcut: any }>} */
  const snap = {};
  for (const s of list) {
    if (!s || s.type !== 'web') continue;
    const id = String(s.id);
    snap[id] = {
      audioMuted: s.audioMuted === true,
      notificationsMuted: s.notificationsMuted === true,
      shortcut: s,
    };
  }
  return snap;
}

/**
 * Aplica en runtime (webContents abiertos) el mute correspondiente según
 * pertenencia a la colección: dentro → audio+notifs libres, fuera → muteado.
 */
function applyMutesForCurrentCollection() {
  const {
    setWebShortcutAudioMuted,
    setWebShortcutNotificationsMuted,
  } = require('./open-shortcut');
  const list = loadShortcuts();
  for (const s of list) {
    if (!s || s.type !== 'web') continue;
    const mk = webMapKey(s);
    const inside = collection.has(mk);
    setWebShortcutAudioMuted(s, !inside);
    setWebShortcutNotificationsMuted(s, !inside);
  }
}

function restoreSnapshot() {
  if (!snapshot) return;
  const {
    setWebShortcutAudioMuted,
    setWebShortcutNotificationsMuted,
  } = require('./open-shortcut');
  for (const id of Object.keys(snapshot)) {
    const entry = snapshot[id];
    if (!entry || !entry.shortcut) continue;
    setWebShortcutAudioMuted(entry.shortcut, entry.audioMuted);
    setWebShortcutNotificationsMuted(entry.shortcut, entry.notificationsMuted);
  }
}

function broadcast() {
  const state = getState();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue;
    try {
      w.webContents.send('focus-mode-changed', state);
    } catch {
      /* ventana cerrando */
    }
  }
  try {
    require('./web-shell').broadcastChromeIfOpen();
  } catch {
    /* noop */
  }
  try {
    require('./detached-web-frame').broadcastChromeToAllDetachedHosts();
  } catch {
    /* noop */
  }
}

/**
 * Alterna la pertenencia de un mapKey en la colección de foco.
 *   - Si el modo no estaba activo, lo activa tomando snapshot global y
 *     añadiendo `mapKey` como primer miembro.
 *   - Si estaba activo y `mapKey` no era miembro, lo añade.
 *   - Si estaba activo y `mapKey` ya era miembro, lo quita. Si tras quitarlo
 *     la colección queda vacía, sale del modo y restaura el snapshot.
 *
 * @param {string} mapKey
 * @returns {boolean} true si tras la acción la clave forma parte de la
 *   colección; false si se quitó o si la clave era inválida.
 */
function toggleMember(mapKey) {
  if (!mapKey || typeof mapKey !== 'string') return false;

  if (!isActive()) {
    snapshot = snapshotAllWebShortcuts();
    collection.clear();
    collection.add(mapKey);
    applyMutesForCurrentCollection();
    broadcast();
    return true;
  }

  if (collection.has(mapKey)) {
    collection.delete(mapKey);
    if (collection.size === 0) {
      // Última membresía retirada → apagar modo foco por completo.
      restoreSnapshot();
      snapshot = null;
      broadcast();
      return false;
    }
    applyMutesForCurrentCollection();
    broadcast();
    return false;
  }

  collection.add(mapKey);
  applyMutesForCurrentCollection();
  broadcast();
  return true;
}

function exitFocusMode() {
  if (!isActive()) {
    collection.clear();
    snapshot = null;
    return;
  }
  restoreSnapshot();
  snapshot = null;
  collection.clear();
  broadcast();
}

/**
 * Si hay modo foco activo, devuelve el override de audio/notifs a aplicar al
 * abrir o reenfocar un shortcut web. `null` si no hay modo foco.
 * @param {string} mapKey
 * @returns {{ audioMuted: boolean, notificationsMuted: boolean } | null}
 */
function getRuntimeOverride(mapKey) {
  if (!isActive()) return null;
  const inside = collection.has(mapKey);
  return { audioMuted: !inside, notificationsMuted: !inside };
}

function isMember(mapKey) {
  return isActive() && collection.has(mapKey);
}

module.exports = {
  isActive,
  isMember,
  getMembers,
  getState,
  toggleMember,
  exitFocusMode,
  getRuntimeOverride,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const {
  DEFAULT_SHORTCUTS,
  LOOSE_NAV_DEFAULT_SHORTCUT,
  MAX_SHORTCUT_UNDO,
} = require('./constants');

let undoStack = [];

function shortcutsFilePath() {
  return path.join(app.getPath('userData'), 'shortcuts.json');
}

/** @param {unknown} raw */
function shortcutArrayFromFilePayload(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.shortcuts)) return raw.shortcuts;
  return null;
}

/**
 * Migración suave: usuarios con shortcuts existentes pero sin el acceso de
 * "Navegación suelta" lo reciben automáticamente. NO se inyecta en listas
 * vacías (instalación nueva o usuario que borró todo): ahí queremos que el
 * onboarding lo guíe a crear su primera ventana sin elementos pre-cargados.
 */
function ensureLooseNavShortcutPresent(list) {
  if (!Array.isArray(list)) return { list, mutated: false };
  if (list.length === 0) return { list, mutated: false };
  const hasLoose = list.some((s) => s && s.type === 'loose');
  if (hasLoose) return { list, mutated: false };
  return { list: [...list, LOOSE_NAV_DEFAULT_SHORTCUT], mutated: true };
}

function loadShortcuts() {
  try {
    const p = shortcutsFilePath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const list = shortcutArrayFromFilePayload(raw);
      if (list !== null) {
        const { list: ensured, mutated } = ensureLooseNavShortcutPresent(list);
        if (mutated) {
          try {
            saveShortcuts(ensured);
          } catch {
            /* mantener en memoria aunque falle la persistencia */
          }
        }
        return ensured;
      }
    }
  } catch {
    /* fall through */
  }
  saveShortcuts(DEFAULT_SHORTCUTS);
  return DEFAULT_SHORTCUTS;
}

function saveShortcuts(shortcuts) {
  const p = shortcutsFilePath();
  let payload = shortcuts;
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        Array.isArray(raw.groups) &&
        Array.isArray(raw.shortcuts)
      ) {
        payload = { groups: raw.groups, shortcuts };
      }
    }
  } catch {
    /* guardar como lista plana */
  }
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf-8');
}

function broadcastShortcutsChanged() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('shortcuts-changed');
  });
}

function pushUndoBeforeChange() {
  undoStack.push(JSON.stringify(loadShortcuts()));
  if (undoStack.length > MAX_SHORTCUT_UNDO) undoStack.shift();
}

module.exports = {
  loadShortcuts,
  saveShortcuts,
  broadcastShortcutsChanged,
  pushUndoBeforeChange,
};

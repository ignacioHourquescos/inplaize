'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const {
  DEFAULT_SHORTCUTS,
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

/** El acceso de "Navegación suelta" ya no se muestra en el dock: se quita de listas viejas. */
function removeLooseNavShortcut(list) {
  if (!Array.isArray(list)) return { list, mutated: false };
  const filtered = list.filter((s) => !(s && s.type === 'loose'));
  return { list: filtered, mutated: filtered.length !== list.length };
}

function loadShortcuts() {
  try {
    const p = shortcutsFilePath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const list = shortcutArrayFromFilePayload(raw);
      if (list !== null) {
        const { list: ensured, mutated } = removeLooseNavShortcut(list);
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

'use strict';

/** Atajo de fábrica: Ctrl + Alt + D. */
const DEFAULT_HOTKEY = ['Ctrl', 'Alt', 'D'];

const MODIFIER_TO_ACC = {
  Ctrl: 'Control',
  Alt: 'Alt',
  Shift: 'Shift',
  Win: 'Super',
};

const NAMED_TO_ACC = {
  Space: 'Space',
  Enter: 'Return',
  Esc: 'Escape',
  Tab: 'Tab',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Backspace: 'Backspace',
  Delete: 'Delete',
};

/**
 * Electron solo registra modificadores + una tecla (por ejemplo Control+Alt+K).
 * @param {unknown} labels
 * @returns {string | null}
 */
function acceleratorFromHotkey(labels) {
  if (!Array.isArray(labels) || labels.length !== 3) return null;
  const mods = [];
  const keys = [];
  const seen = new Set();
  for (const raw of labels) {
    const label = String(raw || '');
    if (!label || seen.has(label)) return null;
    seen.add(label);
    if (MODIFIER_TO_ACC[label]) {
      mods.push(MODIFIER_TO_ACC[label]);
      continue;
    }
    if (/^[A-Z0-9]$/.test(label) || /^F([1-9]|1[0-2])$/.test(label)) {
      keys.push(label);
      continue;
    }
    if (NAMED_TO_ACC[label]) {
      keys.push(NAMED_TO_ACC[label]);
      continue;
    }
    return null;
  }
  if (mods.length < 1 || keys.length !== 1) return null;
  return [...mods, keys[0]].join('+');
}

/** @param {unknown} value */
function normalizeDockHotkey(value) {
  if (acceleratorFromHotkey(value)) return value.map((k) => String(k));
  return DEFAULT_HOTKEY.slice();
}

module.exports = {
  DEFAULT_HOTKEY,
  acceleratorFromHotkey,
  normalizeDockHotkey,
};

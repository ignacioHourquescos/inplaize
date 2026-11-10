'use strict';

const path = require('path');
const analytics = require('./analytics');
const { loadAppSettings, saveAppSettings } = require('./app-settings-store');
const { loadShortcuts } = require('./shortcuts-store');
const { loadStickyNotes } = require('./sticky-notes-store');
const { loadTodos } = require('./todos-store');

const MAX_SHORTCUT_EVENTS = 60;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function webHost(url) {
  try {
    const raw = String(url || '').trim();
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '').slice(0, 60);
  } catch {
    return '';
  }
}

/** Nombre del ejecutable o acceso (.lnk) sin la ruta, que incluye el usuario de Windows. */
function appName(shortcut) {
  const file = path.win32.basename(String(shortcut.url || ''));
  const base = file.replace(/\.(lnk|exe|url|appref-ms)$/i, '');
  return (base || String(shortcut.name || '')).slice(0, 60);
}

function describeShortcut(s) {
  if (s.type === 'web') return { type: 'web', app: webHost(s.url) || 'unknown' };
  if (s.type === 'app') return { type: 'app', app: appName(s) || 'unknown' };
  return { type: String(s.type || 'unknown') };
}

function countTodos(payload) {
  let total = 0;
  let done = 0;
  for (const col of (payload && payload.columns) || []) {
    for (const b of (col && col.blocks) || []) {
      if (!b || b.type !== 'todo') continue;
      total += 1;
      if (b.done) done += 1;
    }
  }
  return { total, done };
}

/** Una vez por día: totales y qué aplicaciones/sitios tiene en la barra. */
function reportUsageSnapshot() {
  const day = today();
  if (loadAppSettings().analyticsInventoryDay === day) return;

  const shortcuts = loadShortcuts().filter((s) => s && s.type);
  const notes = loadStickyNotes();
  const todos = countTodos(loadTodos());
  const byType = (t) => shortcuts.filter((s) => s.type === t).length;

  analytics.track('usage_snapshot', {
    shortcuts_total: shortcuts.length,
    shortcuts_web: byType('web'),
    shortcuts_app: byType('app'),
    notes_total: notes.notes.length,
    notes_crumpled: notes.crumpled.length,
    todos_total: todos.total,
    todos_done: todos.done,
  });
  for (const s of shortcuts.slice(0, MAX_SHORTCUT_EVENTS)) {
    analytics.track('shortcut_saved', describeShortcut(s));
  }
  saveAppSettings({ analyticsInventoryDay: day });
}

function startUsageSnapshots() {
  const run = () => {
    try {
      reportUsageSnapshot();
    } catch {
      /* métricas: nunca deben romper la app */
    }
  };
  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { startUsageSnapshots, describeShortcut };

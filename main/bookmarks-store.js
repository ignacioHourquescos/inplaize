'use strict';

/**
 * Marcadores de la app: los que el usuario guarda y los importados de otros
 * navegadores. Persistencia en `<userData>/bookmarks.json` (array dedupe por URL).
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** @typedef {{ id: string, title: string, url: string, folder: string, added: number }} Bookmark */

/** @type {Bookmark[] | null} */
let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), 'bookmarks.json');
}

function normalizeUrl(url) {
  const s = String(url || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function makeId() {
  return `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** @returns {Bookmark[]} */
function load() {
  if (cache) return cache;
  cache = [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (Array.isArray(raw)) {
      for (const b of raw) {
        const url = normalizeUrl(b && b.url);
        if (!url) continue;
        cache.push({
          id: String((b && b.id) || makeId()),
          title: String((b && b.title) || url),
          url,
          folder: String((b && b.folder) || ''),
          added: Number(b && b.added) || Date.now(),
        });
      }
    }
  } catch {
    /* primer uso */
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(filePath(), JSON.stringify(load(), null, 2), 'utf8');
  } catch {
    /* noop */
  }
}

function list() {
  return load().map((b) => ({ ...b }));
}

/** @param {{ title?: string, url: string, folder?: string }} bm @returns {Bookmark | null} */
function add(bm) {
  const url = normalizeUrl(bm && bm.url);
  if (!url) return null;
  const items = load();
  const existing = items.find((b) => b.url === url);
  if (existing) {
    if (bm.title) existing.title = String(bm.title);
    save();
    return { ...existing };
  }
  const entry = {
    id: makeId(),
    title: String((bm && bm.title) || url),
    url,
    folder: String((bm && bm.folder) || ''),
    added: Date.now(),
  };
  items.push(entry);
  save();
  return { ...entry };
}

/** @param {string} id */
function remove(id) {
  const items = load();
  const idx = items.findIndex((b) => b.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  save();
  return true;
}

/** @param {string} url */
function has(url) {
  const u = normalizeUrl(url);
  return !!u && load().some((b) => b.url === u);
}

/**
 * Mezcla marcadores importados (dedupe por URL, conserva carpeta de origen).
 * @param {Array<{ title?: string, url: string, folder?: string, added?: number }>} entries
 * @returns {number} cuántos nuevos
 */
function importEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const items = load();
  const seen = new Set(items.map((b) => b.url));
  let added = 0;
  for (const e of entries) {
    const url = normalizeUrl(e && e.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      id: makeId(),
      title: String((e.title || url)),
      url,
      folder: String(e.folder || ''),
      added: Number(e.added) || Date.now(),
    });
    added += 1;
  }
  if (added) save();
  return added;
}

module.exports = { list, add, remove, has, importEntries };

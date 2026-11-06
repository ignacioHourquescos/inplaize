'use strict';

/**
 * Historial de navegación de la app: lo que el usuario visita en la navegación
 * suelta más lo importado de otros navegadores. Sirve para sugerir URLs en la
 * barra de direcciones (estilo Comet/Chrome).
 *
 * Persistencia: `<userData>/history.json`, un array dedupe por URL con el
 * número de visitas y la última visita. Se recorta a MAX_ENTRIES por tamaño.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_ENTRIES = 25000;
const SAVE_DEBOUNCE_MS = 1500;

/** @typedef {{ url: string, title: string, visitCount: number, lastVisit: number }} HistoryEntry */

/** @type {Map<string, HistoryEntry> | null} */
let cache = null;
let saveTimer = null;

function filePath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function normalizeUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

/** @returns {Map<string, HistoryEntry>} */
function load() {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (Array.isArray(raw)) {
      for (const e of raw) {
        const url = normalizeUrl(e && e.url);
        if (!url) continue;
        cache.set(url, {
          url,
          title: String((e && e.title) || ''),
          visitCount: Number(e && e.visitCount) || 1,
          lastVisit: Number(e && e.lastVisit) || 0,
        });
      }
    }
  } catch {
    /* primer uso */
  }
  return cache;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, SAVE_DEBOUNCE_MS);
}

function flush() {
  if (!cache) return;
  // Guardamos solo las más relevantes (recientes y visitadas) si hay demasiadas.
  let list = [...cache.values()];
  if (list.length > MAX_ENTRIES) {
    list.sort((a, b) => b.lastVisit - a.lastVisit || b.visitCount - a.visitCount);
    list = list.slice(0, MAX_ENTRIES);
    cache = new Map(list.map((e) => [e.url, e]));
  }
  try {
    fs.writeFileSync(filePath(), JSON.stringify(list), 'utf8');
  } catch {
    /* noop */
  }
}

/**
 * Registra una visita propia (o actualiza el título de una existente).
 * @param {string} url
 * @param {string} [title]
 */
function record(url, title) {
  const u = normalizeUrl(url);
  if (!u) return;
  const map = load();
  const prev = map.get(u);
  map.set(u, {
    url: u,
    title: String(title || (prev && prev.title) || ''),
    visitCount: (prev ? prev.visitCount : 0) + 1,
    lastVisit: Date.now(),
  });
  scheduleSave();
}

/**
 * Mezcla entradas importadas de otro navegador. No pisa un visitCount mayor ya
 * presente; se queda con la última visita más reciente.
 * @param {Array<{ url: string, title?: string, visitCount?: number, lastVisit?: number }>} entries
 * @returns {number} cuántas entradas nuevas o actualizadas
 */
function importEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const map = load();
  let touched = 0;
  for (const e of entries) {
    const u = normalizeUrl(e && e.url);
    if (!u) continue;
    const prev = map.get(u);
    const visitCount = Math.max(Number(e.visitCount) || 1, prev ? prev.visitCount : 0);
    const lastVisit = Math.max(Number(e.lastVisit) || 0, prev ? prev.lastVisit : 0);
    map.set(u, {
      url: u,
      title: String((e.title || (prev && prev.title) || '')),
      visitCount,
      lastVisit,
    });
    touched += 1;
  }
  flush();
  return touched;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Sugerencias para la barra de direcciones. Ranking simple: primero coincidencias
 * al inicio del host, luego por el resto, ponderado por visitas y recencia.
 * @param {string} query
 * @param {number} [limit]
 * @returns {Array<{ url: string, title: string, host: string }>}
 */
function suggest(query, limit) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const max = Math.max(1, Math.min(20, limit || 8));
  const now = Date.now();
  const scored = [];
  for (const e of load().values()) {
    const host = hostOf(e.url);
    const hay = `${host} ${e.url} ${e.title}`.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx === -1) continue;
    const hostStarts = host.startsWith(q) || host.startsWith('www.' + q);
    const ageDays = e.lastVisit ? (now - e.lastVisit) / 86400000 : 999;
    const recency = Math.max(0, 1 - ageDays / 120);
    const score =
      (hostStarts ? 1000 : 0) +
      (idx === 0 ? 300 : 0) +
      Math.log2(1 + e.visitCount) * 40 +
      recency * 60 -
      idx;
    scored.push({ url: e.url, title: e.title, host, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(({ url, title, host }) => ({ url, title, host }));
}

/**
 * Lista para la página de Historial. Sin query devuelve las más recientes;
 * con query filtra por host/url/título. Siempre ordena por última visita.
 * @param {string} [query]
 * @param {number} [limit]
 * @returns {Array<{ url: string, title: string, host: string, visitCount: number, lastVisit: number }>}
 */
function search(query, limit) {
  const q = String(query || '').trim().toLowerCase();
  const max = Math.max(1, Math.min(1000, limit || 300));
  let list = [...load().values()];
  if (q) {
    list = list.filter((e) => {
      const host = hostOf(e.url);
      return `${host} ${e.url} ${e.title}`.toLowerCase().includes(q);
    });
  }
  list.sort((a, b) => b.lastVisit - a.lastVisit || b.visitCount - a.visitCount);
  return list.slice(0, max).map((e) => ({
    url: e.url,
    title: e.title,
    host: hostOf(e.url),
    visitCount: e.visitCount,
    lastVisit: e.lastVisit,
  }));
}

/** @param {string} url @returns {boolean} */
function remove(url) {
  const u = normalizeUrl(url);
  const map = load();
  if (!u || !map.has(u)) return false;
  map.delete(u);
  flush();
  return true;
}

function clear() {
  cache = new Map();
  flush();
}

module.exports = { record, importEntries, suggest, search, remove, clear };

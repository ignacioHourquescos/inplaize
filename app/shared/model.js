'use strict';

const TYPES = new Set(['text', 'todo', 'bullet']);
const MAX_BLOCKS = 400;
const MAX_TEXT = 4000;
const MAX_NAME = 40;
const GUEST_ID = 'guest';

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyBlock(type) {
  return {
    id: createId('b'),
    type: TYPES.has(type) ? type : 'text',
    text: '',
    done: false,
  };
}

function sanitizeNotes(raw) {
  const blocks = [];
  const list = raw && Array.isArray(raw.blocks) ? raw.blocks : [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || blocks.length >= MAX_BLOCKS) continue;
    const type = TYPES.has(item.type) ? item.type : 'text';
    let text = typeof item.text === 'string' ? item.text : '';
    text = text.replace(/\r\n|\r|\n/g, ' ');
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    let id = typeof item.id === 'string' ? item.id.trim().slice(0, 80) : '';
    if (!id || seen.has(id)) id = createId('b');
    seen.add(id);
    blocks.push({
      id,
      type,
      text,
      done: type === 'todo' && item.done === true,
    });
  }
  if (!blocks.length) blocks.push(emptyBlock());
  return { blocks };
}

/**
 * Acepta un enlace o un texto para buscar. Rechaza otros esquemas (javascript:, file:).
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeAddress(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  if (/^(javascript|data|file|vbscript|blob):/i.test(text)) return null;
  const host = /^(localhost(?::\d+)?|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|[\w-]+(?:\.[\w-]+)+(?::\d+)?)(?:\/.*)?$/i;
  if (host.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function sanitizeName(value, fallback) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name || fallback;
}

function sanitizeShortcut(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = normalizeAddress(raw.url);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  let id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : '';
  if (!id) id = createId('s');
  return { id, name: sanitizeName(raw.name, hostOf(url) || 'Acceso'), url };
}

function hueFromSeed(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 20 + (h % 300);
}

function partitionForProfile(profileId) {
  if (profileId === GUEST_ID) return 'mvp-guest';
  return `persist:mvp-profile-${profileId}`;
}

function partitionForShortcut(shortcutId) {
  return `persist:mvp-shortcut-${shortcutId}`;
}

module.exports = {
  GUEST_ID,
  MAX_NAME,
  createId,
  emptyBlock,
  sanitizeNotes,
  normalizeAddress,
  hostOf,
  sanitizeName,
  sanitizeShortcut,
  hueFromSeed,
  partitionForProfile,
  partitionForShortcut,
};

'use strict';

/**
 * Página del icono de inplaize (renglones, columnas, arrastre).
 * Archivo: `userData/todos.json`.
 *
 *   {
 *     version: 3,
 *     activePageId: string,
 *     pages: Array<{ id, title, columns, archive }>,
 *     // Espejo de la página activa (compat con v2 / analytics / tests):
 *     title, columns, archive
 *   }
 *
 * `type` es "text" | "todo" | "bullet" | "document" | "image".
 * Un documento guarda título, descripción y contenido del editor en `doc`.
 * Una imagen guarda `src` (data URL) y `width`.
 * `archive` guarda lo que se soltó en el tacho, con `archivedAt`.
 * La versión 1 (lista plana de items) se migra a una columna de checkboxes.
 * La versión 2 (una sola página) se envuelve en `pages`.
 */

const { sanitizeDocument } = require('./document-content');

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FILE_VERSION = 3;
const MAX_PAGES = 20;
const MAX_COLUMNS = 30;
const MIN_COL_WIDTH = 88;
const MAX_COL_WIDTH = 4000;
const MAX_COL_POS = 12000;
const MAX_BLOCKS = 400;
const MAX_INDENT = 6;
const TYPES = new Set(['text', 'todo', 'bullet', 'document', 'image']);
const MAX_ARCHIVE = 200;
const MAX_IMAGE_SRC = 1200000;

function todosFilePath() {
  return path.join(app.getPath('userData'), 'todos.json');
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.round(n);
}

function sanitizeId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id || id.length > 80) return '';
  return id;
}

function sanitizeText(value, maxLen) {
  if (value == null) return '';
  const str = String(value).replace(/\r\n|\r|\n/g, ' ');
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

function sanitizeImageSrc(value) {
  if (typeof value !== 'string') return '';
  const src = value.replace(/\s+/g, '');
  if (src.length < 32 || src.length > MAX_IMAGE_SRC) return '';
  if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(src)) return '';
  return src;
}

function validIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toISOString();
}

function sanitizeBlock(raw, seen, columnId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sanitizeId(raw.id);
  if (!id || seen.has(id)) return null;
  seen.add(id);
  const type = TYPES.has(raw.type) ? raw.type : 'text';
  const block = {
    id,
    type,
    text: sanitizeText(raw.text, 4000),
    done: type === 'todo' && raw.done === true,
    indent: clampNumber(raw.indent, 0, MAX_INDENT, 0),
  };
  if (type === 'document') {
    const source = raw.doc && typeof raw.doc === 'object' ? { ...raw.doc } : {};
    if (source.title == null) source.title = block.text;
    block.doc = sanitizeDocument(source, id, columnId || '');
    block.text = block.doc.title;
    block.done = false;
  }
  if (type === 'image') {
    const src = sanitizeImageSrc(raw.src);
    if (!src) return null;
    block.src = src;
    block.text = '';
    block.done = false;
    const width = clampNumber(raw.width, 48, 1600, 0);
    if (width >= 48) block.width = width;
  }
  return block;
}

function sanitizeColumn(raw, seen) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sanitizeId(raw.id);
  if (!id || seen.has(id)) return null;
  seen.add(id);
  const blocks = [];
  const list = Array.isArray(raw.blocks) ? raw.blocks : [];
  for (const entry of list) {
    if (blocks.length >= MAX_BLOCKS) break;
    const block = sanitizeBlock(entry, seen, id);
    if (block) blocks.push(block);
  }
  const column = { id, blocks };
  const width = clampNumber(raw.width, MIN_COL_WIDTH, MAX_COL_WIDTH, 0);
  if (width >= MIN_COL_WIDTH) column.width = width;
  const x = clampNumber(raw.x, 0, MAX_COL_POS, -1);
  const y = clampNumber(raw.y, 0, MAX_COL_POS, -1);
  if (raw.x != null && raw.y != null && x >= 0 && y >= 0) {
    column.x = x;
    column.y = y;
  }
  return column;
}

function sanitizeArchive(list, seen) {
  const archive = [];
  const archived = Array.isArray(list) ? list : [];
  for (const entry of archived) {
    if (archive.length >= MAX_ARCHIVE) break;
    const item = sanitizeBlock(entry, seen, '');
    if (!item) continue;
    item.archivedAt = validIso(entry && entry.archivedAt) || new Date().toISOString();
    archive.push(item);
  }
  return archive;
}

function sanitizePageBody(raw, seen, fallbackTitle) {
  const columns = [];
  const list = Array.isArray(raw && raw.columns) ? raw.columns : [];
  for (const entry of list) {
    if (columns.length >= MAX_COLUMNS) break;
    const column = sanitizeColumn(entry, seen);
    if (column) columns.push(column);
  }
  if (!columns.length) columns.push({ id: 'col-main', blocks: [] });
  return {
    title: sanitizeText((raw && raw.title) || fallbackTitle || 'Notas', 200) || 'Notas',
    columns,
    archive: sanitizeArchive(raw && raw.archive, seen),
  };
}

function emptyPage(id, title) {
  return {
    id: id || 'page-main',
    title: title || 'Notas',
    columns: [{ id: 'col-main', blocks: [] }],
    archive: [],
  };
}

function withActiveMirror(pages, activePageId) {
  const active = pages.find((p) => p.id === activePageId) || pages[0];
  return {
    version: FILE_VERSION,
    activePageId: active.id,
    pages,
    title: active.title,
    columns: active.columns,
    archive: active.archive,
  };
}

function emptyPayload() {
  const page = emptyPage('page-main', 'Notas');
  return withActiveMirror([page], page.id);
}

function columnFromLegacyItems(items) {
  const seen = new Set();
  const blocks = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const text = sanitizeText(raw.text, 4000).trim();
    if (!text) continue;
    const id = sanitizeId(raw.id) || `todo-legacy-${blocks.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    blocks.push({
      id,
      type: 'todo',
      text,
      done: raw.done === true,
      indent: 0,
    });
    if (blocks.length >= MAX_BLOCKS) break;
  }
  const page = {
    id: 'page-main',
    title: 'Notas',
    columns: [{ id: 'col-main', blocks }],
    archive: [],
  };
  return withActiveMirror([page], page.id);
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return emptyPayload();
  const legacyItems = Array.isArray(raw.items) ? raw.items : null;
  const hasPages = Array.isArray(raw.pages) && raw.pages.length > 0;
  const hasColumns = Array.isArray(raw.columns);
  if (!hasPages && !hasColumns && legacyItems) return columnFromLegacyItems(legacyItems);

  const pageIds = new Set();
  const pages = [];

  if (hasPages) {
    for (const entry of raw.pages) {
      if (pages.length >= MAX_PAGES) break;
      if (!entry || typeof entry !== 'object') continue;
      const id = sanitizeId(entry.id) || `page-${pages.length + 1}`;
      if (pageIds.has(id)) continue;
      pageIds.add(id);
      const seen = new Set();
      const body = sanitizePageBody(entry, seen, pages.length ? `Notas ${pages.length + 1}` : 'Notas');
      pages.push({ id, ...body });
    }
  }

  if (!pages.length) {
    const seen = new Set();
    const body = sanitizePageBody(
      { title: raw.title, columns: hasColumns ? raw.columns : [], archive: raw.archive },
      seen,
      'Notas'
    );
    pages.push({ id: 'page-main', ...body });
  }

  const wanted = sanitizeId(raw.activePageId);
  const activePageId = pages.some((p) => p.id === wanted) ? wanted : pages[0].id;
  return withActiveMirror(pages, activePageId);
}

function loadTodos() {
  try {
    const p = todosFilePath();
    if (!fs.existsSync(p)) return emptyPayload();
    return normalize(JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch {
    return emptyPayload();
  }
}

function saveTodos(payload) {
  const safe = normalize(payload);
  try {
    fs.writeFileSync(todosFilePath(), JSON.stringify(safe, null, 2), 'utf-8');
  } catch (err) {
    const error = new Error('No se pudo guardar las tareas');
    error.cause = err;
    throw error;
  }
  return safe;
}

function broadcastTodosChanged(senderWebContents) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue;
    if (senderWebContents && w.webContents === senderWebContents) continue;
    try {
      w.webContents.send('todos-changed');
    } catch {
      /* noop */
    }
  }
}

module.exports = {
  loadTodos,
  saveTodos,
  broadcastTodosChanged,
  MAX_PAGES,
};

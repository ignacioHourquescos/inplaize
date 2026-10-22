'use strict';

/**
 * Contenido de un documento del lienzo.
 * Vive dentro del bloque (`type: "document"`) en `todos.json`.
 * No es una base aparte: el renglón sigue siendo el elemento y `doc` es su cuerpo.
 */

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 500;
const MAX_HREF = 2000;
const MAX_TEXT = 20000;
const MAX_TOTAL_TEXT = 200000;
const MAX_NODES = 2500;
const MAX_DEPTH = 40;
const MAX_IMAGE_SRC = 1200000;
const MAX_DOC_JSON = 2400000;
const MAX_ATTRS = 12;

const NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'heading',
  'text',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'horizontalRule',
  'hardBreak',
  'image',
]);

const MARK_TYPES = new Set(['bold', 'italic', 'underline', 'link']);
const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
const WRAP_TYPES = new Set(['listItem', 'taskItem', 'blockquote']);
const LEAVES = new Set(['text', 'horizontalRule', 'hardBreak', 'image']);

function cleanLine(value, max) {
  let str = String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (str.length > max) str = str.slice(0, max);
  return str;
}

function validIso(value, fallback) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return fallback;
  return new Date(time).toISOString();
}

function emptyDocContent() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function sanitizeHref(value) {
  if (typeof value !== 'string') return '';
  const href = value.trim();
  if (!href || href.length > MAX_HREF) return '';
  let url;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return '';
  return url.href;
}

function sanitizeImageSrc(value) {
  if (typeof value !== 'string') return '';
  const src = value.replace(/\s+/g, '');
  if (src.length < 32 || src.length > MAX_IMAGE_SRC) return '';
  if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(src)) return '';
  return src;
}

function sanitizeAttrs(type, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length && Object.keys(out).length < MAX_ATTRS; i += 1) {
    const key = keys[i];
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(key)) continue;
    const value = raw[key];
    if (key === 'href') {
      const href = sanitizeHref(value);
      if (href) out.href = href;
      continue;
    }
    if (key === 'src') {
      const src = sanitizeImageSrc(value);
      if (src) out.src = src;
      continue;
    }
    if (key === 'target') {
      if (value === '_blank' || value === '_self') out.target = value;
      continue;
    }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value;
    } else if (typeof value === 'string' && value.length <= 500) {
      out[key] = value;
    }
  }
  if (type === 'heading') {
    const level = out.level;
    out.level = level === 2 || level === 3 ? level : 1;
  }
  if (type === 'image' && !out.src) return null;
  if (type === 'link' && !out.href) return null;
  return Object.keys(out).length ? out : null;
}

function sanitizeMarks(raw) {
  if (!Array.isArray(raw)) return null;
  const marks = [];
  for (const mark of raw) {
    if (!mark || typeof mark !== 'object') continue;
    if (!MARK_TYPES.has(mark.type) || marks.length >= 8) continue;
    const next = { type: mark.type };
    const attrs = sanitizeAttrs(mark.type, mark.attrs);
    if (mark.type === 'link') {
      if (!attrs || !attrs.href) continue;
      next.attrs = { href: attrs.href };
      if (attrs.target) next.attrs.target = attrs.target;
    } else if (attrs) {
      next.attrs = attrs;
    }
    marks.push(next);
  }
  return marks.length ? marks : null;
}

function sanitizeNode(raw, depth, budget) {
  if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH) return null;
  if (budget.nodes <= 0) return null;
  const type = raw.type;
  if (!NODE_TYPES.has(type)) return null;
  if (type === 'doc' && depth !== 0) return null;
  budget.nodes -= 1;
  const node = { type };
  if (type === 'text') {
    let text = String(raw.text == null ? '' : raw.text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (!text) return null;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    if (text.length > budget.text) text = text.slice(0, budget.text);
    if (!text) return null;
    budget.text -= text.length;
    node.text = text;
    const marks = sanitizeMarks(raw.marks);
    if (marks) node.marks = marks;
    return node;
  }
  const attrs = sanitizeAttrs(type, raw.attrs);
  if (type === 'image' && !attrs) return null;
  if (attrs) node.attrs = attrs;
  if (LEAVES.has(type)) return node;
  const content = [];
  const list = Array.isArray(raw.content) ? raw.content : [];
  for (const child of list) {
    const clean = sanitizeNode(child, depth + 1, budget);
    if (clean) content.push(clean);
  }
  if (content.length) node.content = content;
  return node;
}

function prune(node) {
  if (!node) return null;
  if (Array.isArray(node.content)) {
    node.content = node.content.map(prune).filter(Boolean);
    if (!node.content.length) delete node.content;
  }
  if (LIST_TYPES.has(node.type) && !node.content) return null;
  if (WRAP_TYPES.has(node.type) && !node.content) node.content = [{ type: 'paragraph' }];
  if (node.type === 'doc' && !node.content) node.content = [{ type: 'paragraph' }];
  return node;
}

function jsonSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return MAX_DOC_JSON + 1;
  }
}

function removeFirstImage(node) {
  if (!node || !Array.isArray(node.content)) return false;
  const index = node.content.findIndex((child) => child && child.type === 'image');
  if (index >= 0) {
    node.content.splice(index, 1);
    if (!node.content.length) delete node.content;
    return true;
  }
  return node.content.some((child) => removeFirstImage(child));
}

function truncateText(node, max) {
  if (!node) return;
  if (node.type === 'text' && typeof node.text === 'string' && node.text.length > max) {
    node.text = node.text.slice(0, max);
  }
  if (Array.isArray(node.content)) node.content.forEach((child) => truncateText(child, max));
}

function fitContent(doc) {
  let guard = 0;
  while (jsonSize(doc) > MAX_DOC_JSON && guard < 40 && removeFirstImage(doc)) guard += 1;
  if (jsonSize(doc) > MAX_DOC_JSON) truncateText(doc, 2000);
  if (jsonSize(doc) > MAX_DOC_JSON) truncateText(doc, 200);
  return prune(doc) || emptyDocContent();
}

function sanitizeDocument(raw, id, parentId) {
  const now = new Date().toISOString();
  const source = raw && typeof raw === 'object' ? raw : {};
  const content = sanitizeNode(source.content, 0, { nodes: MAX_NODES, text: MAX_TOTAL_TEXT });
  const doc = content && content.type === 'doc' ? content : emptyDocContent();
  return {
    id,
    title: cleanLine(source.title, MAX_TITLE),
    description: cleanLine(source.description, MAX_DESCRIPTION),
    content: fitContent(doc),
    parentId: parentId || '',
    createdAt: validIso(source.createdAt, now),
    updatedAt: validIso(source.updatedAt, now),
  };
}

module.exports = {
  sanitizeDocument,
  emptyDocContent,
  MAX_TITLE,
  MAX_DESCRIPTION,
  MAX_IMAGE_SRC,
};

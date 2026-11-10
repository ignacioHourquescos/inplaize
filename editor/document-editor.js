import { Editor, Extension, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Suggestion from '@tiptap/suggestion';
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';

const PLACEHOLDER = 'Escribí, presioná / para insertar bloques...';
const MAX_DOC_COLUMNS = 4;

function sanitizeBrowserSrc(value) {
  if (typeof value !== 'string') return '';
  const src = value.replace(/\s+/g, '');
  if (src.length < 32 || src.length > 1200000) return '';
  if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(src)) return '';
  return src;
}

function normalizeHref(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 2000) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return '';
    if (url.protocol !== 'mailto:' && !url.hostname) return '';
    return url.href;
  } catch {
    return '';
  }
}

function linkLabel(href) {
  try {
    const url = new URL(href);
    if (url.protocol === 'mailto:') return url.pathname || href;
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.host}${path}` || href;
  } catch {
    return href;
  }
}

function norm(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isEmptySlash(state, range) {
  const $from = state.doc.resolve(range.from);
  if (!$from.parent.isTextblock) return false;
  const before = state.doc.textBetween($from.start(), range.from, 'x', 'x');
  const after = state.doc.textBetween(range.to, $from.end(), 'x', 'x');
  return before.length === 0 && after.length === 0;
}

function imageFiles(data) {
  if (!data || !data.files || !data.files.length) return [];
  const files = [];
  for (const file of data.files) {
    if (file && /^image\/(?:png|jpe?g|gif|webp)$/i.test(file.type)) files.push(file);
  }
  return files;
}

const SafeImage = Image.extend({
  addInputRules() {
    return [];
  },
  parseHTML() {
    return [{
      tag: 'img[src]',
      getAttrs: (element) => {
        const src = sanitizeBrowserSrc(element.getAttribute('src'));
        if (!src) return false;
        return { src, alt: element.getAttribute('alt') || '' };
      },
    }];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const cuts = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && !sanitizeBrowserSrc(node.attrs.src)) {
              cuts.push({ from: pos, to: pos + node.nodeSize });
            }
          });
          if (!cuts.length) return null;
          let tr = state.tr;
          for (let i = cuts.length - 1; i >= 0; i -= 1) tr = tr.delete(cuts[i].from, cuts[i].to);
          return tr;
        },
      }),
    ];
  },
}).configure({
  inline: false,
  allowBase64: true,
  resize: {
    enabled: true,
    directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    minWidth: 64,
    minHeight: 48,
    alwaysPreserveAspectRatio: true,
  },
});

function columnIsEmpty(node) {
  if (node.childCount !== 1) return false;
  const only = node.firstChild;
  return only.type.name === 'paragraph' && only.content.size === 0;
}

// Una columna que se vacía se va; si queda una sola, su contenido vuelve al flujo.
function normalizeColumns(state) {
  const fixes = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'columns') return true;
    const kept = [];
    node.forEach((child) => {
      if (!columnIsEmpty(child)) kept.push(child);
    });
    if (kept.length >= 2 && kept.length === node.childCount) return false;
    let replacement;
    if (kept.length >= 2) replacement = node.type.create(node.attrs, kept);
    else if (kept.length === 1) replacement = kept[0].content;
    else replacement = state.schema.nodes.paragraph.create();
    fixes.push({ from: pos, to: pos + node.nodeSize, replacement });
    return false;
  });
  if (!fixes.length) return null;
  const tr = state.tr;
  for (let i = fixes.length - 1; i >= 0; i -= 1) tr.replaceWith(fixes[i].from, fixes[i].to, fixes[i].replacement);
  return tr;
}

const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column+',
  defining: true,
  isolating: true,
  selectable: false,
  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'doc-columns' }), 0];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return normalizeColumns(state);
        },
      }),
    ];
  },
});

const Column = Node.create({
  name: 'column',
  content: '(paragraph | heading | bulletList | orderedList | taskList | blockquote | horizontalRule | image)+',
  defining: true,
  isolating: true,
  selectable: false,
  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'doc-column' }), 0];
  },
});

function isBlockSlice(slice) {
  if (!slice || slice.openStart !== 0 || slice.openEnd !== 0 || !slice.content.childCount) return false;
  let ok = true;
  slice.content.forEach((node) => {
    if (!node.isBlock || node.type.name === 'columns' || node.type.name === 'column') ok = false;
  });
  return ok;
}

function dragSource(view) {
  const dragging = view.dragging;
  if (dragging && dragging.node) return { from: dragging.node.from, to: dragging.node.to };
  const { from, to } = view.state.selection;
  return { from, to };
}

function canHostColumn(node) {
  if (node.type.name === 'horizontalRule') return false;
  if (node.isTextblock) return node.content.size > 0;
  return true;
}

// Zonas laterales de un bloque: a la derecha del contenido (o del último tercio del texto) y el borde izquierdo.
function sideOf(view, node, pos, rect, x) {
  if (node.type.name === 'image') {
    const dom = view.nodeDOM(pos);
    const img = dom && dom.querySelector ? dom.querySelector('img') : null;
    const box = img ? img.getBoundingClientRect() : rect;
    if (x > box.right + 4) return { side: 'after', line: Math.min(rect.right, box.right + 10) };
    if (x < box.left + 16) return { side: 'before', line: box.left - 10 };
    return null;
  }
  if (x >= rect.left + rect.width * 0.65) return { side: 'after', line: rect.right };
  if (x <= rect.left + 24) return { side: 'before', line: rect.left - 10 };
  return null;
}

const LIST_NODES = new Set(['bulletList', 'orderedList', 'taskList']);

function itemDropTarget(view, list, offset, x, y, covers) {
  let hit = null;
  let itemPos = offset + 1;
  list.forEach((item, _at, index) => {
    const pos = itemPos;
    itemPos += item.nodeSize;
    if (hit) return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const box = dom.getBoundingClientRect();
    if (y < box.top || y > box.bottom) return;
    if (covers(pos, pos + item.nodeSize)) return;
    if (!item.textContent.trim() && item.childCount < 2) return;
    const zone = sideOf(view, item, pos, box, x);
    if (!zone) return;
    hit = {
      kind: 'item',
      listPos: offset,
      list,
      index,
      side: zone.side,
      line: zone.line,
      top: box.top,
      height: box.height,
    };
  });
  return hit;
}

function listPiece(list, from, to) {
  const items = [];
  list.forEach((item, _at, index) => {
    if (index >= from && index < to) items.push(item);
  });
  const attrs = list.type.name === 'orderedList'
    ? { ...list.attrs, start: (Number(list.attrs.start) || 1) + from }
    : list.attrs;
  return list.type.create(attrs, items);
}

function columnDropTarget(view, x, y) {
  const dragging = view.dragging;
  if (!dragging || !isBlockSlice(dragging.slice)) return null;
  const source = dragSource(view);
  const overlaps = (from, to) => source.from < to && source.to > from;
  let hit = null;
  let done = false;
  view.state.doc.forEach((node, offset) => {
    if (done) return;
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    if (y < rect.top || y > rect.bottom) return;
    done = true;
    if (node.type.name === 'columns') {
      if (node.childCount >= MAX_DOC_COLUMNS) return;
      let colPos = offset + 1;
      node.forEach((col) => {
        const colDom = view.nodeDOM(colPos);
        if (!hit && colDom instanceof HTMLElement) {
          const box = colDom.getBoundingClientRect();
          const zone = Math.min(48, box.width * 0.2);
          let side = null;
          if (x >= box.right - zone && x <= box.right + 20) side = 'after';
          else if (x <= box.left + zone && x >= box.left - 20) side = 'before';
          const lonely = col.childCount === 1 && overlaps(colPos, colPos + col.nodeSize);
          if (side && !lonely) {
            hit = {
              kind: 'column',
              pos: colPos,
              node: col,
              side,
              line: side === 'after' ? box.right + 10 : box.left - 10,
              top: box.top,
              height: box.height,
            };
          }
        }
        colPos += col.nodeSize;
      });
      return;
    }
    if (LIST_NODES.has(node.type.name)) {
      const covers = (from, to) => source.from <= from && source.to >= to;
      hit = itemDropTarget(view, node, offset, x, y, covers);
      return;
    }
    if (!canHostColumn(node) || overlaps(offset, offset + node.nodeSize)) return;
    const zone = sideOf(view, node, offset, rect, x);
    if (!zone) return;
    hit = { kind: 'block', pos: offset, node, side: zone.side, line: zone.line, top: rect.top, height: rect.height };
  });
  return hit;
}

function dropIntoColumns(view, target, slice, moved) {
  const { state } = view;
  const { columns, column } = state.schema.nodes;
  let fresh;
  try {
    fresh = column.createChecked(null, slice.content);
  } catch {
    return false;
  }
  const tr = state.tr;
  if (moved) {
    if (view.dragging && view.dragging.node) view.dragging.node.replace(tr);
    else tr.deleteSelection();
  }
  let insertedAt;
  if (target.kind === 'column') {
    const at = target.side === 'before' ? target.pos : target.pos + target.node.nodeSize;
    const pos = tr.mapping.map(at, target.side === 'before' ? 1 : -1);
    if (tr.doc.resolve(pos).parent.type !== columns) return false;
    tr.insert(pos, fresh);
    insertedAt = pos + 1;
  } else if (target.kind === 'item') {
    const from = tr.mapping.map(target.listPos, 1);
    const list = tr.doc.nodeAt(from);
    if (!list || list.type !== target.list.type || list.childCount !== target.list.childCount) return false;
    const host = column.create(null, listPiece(list, target.index, target.index + 1));
    let wrap;
    try {
      wrap = columns.createChecked(null, target.side === 'before' ? [fresh, host] : [host, fresh]);
    } catch {
      return false;
    }
    const parts = [];
    if (target.index > 0) parts.push(listPiece(list, 0, target.index));
    parts.push(wrap);
    if (target.index < list.childCount - 1) parts.push(listPiece(list, target.index + 1, list.childCount));
    tr.replaceWith(from, from + list.nodeSize, parts);
    const lead = target.index > 0 ? parts[0].nodeSize : 0;
    insertedAt = from + lead + 2 + (target.side === 'before' ? 0 : host.nodeSize);
  } else {
    const from = tr.mapping.map(target.pos, 1);
    const current = tr.doc.nodeAt(from);
    if (!current || !current.eq(target.node)) return false;
    const host = column.create(null, current);
    let wrap;
    try {
      wrap = columns.createChecked(null, target.side === 'before' ? [fresh, host] : [host, fresh]);
    } catch {
      return false;
    }
    tr.replaceWith(from, from + current.nodeSize, wrap);
    insertedAt = from + 2 + (target.side === 'before' ? 0 : host.nodeSize);
  }
  const first = slice.content.firstChild;
  try {
    if (slice.content.childCount === 1 && first.type.name === 'image' && tr.doc.nodeAt(insertedAt)) {
      tr.setSelection(NodeSelection.create(tr.doc, insertedAt));
    } else {
      tr.setSelection(TextSelection.near(tr.doc.resolve(insertedAt + 1)));
    }
  } catch {
    // La selección queda donde la dejó el mapeo.
  }
  view.focus();
  view.dispatch(tr.setMeta('uiEvent', 'drop'));
  return true;
}

function modLabel() {
  return /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
}

export function mount(host, options) {
  const portal = (options && options.portal) || document.body;
  const onChange = (options && options.onChange) || function () {};
  const onNotice = (options && options.onNotice) || function () {};
  const readImage = (options && options.readImage) || function () { return Promise.resolve(null); };

  let alive = true;
  let ready = false;
  let editor = null;
  let slashOn = false;
  let selected = 0;
  let currentItems = [];
  let latest = null;
  let unmountSlash = null;
  let savedRange = null;

  const menu = document.createElement('div');
  menu.className = 'notion-menu doc-slash-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Insertar bloque');
  menu.setAttribute('data-mouse-hit', '');

  const bubble = document.createElement('div');
  bubble.className = 'doc-format-bar';
  bubble.setAttribute('role', 'toolbar');
  bubble.setAttribute('aria-label', 'Formato');
  bubble.setAttribute('data-mouse-hit', '');
  bubble.hidden = true;
  bubble.addEventListener('mousedown', (event) => event.preventDefault());

  const popover = document.createElement('div');
  popover.className = 'doc-link-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Enlace');
  popover.setAttribute('data-mouse-hit', '');
  popover.hidden = true;

  const linkInput = document.createElement('input');
  linkInput.type = 'url';
  linkInput.className = 'doc-link-input';
  linkInput.placeholder = 'https://…';
  linkInput.setAttribute('aria-label', 'Dirección del enlace');
  linkInput.spellcheck = false;

  const linkError = document.createElement('p');
  linkError.className = 'doc-link-error';
  linkError.hidden = true;

  const linkApply = document.createElement('button');
  linkApply.type = 'button';
  linkApply.className = 'doc-link-apply';
  linkApply.textContent = 'Agregar';

  const linkRemove = document.createElement('button');
  linkRemove.type = 'button';
  linkRemove.className = 'doc-link-remove';
  linkRemove.textContent = 'Quitar';

  const linkRow = document.createElement('div');
  linkRow.className = 'doc-link-row';
  linkRow.append(linkInput, linkApply, linkRemove);
  popover.append(linkRow, linkError);

  const columnDrop = document.createElement('div');
  columnDrop.className = 'doc-col-drop';
  columnDrop.setAttribute('aria-hidden', 'true');
  portal.append(bubble, popover, columnDrop);

  function hideColumnDrop() {
    columnDrop.classList.remove('is-on');
    portal.classList.remove('is-col-dropping');
  }

  function showColumnDrop(target) {
    if (!target) {
      hideColumnDrop();
      return;
    }
    columnDrop.style.left = `${Math.round(target.line - 1)}px`;
    columnDrop.style.top = `${Math.round(target.top)}px`;
    columnDrop.style.height = `${Math.max(32, Math.round(target.height))}px`;
    columnDrop.classList.add('is-on');
    portal.classList.add('is-col-dropping');
  }

  function hideBubble() {
    bubble.hidden = true;
  }

  function place(el, rect) {
    const margin = 8;
    const width = el.offsetWidth || 220;
    const height = el.offsetHeight || 44;
    let left = rect.left;
    let top = rect.top - height - 8;
    if (top < margin) top = rect.bottom + 8;
    const maxLeft = window.innerWidth - width - margin;
    if (left > maxLeft) left = Math.max(margin, maxLeft);
    if (left < margin) left = margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function selectionRect() {
    if (!editor) return null;
    try {
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      return { left: coords.left, top: coords.top, bottom: coords.bottom };
    } catch {
      return null;
    }
  }

  function showAt(el, rect) {
    el.hidden = false;
    el.style.visibility = 'hidden';
    place(el, rect);
    el.style.visibility = '';
  }

  function syncPressed() {
    if (!editor) return;
    bubble.querySelectorAll('[data-mark]').forEach((button) => {
      const on = editor.isActive(button.dataset.mark);
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function updateBubble() {
    if (!alive || !editor || slashOn || !popover.hidden) {
      hideBubble();
      return;
    }
    const selection = editor.state.selection;
    if (!(selection instanceof TextSelection) || selection.empty) {
      hideBubble();
      return;
    }
    const rect = selectionRect();
    if (!rect) {
      hideBubble();
      return;
    }
    showAt(bubble, rect);
    syncPressed();
  }

  function closeLink(refocus) {
    popover.hidden = true;
    linkError.hidden = true;
    if (refocus && alive && editor) editor.commands.focus();
    updateBubble();
  }

  function openLink() {
    if (!alive || !editor) return;
    const selection = editor.state.selection;
    savedRange = selection instanceof TextSelection
      ? { from: selection.from, to: selection.to }
      : { from: selection.from, to: selection.from };
    const current = editor.getAttributes('link').href || '';
    linkInput.value = current;
    linkError.hidden = true;
    linkRemove.hidden = !current;
    hideBubble();
    const rect = selectionRect() || { left: 24, top: 80, bottom: 100 };
    showAt(popover, rect);
    linkInput.focus();
    linkInput.select();
  }

  function applyLink() {
    if (!editor) return;
    const href = normalizeHref(linkInput.value);
    if (!href) {
      linkError.hidden = false;
      linkError.textContent = 'Ingresá una dirección http, https o mailto.';
      linkInput.focus();
      return;
    }
    const range = savedRange || { from: editor.state.selection.from, to: editor.state.selection.to };
    if (range.from === range.to) {
      editor.chain().focus().setTextSelection(range.from).insertContent({
        type: 'text',
        text: linkLabel(href),
        marks: [{ type: 'link', attrs: { href } }],
      }).run();
    } else {
      editor.chain().focus().setTextSelection(range).setLink({ href }).run();
    }
    closeLink(false);
  }

  function removeLink() {
    if (!editor || !savedRange) {
      closeLink(true);
      return;
    }
    editor.chain().focus().setTextSelection(savedRange).extendMarkRange('link').unsetLink().run();
    closeLink(false);
  }

  async function addImages(files, pos) {
    const list = files && files.length ? Array.from(files) : [null];
    let at = typeof pos === 'number' ? pos : (editor ? editor.state.selection.from : 1);
    for (const file of list) {
      if (!alive || !editor) return;
      let result = null;
      try {
        result = await readImage(file || undefined);
      } catch {
        result = { error: 'No se pudo leer la imagen.' };
      }
      if (!alive || !editor) return;
      if (!result) continue;
      if (result.error || !result.src) {
        onNotice(result.error || 'No se pudo leer la imagen.');
        continue;
      }
      const node = { type: 'image', attrs: { src: result.src, alt: '' } };
      const inserted = editor.chain().focus().insertContentAt(at, node).run();
      if (!inserted) editor.chain().focus().setImage({ src: result.src, alt: '' }).run();
      at = editor.state.selection.from;
    }
  }

  const mod = modLabel();
  const commands = [
    { id: 'text', label: 'Texto', icon: 'T', keywords: ['texto', 'parrafo'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setParagraph().run() },
    { id: 'h1', label: 'Encabezado 1', icon: 'H1', keywords: ['encabezado', 'titulo', 'h1'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setHeading({ level: 1 }).run() },
    { id: 'h2', label: 'Encabezado 2', icon: 'H2', keywords: ['encabezado', 'h2'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setHeading({ level: 2 }).run() },
    { id: 'h3', label: 'Encabezado 3', icon: 'H3', keywords: ['encabezado', 'h3'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setHeading({ level: 3 }).run() },
    { id: 'bullet', label: 'Lista con viñetas', icon: '•', keywords: ['lista', 'vineta', 'viñeta'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).toggleBulletList().run() },
    { id: 'ordered', label: 'Lista numerada', icon: '1.', keywords: ['lista', 'numerada', 'numero'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).toggleOrderedList().run() },
    { id: 'check', label: 'Checkbox', icon: '☐', keywords: ['checkbox', 'tarea', 'todo'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).toggleTaskList().run() },
    { id: 'quote', label: 'Cita', icon: '“', keywords: ['cita', 'quote'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).toggleBlockquote().run() },
    { id: 'rule', label: 'Separador', icon: '—', keywords: ['separador', 'linea'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setHorizontalRule().run() },
    { id: 'link', label: 'Enlace', icon: '↗', keywords: ['enlace', 'link', 'url'], run: ({ editor: ed, range }) => { ed.chain().focus().deleteRange(range).run(); openLink(); } },
    { id: 'image', label: 'Imagen', icon: '▣', keywords: ['imagen', 'foto'], run: ({ editor: ed, range }) => { ed.chain().focus().deleteRange(range).run(); addImages(null, ed.state.selection.from); } },
  ];

  function filterCommands(query) {
    const q = norm(query).trim();
    if (!q) return commands.slice();
    return commands.filter((item) => norm(item.label).includes(q) || item.keywords.some((word) => norm(word).includes(q)));
  }

  function highlight() {
    const buttons = [...menu.querySelectorAll('.notion-menu-item')];
    buttons.forEach((button, index) => {
      const on = index === selected;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) button.scrollIntoView({ block: 'nearest' });
    });
  }

  function renderMenu(props) {
    latest = props;
    const incoming = props.items || [];
    if (props.loading && !incoming.length && currentItems.length) return;
    currentItems = incoming;
    if (selected >= currentItems.length) selected = 0;
    menu.replaceChildren();
    if (!currentItems.length) {
      const empty = document.createElement('div');
      empty.className = 'doc-slash-empty';
      empty.textContent = props.loading ? 'Buscando…' : 'Sin resultados';
      menu.appendChild(empty);
      return;
    }
    currentItems.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `notion-menu-item${index === selected ? ' is-active' : ''}`;
      button.setAttribute('role', 'option');
      button.id = `doc-slash-${item.id}`;
      button.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      const icon = document.createElement('span');
      icon.className = 'notion-menu-ico';
      icon.textContent = item.icon;
      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(icon, label);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('mouseenter', () => {
        selected = index;
        highlight();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        if (latest) latest.command(item);
      });
      menu.appendChild(button);
    });
  }

  function closeSlash() {
    slashOn = false;
    if (!unmountSlash) return;
    const unmount = unmountSlash;
    unmountSlash = null;
    unmount();
  }

  const SlashCommand = Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          container: portal,
          placement: 'bottom-start',
          floatingUi: { strategy: 'fixed' },
          decorationClass: 'doc-slash-query',
          decorationEmptyClass: 'doc-slash-query-empty',
          initialItems: commands,
          items: ({ query }) => filterCommands(query),
          command: ({ editor: ed, range, props }) => props.run({ editor: ed, range }),
          allow: ({ state, range }) => isEmptySlash(state, range),
          render: () => ({
            onStart: (props) => {
              if (unmountSlash) {
                const previous = unmountSlash;
                unmountSlash = null;
                previous();
              }
              slashOn = true;
              selected = 0;
              hideBubble();
              renderMenu(props);
              unmountSlash = props.mount(menu);
            },
            onUpdate: (props) => {
              if (props.query !== (latest && latest.query)) selected = 0;
              renderMenu(props);
            },
            onExit: () => {
              closeSlash();
              updateBubble();
            },
            onKeyDown: ({ event }) => {
              if (event.key === 'Escape' || event.key === 'Esc') {
                event.preventDefault();
                event.stopPropagation();
                return false;
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                if (!currentItems.length) return true;
                selected = event.key === 'ArrowDown'
                  ? (selected + 1) % currentItems.length
                  : (selected - 1 + currentItems.length) % currentItems.length;
                highlight();
                return true;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                if (currentItems[selected] && latest) latest.command(currentItems[selected]);
                return true;
              }
              return false;
            },
          }),
        }),
      ];
    },
  });

  const LinkShortcut = Extension.create({
    name: 'linkShortcut',
    addKeyboardShortcuts() {
      return {
        'Mod-k': () => {
          openLink();
          return true;
        },
      };
    },
  });

  function markButton(mark, label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `doc-format-btn doc-format-${mark}`;
    button.dataset.mark = mark;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (!editor) return;
      const chain = editor.chain().focus();
      if (mark === 'bold') chain.toggleBold();
      else if (mark === 'italic') chain.toggleItalic();
      else chain.toggleUnderline();
      chain.run();
      syncPressed();
    });
    return button;
  }

  const linkButton = document.createElement('button');
  linkButton.type = 'button';
  linkButton.className = 'doc-format-btn doc-format-link';
  linkButton.dataset.mark = 'link';
  linkButton.dataset.docLink = '1';
  linkButton.textContent = '↗';
  linkButton.title = `Enlace (${mod}+K)`;
  linkButton.setAttribute('aria-label', `Enlace (${mod}+K)`);
  linkButton.setAttribute('aria-pressed', 'false');
  linkButton.setAttribute('data-doc-link', '');
  linkButton.addEventListener('mousedown', (event) => event.preventDefault());
  linkButton.addEventListener('click', (event) => {
    event.preventDefault();
    openLink();
  });

  bubble.append(
    markButton('bold', 'B', `Negrita (${mod}+B)`),
    markButton('italic', 'I', `Cursiva (${mod}+I)`),
    markButton('underline', 'U', `Subrayado (${mod}+U)`),
    linkButton,
  );

  linkApply.addEventListener('click', (event) => {
    event.preventDefault();
    applyLink();
  });
  linkRemove.addEventListener('click', (event) => {
    event.preventDefault();
    removeLink();
  });
  linkInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      applyLink();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeLink(true);
    }
  });
  linkInput.addEventListener('input', () => {
    linkError.hidden = true;
  });

  function onPointerDown(event) {
    if (popover.hidden) return;
    const target = event.target;
    if (!(target instanceof Node) || popover.contains(target)) return;
    if (target instanceof Element && target.closest('[data-doc-link]')) return;
    closeLink(false);
  }
  document.addEventListener('pointerdown', onPointerDown, true);

  const initial = options && options.content && options.content.type === 'doc' ? options.content : undefined;

  try {
  editor = new Editor({
    element: host,
    content: initial,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        code: false,
        codeBlock: false,
        strike: false,
        dropcursor: { class: 'doc-dropcursor', color: '#a78bfa', width: 2 },
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          protocols: ['http', 'https', 'mailto'],
          HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
        },
      }),
      SafeImage,
      Columns,
      Column,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: PLACEHOLDER,
        emptyEditorClass: 'is-editor-empty',
      }),
      SlashCommand,
      LinkShortcut,
    ],
    editorProps: {
      attributes: {
        spellcheck: 'true',
        'aria-label': 'Contenido del documento',
        'aria-multiline': 'true',
      },
      handleClick(_view, _pos, event) {
        const target = event.target;
        const anchor = target && target.closest ? target.closest('a') : null;
        if (anchor) event.preventDefault();
        return false;
      },
      handlePaste(_view, event) {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        event.stopPropagation();
        addImages(files);
        return true;
      },
      handleDOMEvents: {
        dragover(view, event) {
          showColumnDrop(columnDropTarget(view, event.clientX, event.clientY));
          return false;
        },
        dragleave(view, event) {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !view.dom.contains(next)) hideColumnDrop();
          return false;
        },
        dragend() {
          hideColumnDrop();
          return false;
        },
      },
      handleDrop(view, event, slice, moved) {
        const target = columnDropTarget(view, event.clientX, event.clientY);
        hideColumnDrop();
        if (target && dropIntoColumns(view, target, slice, moved)) return true;
        if (moved) return false;
        const files = imageFiles(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        event.stopPropagation();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        addImages(files, coords ? coords.pos : undefined);
        return true;
      },
    },
    onUpdate: () => {
      if (!ready || !alive) return;
      onChange(editor.getJSON());
    },
    onSelectionUpdate: () => updateBubble(),
  });
  } catch (err) {
    alive = false;
    document.removeEventListener('pointerdown', onPointerDown, true);
    bubble.remove();
    popover.remove();
    columnDrop.remove();
    throw err;
  }
  ready = true;

  return {
    getJSON() {
      return editor ? editor.getJSON() : { type: 'doc', content: [{ type: 'paragraph' }] };
    },
    focus(where) {
      if (!editor) return;
      editor.commands.focus(where === 'start' ? 'start' : 'end');
    },
    getSelection() {
      if (!editor) return null;
      const { from, to } = editor.state.selection;
      return { from, to };
    },
    restoreSelection(range) {
      if (!editor) return;
      const size = editor.state.doc.content.size;
      const at = Math.max(0, Math.min(size, Math.round(Number(range && range.from) || 0)));
      try {
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(at))));
      } catch {
        // Si la posición ya no existe, queda la selección inicial.
      }
      editor.commands.focus(null, { scrollIntoView: false });
    },
    destroy() {
      alive = false;
      ready = false;
      document.removeEventListener('pointerdown', onPointerDown, true);
      closeSlash();
      bubble.remove();
      popover.remove();
      hideColumnDrop();
      columnDrop.remove();
      if (editor) {
        const current = editor;
        editor = null;
        current.destroy();
      }
    },
  };
}

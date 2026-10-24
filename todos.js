'use strict';

/**
 * Página del icono de inplaize.
 * Renglones (texto, checkbox, viñeta, documento), columnas y arrastre.
 * Arrastrá un renglón desde cualquier parte para moverlo. En el espacio vacío,
 * el arrastre selecciona varios; Shift+clic también. Se sueltan juntos en otro lugar,
 * justo antes de un documento, o encima de él para meterlos en esa página.
 * Enter en un checkbox o una viñeta abre otro igual. En uno vacío, pasa a texto.
 * "/" elige el tipo. Tab sangra.
 * Un documento se edita en un modal, sin cambiar de página.
 * Ctrl+Z deshace y Ctrl+Mayús+Z (o Ctrl+Y) rehace. El historial es de esta
 * sesión; en disco se sigue guardando solo el estado actual.
 */

(function () {
  const SAVE_DEBOUNCE_MS = 250;
  const MAX_COLUMNS = 30;
  const MIN_COL_WIDTH = 88;
  const MAX_COL_WIDTH = 4000;
  const DEFAULT_COL_WIDTH = 340;
  const SINGLE_COL_WIDTH = 720;
  const MAX_BLOCKS = 400;
  const MAX_HISTORY = 50;
  const HISTORY_COALESCE_MS = 800;
  const MAX_INDENT = 6;
  const MAX_DROP_GAP = 40;
  const TYPES = ['text', 'todo', 'bullet', 'document'];

  const homeEl = document.getElementById('todo-home');
  const rootEl = document.getElementById('notion-root');
  if (!homeEl || !rootEl) return;

  const state = {
    title: 'Tareas',
    columns: [],
  };

  let saveTimer = null;
  let ready = false;
  let menuEl = null;
  let menuBlockId = null;
  let menuIndex = 0;
  let canvasMenuEl = null;
  const canvasOptionsBtn = document.getElementById('canvas-options-btn');
  const canvasUndoBtn = document.getElementById('canvas-undo-btn');
  const canvasRedoBtn = document.getElementById('canvas-redo-btn');
  const CANVAS_THEME_KEY = 'inplaize.canvasTheme';
  let press = null;
  let dropTarget = null;
  let scrollPump = 0;
  let clearColumnOnEmpty = null;
  let selectedIds = new Set();
  let selectionAnchorId = null;
  let blockGesture = null;
  let swallowClick = false;

  const layerParent = document.getElementById('sidebar') || document.body;
  const dropLine = document.createElement('div');
  dropLine.className = 'notion-drop-line';
  layerParent.appendChild(dropLine);
  const marqueeEl = document.createElement('div');
  marqueeEl.className = 'notion-marquee';
  layerParent.appendChild(marqueeEl);

  function getApi() {
    return (typeof window !== 'undefined' && window.usualDesk) || null;
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function emptyContent() {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }

  function docContentBlank(content) {
    if (!content || content.type !== 'doc' || !Array.isArray(content.content) || !content.content.length) return true;
    return content.content.every((node) => !node || (node.type === 'paragraph' && !(node.content && node.content.length)));
  }

  function ensureDoc(block, columnId) {
    const now = new Date().toISOString();
    if (!block.doc || typeof block.doc !== 'object') {
      block.doc = {
        id: block.id,
        title: '',
        description: '',
        content: emptyContent(),
        parentId: columnId || '',
        createdAt: now,
        updatedAt: now,
      };
    }
    const doc = block.doc;
    if (typeof doc.title !== 'string') doc.title = block.text || '';
    if (typeof doc.description !== 'string') doc.description = '';
    if (!doc.content || doc.content.type !== 'doc') doc.content = emptyContent();
    if (typeof doc.createdAt !== 'string') doc.createdAt = now;
    if (typeof doc.updatedAt !== 'string') doc.updatedAt = doc.createdAt;
    doc.id = block.id;
    if (columnId) doc.parentId = columnId;
    block.text = doc.title;
    block.done = false;
    return doc;
  }

  function emptyBlock(type) {
    const block = {
      id: makeId('b'),
      type: TYPES.includes(type) ? type : 'text',
      text: '',
      done: false,
      indent: 0,
    };
    if (block.type === 'document') ensureDoc(block, '');
    return block;
  }

  function countBlocks() {
    return state.columns.reduce((n, col) => n + col.blocks.length, 0);
  }

  function findBlock(id) {
    for (const column of state.columns) {
      const index = column.blocks.findIndex((block) => block.id === id);
      if (index >= 0) return { column, index, block: column.blocks[index] };
    }
    return null;
  }

  function ensureShape() {
    if (!Array.isArray(state.columns) || !state.columns.length) {
      state.columns = [{ id: makeId('c'), blocks: [] }];
    }
    state.columns = state.columns.slice(0, MAX_COLUMNS);
    for (const column of state.columns) {
      if (!column.id) column.id = makeId('c');
      if (!Array.isArray(column.blocks) || !column.blocks.length) {
        column.blocks = [emptyBlock('text')];
      }
      for (const block of column.blocks) {
        if (block && block.type === 'document') ensureDoc(block, column.id);
      }
    }
    stripCardPositions();
  }

  function stripCardPositions() {
    const placed = state.columns.some((column) => Number.isFinite(column.x) && Number.isFinite(column.y));
    if (!placed) return;
    let flowX = 0;
    const keyed = state.columns.map((column, index) => {
      if (Number.isFinite(column.x) && Number.isFinite(column.y)) {
        return { column, x: column.x, y: column.y, index };
      }
      const slot = { column, x: flowX, y: 0, index };
      flowX += columnPixelWidth(column) + 20;
      return slot;
    });
    keyed.sort((a, b) => (a.x - b.x) || (a.y - b.y) || (a.index - b.index));
    state.columns = keyed.map((item) => item.column);
    for (const column of state.columns) {
      delete column.x;
      delete column.y;
    }
    scheduleSave();
  }

  function snapshot() {
    return {
      title: state.title,
      columns: state.columns.map((column) => {
        const entry = {
          id: column.id,
          blocks: column.blocks.map((block) => {
            if (block.type === 'document') {
              const doc = ensureDoc(block, column.id);
              return {
                id: block.id,
                type: 'document',
                text: doc.title || '',
                done: false,
                indent: block.indent || 0,
                doc: {
                  id: block.id,
                  title: doc.title || '',
                  description: doc.description || '',
                  content: doc.content,
                  parentId: column.id,
                  createdAt: doc.createdAt,
                  updatedAt: doc.updatedAt,
                },
              };
            }
            return {
              id: block.id,
              type: block.type,
              text: block.text,
              done: block.done === true,
              indent: block.indent || 0,
            };
          }),
        };
        if (column.width >= MIN_COL_WIDTH) entry.width = clampWidth(column.width);
        return entry;
      }),
    };
  }

  let saveChain = Promise.resolve();

  function persistNow() {
    const api = getApi();
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!api || typeof api.saveTodos !== 'function') return Promise.resolve(false);
    const run = saveChain.then(() => api.saveTodos(snapshot()).then(() => true, () => false));
    saveChain = run.then(() => {}, () => {});
    return run;
  }

  function scheduleSave(coalesceKey) {
    noteChange(coalesceKey);
    const api = getApi();
    if (!api || typeof api.saveTodos !== 'function') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    return persistNow();
  }

  const undoStack = [];
  const redoStack = [];
  let historyCurrent = '';
  let historyKey = null;
  let historyAt = 0;
  let historyReady = false;
  let historyLock = false;

  function historyJson() {
    const data = snapshot();
    data.columns.forEach((column) => {
      column.blocks.forEach((block) => {
        if (block.doc) delete block.doc.updatedAt;
      });
    });
    return JSON.stringify(data);
  }

  function seedHistory() {
    historyLock = true;
    historyCurrent = historyJson();
    historyKey = null;
    historyAt = 0;
    undoStack.length = 0;
    redoStack.length = 0;
    historyReady = true;
    historyLock = false;
    syncHistoryButtons();
  }

  function noteChange(coalesceKey) {
    if (!historyReady || historyLock) return;
    const next = historyJson();
    if (next === historyCurrent) return;
    const now = Date.now();
    const key = coalesceKey || null;
    const burst = Boolean(key) && key === historyKey && now - historyAt < HISTORY_COALESCE_MS;
    if (!burst) {
      undoStack.push(historyCurrent);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
    }
    historyCurrent = next;
    historyKey = key;
    historyAt = now;
    syncHistoryButtons();
  }

  function syncHistoryButtons() {
    const undoOn = undoStack.length > 0;
    const redoOn = redoStack.length > 0;
    if (canvasUndoBtn) canvasUndoBtn.setAttribute('aria-disabled', undoOn ? 'false' : 'true');
    if (canvasRedoBtn) canvasRedoBtn.setAttribute('aria-disabled', redoOn ? 'false' : 'true');
  }

  function editingFocus() {
    const active = document.activeElement;
    if (!active || !active.classList || !active.classList.contains('notion-content')) return null;
    const row = active.closest('.notion-block');
    if (!row) return null;
    return { id: row.dataset.blockId, offset: selectionParts(active).before.length };
  }

  function focusInSnapshot(json, focus) {
    if (!focus || !focus.id) return null;
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return null;
    }
    const columns = Array.isArray(data.columns) ? data.columns : [];
    for (const column of columns) {
      const block = (column.blocks || []).find((item) => item && item.id === focus.id);
      if (!block) continue;
      const len = String(block.text || '').length;
      return { id: focus.id, offset: Math.max(0, Math.min(focus.offset || 0, len)) };
    }
    return null;
  }

  function applyHistory(json, focus) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return;
    }
    historyLock = true;
    try {
      state.title = typeof data.title === 'string' ? data.title : 'Tareas';
      state.columns = Array.isArray(data.columns) ? data.columns : [];
      ensureShape();
      historyCurrent = historyJson();
      historyKey = null;
      historyAt = 0;
      closeCanvasMenu();
      selectedIds = new Set();
      selectionAnchorId = null;
      const restored = focusInSnapshot(historyCurrent, focus);
      render(restored ? { id: restored.id, offset: restored.offset } : { skipFocus: true });
    } finally {
      historyLock = false;
    }
    syncHistoryButtons();
    persistNow();
  }

  function undo() {
    if (!undoStack.length || !historyViewAllowed()) return;
    const focus = editingFocus();
    const current = historyJson();
    redoStack.push(current);
    const prev = undoStack.pop();
    applyHistory(prev, focus);
  }

  function redo() {
    if (!redoStack.length || !historyViewAllowed()) return;
    const focus = editingFocus();
    const current = historyJson();
    undoStack.push(current);
    const next = redoStack.pop();
    applyHistory(next, focus);
  }

  function overlayBlocksHistory() {
    if (document.documentElement.classList.contains('doc-modal-open')) return true;
    if (document.documentElement.classList.contains('onboarding-active')) return true;
    return ['modal-overlay', 'settings-modal-overlay', 'dock-inline-editor'].some((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
  }

  function historyViewAllowed() {
    if (overlayBlocksHistory()) return false;
    const panel = document.getElementById('dock-home-panel');
    if (panel && panel.dataset.homeView && panel.dataset.homeView !== 'todos') return false;
    return true;
  }

  function historyFocusAllowed() {
    const active = document.activeElement;
    if (!active || !active.closest) return true;
    if (active.closest('input, textarea, select')) return false;
    if (active.isContentEditable && !active.classList.contains('notion-content')) return false;
    return true;
  }

  function historyShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
    const key = (event.key || '').toLowerCase();
    if (key === 'z' && !event.shiftKey) return 'undo';
    if (key === 'z' && event.shiftKey) return 'redo';
    if (key === 'y' && !event.shiftKey) return 'redo';
    return null;
  }

  function clampWidth(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_COL_WIDTH;
    return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, n));
  }

  function columnPixelWidth(column) {
    if (column.width >= MIN_COL_WIDTH) return clampWidth(column.width);
    return state.columns.length === 1 ? SINGLE_COL_WIDTH : DEFAULT_COL_WIDTH;
  }

  function applyColumnWidth(el, px) {
    el.style.flex = '0 0 auto';
    el.style.width = `${px}px`;
  }

  function keepColumnFocus(id, offset) {
    focusBlock(id, offset);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      const row = active && active.closest ? active.closest(`[data-block-id="${CSS.escape(id)}"]`) : null;
      if (!row) focusBlock(id, offset);
    });
  }

  function beginWritingAt(x, y) {
    const target = hitTest(x, y);
    if (!target || target.kind !== 'insert') return false;
    const column = state.columns.find((item) => item.id === target.columnId);
    if (!column) return false;
    const columnEl = rootEl.querySelector(`.notion-column[data-column-id="${CSS.escape(column.id)}"]`);
    if (columnEl) {
      const rows = [...columnEl.querySelectorAll('.notion-block')];
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (y < rect.top || y > rect.bottom) continue;
        const block = column.blocks.find((item) => item.id === row.dataset.blockId);
        if (!block) continue;
        keepColumnFocus(block.id, (block.text || '').length);
        return true;
      }
    }
    const index = Math.max(0, Math.min(target.index, column.blocks.length));
    const at = column.blocks[index];
    const before = index > 0 ? column.blocks[index - 1] : null;
    if (at && !(at.text || '').trim()) {
      keepColumnFocus(at.id, 0);
      return true;
    }
    if (before && !(before.text || '').trim()) {
      keepColumnFocus(before.id, 0);
      return true;
    }
    if (countBlocks() >= MAX_BLOCKS) {
      const last = column.blocks[column.blocks.length - 1];
      if (last) keepColumnFocus(last.id, (last.text || '').length);
      return true;
    }
    const block = emptyBlock('text');
    column.blocks.splice(index, 0, block);
    render({ id: block.id, offset: 0 });
    scheduleSave();
    return true;
  }

  function stretchColumns() {
    const columnsEl = rootEl.querySelector('.notion-columns');
    if (!columnsEl) return;
    const homeRect = homeEl.getBoundingClientRect();
    const colRect = columnsEl.getBoundingClientRect();
    const topInHome = colRect.top - homeRect.top + homeEl.scrollTop;
    const padBottom = parseFloat(getComputedStyle(homeEl).paddingBottom) || 0;
    const next = Math.max(160, Math.ceil(homeEl.clientHeight - topInHome - padBottom - 4));
    const value = `${next}px`;
    if (columnsEl.style.minHeight !== value) columnsEl.style.minHeight = value;
  }

  function materializeColumnWidths() {
    rootEl.querySelectorAll('.notion-column').forEach((el) => {
      const column = state.columns.find((item) => item.id === el.dataset.columnId);
      if (!column || column.width >= MIN_COL_WIDTH) return;
      column.width = clampWidth(el.getBoundingClientRect().width);
    });
  }

  function bindColumnResize(handle, column, columnEl) {
    const apply = (px) => {
      column.width = clampWidth(px);
      applyColumnWidth(columnEl, column.width);
      handle.setAttribute('aria-valuenow', String(column.width));
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      materializeColumnWidths();
      const startX = e.clientX;
      const startW = clampWidth(column.width || columnEl.getBoundingClientRect().width);
      apply(startW);
      handle.classList.add('is-active');
      document.body.classList.add('notion-col-resizing');
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        apply(clampWidth(startW + ev.clientX - startX));
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        handle.classList.remove('is-active');
        document.body.classList.remove('notion-col-resizing');
        scheduleSave(`width:${column.id}`);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      materializeColumnWidths();
      const delta = e.key === 'ArrowRight' ? 24 : -24;
      const start = column.width >= MIN_COL_WIDTH ? column.width : columnEl.getBoundingClientRect().width;
      apply(clampWidth(start + delta));
      scheduleSave(`width:${column.id}`);
    });
  }

  function svgEl(pathD) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function selectionParts(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) {
      const text = el.textContent || '';
      return { before: text, after: '', collapsed: true, atStart: false, atEnd: true };
    }
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    const post = range.cloneRange();
    post.selectNodeContents(el);
    post.setStart(range.endContainer, range.endOffset);
    const before = pre.toString();
    const after = post.toString();
    return {
      before,
      after,
      collapsed: sel.isCollapsed,
      atStart: before.length === 0 && sel.isCollapsed,
      atEnd: after.length === 0 && sel.isCollapsed,
    };
  }

  function focusBlock(id, offset) {
    const row = rootEl.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const opener = row.querySelector('.notion-doc-open');
    if (opener) {
      opener.focus();
      return;
    }
    const el = row.querySelector('.notion-content');
    if (!el) return;
    el.focus();
    const textNode = firstTextNode(el);
    const text = el.textContent || '';
    const off = offset == null ? text.length : Math.max(0, Math.min(offset, text.length));
    const range = document.createRange();
    if (!textNode) {
      range.setStart(el, 0);
      range.collapse(true);
    } else {
      range.setStart(textNode, Math.min(off, textNode.textContent.length));
      range.collapse(true);
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function firstTextNode(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    return walker.nextNode();
  }

  function canvasIsLight() {
    return document.documentElement.getAttribute('data-canvas-theme') === 'light';
  }

  function setCanvasTheme(theme) {
    const light = theme === 'light';
    if (light) document.documentElement.setAttribute('data-canvas-theme', 'light');
    else document.documentElement.removeAttribute('data-canvas-theme');
    try {
      localStorage.setItem(CANVAS_THEME_KEY, light ? 'light' : 'dark');
    } catch {
      /* el canvas sigue el tema en esta sesión */
    }
  }

  function loadCanvasTheme() {
    let theme = 'dark';
    try {
      if (localStorage.getItem(CANVAS_THEME_KEY) === 'light') theme = 'light';
    } catch {
      /* sin almacenamiento: queda el canvas oscuro */
    }
    setCanvasTheme(theme);
  }

  function closeCanvasMenu() {
    if (canvasMenuEl) canvasMenuEl.remove();
    canvasMenuEl = null;
    canvasOptionsBtn?.setAttribute('aria-expanded', 'false');
  }

  function openCanvasMenu() {
    if (!canvasOptionsBtn) return;
    closeMenu();
    closeCanvasMenu();
    const menu = document.createElement('div');
    menu.id = 'canvas-options-menu';
    menu.className = 'notion-menu canvas-options-menu';
    menu.setAttribute('data-mouse-hit', '');
    menu.setAttribute('role', 'menu');
    const item = menuButton('◐', 'Invertir colores', () => {
      setCanvasTheme(canvasIsLight() ? 'dark' : 'light');
      closeCanvasMenu();
    });
    item.setAttribute('role', 'menuitemcheckbox');
    item.setAttribute('aria-checked', canvasIsLight() ? 'true' : 'false');
    if (canvasIsLight()) item.classList.add('is-checked');
    menu.appendChild(item);
    layerParent.appendChild(menu);
    canvasMenuEl = menu;
    canvasOptionsBtn.setAttribute('aria-expanded', 'true');
    const rect = canvasOptionsBtn.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = rect.left;
    let top = rect.top - height - 8;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (top < 8) top = rect.bottom + 8;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
  }

  function menuItems() {
    if (!menuEl) return [];
    return [...menuEl.querySelectorAll('.notion-menu-item')];
  }

  function setMenuIndex(index) {
    const items = menuItems();
    if (!items.length) return;
    const next = (index + items.length) % items.length;
    menuIndex = next;
    items.forEach((el, i) => {
      const on = i === next;
      el.classList.toggle('is-active', on);
      if (on) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    });
  }

  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
    menuIndex = 0;
    if (menuBlockId) {
      const row = rootEl.querySelector(`[data-block-id="${CSS.escape(menuBlockId)}"]`);
      row?.classList.remove('is-menu-open');
    }
    menuBlockId = null;
  }

  function openMenu(anchor, block, mode) {
    closeCanvasMenu();
    closeMenu();
    menuBlockId = block.id;
    const row = rootEl.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`);
    row?.classList.add('is-menu-open');

    const menu = document.createElement('div');
    menu.className = 'notion-menu';
    menu.setAttribute('data-mouse-hit', '');
    menu.setAttribute('role', 'menu');

    const types = [
      { type: 'todo', label: 'Checkbox', ico: '☐' },
      { type: 'bullet', label: 'Viñeta', ico: '•' },
      { type: 'text', label: 'Texto', ico: 'T' },
      { type: 'document', label: 'Documento', ico: documentIcon() },
    ];
    for (const item of types) {
      menu.appendChild(menuButton(item.ico, item.label, () => {
        const found = findBlock(block.id);
        if (!found) return;
        const wasSlash = (found.block.text || '').trim() === '/';
        if (item.type === 'document') {
          const title = wasSlash ? '' : (found.block.text || '');
          found.block.type = 'document';
          found.block.done = false;
          ensureDoc(found.block, found.column.id);
          found.block.doc.title = title;
          found.block.text = title;
          closeMenu();
          render({ id: found.block.id, skipFocus: true });
          scheduleSave();
          if (window.InplaizeDocumentModal) window.InplaizeDocumentModal.open(found.block.id);
          return;
        }
        found.block.type = item.type;
        if (wasSlash) found.block.text = '';
        if (item.type !== 'todo') found.block.done = false;
        closeMenu();
        render({ id: found.block.id, offset: wasSlash ? 0 : (found.block.text || '').length });
        scheduleSave();
      }));
    }

    if (mode !== 'slash') {
      menu.appendChild(sep());
      if (state.columns.length < MAX_COLUMNS) {
        menu.appendChild(menuButton('+', 'Agregar columna', () => {
          closeMenu();
          addColumn();
        }));
      }
      const host = state.columns.find((column) => column.blocks.some((b) => b.id === block.id));
      if (state.columns.length > 1 && host) {
        menu.appendChild(menuButton('–', 'Quitar columna', () => {
          closeMenu();
          removeColumn(host.id);
        }));
      }
      menu.appendChild(menuButton('×', 'Eliminar', () => {
        closeMenu();
        deleteBlock(block.id);
      }, true));
    }

    layerParent.appendChild(menu);
    menuEl = menu;
    setMenuIndex(0);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
  }

  function sep() {
    const el = document.createElement('div');
    el.className = 'notion-menu-sep';
    return el;
  }

  function documentIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of [
      'M7 3.5h7L19.5 9V20a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5z',
      'M14 3.5V9h5.5',
      'M8.5 13h7',
      'M8.5 17h5',
    ]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.8');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    }
    return svg;
  }

  function menuButton(ico, label, onClick, danger) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notion-menu-item' + (danger ? ' is-danger' : '');
    btn.setAttribute('role', 'menuitem');
    const mark = document.createElement('span');
    mark.className = 'notion-menu-ico';
    if (typeof ico === 'string') mark.textContent = ico;
    else mark.appendChild(ico);
    const text = document.createElement('span');
    text.textContent = label;
    btn.append(mark, text);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('mouseenter', () => {
      const items = menuItems();
      const index = items.indexOf(btn);
      if (index >= 0) setMenuIndex(index);
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return btn;
  }

  function neighbor(column, index, dir) {
    const next = index + dir;
    if (next >= 0 && next < column.blocks.length) {
      return { column, index: next, block: column.blocks[next] };
    }
    return null;
  }

  function blockHasText(block) {
    if (block && block.type === 'document') {
      if (((block.doc && block.doc.title) || block.text || '').trim()) return true;
      if (((block.doc && block.doc.description) || '').trim()) return true;
      return !docContentBlank(block.doc && block.doc.content);
    }
    return !!((block && block.text) || '').trim();
  }

  function docIsBlank(block) {
    return block && block.type === 'document' && !blockHasText(block);
  }

  function columnHasOtherText(column, blockId) {
    return column.blocks.some((item) => item.id !== blockId && blockHasText(item));
  }

  // Borrar el último ítem con texto saca la columna. Si era la única, queda
  // un renglón vacío para seguir escribiendo. Una línea en blanco que el
  // usuario acaba de abrir no cuenta como borrar ese ítem.
  function dropColumnAfterDelete(column) {
    const index = state.columns.findIndex((item) => item.id === column.id);
    if (index < 0) return null;
    if (state.columns.length < 2) {
      const block = emptyBlock('text');
      column.blocks = [block];
      return { id: block.id, offset: 0 };
    }
    state.columns.splice(index, 1);
    const prevCol = state.columns[index - 1];
    if (prevCol && prevCol.blocks.length) {
      const block = prevCol.blocks[prevCol.blocks.length - 1];
      return { id: block.id, offset: (block.text || '').length };
    }
    const nextCol = state.columns[index] || state.columns[state.columns.length - 1];
    if (nextCol && nextCol.blocks.length) {
      return { id: nextCol.blocks[0].id, offset: 0 };
    }
    return null;
  }

  function columnEmptiedByDelete(column, removedHadText) {
    if (column.blocks.some(blockHasText)) return false;
    return removedHadText || column.blocks.length === 0;
  }

  function deleteBlock(id) {
    const found = findBlock(id);
    if (!found) return;
    const removedHadText = blockHasText(found.block);
    const prev = neighbor(found.column, found.index, -1) || neighbor(found.column, found.index, 1);
    const column = found.column;
    column.blocks.splice(found.index, 1);
    if (columnEmptiedByDelete(column, removedHadText)) {
      render(dropColumnAfterDelete(column));
      scheduleSave();
      return;
    }
    const target = prev && prev.block.id !== id ? prev.block : column.blocks[Math.max(0, found.index - 1)] || column.blocks[0];
    render(target ? { id: target.id, offset: (target.text || '').length } : null);
    scheduleSave();
  }

  function insertAfter(id, type, text, indent) {
    if (countBlocks() >= MAX_BLOCKS) return null;
    const found = findBlock(id);
    if (!found) return null;
    const block = emptyBlock(type || found.block.type);
    block.text = text || '';
    block.indent = Math.max(0, Math.min(MAX_INDENT, indent == null ? found.block.indent || 0 : indent));
    found.column.blocks.splice(found.index + 1, 0, block);
    return block;
  }

  function addColumn() {
    if (state.columns.length >= MAX_COLUMNS) return;
    const column = { id: makeId('c'), blocks: [emptyBlock('todo')] };
    state.columns.push(column);
    render({ id: column.blocks[0].id, offset: 0 });
    scheduleSave();
  }

  function removeColumn(columnId) {
    if (state.columns.length < 2) return;
    const index = state.columns.findIndex((column) => column.id === columnId);
    if (index < 0) return;
    const [removed] = state.columns.splice(index, 1);
    const keep = removed.blocks.filter((block) => (block.text || '').trim());
    const destIndex = Math.max(0, index - 1);
    const dest = state.columns[destIndex];
    if (keep.length && countBlocks() + keep.length <= MAX_BLOCKS) {
      const tail = dest.blocks.length === 1 && !(dest.blocks[0].text || '').trim();
      if (tail) dest.blocks = keep;
      else dest.blocks.push(...keep);
    }
    ensureShape();
    render({ id: dest.blocks[0].id, offset: 0 });
    scheduleSave();
  }

  function blocksInOrder(idSet) {
    const blocks = [];
    state.columns.forEach((column) => {
      column.blocks.forEach((block) => {
        if (idSet.has(block.id)) blocks.push(block);
      });
    });
    return blocks;
  }

  // Un rango ya contiguo, soltado sobre sí mismo, no se mueve.
  function selectionAlreadyThere(idSet, dest, toIndex) {
    const positions = [];
    let outside = false;
    state.columns.forEach((column) => {
      column.blocks.forEach((block, index) => {
        if (!idSet.has(block.id)) return;
        if (column !== dest) outside = true;
        else positions.push(index);
      });
    });
    if (outside || !positions.length) return false;
    for (let i = 1; i < positions.length; i += 1) {
      if (positions[i] !== positions[0] + i) return false;
    }
    return toIndex >= positions[0] && toIndex <= positions[positions.length - 1] + 1;
  }

  function pullBlocks(idSet) {
    const moving = blocksInOrder(idSet);
    state.columns.forEach((column) => {
      const keep = column.blocks.filter((block) => !idSet.has(block.id));
      column.blocks = keep.length ? keep : [emptyBlock('text')];
    });
    return moving;
  }

  function moveBlocks(ids, toColumnId, toIndex) {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    const dest = state.columns.find((column) => column.id === toColumnId);
    if (!dest || !idSet.size) return false;
    if (selectionAlreadyThere(idSet, dest, toIndex)) return false;
    let removedBefore = 0;
    const limit = Math.max(0, Math.min(toIndex, dest.blocks.length));
    for (let i = 0; i < limit; i += 1) {
      if (idSet.has(dest.blocks[i].id)) removedBefore += 1;
    }
    const room = Math.max(0, MAX_BLOCKS - countBlocks());
    const moving = pullBlocks(idSet);
    if (!moving.length) return false;
    let index = Math.max(0, toIndex - removedBefore);
    const missing = Math.min(room, Math.max(0, index - dest.blocks.length));
    for (let n = 0; n < missing; n += 1) dest.blocks.push(emptyBlock('text'));
    if (index > dest.blocks.length) index = dest.blocks.length;
    dest.blocks.splice(index, 0, ...moving);
    return true;
  }

  function plainBlockText(value) {
    return String(value || '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .slice(0, 4000);
  }

  function paragraphIsBlank(node) {
    if (!node || node.type !== 'paragraph') return false;
    if (!Array.isArray(node.content) || !node.content.length) return true;
    return node.content.every((child) => !child || child.type !== 'text' || !(child.text || '').trim());
  }

  function paragraphNode(text) {
    const clean = plainBlockText(text);
    if (!clean.trim()) return { type: 'paragraph' };
    const content = [];
    clean.split('\n').forEach((line, index) => {
      if (index) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line });
    });
    return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
  }

  function nodesFromBlock(block) {
    if (block.type === 'document') {
      const doc = ensureDoc(block, '');
      const nodes = [];
      const title = plainBlockText(doc.title || block.text || '').replace(/\n/g, ' ').trim();
      if (title) {
        nodes.push({
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: title.slice(0, 200) }],
        });
      }
      const body = doc.content && Array.isArray(doc.content.content) ? doc.content.content : [];
      body.forEach((node) => {
        if (!node || paragraphIsBlank(node)) return;
        nodes.push(JSON.parse(JSON.stringify(node)));
      });
      return nodes;
    }
    if (block.type === 'todo') {
      return [{
        type: 'taskItem',
        attrs: { checked: block.done === true },
        content: [paragraphNode(block.text)],
      }];
    }
    if (block.type === 'bullet') {
      if (!plainBlockText(block.text).trim()) return [];
      return [{ type: 'listItem', content: [paragraphNode(block.text)] }];
    }
    if (!plainBlockText(block.text).trim()) return [];
    return [paragraphNode(block.text)];
  }

  function nodesFromBlocks(blocks) {
    const out = [];
    let tasks = [];
    let bullets = [];
    const flushTasks = () => {
      if (!tasks.length) return;
      out.push({ type: 'taskList', content: tasks });
      tasks = [];
    };
    const flushBullets = () => {
      if (!bullets.length) return;
      out.push({ type: 'bulletList', content: bullets });
      bullets = [];
    };
    blocks.forEach((block) => {
      if (block.type === 'todo') {
        flushBullets();
        nodesFromBlock(block).forEach((node) => tasks.push(node));
        return;
      }
      if (block.type === 'bullet') {
        flushTasks();
        nodesFromBlock(block).forEach((node) => bullets.push(node));
        return;
      }
      flushTasks();
      flushBullets();
      nodesFromBlock(block).forEach((node) => out.push(node));
    });
    flushTasks();
    flushBullets();
    return out;
  }

  function appendDocNodes(doc, nodes) {
    if (!doc.content || doc.content.type !== 'doc' || !Array.isArray(doc.content.content)) {
      doc.content = emptyContent();
    }
    const content = doc.content.content;
    if (!content.length || content.every(paragraphIsBlank)) {
      doc.content.content = nodes.slice();
    } else {
      while (content.length && paragraphIsBlank(content[content.length - 1])) content.pop();
      content.push(...nodes);
    }
    doc.updatedAt = new Date().toISOString();
  }

  function moveBlocksIntoDocument(ids, documentId) {
    const found = findBlock(documentId);
    if (!found || found.block.type !== 'document') return false;
    const idSet = new Set(ids);
    idSet.delete(documentId);
    if (!idSet.size) return false;
    const moving = blocksInOrder(idSet);
    if (!moving.length) return false;
    const nodes = nodesFromBlocks(moving);
    if (!nodes.length) return false;
    appendDocNodes(ensureDoc(found.block, found.column.id), nodes);
    pullBlocks(idSet);
    return true;
  }

  function canDropIntoDocument(blockId) {
    if (!press || !press.dragging || !press.blockIds || !press.blockIds.length) return false;
    const found = findBlock(blockId);
    if (!found || found.block.type !== 'document') return false;
    return press.blockIds.some((id) => id !== blockId);
  }

  function moveBlock(blockId, toColumnId, toIndex) {
    return moveBlocks([blockId], toColumnId, toIndex);
  }

  function clearDropInto() {
    rootEl.querySelectorAll('.notion-block.is-drop-into').forEach((row) => {
      row.classList.remove('is-drop-into');
    });
  }

  function hideDrop() {
    dropTarget = null;
    dropLine.classList.remove('is-on');
    clearDropInto();
  }

  function hitTest(x, y) {
    const columns = [...rootEl.querySelectorAll('.notion-column')];
    if (!columns.length) return null;
    let columnEl = null;
    let best = Infinity;
    for (const el of columns) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const dx = Math.abs(x - cx);
      const inside = x >= rect.left - 12 && x <= rect.right + 12;
      const score = inside ? dx : dx + 1000;
      if (score < best) {
        best = score;
        columnEl = el;
      }
    }
    if (!columnEl) return null;
    const columnId = columnEl.dataset.columnId;
    const rows = [...columnEl.querySelectorAll('.notion-block')];
    if (!rows.length) return { kind: 'insert', columnId, index: 0, top: columnEl.getBoundingClientRect().top, left: columnEl.getBoundingClientRect().left, width: columnEl.getBoundingClientRect().width };
    for (let i = 0; i < rows.length; i += 1) {
      const rect = rows[i].getBoundingClientRect();
      const blockId = rows[i].dataset.blockId;
      if (
        rows[i].classList.contains('notion-block-document')
        && rect.height >= 24
        && y > rect.top + 7
        && y < rect.bottom - 7
        && canDropIntoDocument(blockId)
      ) {
        return { kind: 'into-document', blockId, columnId, top: rect.top, left: rect.left, width: rect.width };
      }
      if (y < rect.top + rect.height / 2) {
        return { kind: 'insert', columnId, index: i, top: rect.top, left: rect.left, width: rect.width };
      }
    }
    const last = rows[rows.length - 1].getBoundingClientRect();
    const pitch = slotPitch(rows);
    const extra = Math.max(0, Math.min(MAX_DROP_GAP, Math.floor((y - last.bottom) / pitch)));
    return {
      kind: 'insert',
      columnId,
      index: rows.length + extra,
      top: last.bottom + extra * pitch,
      left: last.left,
      width: last.width,
    };
  }

  function slotPitch(rows) {
    const last = rows[rows.length - 1].getBoundingClientRect();
    if (rows.length > 1) {
      const prev = rows[rows.length - 2].getBoundingClientRect();
      const pitch = last.top - prev.top;
      if (pitch >= 24 && pitch <= 160) return pitch;
    }
    return Math.max(32, Math.round(last.height) + 2);
  }

  function placeDropLine(top, left, width) {
    const origin = layerParent.getBoundingClientRect();
    dropLine.style.top = `${top - origin.top}px`;
    dropLine.style.left = `${left - origin.left}px`;
    dropLine.style.width = `${Math.max(40, width)}px`;
  }

  function showDrop(target) {
    clearDropInto();
    if (target && target.kind === 'into-document') {
      dropTarget = target;
      dropLine.classList.remove('is-on');
      const row = rootEl.querySelector(`[data-block-id="${CSS.escape(target.blockId)}"]`);
      row?.classList.add('is-drop-into');
      return;
    }
    if (target && target.kind === 'insert' && press && press.blockIds && press.blockIds.length) {
      const dest = state.columns.find((column) => column.id === target.columnId);
      if (dest && selectionAlreadyThere(new Set(press.blockIds), dest, target.index)) {
        dropTarget = null;
        dropLine.classList.remove('is-on');
        return;
      }
    }
    dropTarget = target;
    if (!target || target.kind !== 'insert') {
      dropLine.classList.remove('is-on');
      return;
    }
    dropLine.classList.add('is-on');
    placeDropLine(target.top - 1, target.left, target.width);
  }

  function autoScroll(y) {
    const rect = homeEl.getBoundingClientRect();
    if (y < rect.top + 48) homeEl.scrollTop -= 18;
    else if (y > rect.bottom - 48) homeEl.scrollTop += 18;
  }

  function stopDragScroll() {
    if (scrollPump) cancelAnimationFrame(scrollPump);
    scrollPump = 0;
  }

  function pumpDragScroll() {
    scrollPump = 0;
    if (!press || !press.dragging || press.lastY == null) return;
    const before = homeEl.scrollTop;
    autoScroll(press.lastY);
    if (homeEl.scrollTop !== before) showDrop(hitTest(press.lastX, press.lastY));
    if (press && press.dragging) scrollPump = requestAnimationFrame(pumpDragScroll);
  }

  function trackDragPointer(x, y) {
    if (!press) return;
    press.lastX = x;
    press.lastY = y;
    autoScroll(y);
    showDrop(hitTest(x, y));
    if (!scrollPump) scrollPump = requestAnimationFrame(pumpDragScroll);
  }

  function markDragging(ids, on) {
    const set = new Set(ids || []);
    rootEl.querySelectorAll('.notion-block').forEach((row) => {
      if (set.has(row.dataset.blockId)) row.classList.toggle('is-dragging', on);
    });
  }

  function finishDrag() {
    stopDragScroll();
    const ids = (press && press.blockIds) || [];
    const target = dropTarget;
    const moved = press && press.dragging;
    press = null;
    hideDrop();
    document.body.classList.remove('notion-dragging');
    if (!moved || !ids.length || !target) {
      markDragging(ids, false);
      return;
    }
    if (target.kind === 'into-document') {
      const nested = moveBlocksIntoDocument(ids, target.blockId);
      if (!nested) {
        markDragging(ids, false);
        return;
      }
      selectedIds = new Set();
      selectionAnchorId = null;
      render({ skipFocus: true });
      scheduleSave();
      return;
    }
    const changed = moveBlocks(ids, target.columnId, target.index);
    if (!changed) {
      markDragging(ids, false);
      return;
    }
    selectedIds = new Set(ids);
    selectionAnchorId = ids[0] || null;
    render({ skipFocus: true, keepSelection: true });
    scheduleSave();
  }

  function applySelectionClasses() {
    rootEl.querySelectorAll('.notion-block').forEach((row) => {
      const on = selectedIds.has(row.dataset.blockId);
      row.classList.toggle('is-selected', on);
      const content = row.querySelector('.notion-content');
      if (!content) return;
      const editable = on ? 'false' : 'true';
      if (content.contentEditable !== editable) content.contentEditable = editable;
    });
  }

  function clearBlockSelection() {
    if (!selectedIds.size && !selectionAnchorId) return;
    selectedIds = new Set();
    selectionAnchorId = null;
    applySelectionClasses();
  }

  function selectRange(fromId, toId) {
    const list = [];
    state.columns.forEach((column) => {
      column.blocks.forEach((block) => list.push(block.id));
    });
    let from = list.indexOf(fromId);
    const to = list.indexOf(toId);
    if (to < 0) return;
    if (from < 0) from = to;
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    selectedIds = new Set(list.slice(start, end + 1));
    if (!selectionAnchorId) selectionAnchorId = list[start];
    applySelectionClasses();
  }

  function eventElement(e) {
    if (e.target instanceof Element) return e.target;
    return e.target && e.target.parentElement;
  }

  function blockRowAt(x, y) {
    const columns = rootEl.querySelectorAll('.notion-column');
    for (const columnEl of columns) {
      const cr = columnEl.getBoundingClientRect();
      if (x < cr.left || x > cr.right || y < cr.top || y > cr.bottom) continue;
      for (const row of columnEl.querySelectorAll('.notion-block')) {
        const rect = row.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) return row;
      }
    }
    return null;
  }

  function idsInDrag(x0, y0, x1, y1) {
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const ids = [];
    rootEl.querySelectorAll('.notion-column').forEach((columnEl) => {
      const cr = columnEl.getBoundingClientRect();
      if (cr.right < left || cr.left > right) return;
      columnEl.querySelectorAll('.notion-block').forEach((row) => {
        const rect = row.getBoundingClientRect();
        if (rect.bottom < top || rect.top > bottom) return;
        if (row.dataset.blockId) ids.push(row.dataset.blockId);
      });
    });
    return ids;
  }

  function showMarquee(x0, y0, x1, y1) {
    marqueeEl.classList.add('is-on');
    marqueeEl.style.left = `${Math.min(x0, x1)}px`;
    marqueeEl.style.top = `${Math.min(y0, y1)}px`;
    marqueeEl.style.width = `${Math.abs(x1 - x0)}px`;
    marqueeEl.style.height = `${Math.abs(y1 - y0)}px`;
  }

  function hideMarquee() {
    marqueeEl.classList.remove('is-on');
  }

  function armSwallowClick() {
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
  }

  function paintDragSelection(gesture, x, y) {
    showMarquee(gesture.x, gesture.y, x, y);
    autoScroll(y);
    const next = new Set(gesture.baseIds || []);
    idsInDrag(gesture.x, gesture.y, x, y).forEach((id) => next.add(id));
    selectedIds = next;
    if (!selectionAnchorId) {
      const anchor = blockRowAt(gesture.x, gesture.y);
      if (anchor) selectionAnchorId = anchor.dataset.blockId;
    }
    applySelectionClasses();
  }

  function startMarquee(gesture, e) {
    gesture.mode = 'marquee';
    if (!gesture.baseIds) gesture.baseIds = new Set();
    if (!gesture.shiftKey) selectionAnchorId = null;
    if (gesture.fromDoc || gesture.fromContent) armSwallowClick();
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('notion-content')) active.blur();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    closeMenu();
    document.body.classList.add('notion-selecting');
    try { homeEl.setPointerCapture(e.pointerId); } catch { /* ya capturado */ }
    paintDragSelection(gesture, e.clientX, e.clientY);
  }

  function startGroupMove(gesture, e) {
    const blockId = gesture.blockId;
    if (!blockId) return;
    const inGroup = selectedIds.has(blockId) && selectedIds.size > 1;
    const ids = inGroup ? [...selectedIds] : [blockId];
    if (!inGroup) {
      selectedIds = new Set(ids);
      selectionAnchorId = blockId;
      applySelectionClasses();
    }
    gesture.mode = 'moving';
    armSwallowClick();
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('notion-content')) active.blur();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    press = {
      blockId: gesture.blockId,
      blockIds: ids,
      pointerId: e.pointerId,
      x: gesture.x,
      y: gesture.y,
      dragging: true,
    };
    closeMenu();
    document.body.classList.add('notion-dragging');
    markDragging(ids, true);
    try { homeEl.setPointerCapture(e.pointerId); } catch { /* ya capturado */ }
    trackDragPointer(e.clientX, e.clientY);
  }

  function wantsBlockSelect(gesture, dx, dy) {
    if (gesture.fromContent && !gesture.shiftKey) {
      if (Math.abs(dy) < 14) return false;
      if (Math.abs(dy) < 28 && Math.abs(dx) > Math.abs(dy)) return false;
      return true;
    }
    return Math.hypot(dx, dy) >= 8;
  }

  function onBlockGestureMove(e) {
    if (!blockGesture || blockGesture.pointerId !== e.pointerId) return;
    const dx = e.clientX - blockGesture.x;
    const dy = e.clientY - blockGesture.y;
    if (blockGesture.mode === 'pending-move') {
      if (Math.hypot(dx, dy) <= 6) return;
      startGroupMove(blockGesture, e);
      return;
    }
    if (blockGesture.mode === 'pending-select') {
      if (!wantsBlockSelect(blockGesture, dx, dy)) return;
      startMarquee(blockGesture, e);
      return;
    }
    if (blockGesture.mode === 'marquee') {
      paintDragSelection(blockGesture, e.clientX, e.clientY);
      return;
    }
    if (blockGesture.mode === 'moving') trackDragPointer(e.clientX, e.clientY);
  }

  function finishPendingSelect(gesture, e) {
    hideMarquee();
    document.body.classList.remove('notion-selecting');
    if (gesture.shiftKey && gesture.blockId) {
      selectRange(selectionAnchorId || gesture.blockId, gesture.blockId);
      return;
    }
    if (gesture.fromContent || gesture.fromDoc) return;
    clearBlockSelection();
    beginWritingAt(gesture.x, gesture.y);
  }

  function onBlockGestureEnd(e) {
    if (!blockGesture || blockGesture.pointerId !== e.pointerId) return;
    const gesture = blockGesture;
    blockGesture = null;
    try { homeEl.releasePointerCapture(e.pointerId); } catch { /* sin captura */ }
    if (gesture.mode === 'moving') {
      finishDrag();
      return;
    }
    if (gesture.mode === 'marquee') {
      hideMarquee();
      document.body.classList.remove('notion-selecting');
      return;
    }
    if (gesture.mode === 'pending-move') {
      if (gesture.onDoc) {
        armSwallowClick();
        clearBlockSelection();
        if (window.InplaizeDocumentModal) window.InplaizeDocumentModal.open(gesture.blockId);
        return;
      }
      if (gesture.onCheck) {
        // El arrastre captura el puntero en la página, así que el click del
        // botón no llega. Se marca acá, y se traga el click por si igual dispara.
        armSwallowClick();
        clearBlockSelection();
        toggleTodoDone(gesture.blockId);
        return;
      }
      if (gesture.onContent) {
        if (gesture.wasSelected) {
          const id = gesture.blockId;
          clearBlockSelection();
          focusBlock(id, null);
        }
        return;
      }
      clearBlockSelection();
      beginWritingAt(gesture.x, gesture.y);
      return;
    }
    if (gesture.mode === 'pending-select') finishPendingSelect(gesture, e);
  }

  function onBlockGestureCancel(e) {
    if (!blockGesture || blockGesture.pointerId !== e.pointerId) return;
    const gesture = blockGesture;
    blockGesture = null;
    hideMarquee();
    document.body.classList.remove('notion-selecting');
    if (gesture.mode === 'moving') {
      stopDragScroll();
      const ids = (press && press.blockIds) || [];
      press = null;
      hideDrop();
      markDragging(ids, false);
      document.body.classList.remove('notion-dragging');
    }
  }

  function editingText() {
    const active = document.activeElement;
    return !!(active && active.classList && active.classList.contains('notion-content') && active.isContentEditable);
  }

  function deleteSelected() {
    const idSet = new Set(selectedIds);
    if (!idSet.size) return;
    let focusId = null;
    const doomed = [];
    state.columns.forEach((column) => {
      const removedHadText = column.blocks.some((block) => idSet.has(block.id) && blockHasText(block));
      const keep = [];
      column.blocks.forEach((block) => {
        if (idSet.has(block.id)) return;
        if (!focusId) focusId = block.id;
        keep.push(block);
      });
      column.blocks = keep;
      if (columnEmptiedByDelete(column, removedHadText)) doomed.push(column);
      else if (!column.blocks.length) column.blocks.push(emptyBlock('text'));
    });
    doomed.forEach((column) => {
      if (state.columns.length < 2) {
        const block = emptyBlock('text');
        column.blocks = [block];
        focusId = block.id;
        return;
      }
      const index = state.columns.indexOf(column);
      if (index >= 0) state.columns.splice(index, 1);
    });
    selectedIds = new Set();
    selectionAnchorId = null;
    ensureShape();
    if (focusId && !findBlock(focusId)) {
      focusId = state.columns[0] && state.columns[0].blocks[0] ? state.columns[0].blocks[0].id : null;
    }
    render(focusId ? { id: focusId, offset: 0 } : null);
    scheduleSave();
  }

  function syncDocRow(block) {
    const row = rootEl.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`);
    if (!row) return;
    const title = row.querySelector('.notion-doc-title');
    const label = (block.text || '').trim();
    if (title) {
      title.textContent = label || 'Documento sin título';
      title.classList.toggle('is-untitled', !label);
    }
    const open = row.querySelector('.notion-doc-open');
    if (open) open.setAttribute('aria-label', label ? `Abrir documento ${label}` : 'Abrir documento sin título');
  }

  function onDocKeydown(event, block) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const found = findBlock(block.id);
      if (!found) return;
      const target = neighbor(found.column, found.index, event.key === 'ArrowUp' ? -1 : 1);
      if (!target) return;
      event.preventDefault();
      focusBlock(target.block.id, event.key === 'ArrowUp' ? (target.block.text || '').length : 0);
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && docIsBlank(block)) {
      event.preventDefault();
      deleteBlock(block.id);
    }
  }

  function onBlockKeydown(e, block, content) {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      closeMenu();
      return;
    }
    if (menuEl && menuBlockId === block.id && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
      e.preventDefault();
      if (e.key === 'ArrowDown') setMenuIndex(menuIndex + 1);
      else if (e.key === 'ArrowUp') setMenuIndex(menuIndex - 1);
      else menuItems()[menuIndex]?.click();
      return;
    }
    if (e.key === '/' && !(content.textContent || '').length) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) return;
      closeMenu();
      if (countBlocks() >= MAX_BLOCKS) return;
      const parts = selectionParts(content);
      const listItem = block.type === 'todo' || block.type === 'bullet';
      // Un checkbox o una viñeta vacíos pasan a texto para salir de la lista.
      if (!parts.before && !parts.after && listItem) {
        block.type = 'text';
        block.done = false;
        block.indent = 0;
        render({ id: block.id, offset: 0 });
        scheduleSave();
        return;
      }
      block.text = parts.before;
      const nextType = listItem ? block.type : 'text';
      const nextIndent = listItem ? (block.indent || 0) : (parts.after ? (block.indent || 0) : 0);
      const created = insertAfter(block.id, nextType, parts.after, nextIndent);
      if (!created) return;
      render({ id: created.id, offset: 0 });
      scheduleSave();
      return;
    }
    if (e.key === 'Backspace') {
      const parts = selectionParts(content);
      if (!parts.collapsed) return;
      if (parts.atStart && (block.indent || 0) > 0 && !(e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        block.indent -= 1;
        const row = content.closest('.notion-block');
        if (row) row.style.setProperty('--indent', String(block.indent));
        scheduleSave();
        return;
      }
      if (parts.atStart) {
        e.preventDefault();
        const found = findBlock(block.id);
        if (!found) return;
        const prev = neighbor(found.column, found.index, -1);
        if (!prev) {
          if (!block.text) return;
          return;
        }
        if (!block.text) {
          deleteBlock(block.id);
          return;
        }
        const joinAt = (prev.block.text || '').length;
        prev.block.text = (prev.block.text || '') + (block.text || '');
        found.column.blocks.splice(found.index, 1);
        render({ id: prev.block.id, offset: joinAt });
        scheduleSave();
      }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const next = (block.indent || 0) + (e.shiftKey ? -1 : 1);
      block.indent = Math.max(0, Math.min(MAX_INDENT, next));
      const row = content.closest('.notion-block');
      if (row) row.style.setProperty('--indent', String(block.indent));
      scheduleSave();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const parts = selectionParts(content);
      const up = e.key === 'ArrowUp';
      if (up && !parts.atStart) return;
      if (!up && !parts.atEnd) return;
      const found = findBlock(block.id);
      if (!found) return;
      const target = neighbor(found.column, found.index, up ? -1 : 1);
      if (!target) return;
      e.preventDefault();
      focusBlock(target.block.id, up ? (target.block.text || '').length : 0);
    }
  }

  function onBlockBeforeInput(e, block) {
    clearColumnOnEmpty = null;
    if (e.isComposing || !e.inputType || !e.inputType.startsWith('delete')) return;
    if (e.inputType === 'deleteCompositionText' || e.inputType === 'deleteByDrag') return;
    if (!blockHasText(block)) return;
    const host = findBlock(block.id);
    if (!host || columnHasOtherText(host.column, block.id)) return;
    clearColumnOnEmpty = { blockId: block.id, column: host.column };
  }

  function finishClearedColumn(column, block) {
    const key = `text:${block.id}`;
    if (!state.columns.includes(column) || !column.blocks.includes(block) || blockHasText(block) || columnHasOtherText(column, block.id)) {
      scheduleSave(key);
      return;
    }
    if (state.columns.length < 2) {
      const collapsed = column.blocks.length > 1;
      column.blocks = [block];
      if (collapsed) render({ id: block.id, offset: 0 });
      scheduleSave(key);
      return;
    }
    render(dropColumnAfterDelete(column));
    scheduleSave(key);
  }

  function onBlockInput(block, content) {
    if (content.querySelector('br, div') && !content.textContent) content.textContent = '';
    block.text = content.textContent || '';
    if (block.text.length > 4000) {
      block.text = block.text.slice(0, 4000);
      content.textContent = block.text;
      focusBlock(block.id, 4000);
    }
    const pending = clearColumnOnEmpty;
    clearColumnOnEmpty = null;
    if (pending && pending.blockId === block.id && !blockHasText(block)) {
      const current = findBlock(block.id);
      if (current && current.column === pending.column && !columnHasOtherText(current.column, block.id)) {
        if (menuEl && menuBlockId === block.id) closeMenu();
        const column = current.column;
        const keep = current.block;
        queueMicrotask(() => finishClearedColumn(column, keep));
        return;
      }
    }
    scheduleSave(`text:${block.id}`);
    if (block.text.trim() === '/') openMenu(content, block, 'slash');
    else if (menuEl && menuBlockId === block.id) closeMenu();
  }

  function onPaste(e, block, content) {
    e.preventDefault();
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (lines.length <= 1) {
      insertPlain(lines[0] || '');
      block.text = content.textContent || '';
      scheduleSave(`text:${block.id}`);
      if (block.text.trim() === '/') openMenu(content, block, 'slash');
      return;
    }
    const parts = selectionParts(content);
    block.text = parts.before + (lines[0] || '');
    let after = lines.slice(1);
    const tail = parts.after;
    if (tail) after[after.length - 1] = (after[after.length - 1] || '') + tail;
    let anchor = block.id;
    let last = block;
    for (const line of after) {
      if (countBlocks() >= MAX_BLOCKS) break;
      const created = insertAfter(anchor, block.type, line, block.indent);
      if (!created) break;
      anchor = created.id;
      last = created;
    }
    render({ id: last.id, offset: (last.text || '').length });
    scheduleSave();
  }

  function insertPlain(text) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function render(focus) {
    clearColumnOnEmpty = null;
    closeMenu();
    hideDrop();
    if (!focus || !focus.keepSelection) {
      selectedIds = new Set();
      selectionAnchorId = null;
    }
    ensureShape();
    rootEl.replaceChildren();

    const sheet = document.createElement('div');
    sheet.className = 'notion-sheet' + (state.columns.length > 1 ? ' is-multi' : '');

    const columnsEl = document.createElement('div');
    columnsEl.className = 'notion-columns';

    state.columns.forEach((column, columnIndex) => {
      const columnEl = document.createElement('div');
      columnEl.className = 'notion-column';
      columnEl.dataset.columnId = column.id;
      const colWidth = columnPixelWidth(column);
      applyColumnWidth(columnEl, colWidth);

      const resize = document.createElement('div');
      resize.className = 'notion-col-resize';
      resize.tabIndex = 0;
      resize.setAttribute('role', 'separator');
      resize.setAttribute('aria-orientation', 'vertical');
      resize.setAttribute('aria-label', 'Cambiar ancho de la columna');
      resize.setAttribute('aria-valuemin', String(MIN_COL_WIDTH));
      resize.setAttribute('aria-valuemax', String(MAX_COL_WIDTH));
      resize.setAttribute('aria-valuenow', String(colWidth));
      bindColumnResize(resize, column, columnEl);
      columnEl.appendChild(resize);

      if (state.columns.length > 1) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'notion-col-remove';
        remove.setAttribute('aria-label', 'Quitar columna');
        remove.dataset.tooltip = 'Quitar columna';
        remove.dataset.tooltipPlacement = 'bottom';
        remove.textContent = '×';
        remove.addEventListener('click', () => removeColumn(column.id));
        columnEl.appendChild(remove);
      }

      column.blocks.forEach((block) => {
        columnEl.appendChild(renderBlock(column, block, columnIndex));
      });
      columnsEl.appendChild(columnEl);
    });

    sheet.appendChild(columnsEl);
    rootEl.appendChild(sheet);
    applySelectionClasses();
    stretchColumns();

    if (focus && focus.id && !focus.skipFocus) {
      const focusId = focus.id;
      const focusOffset = focus.offset;
      requestAnimationFrame(() => {
        focusBlock(focusId, focusOffset);
      });
    }
  }

  function paintTodoCheck(block) {
    const row = rootEl.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`);
    if (!row) return;
    row.classList.toggle('is-done', block.done === true);
    const check = row.querySelector('.notion-check');
    if (!check) return;
    check.setAttribute('aria-pressed', block.done ? 'true' : 'false');
    check.setAttribute('aria-label', block.done ? 'Marcar como pendiente' : 'Marcar como hecha');
  }

  function toggleTodoDone(blockId) {
    const found = findBlock(blockId);
    if (!found || found.block.type !== 'todo') return;
    found.block.done = !found.block.done;
    paintTodoCheck(found.block);
    scheduleSave();
  }

  function renderBlock(column, block, columnIndex) {
    const row = document.createElement('div');
    row.className = 'notion-block' + (block.type === 'todo' && block.done ? ' is-done' : '');
    row.dataset.blockId = block.id;
    row.dataset.columnId = column.id;
    row.style.setProperty('--indent', String(block.indent || 0));

    if (block.type === 'document') {
      row.classList.add('notion-block-document');
      ensureDoc(block, column.id);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'notion-doc-open';
      const icon = document.createElement('span');
      icon.className = 'notion-doc-ico';
      icon.setAttribute('aria-hidden', 'true');
      icon.appendChild(documentIcon());
      const title = document.createElement('span');
      title.className = 'notion-doc-title';
      const label = (block.text || '').trim();
      title.textContent = label || 'Documento sin título';
      if (!label) title.classList.add('is-untitled');
      open.append(icon, title);
      open.setAttribute('aria-label', label ? `Abrir documento ${label}` : 'Abrir documento sin título');
      open.addEventListener('click', (event) => {
        if (swallowClick) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (window.InplaizeDocumentModal) window.InplaizeDocumentModal.open(block.id);
      });
      open.addEventListener('keydown', (event) => onDocKeydown(event, block));
      row.appendChild(open);
      return row;
    }

    if (block.type === 'todo') {
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'notion-check';
      check.setAttribute('aria-pressed', block.done ? 'true' : 'false');
      check.setAttribute('aria-label', block.done ? 'Marcar como pendiente' : 'Marcar como hecha');
      check.appendChild(svgEl('M5 12.5 9.5 17 19 7'));
      check.addEventListener('mousedown', (e) => e.preventDefault());
      check.addEventListener('click', () => {
        if (swallowClick) return;
        toggleTodoDone(block.id);
      });
      row.appendChild(check);
    } else if (block.type === 'bullet') {
      const bullet = document.createElement('span');
      bullet.className = 'notion-bullet';
      bullet.setAttribute('aria-hidden', 'true');
      row.appendChild(bullet);
    }

    const content = document.createElement('div');
    content.className = 'notion-content';
    content.contentEditable = 'true';
    content.spellcheck = true;
    content.setAttribute('role', 'textbox');
    content.setAttribute('aria-label', block.type === 'todo' ? 'Checkbox' : block.type === 'bullet' ? 'Viñeta' : 'Texto');
    const columnEmpty = column.blocks.every((item) => !(item.text || '').trim());
    const hint = columnEmpty && column.blocks[0] === block;
    content.dataset.placeholder = hint && columnIndex === 0
      ? 'Escribí acá. Enter baja de renglón, / elige checkbox, viñeta o documento'
      : 'Escribí…';
    if (hint) content.dataset.hint = '1';
    content.textContent = block.text || '';
    content.addEventListener('keydown', (e) => onBlockKeydown(e, block, content));
    content.addEventListener('beforeinput', (e) => onBlockBeforeInput(e, block));
    content.addEventListener('input', () => onBlockInput(block, content));
    content.addEventListener('paste', (e) => onPaste(e, block, content));
    row.appendChild(content);
    return row;
  }

  document.addEventListener('pointerdown', (e) => {
    const target = e.target instanceof Node ? e.target : null;
    if (selectedIds.size && target && !homeEl.contains(target) && !(target instanceof Element && target.closest('.notion-menu'))) {
      clearBlockSelection();
    }
    if (canvasMenuEl && target && !canvasMenuEl.contains(target) && !canvasOptionsBtn?.contains(target)) {
      closeCanvasMenu();
    }
    if (!menuEl) return;
    if (target && menuEl.contains(target)) return;
    closeMenu();
  }, true);

  document.addEventListener('keydown', (e) => {
    const action = historyShortcut(e);
    if (!action || !historyViewAllowed() || !historyFocusAllowed()) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'undo') undo();
    else redo();
  }, true);

  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedIds.size && !editingText()) {
      if (document.documentElement.classList.contains('doc-modal-open')) return;
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (e.key !== 'Escape') return;
    if (document.documentElement.classList.contains('doc-modal-open')) return;
    if (menuEl || canvasMenuEl) {
      closeMenu();
      closeCanvasMenu();
      return;
    }
    if (selectedIds.size) {
      clearBlockSelection();
      return;
    }
    closeMenu();
    closeCanvasMenu();
  });

  document.addEventListener('pointermove', onBlockGestureMove);
  document.addEventListener('pointerup', onBlockGestureEnd);
  document.addEventListener('pointercancel', onBlockGestureCancel);

  homeEl.addEventListener('scroll', () => {
    closeMenu();
    closeCanvasMenu();
  }, { passive: true });

  if (canvasOptionsBtn) {
    canvasOptionsBtn.addEventListener('mousedown', (e) => e.preventDefault());
    canvasOptionsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (canvasMenuEl) closeCanvasMenu();
      else openCanvasMenu();
    });
  }

  [canvasUndoBtn, canvasRedoBtn].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (btn.getAttribute('aria-disabled') === 'true') return;
      if (btn === canvasUndoBtn) undo();
      else redo();
    });
  });

  loadCanvasTheme();

  homeEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || blockGesture || (press && press.dragging)) return;
    const origin = eventElement(e);
    if (!origin || !homeEl.contains(origin)) return;
    if (origin.closest('.notion-col-resize, .notion-col-remove, .notion-menu')) return;

    const row = origin.closest('.notion-block');
    const onContent = !!origin.closest('.notion-content');
    const onDoc = !!origin.closest('.notion-block-document');
    const onCheck = !!origin.closest('.notion-check');

    if (e.shiftKey && row) {
      e.preventDefault();
      blockGesture = {
        mode: 'pending-select',
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        blockId: row.dataset.blockId,
        shiftKey: true,
        baseIds: new Set(selectedIds),
        fromContent: onContent,
        fromDoc: onDoc,
      };
      try { homeEl.setPointerCapture(e.pointerId); } catch { /* el puntero sintético no siempre deja capturar */ }
      return;
    }

    if (row) {
      const wasSelected = selectedIds.has(row.dataset.blockId);
      if ((wasSelected || onDoc) && !onCheck) e.preventDefault();
      blockGesture = {
        mode: 'pending-move',
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        blockId: row.dataset.blockId,
        onContent: onContent && !onDoc,
        onDoc,
        onCheck,
        wasSelected,
      };
      try { homeEl.setPointerCapture(e.pointerId); } catch { /* el puntero sintético no siempre deja capturar */ }
      return;
    }

    e.preventDefault();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    blockGesture = {
      mode: 'pending-select',
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      blockId: row ? row.dataset.blockId : null,
    };
    try { homeEl.setPointerCapture(e.pointerId); } catch { /* el puntero sintético no siempre deja capturar */ }
  });

  async function loadFromDisk() {
    if (document.documentElement.classList.contains('doc-modal-open')) return;
    const active = document.activeElement;
    const editing = ready
      && active
      && homeEl.contains(active)
      && active.classList.contains('notion-content');
    if (editing) return;

    const api = getApi();
    if (!api || typeof api.getTodos !== 'function') {
      ensureShape();
      render(null);
      seedHistory();
      ready = true;
      return;
    }
    try {
      const payload = await api.getTodos();
      state.title = typeof payload?.title === 'string' ? payload.title : 'Tareas';
      state.columns = Array.isArray(payload?.columns) ? payload.columns : [];
    } catch {
      state.title = 'Tareas';
      state.columns = [];
    }
    ensureShape();
    render(null);
    seedHistory();
    ready = true;
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => stretchColumns()).observe(homeEl);
  }
  window.addEventListener('resize', () => stretchColumns());

  if (window.InplaizeDocumentModal) {
    window.InplaizeDocumentModal.bind({
      getBlock(id) {
        const found = findBlock(id);
        if (!found || found.block.type !== 'document') return null;
        ensureDoc(found.block, found.column.id);
        return found.block;
      },
      apply(id, fields) {
        const found = findBlock(id);
        if (!found || found.block.type !== 'document') return false;
        const doc = ensureDoc(found.block, found.column.id);
        doc.title = String(fields.title || '').replace(/[\r\n]/g, '').slice(0, 200);
        doc.description = String(fields.description || '').replace(/[\r\n]/g, '').slice(0, 500);
        if (fields.content && fields.content.type === 'doc') doc.content = fields.content;
        doc.updatedAt = new Date().toISOString();
        doc.parentId = found.column.id;
        doc.id = found.block.id;
        found.block.text = doc.title;
        found.block.done = false;
        syncDocRow(found.block);
        return true;
      },
      persist() {
        return persistNow();
      },
    });
  }

  document.addEventListener('inplaize-doc-modal', () => {
    if (document.documentElement.classList.contains('doc-modal-open')) return;
    noteChange(null);
  });

  loadFromDisk();

  const api = getApi();
  if (api && typeof api.onTodosChanged === 'function') {
    api.onTodosChanged(() => {
      if (!ready) return;
      if (document.documentElement.classList.contains('doc-modal-open')) return;
      const active = document.activeElement;
      if (active && homeEl.contains(active)) return;
      loadFromDisk();
    });
  }

  window.addEventListener('beforeunload', () => {
    const modal = window.InplaizeDocumentModal;
    if (modal && modal.isOpen()) modal.flush();
    else if (saveTimer) persistNow();
  });
})();

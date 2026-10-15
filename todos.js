'use strict';

/**
 * Página del icono de inplaize.
 * Renglones (texto, checkbox, viñeta), columnas y arrastre.
 * Enter baja a un renglón de texto, también vacío. "/" elige checkbox o viñeta. Tab sangra.
 */

(function () {
  const SAVE_DEBOUNCE_MS = 250;
  const MAX_COLUMNS = 30;
  const MIN_COL_WIDTH = 88;
  const MAX_COL_WIDTH = 4000;
  const DEFAULT_COL_WIDTH = 340;
  const SINGLE_COL_WIDTH = 720;
  const COL_GAP = 20;
  const MAX_COL_POS = 12000;
  const MAX_BLOCKS = 400;
  const MAX_INDENT = 6;
  const TYPES = ['text', 'todo', 'bullet'];

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
  let canvasMenuEl = null;
  const canvasOptionsBtn = document.getElementById('canvas-options-btn');
  const CANVAS_THEME_KEY = 'inplaize.canvasTheme';
  let press = null;
  let dropTarget = null;

  const layerParent = document.getElementById('sidebar') || document.body;
  const dropLine = document.createElement('div');
  dropLine.className = 'notion-drop-line';
  layerParent.appendChild(dropLine);

  function getApi() {
    return (typeof window !== 'undefined' && window.usualDesk) || null;
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function emptyBlock(type) {
    return {
      id: makeId('b'),
      type: TYPES.includes(type) ? type : 'text',
      text: '',
      done: false,
      indent: 0,
    };
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
    }
  }

  function snapshot() {
    return {
      title: state.title,
      columns: state.columns.map((column) => {
        const entry = {
          id: column.id,
          blocks: column.blocks.map((block) => ({
            id: block.id,
            type: block.type,
            text: block.text,
            done: block.done === true,
            indent: block.indent || 0,
          })),
        };
        if (column.width >= MIN_COL_WIDTH) entry.width = clampWidth(column.width);
        if (hasPosition(column)) {
          entry.x = clampPos(column.x);
          entry.y = clampPos(column.y);
        }
        return entry;
      }),
    };
  }

  function scheduleSave() {
    const api = getApi();
    if (!api || typeof api.saveTodos !== 'function') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      api.saveTodos(snapshot()).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    const api = getApi();
    if (!api || typeof api.saveTodos !== 'function') return;
    clearTimeout(saveTimer);
    saveTimer = null;
    api.saveTodos(snapshot()).catch(() => {});
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

  function clampPos(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(MAX_COL_POS, n));
  }

  function hasPosition(column) {
    return Number.isFinite(column.x) && Number.isFinite(column.y);
  }

  function flowPositions() {
    const map = new Map();
    let x = 0;
    for (const column of state.columns) {
      if (hasPosition(column)) {
        map.set(column.id, { x: clampPos(column.x), y: clampPos(column.y) });
      } else {
        map.set(column.id, { x, y: 0 });
        x += columnPixelWidth(column) + COL_GAP;
      }
    }
    return map;
  }

  function applyColumnPosition(el, x, y) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  function materializePositions() {
    rootEl.querySelectorAll('.notion-column').forEach((el) => {
      const column = state.columns.find((item) => item.id === el.dataset.columnId);
      if (!column || hasPosition(column)) return;
      column.x = clampPos(parseFloat(el.style.left) || 0);
      column.y = clampPos(parseFloat(el.style.top) || 0);
    });
  }

  function assignOpenPosition(column) {
    if (!state.columns.some(hasPosition)) return;
    let right = 0;
    for (const other of state.columns) {
      if (!hasPosition(other)) continue;
      right = Math.max(right, other.x + columnPixelWidth(other));
    }
    column.x = clampPos(right + COL_GAP);
    column.y = 0;
  }

  function syncBoardSize() {
    const board = rootEl.querySelector('.notion-columns');
    if (!board) return;
    let width = 48;
    let height = 48;
    board.querySelectorAll('.notion-column, .notion-add-col').forEach((el) => {
      const left = parseFloat(el.style.left) || 0;
      const top = parseFloat(el.style.top) || 0;
      width = Math.max(width, left + el.offsetWidth);
      height = Math.max(height, top + el.offsetHeight);
    });
    board.style.width = `${Math.ceil(width)}px`;
    board.style.height = `${Math.ceil(height)}px`;
  }

  const CARD_GAP = 16;

  function cardOrigin(column, el) {
    return {
      x: hasPosition(column) ? column.x : (parseFloat(el.style.left) || 0),
      y: hasPosition(column) ? column.y : (parseFloat(el.style.top) || 0),
      w: el.offsetWidth,
      h: el.offsetHeight,
    };
  }

  function hitsCard(a, b) {
    const other = { x: b.x - CARD_GAP, y: b.y - CARD_GAP, w: b.w + CARD_GAP * 2, h: b.h + CARD_GAP * 2 };
    return a.x < other.x + other.w && a.x + a.w > other.x && a.y < other.y + other.h && a.y + a.h > other.y;
  }

  function separateColumn(column, el) {
    const others = [];
    rootEl.querySelectorAll('.notion-column').forEach((otherEl) => {
      if (otherEl === el) return;
      const other = state.columns.find((item) => item.id === otherEl.dataset.columnId);
      if (!other) return;
      others.push(cardOrigin(other, otherEl));
    });
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    for (let pass = 0; pass < 24; pass += 1) {
      const box = { x: column.x, y: column.y, w, h };
      const hit = others.find((other) => hitsCard(box, other));
      if (!hit) return;
      const inflated = { x: hit.x - CARD_GAP, y: hit.y - CARD_GAP, w: hit.w + CARD_GAP * 2, h: hit.h + CARD_GAP * 2 };
      const overlapX = Math.min(box.x + box.w, inflated.x + inflated.w) - Math.max(box.x, inflated.x);
      const overlapY = Math.min(box.y + box.h, inflated.y + inflated.h) - Math.max(box.y, inflated.y);
      const dirX = (box.x + w / 2) < (hit.x + hit.w / 2) ? -1 : 1;
      const dirY = (box.y + h / 2) < (hit.y + hit.h / 2) ? -1 : 1;
      if (overlapX <= overlapY) {
        const next = clampPos(column.x + dirX * overlapX);
        if (next !== column.x) column.x = next;
        else column.y = clampPos(column.y + dirY * overlapY);
      } else {
        const next = clampPos(column.y + dirY * overlapY);
        if (next !== column.y) column.y = next;
        else column.x = clampPos(column.x + dirX * overlapX);
      }
    }
  }

  function widthClearOfNeighbors(column, el, desired) {
    const x = hasPosition(column) ? column.x : (parseFloat(el.style.left) || 0);
    const y = hasPosition(column) ? column.y : (parseFloat(el.style.top) || 0);
    const h = el.offsetHeight;
    let max = desired;
    rootEl.querySelectorAll('.notion-column').forEach((otherEl) => {
      if (otherEl === el) return;
      const other = state.columns.find((item) => item.id === otherEl.dataset.columnId);
      if (!other) return;
      const origin = cardOrigin(other, otherEl);
      const sharesRow = y < origin.y + origin.h + CARD_GAP && y + h + CARD_GAP > origin.y;
      if (!sharesRow || origin.x <= x) return;
      const limit = origin.x - CARD_GAP - x;
      if (limit > 0) max = Math.min(max, limit);
    });
    return clampWidth(max);
  }

  function settleOverlaps() {
    let changed = false;
    const els = [...rootEl.querySelectorAll('.notion-column')];
    for (let pass = 0; pass < 20; pass += 1) {
      let any = false;
      for (const el of els) {
        const column = state.columns.find((item) => item.id === el.dataset.columnId);
        if (!column) continue;
        const wasPlaced = hasPosition(column);
        if (!wasPlaced) {
          column.x = parseFloat(el.style.left) || 0;
          column.y = parseFloat(el.style.top) || 0;
        }
        const prevX = column.x;
        const prevY = column.y;
        separateColumn(column, el);
        if (column.x !== prevX || column.y !== prevY) {
          applyColumnPosition(el, column.x, column.y);
          any = true;
          changed = true;
        } else if (!wasPlaced) {
          delete column.x;
          delete column.y;
        }
      }
      if (!any) break;
    }
    if (!changed) return;
    syncBoardSize();
    scheduleSave();
  }

  function bindColumnMove(columnEl, column) {
    columnEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target !== columnEl && !(e.target instanceof Element && e.target.classList.contains('notion-col-move'))) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = parseFloat(columnEl.style.left) || 0;
      const origY = parseFloat(columnEl.style.top) || 0;
      let dragging = false;
      columnEl.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragging) {
          if (Math.hypot(dx, dy) < 4) return;
          dragging = true;
          materializePositions();
          columnEl.classList.add('is-moving');
          document.body.classList.add('notion-col-moving');
        }
        column.x = clampPos(origX + dx);
        column.y = clampPos(origY + dy);
        separateColumn(column, columnEl);
        applyColumnPosition(columnEl, column.x, column.y);
        syncBoardSize();
      };
      const onUp = () => {
        columnEl.removeEventListener('pointermove', onMove);
        columnEl.removeEventListener('pointerup', onUp);
        columnEl.removeEventListener('pointercancel', onUp);
        columnEl.classList.remove('is-moving');
        document.body.classList.remove('notion-col-moving');
        if (!dragging) {
          const last = column.blocks[column.blocks.length - 1];
          if (last) focusBlock(last.id, (last.text || '').length);
          return;
        }
        separateColumn(column, columnEl);
        applyColumnPosition(columnEl, column.x, column.y);
        syncBoardSize();
        scheduleSave();
      };
      columnEl.addEventListener('pointermove', onMove);
      columnEl.addEventListener('pointerup', onUp);
      columnEl.addEventListener('pointercancel', onUp);
    });
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
      column.width = widthClearOfNeighbors(column, columnEl, clampWidth(px));
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
        syncBoardSize();
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        handle.classList.remove('is-active');
        document.body.classList.remove('notion-col-resizing');
        syncBoardSize();
        scheduleSave();
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
      scheduleSave();
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

  function gripIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    for (const [cx, cy] of [[9, 7], [15, 7], [9, 12], [15, 12], [9, 17], [15, 17]]) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(cy));
      dot.setAttribute('r', '1.4');
      svg.appendChild(dot);
    }
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
    const el = rootEl.querySelector(`[data-block-id="${CSS.escape(id)}"] .notion-content`);
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

  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
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
    ];
    for (const item of types) {
      menu.appendChild(menuButton(item.ico, item.label, () => {
        const found = findBlock(block.id);
        if (!found) return;
        const wasSlash = (found.block.text || '').trim() === '/';
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

  function menuButton(ico, label, onClick, danger) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notion-menu-item' + (danger ? ' is-danger' : '');
    btn.setAttribute('role', 'menuitem');
    const mark = document.createElement('span');
    mark.className = 'notion-menu-ico';
    mark.textContent = ico;
    const text = document.createElement('span');
    text.textContent = label;
    btn.append(mark, text);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
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

  function deleteBlock(id) {
    const found = findBlock(id);
    if (!found) return;
    const prev = neighbor(found.column, found.index, -1) || neighbor(found.column, found.index, 1);
    found.column.blocks.splice(found.index, 1);
    if (!found.column.blocks.length) found.column.blocks.push(emptyBlock('text'));
    const target = prev && prev.block.id !== id ? prev.block : found.column.blocks[Math.max(0, found.index - 1)] || found.column.blocks[0];
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
    assignOpenPosition(column);
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

  function moveBlock(blockId, toColumnId, toIndex) {
    const found = findBlock(blockId);
    if (!found) return false;
    const dest = state.columns.find((column) => column.id === toColumnId);
    if (!dest) return false;
    if (found.column.id === dest.id) {
      if (toIndex === found.index || toIndex === found.index + 1) return false;
      const [block] = found.column.blocks.splice(found.index, 1);
      const index = toIndex > found.index ? toIndex - 1 : toIndex;
      dest.blocks.splice(Math.max(0, Math.min(index, dest.blocks.length)), 0, block);
    } else {
      const [block] = found.column.blocks.splice(found.index, 1);
      dest.blocks.splice(Math.max(0, Math.min(toIndex, dest.blocks.length)), 0, block);
      if (!found.column.blocks.length) found.column.blocks.push(emptyBlock('text'));
    }
    return true;
  }

  function moveBlockToNewColumn(blockId) {
    if (state.columns.length >= MAX_COLUMNS) return false;
    const found = findBlock(blockId);
    if (!found) return false;
    const [block] = found.column.blocks.splice(found.index, 1);
    if (!found.column.blocks.length) found.column.blocks.push(emptyBlock('text'));
    const column = { id: makeId('c'), blocks: [block] };
    assignOpenPosition(column);
    state.columns.push(column);
    return true;
  }

  function hideDrop() {
    dropTarget = null;
    dropLine.classList.remove('is-on');
    rootEl.querySelector('.notion-add-col')?.classList.remove('is-drop-target');
  }

  function hitTest(x, y) {
    const add = rootEl.querySelector('.notion-add-col');
    if (add && state.columns.length < MAX_COLUMNS) {
      const rect = add.getBoundingClientRect();
      if (x >= rect.left - 16 && x <= rect.right + 20 && y >= rect.top - 8 && y <= rect.bottom + 8) {
        return { kind: 'new-column' };
      }
    }
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
      if (y < rect.top + rect.height / 2) {
        return { kind: 'insert', columnId, index: i, top: rect.top, left: rect.left, width: rect.width };
      }
    }
    const last = rows[rows.length - 1].getBoundingClientRect();
    return { kind: 'insert', columnId, index: rows.length, top: last.bottom, left: last.left, width: last.width };
  }

  function showDrop(target) {
    dropTarget = target;
    const add = rootEl.querySelector('.notion-add-col');
    add?.classList.toggle('is-drop-target', target?.kind === 'new-column');
    if (!target || target.kind !== 'insert') {
      dropLine.classList.remove('is-on');
      return;
    }
    dropLine.classList.add('is-on');
    dropLine.style.top = `${target.top - 1}px`;
    dropLine.style.left = `${target.left}px`;
    dropLine.style.width = `${Math.max(40, target.width)}px`;
  }

  function autoScroll(y) {
    const rect = homeEl.getBoundingClientRect();
    if (y < rect.top + 36) homeEl.scrollTop -= 14;
    else if (y > rect.bottom - 36) homeEl.scrollTop += 14;
  }

  function finishDrag() {
    const draggingId = press && press.blockId;
    const target = dropTarget;
    const moved = press && press.dragging;
    press = null;
    hideDrop();
    document.body.classList.remove('notion-dragging');
    rootEl.querySelector('.notion-sheet')?.classList.remove('is-dragging');
    if (!moved || !draggingId || !target) return;
    let changed = false;
    if (target.kind === 'new-column') changed = moveBlockToNewColumn(draggingId);
    else changed = moveBlock(draggingId, target.columnId, target.index);
    if (!changed) {
      const row = rootEl.querySelector(`[data-block-id="${CSS.escape(draggingId)}"]`);
      row?.classList.remove('is-dragging');
      return;
    }
    render({ id: draggingId, offset: null });
    scheduleSave();
  }

  function bindHandle(handle, block) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      press = {
        blockId: block.id,
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dragging: false,
      };
      try { handle.setPointerCapture(e.pointerId); } catch { /* el puntero sintético no siempre deja capturar */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (!press || press.pointerId !== e.pointerId || press.blockId !== block.id) return;
      if (!press.dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) {
        press.dragging = true;
        document.body.classList.add('notion-dragging');
        rootEl.querySelector('.notion-sheet')?.classList.add('is-dragging');
        rootEl.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`)?.classList.add('is-dragging');
      }
      if (!press.dragging) return;
      autoScroll(e.clientY);
      showDrop(hitTest(e.clientX, e.clientY));
    });
    handle.addEventListener('pointerup', (e) => {
      if (!press || press.pointerId !== e.pointerId || press.blockId !== block.id) return;
      const wasDrag = press.dragging;
      if (wasDrag) finishDrag();
      else openMenu(handle, block, 'type');
    });
    handle.addEventListener('pointercancel', () => {
      if (!press || press.blockId !== block.id) return;
      press = null;
      hideDrop();
      document.body.classList.remove('notion-dragging');
      rootEl.querySelector('.notion-sheet')?.classList.remove('is-dragging');
    });
  }

  function onBlockKeydown(e, block, content) {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      closeMenu();
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
      // Un renglón vacío con checkbox o viñeta pasa a texto: Enter no obliga a
      // otro ítem. Si ya es texto, el renglón de abajo queda en blanco.
      if (!parts.before && !parts.after && block.type !== 'text') {
        block.type = 'text';
        block.done = false;
        block.indent = 0;
        render({ id: block.id, offset: 0 });
        scheduleSave();
        return;
      }
      block.text = parts.before;
      const created = insertAfter(block.id, 'text', parts.after, parts.after ? block.indent : 0);
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

  function onBlockInput(block, content) {
    if (content.querySelector('br, div') && !content.textContent) content.textContent = '';
    block.text = content.textContent || '';
    if (block.text.length > 4000) {
      block.text = block.text.slice(0, 4000);
      content.textContent = block.text;
      focusBlock(block.id, 4000);
    }
    scheduleSave();
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
      scheduleSave();
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
    closeMenu();
    hideDrop();
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

      const positions = flowPositions();
      const pos = positions.get(column.id) || { x: 0, y: 0 };
      applyColumnPosition(columnEl, pos.x, pos.y);
      bindColumnMove(columnEl, column);

      const move = document.createElement('div');
      move.className = 'notion-col-move';
      move.setAttribute('aria-hidden', 'true');
      columnEl.appendChild(move);

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

    const slot = document.getElementById('canvas-add-slot');
    if (slot) slot.replaceChildren();
    if (slot && state.columns.length < MAX_COLUMNS) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'notion-add-col';
      add.setAttribute('data-mouse-hit', '');
      add.setAttribute('aria-label', 'Agregar columna');
      add.dataset.tooltip = 'Agregar columna';
      add.dataset.tooltipPlacement = 'right';
      add.appendChild(svgEl('M12 5v14M5 12h14'));
      add.addEventListener('click', () => addColumn());
      slot.appendChild(add);
    }

    sheet.appendChild(columnsEl);
    rootEl.appendChild(sheet);
    syncBoardSize();
    settleOverlaps();

    if (focus && focus.id) {
      requestAnimationFrame(() => focusBlock(focus.id, focus.offset));
    }
  }

  function renderBlock(column, block, columnIndex) {
    const row = document.createElement('div');
    row.className = 'notion-block' + (block.type === 'todo' && block.done ? ' is-done' : '');
    row.dataset.blockId = block.id;
    row.dataset.columnId = column.id;
    row.style.setProperty('--indent', String(block.indent || 0));

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'notion-handle';
    handle.setAttribute('aria-label', 'Mover o cambiar tipo');
    handle.dataset.tooltip = 'Arrastrá para mover. Clic para el tipo';
    handle.dataset.tooltipPlacement = 'left';
    handle.appendChild(gripIcon());
    bindHandle(handle, block);
    row.appendChild(handle);

    if (block.type === 'todo') {
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'notion-check';
      check.setAttribute('aria-pressed', block.done ? 'true' : 'false');
      check.setAttribute('aria-label', block.done ? 'Marcar como pendiente' : 'Marcar como hecha');
      check.appendChild(svgEl('M5 12.5 9.5 17 19 7'));
      check.addEventListener('mousedown', (e) => e.preventDefault());
      check.addEventListener('click', () => {
        block.done = !block.done;
        row.classList.toggle('is-done', block.done);
        check.setAttribute('aria-pressed', block.done ? 'true' : 'false');
        check.setAttribute('aria-label', block.done ? 'Marcar como pendiente' : 'Marcar como hecha');
        scheduleSave();
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
      ? 'Escribí acá. Enter baja de renglón, / elige checkbox o viñeta'
      : 'Escribí…';
    if (hint) content.dataset.hint = '1';
    content.textContent = block.text || '';
    content.addEventListener('keydown', (e) => onBlockKeydown(e, block, content));
    content.addEventListener('input', () => onBlockInput(block, content));
    content.addEventListener('paste', (e) => onPaste(e, block, content));
    row.appendChild(content);
    return row;
  }

  document.addEventListener('pointerdown', (e) => {
    const target = e.target instanceof Node ? e.target : null;
    if (canvasMenuEl && target && !canvasMenuEl.contains(target) && !canvasOptionsBtn?.contains(target)) {
      closeCanvasMenu();
    }
    if (!menuEl) return;
    if (target && menuEl.contains(target)) return;
    closeMenu();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      closeCanvasMenu();
    }
  });

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

  loadCanvasTheme();

  const captureEl = document.getElementById('quick-capture-text');
  const captureStatusEl = document.getElementById('quick-capture-status');
  let committingCapture = false;
  let captureCommitWhenReady = false;

  function syncCaptureEmpty() {
    if (!captureEl) return;
    const empty = !cleanCapture(captureEl.textContent);
    captureEl.classList.toggle('is-empty', empty);
    if (empty && captureEl.childNodes.length) captureEl.textContent = '';
  }

  function cleanCapture(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  }

  function setCaptureStatus(message) {
    if (!captureStatusEl) return;
    captureStatusEl.textContent = message || '';
    captureStatusEl.classList.toggle('is-on', !!message);
  }

  function todosSurfaceOpen() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !sidebar.classList.contains('open')) return false;
    const panel = document.getElementById('dock-home-panel');
    if (!panel || panel.getAttribute('data-home-view') !== 'todos') return false;
    if (getComputedStyle(panel).display === 'none') return false;
    if (document.documentElement.classList.contains('onboarding-active')) return false;
    const settings = document.getElementById('settings-modal-overlay');
    const shortcutModal = document.getElementById('modal-overlay');
    if (settings && !settings.classList.contains('hidden')) return false;
    if (shortcutModal && !shortcutModal.classList.contains('hidden')) return false;
    if (document.querySelector('.dock-home-menu-drawer.is-open')) return false;
    return true;
  }

  function isCaptureHint(el) {
    return !!(el
      && el.nodeType === 1
      && el.classList.contains('notion-content')
      && el.dataset.hint === '1'
      && !cleanCapture(el.textContent));
  }

  function foreignField(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    if (!captureEl || el === captureEl || captureEl.contains(el)) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return true;
    if (el.closest && el.closest('button, a, [role="menu"], .notion-menu')) return true;
    return false;
  }

  function focusCaptureEnd() {
    if (!captureEl) return;
    captureEl.focus({ preventScroll: true });
    const textNode = firstTextNode(captureEl);
    const range = document.createRange();
    if (!textNode) {
      range.selectNodeContents(captureEl);
      range.collapse(false);
    } else {
      range.setStart(textNode, textNode.textContent.length);
      range.collapse(true);
    }
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function focusCaptureIfIdle() {
    if (!captureEl || !todosSurfaceOpen()) return;
    if (foreignField(document.activeElement)) return;
    focusCaptureEnd();
  }

  function placeCapturedNote(text) {
    ensureShape();
    const column = state.columns[0];
    const block = emptyBlock('todo');
    block.text = text;
    const allEmpty = column.blocks.every((item) => !(item.text || '').trim());
    if (!allEmpty && countBlocks() >= MAX_BLOCKS) return null;
    if (allEmpty) column.blocks = [block];
    else column.blocks.unshift(block);
    return block.id;
  }

  function commitCapture(opts) {
    if (!captureEl || committingCapture) return;
    const text = cleanCapture(captureEl.textContent);
    if (!text) return;
    if (!ready) {
      captureCommitWhenReady = true;
      return;
    }
    const id = placeCapturedNote(text);
    if (!id) {
      setCaptureStatus('La lista está llena');
      return;
    }
    committingCapture = true;
    captureEl.textContent = '';
    syncCaptureEmpty();
    setCaptureStatus('Guardado');
    flushSave();
    render(null);
    const row = rootEl.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
    if (row) {
      row.classList.add('is-just-captured');
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    committingCapture = false;
    if (!opts || opts.refocus !== false) focusCaptureEnd();
  }

  function insertIntoCapture(ch) {
    if (!captureEl) return;
    const next = ((captureEl.textContent || '') + ch).slice(0, 4000);
    captureEl.textContent = next;
    syncCaptureEmpty();
    setCaptureStatus('');
    focusCaptureEnd();
  }

  function settleCaptureAfterLoad() {
    if (captureCommitWhenReady) {
      captureCommitWhenReady = false;
      commitCapture({ refocus: false });
    }
    requestAnimationFrame(() => focusCaptureIfIdle());
  }

  function releaseCaptureFocus() {
    if (captureEl && document.activeElement === captureEl) captureEl.blur();
  }

  if (captureEl) {
    captureEl.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commitCapture({ refocus: true });
        return;
      }
      if (e.key === 'Escape') {
        if (menuEl) return;
        e.preventDefault();
        captureEl.textContent = '';
        syncCaptureEmpty();
        setCaptureStatus('');
      }
    });

    captureEl.addEventListener('input', () => {
      const text = captureEl.textContent || '';
      if (text.length > 4000) {
        captureEl.textContent = text.slice(0, 4000);
        focusCaptureEnd();
      }
      syncCaptureEmpty();
      if ((captureEl.textContent || '').trim()) setCaptureStatus('');
    });

    captureEl.addEventListener('focus', () => {
      requestAnimationFrame(() => syncCaptureEmpty());
    });

    captureEl.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/\s+/g, ' ');
      if (!text) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !captureEl.contains(sel.anchorNode)) {
        insertIntoCapture(text);
        return;
      }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      if ((captureEl.textContent || '').length > 4000) {
        captureEl.textContent = captureEl.textContent.slice(0, 4000);
        focusCaptureEnd();
      }
      syncCaptureEmpty();
      setCaptureStatus('');
    });

    document.addEventListener('keydown', (e) => {
      if (e.isComposing || !todosSurfaceOpen()) return;
      const active = document.activeElement;
      const inCapture = e.target === captureEl || captureEl.contains(e.target) || active === captureEl;
      if (inCapture) return;
      const hint = isCaptureHint(active) || isCaptureHint(e.target);
      if (!hint && (foreignField(active) || foreignField(e.target))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Dead' || e.key === 'Process') {
        focusCaptureEnd();
        return;
      }
      if (e.key.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      insertIntoCapture(e.key);
    }, true);

    homeEl.addEventListener('pointerdown', (e) => {
      const origin = e.target instanceof Element ? e.target : e.target && e.target.parentElement;
      if (origin && origin.closest('.notion-block, button, a, .notion-menu, .notion-col-resize, .notion-column')) return;
      requestAnimationFrame(() => focusCaptureIfIdle());
    });

    const homePanel = document.getElementById('dock-home-panel');
    if (homePanel) {
      new MutationObserver(() => {
        if (homePanel.getAttribute('data-home-view') === 'todos') return;
        commitCapture({ refocus: false });
        releaseCaptureFocus();
      }).observe(homePanel, { attributes: true, attributeFilter: ['data-home-view'] });
    }

    const captureApi = getApi();
    if (captureApi && typeof captureApi.onSidebarState === 'function') {
      captureApi.onSidebarState((expanded) => {
        if (!expanded) {
          commitCapture({ refocus: false });
          releaseCaptureFocus();
          return;
        }
        requestAnimationFrame(() => {
          if (captureEl && !cleanCapture(captureEl.textContent)) setCaptureStatus('');
          focusCaptureIfIdle();
        });
      });
    }
  }

  async function loadFromDisk() {
    const active = document.activeElement;
    const editing = ready
      && active
      && homeEl.contains(active)
      && active.classList.contains('notion-content');
    if (editing) return;

    const api = getApi();
    if (!api || typeof api.getTodos !== 'function') {
      ensureShape();
      ready = true;
      render(null);
      settleCaptureAfterLoad();
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
    ready = true;
    render(null);
    settleCaptureAfterLoad();
  }

  loadFromDisk();

  const api = getApi();
  if (api && typeof api.onTodosChanged === 'function') {
    api.onTodosChanged(() => {
      if (!ready) return;
      const active = document.activeElement;
      if (active && homeEl.contains(active)) return;
      loadFromDisk();
    });
  }

  window.addEventListener('beforeunload', () => {
    commitCapture({ refocus: false });
    if (saveTimer) flushSave();
  });
})();

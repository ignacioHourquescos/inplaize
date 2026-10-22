'use strict';

/**
 * Modal de edición de un documento del lienzo.
 * No cambia de ruta: se superpone al dock y devuelve el foco al renglón.
 */

(function () {
  const TITLE_MAX = 200;
  const DESCRIPTION_MAX = 500;
  const SAVE_DELAY = 700;

  const overlay = document.createElement('div');
  overlay.className = 'doc-modal-overlay';
  overlay.setAttribute('data-mouse-hit', '');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = true;

  const card = document.createElement('div');
  card.className = 'doc-modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'Documento sin título');

  const bar = document.createElement('div');
  bar.className = 'doc-modal-bar';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'doc-modal-close';
  closeBtn.setAttribute('aria-label', 'Cerrar');
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Cerrar</span>';

  const statusEl = document.createElement('p');
  statusEl.className = 'doc-modal-status is-saved';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.textContent = 'Guardado';

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'doc-modal-retry';
  retryBtn.textContent = 'Reintentar';
  retryBtn.hidden = true;

  const noteEl = document.createElement('p');
  noteEl.className = 'doc-modal-note';
  noteEl.hidden = true;

  const statusWrap = document.createElement('div');
  statusWrap.className = 'doc-modal-status-wrap';
  statusWrap.append(statusEl, retryBtn, noteEl);

  bar.append(closeBtn, statusWrap);

  const scrollEl = document.createElement('div');
  scrollEl.className = 'doc-modal-scroll';

  const pageEl = document.createElement('div');
  pageEl.className = 'doc-modal-page';

  const titleEl = document.createElement('div');
  titleEl.className = 'doc-modal-title is-empty';
  titleEl.contentEditable = 'true';
  titleEl.spellcheck = true;
  titleEl.setAttribute('role', 'textbox');
  titleEl.setAttribute('aria-label', 'Título');
  titleEl.setAttribute('aria-multiline', 'false');
  titleEl.dataset.placeholder = 'Documento sin título';

  const descriptionEl = document.createElement('div');
  descriptionEl.className = 'doc-modal-description is-empty';
  descriptionEl.contentEditable = 'true';
  descriptionEl.spellcheck = true;
  descriptionEl.setAttribute('role', 'textbox');
  descriptionEl.setAttribute('aria-label', 'Descripción');
  descriptionEl.setAttribute('aria-multiline', 'false');
  descriptionEl.dataset.placeholder = 'Agregá una descripción...';

  const editorHost = document.createElement('div');
  editorHost.className = 'doc-editor';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
  fileInput.className = 'doc-file-input';
  fileInput.tabIndex = -1;
  fileInput.setAttribute('aria-hidden', 'true');

  pageEl.append(titleEl, descriptionEl, editorHost);
  scrollEl.appendChild(pageEl);
  card.append(bar, scrollEl);
  overlay.append(card, fileInput);
  document.body.appendChild(overlay);

  let hooks = null;
  let editorApi = null;
  let currentId = null;
  let contentFallback = emptyContent();
  let hydrating = false;
  let rev = 0;
  let savedRev = 0;
  let failed = false;
  let timer = null;
  let noteTimer = null;
  let hideTimer = null;
  let generation = 0;
  let closing = false;
  let pickToken = 0;

  function emptyContent() {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }

  function bodyBlank(content) {
    if (!content || content.type !== 'doc' || !Array.isArray(content.content) || !content.content.length) return true;
    return content.content.every((node) => !node || (node.type === 'paragraph' && !(node.content && node.content.length)));
  }

  function cleanField(value, max) {
    let text = String(value || '').replace(/[\r\n]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (text.length > max) text = text.slice(0, max);
    return text;
  }

  function placeCaretEnd(el) {
    const node = el.firstChild;
    const range = document.createRange();
    if (!node) {
      range.setStart(el, 0);
      range.collapse(true);
    } else {
      range.setStart(node, node.textContent.length);
      range.collapse(true);
    }
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
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

  function readField(el, max) {
    return cleanField(el.textContent || '', max);
  }

  function writeField(el, value) {
    const text = value || '';
    el.textContent = text;
    el.classList.toggle('is-empty', !text);
  }

  function publishField(el, max, assign) {
    if (el.dataset.composing === '1') return;
    const text = readField(el, max);
    const messy = !!el.querySelector('*') || (el.textContent || '') !== text;
    if (messy) {
      el.textContent = text;
      placeCaretEnd(el);
    }
    if (!text && el.childNodes.length) el.textContent = '';
    el.classList.toggle('is-empty', !text);
    assign(text);
    if (!hydrating) {
      card.setAttribute('aria-label', readField(titleEl, TITLE_MAX).trim() || 'Documento sin título');
      markDirty();
    }
  }

  function bindField(el, max, assign, onEnter) {
    el.addEventListener('compositionstart', () => {
      el.dataset.composing = '1';
    });
    el.addEventListener('compositionend', () => {
      delete el.dataset.composing;
      publishField(el, max, assign);
    });
    el.addEventListener('input', () => publishField(el, max, assign));
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onEnter();
      }
    });
    el.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = ((event.clipboardData && event.clipboardData.getData('text/plain')) || '').replace(/\s+/g, ' ');
      if (!text) return;
      insertPlain(text);
      publishField(el, max, assign);
    });
  }

  let titleValue = '';
  let descriptionValue = '';
  bindField(titleEl, TITLE_MAX, (value) => { titleValue = value; }, () => focusEditor('start'));
  bindField(descriptionEl, DESCRIPTION_MAX, (value) => { descriptionValue = value; }, () => focusEditor('start'));

  function setStatus(kind) {
    statusEl.classList.remove('is-saving', 'is-saved', 'is-error');
    if (kind === 'saving') {
      statusEl.textContent = 'Guardando...';
      statusEl.classList.add('is-saving');
      retryBtn.hidden = true;
    } else if (kind === 'error') {
      statusEl.textContent = 'No se pudo guardar';
      statusEl.classList.add('is-error');
      retryBtn.hidden = false;
    } else {
      statusEl.textContent = 'Guardado';
      statusEl.classList.add('is-saved');
      retryBtn.hidden = true;
    }
  }

  function notify(message) {
    clearTimeout(noteTimer);
    if (!message) {
      noteEl.hidden = true;
      noteEl.textContent = '';
      return;
    }
    noteEl.hidden = false;
    noteEl.textContent = message;
    noteTimer = setTimeout(() => {
      noteEl.hidden = true;
      noteEl.textContent = '';
    }, 4200);
  }

  function applyNow() {
    if (!hooks || !currentId) return false;
    const content = editorApi ? editorApi.getJSON() : contentFallback;
    contentFallback = content;
    return hooks.apply(currentId, {
      title: readField(titleEl, TITLE_MAX),
      description: readField(descriptionEl, DESCRIPTION_MAX),
      content,
    }) !== false;
  }

  function markDirty() {
    if (hydrating || !overlay.classList.contains('is-open')) return;
    rev += 1;
    failed = false;
    applyNow();
    setStatus('saving');
    clearTimeout(timer);
    timer = setTimeout(() => { flush(); }, SAVE_DELAY);
  }

  async function flush() {
    if (!hooks || !currentId) return true;
    clearTimeout(timer);
    timer = null;
    if (!applyNow()) return true;
    if (rev === savedRev && !failed) {
      setStatus('saved');
      return true;
    }
    const target = rev;
    setStatus('saving');
    let ok = false;
    try {
      ok = await hooks.persist();
    } catch {
      ok = false;
    }
    if (!ok) {
      failed = true;
      setStatus('error');
      return false;
    }
    if (rev !== target) return flush();
    savedRev = target;
    failed = false;
    setStatus('saved');
    return true;
  }

  function focusEditor(where) {
    if (editorApi) editorApi.focus(where || 'end');
  }

  function focusInitial(block) {
    const title = (block.doc && block.doc.title) || '';
    const blank = bodyBlank(block.doc && block.doc.content);
    requestAnimationFrame(() => {
      if (!String(title).trim() && blank) titleEl.focus();
      else focusEditor('end');
    });
  }

  function teardownEditor() {
    if (!editorApi) return;
    const current = editorApi;
    editorApi = null;
    current.destroy();
  }

  function stubEditor(message) {
    editorHost.textContent = message;
    return {
      getJSON() { return contentFallback; },
      focus() {},
      destroy() { editorHost.textContent = ''; },
    };
  }

  function mountEditor(block) {
    teardownEditor();
    editorHost.textContent = '';
    contentFallback = (block.doc && block.doc.content) || emptyContent();
    const api = window.InplaizeDocs;
    if (!api || typeof api.mount !== 'function') {
      editorApi = stubEditor('No se pudo cargar el editor.');
      return;
    }
    try {
      editorApi = api.mount(editorHost, {
        content: contentFallback,
        portal: overlay,
        onChange(json) {
          contentFallback = json;
          markDirty();
        },
        onNotice: notify,
        readImage,
      });
    } catch {
      editorApi = stubEditor('No se pudo cargar el editor.');
    }
  }

  function show(block) {
    generation += 1;
    clearTimeout(hideTimer);
    hydrating = true;
    titleValue = (block.doc && block.doc.title) || '';
    descriptionValue = (block.doc && block.doc.description) || '';
    writeField(titleEl, titleValue);
    writeField(descriptionEl, descriptionValue);
    card.setAttribute('aria-label', titleValue.trim() || 'Documento sin título');
    notify('');
    mountEditor(block);
    rev = 0;
    savedRev = 0;
    failed = false;
    closing = false;
    setStatus('saved');
    hydrating = false;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.inert = false;
    document.documentElement.classList.add('doc-modal-open');
    document.dispatchEvent(new CustomEvent('inplaize-doc-modal'));
    focusInitial(block);
  }

  function restoreFocus(id) {
    if (!id) return;
    const button = document.querySelector(`[data-block-id="${CSS.escape(id)}"] .notion-doc-open`);
    if (button) button.focus();
  }

  function hide() {
    const token = generation;
    const id = currentId;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.inert = true;
    document.documentElement.classList.remove('doc-modal-open');
    document.dispatchEvent(new CustomEvent('inplaize-doc-modal'));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (token !== generation) return;
      teardownEditor();
      editorHost.textContent = '';
      restoreFocus(id);
      closing = false;
    }, 200);
  }

  async function requestClose() {
    if (!overlay.classList.contains('is-open') || closing) return;
    closing = true;
    const ok = await flush();
    if (!ok) {
      closing = false;
      return;
    }
    hide();
  }

  async function open(id) {
    if (!hooks || !id) return;
    if (currentId === id && overlay.classList.contains('is-open')) {
      const block = hooks.getBlock(id);
      if (block) focusInitial(block);
      return;
    }
    if (overlay.classList.contains('is-open')) {
      const ok = await flush();
      if (!ok) return;
      teardownEditor();
    }
    const block = hooks.getBlock(id);
    if (!block) return;
    currentId = id;
    show(block);
  }

  function isShown(el) {
    if (!el || el.hidden || el.closest('[hidden]')) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function focusable() {
    return [...overlay.querySelectorAll('button, [href], input, textarea, [contenteditable="true"]')].filter(isShown);
  }

  function trapTab(event) {
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !overlay.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image'));
      image.src = src;
    });
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read'));
      reader.readAsDataURL(file);
    });
  }

  async function compressImage(file) {
    if (!file || !/^image\/(png|jpeg|gif|webp)$/i.test(file.type) && !/^image\/jpg$/i.test(file.type)) {
      return { error: 'Ese archivo no es una imagen compatible.' };
    }
    if (file.type === 'image/gif' && file.size > 0 && file.size <= 800000) {
      const src = await readFile(file);
      if (!src.startsWith('data:image/gif') || src.length > 1200000) {
        return { error: 'La imagen es demasiado pesada.' };
      }
      return { src };
    }
    const blobUrl = URL.createObjectURL(file);
    try {
      const image = await loadImage(blobUrl);
      let scale = Math.min(1, 1600 / Math.max(image.width || 1, image.height || 1));
      let quality = 0.82;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) break;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        const src = canvas.toDataURL('image/jpeg', quality);
        if (src.length <= 1200000) return { src };
        quality = Math.max(0.5, quality - 0.12);
        scale *= 0.75;
      }
      return { error: 'La imagen es demasiado pesada.' };
    } catch {
      return { error: 'No se pudo leer la imagen.' };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  function pickFile() {
    const token = ++pickToken;
    const api = window.usualDesk;
    if (api && typeof api.holdDockBlur === 'function') api.holdDockBlur(60000);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (file) => {
        if (settled || token !== pickToken) return;
        settled = true;
        fileInput.removeEventListener('change', onChange);
        fileInput.removeEventListener('cancel', onCancel);
        clearTimeout(timeout);
        fileInput.value = '';
        resolve(file || null);
      };
      const onChange = () => finish(fileInput.files && fileInput.files[0]);
      const onCancel = () => finish(null);
      const timeout = setTimeout(() => finish(null), 90000);
      fileInput.addEventListener('change', onChange);
      fileInput.addEventListener('cancel', onCancel);
      fileInput.click();
    });
  }

  async function readImage(file) {
    try {
      const chosen = file || await pickFile();
      if (!chosen) return null;
      return await compressImage(chosen);
    } catch {
      return { error: 'No se pudo leer la imagen.' };
    }
  }

  closeBtn.addEventListener('click', () => { requestClose(); });
  retryBtn.addEventListener('click', () => { flush(); });
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target !== overlay) return;
    requestClose();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      trapTab(event);
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  });
  scrollEl.addEventListener('pointerdown', (event) => {
    if (event.target !== scrollEl && event.target !== pageEl) return;
    focusEditor('end');
  });

  window.InplaizeDocumentModal = {
    bind(api) { hooks = api; },
    open,
    isOpen() { return overlay.classList.contains('is-open'); },
    flush,
  };
})();

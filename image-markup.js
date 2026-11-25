'use strict';

/**
 * Clic en una imagen: se abre para dibujar encima con un marcador rojo.
 * Listo devuelve un data URL; Cancelar no cambia la foto.
 */
(function () {
  const MARKER = '#ff2b2b';
  const MAX_EDGE = 1600;
  const MAX_URL = 1050000;
  let openEl = null;

  function close() {
    if (!openEl) return;
    const onKey = openEl._onKey;
    openEl.remove();
    openEl = null;
    if (onKey) document.removeEventListener('keydown', onKey, true);
  }

  function encode(base, ink, source) {
    const out = document.createElement('canvas');
    out.width = base.width;
    out.height = base.height;
    const ctx = out.getContext('2d');
    const png = /^data:image\/png/i.test(source);
    if (!png) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.drawImage(base, 0, 0);
    ctx.drawImage(ink, 0, 0);
    if (png) {
      const asPng = out.toDataURL('image/png');
      if (asPng.length <= MAX_URL) return asPng;
    }
    let quality = 0.92;
    let url = out.toDataURL('image/jpeg', quality);
    while (url.length > MAX_URL && quality > 0.45) {
      quality -= 0.08;
      url = out.toDataURL('image/jpeg', quality);
    }
    return url.length <= MAX_URL ? url : '';
  }

  function open(src, onSave) {
    const source = typeof src === 'string' ? src : '';
    if (!source || typeof onSave !== 'function') return;
    close();

    const overlay = document.createElement('div');
    overlay.className = 'image-markup';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Dibujar sobre la imagen');

    const bar = document.createElement('div');
    bar.className = 'image-markup-bar';
    const title = document.createElement('p');
    title.className = 'image-markup-title';
    title.textContent = 'Dibujá encima con el marcador';
    const actions = document.createElement('div');
    actions.className = 'image-markup-actions';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'image-markup-btn';
    clearBtn.textContent = 'Borrar';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'image-markup-btn';
    cancelBtn.textContent = 'Cancelar';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'image-markup-btn is-primary';
    saveBtn.textContent = 'Listo';
    actions.append(clearBtn, cancelBtn, saveBtn);
    bar.append(title, actions);

    const stage = document.createElement('div');
    stage.className = 'image-markup-stage';
    const stack = document.createElement('div');
    stack.className = 'image-markup-stack';
    const base = document.createElement('canvas');
    base.className = 'image-markup-base';
    const ink = document.createElement('canvas');
    ink.className = 'image-markup-ink';
    stack.append(base, ink);
    stage.appendChild(stack);
    overlay.append(bar, stage);
    document.body.appendChild(overlay);
    openEl = overlay;

    let dirty = false;
    let drawing = false;
    let last = null;
    const inkCtx = ink.getContext('2d');

    function finish(save) {
      if (save && dirty) {
        let url = '';
        try {
          url = encode(base, ink, source);
        } catch {
          url = '';
        }
        if (url) onSave(url);
      }
      close();
    }

    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    overlay._onKey = onKey;
    document.addEventListener('keydown', onKey, true);

    cancelBtn.addEventListener('click', () => finish(false));
    saveBtn.addEventListener('click', () => finish(true));
    clearBtn.addEventListener('click', () => {
      inkCtx.clearRect(0, 0, ink.width, ink.height);
      dirty = false;
    });
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay || event.target === stage) finish(false);
    });

    function point(event) {
      const rect = ink.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {
        x: ((event.clientX - rect.left) / rect.width) * ink.width,
        y: ((event.clientY - rect.top) / rect.height) * ink.height,
      };
    }

    function stroke(from, to) {
      const width = Math.max(4, Math.round(Math.min(ink.width, ink.height) / 140));
      inkCtx.strokeStyle = MARKER;
      inkCtx.lineWidth = width;
      inkCtx.lineCap = 'round';
      inkCtx.lineJoin = 'round';
      inkCtx.globalAlpha = 0.9;
      inkCtx.beginPath();
      inkCtx.moveTo(from.x, from.y);
      inkCtx.lineTo(to.x, to.y);
      inkCtx.stroke();
      dirty = true;
    }

    ink.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const at = point(event);
      if (!at) return;
      drawing = true;
      last = at;
      try { ink.setPointerCapture(event.pointerId); } catch { /* noop */ }
      stroke(at, { x: at.x + 0.01, y: at.y + 0.01 });
    });
    ink.addEventListener('pointermove', (event) => {
      if (!drawing) return;
      const at = point(event);
      if (!at || !last) return;
      stroke(last, at);
      last = at;
    });
    const endDraw = () => {
      drawing = false;
      last = null;
    };
    ink.addEventListener('pointerup', endDraw);
    ink.addEventListener('pointercancel', endDraw);

    const image = new Image();
    image.onload = () => {
      if (openEl !== overlay) return;
      const edge = Math.max(image.naturalWidth || 1, image.naturalHeight || 1);
      const scale = edge > MAX_EDGE ? MAX_EDGE / edge : 1;
      const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
      const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
      base.width = width;
      base.height = height;
      ink.width = width;
      ink.height = height;
      const ctx = base.getContext('2d');
      ctx.drawImage(image, 0, 0, width, height);
      stack.style.aspectRatio = `${width} / ${height}`;
    };
    image.onerror = () => finish(false);
    image.src = source;
  }

  window.InplaizeImageMarkup = { open, close };
})();

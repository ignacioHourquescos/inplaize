'use strict';

/**
 * Cajón mágico (UI del dock).
 *
 * Dock flotante en la parte inferior de la grilla de descargas. Al soltar un
 * archivo sobre una zona, el visor de imágenes muestra la lista de opciones
 * (niveles de compresión o formatos destino); al elegir una, corre ffmpeg en
 * el main y el visor muestra un loader con progreso. Al terminar, el visor
 * previsualiza el resultado (o un resumen de tamaños para video/audio) y la
 * tile nueva queda destacada en la grilla.
 *
 * Se carga después de renderer.js y usa sus globals: openImageDrawer,
 * closeImageDrawer, downloadsRegistry, fileUrlFromPath, downloadExtLabel,
 * renderDownloadsHome, isPreviewableDownload, pushDockToast.
 */

(function initMagicDrawer() {
  const api = window.usualDesk;
  if (!api || typeof api.magicTransform !== 'function') return;

  /* Debe reflejar los sets de main/magic-drawer.js. */
  const MAGIC_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'avif']);
  const MAGIC_VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv', 'gif']);
  const MAGIC_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma', 'opus']);

  function magicFileKind(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (MAGIC_IMAGE_EXTS.has(ext)) return 'image';
    if (MAGIC_VIDEO_EXTS.has(ext)) return 'video';
    if (MAGIC_AUDIO_EXTS.has(ext)) return 'audio';
    return null;
  }

  function magicFileExt(name) {
    return String(name || '').split('.').pop().toLowerCase();
  }

  function formatBytes(n) {
    const num = Number(n) || 0;
    if (num >= 1024 * 1024 * 1024) return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (num >= 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
    if (num >= 1024) return `${Math.round(num / 1024)} KB`;
    return `${num} B`;
  }

  /* ---------------- Estado ---------------- */

  const state = {
    view: 'none', // 'none' | 'options' | 'loader' | 'result'
    file: null, // { path, name, size, kind, ext }
    action: null,
    jobId: null,
  };

  /** Descargas recién generadas por el cajón: la tile se destaca hasta tocarla. */
  const freshDownloadIds = new Set();

  /* ---------------- Vistas en el espacio del visor ---------------- */

  const el = (id) => document.getElementById(id);

  function hideMagicViews() {
    el('image-drawer-magic-options')?.classList.add('hidden');
    el('image-drawer-magic-loader')?.classList.add('hidden');
    el('image-drawer-magic-result')?.classList.add('hidden');
    state.view = 'none';
  }

  /** Muestra una de las vistas mágicas dentro del cuerpo del visor. */
  function showMagicView(name) {
    // Resetea el visor (cierra preview/pdf y vuelve al estado vacío)...
    closeImageDrawer();
    // ...pero en lugar del placeholder mostramos la vista mágica.
    el('image-drawer-placeholder')?.classList.add('hidden');
    el('image-drawer-magic-options')?.classList.toggle('hidden', name !== 'options');
    el('image-drawer-magic-loader')?.classList.toggle('hidden', name !== 'loader');
    el('image-drawer-magic-result')?.classList.toggle('hidden', name !== 'result');
    state.view = name;
  }

  /* ---------------- Opciones por acción ---------------- */

  const COMPRESS_LEVELS = [
    { target: 'light', label: 'Compresión ligera', hint: 'Casi sin pérdida de calidad' },
    { target: 'medium', label: 'Compresión media', hint: 'Equilibrio recomendado' },
    { target: 'max', label: 'Compresión máxima', hint: 'El archivo más chico posible' },
  ];

  const CONVERT_HINTS = {
    png: 'Sin pérdida, admite transparencia',
    jpg: 'Liviano, sin transparencia',
    webp: 'Moderno y muy liviano',
    mp4: 'Compatible con todo',
    webm: 'Abierto, ideal para web',
    gif: 'Animado, máx. 480px',
    mp3: 'Solo el audio',
    wav: 'Audio sin comprimir',
  };

  function convertTargetsFor(file) {
    const ext = file.ext === 'jpeg' ? 'jpg' : file.ext;
    let targets = [];
    if (file.kind === 'image') targets = ['png', 'jpg', 'webp'];
    else if (file.ext === 'gif') targets = ['mp4', 'webm'];
    else if (file.kind === 'video') targets = ['mp4', 'webm', 'gif', 'mp3'];
    else if (file.kind === 'audio') targets = ['mp3', 'wav'];
    return targets.filter((t) => t !== ext);
  }

  function optionsForDrop(action, file) {
    if (action === 'compress-image' || action === 'compress-video') {
      return COMPRESS_LEVELS.map((o) => ({ ...o }));
    }
    return convertTargetsFor(file).map((t) => ({
      target: t,
      label: `Convertir a ${t.toUpperCase()}`,
      hint: CONVERT_HINTS[t] || '',
    }));
  }

  const ACTION_TITLES = {
    'compress-image': '¿Cuánto querés comprimir la imagen?',
    'compress-video': '¿Cuánto querés comprimir el video?',
    convert: '¿A qué formato lo convertimos?',
  };

  /* ---------------- Vista: opciones ---------------- */

  function showOptionsView(action, file) {
    state.file = file;
    state.action = action;

    const nameEl = el('magic-options-name');
    if (nameEl) nameEl.textContent = file.name;

    const thumb = el('magic-options-thumb');
    const extChip = el('magic-options-ext');
    if (thumb && extChip) {
      if (file.kind === 'image') {
        thumb.src = fileUrlFromPath(file.path);
        thumb.classList.remove('hidden');
        extChip.classList.add('hidden');
      } else {
        thumb.classList.add('hidden');
        thumb.removeAttribute('src');
        extChip.textContent = downloadExtLabel(file.name);
        extChip.classList.remove('hidden');
      }
    }

    const titleEl = el('magic-options-title');
    if (titleEl) titleEl.textContent = ACTION_TITLES[action] || '';

    const list = el('magic-options-list');
    if (list) {
      list.innerHTML = '';
      for (const opt of optionsForDrop(action, file)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'magic-option-btn';
        const label = document.createElement('span');
        label.className = 'magic-option-label';
        label.textContent = opt.label;
        btn.appendChild(label);
        if (opt.hint) {
          const hint = document.createElement('span');
          hint.className = 'magic-option-hint';
          hint.textContent = opt.hint;
          btn.appendChild(hint);
        }
        btn.addEventListener('click', () => startJob(opt.target));
        list.appendChild(btn);
      }
    }

    showMagicView('options');
  }

  /* ---------------- Vista: loader ---------------- */

  function setLoaderProgress(pct) {
    const fill = el('magic-loader-fill');
    const pctEl = el('magic-loader-pct');
    if (!fill || !pctEl) return;
    if (pct == null) {
      fill.classList.add('is-indeterminate');
      fill.style.width = '';
      pctEl.textContent = 'Procesando…';
    } else {
      fill.classList.remove('is-indeterminate');
      fill.style.width = `${Math.round(pct)}%`;
      pctEl.textContent = `${Math.round(pct)}%`;
    }
  }

  function showLoaderView(file) {
    const nameEl = el('magic-loader-name');
    if (nameEl) nameEl.textContent = file.name;
    setLoaderProgress(null);
    showMagicView('loader');
  }

  /* ---------------- Vista: resultado (video/audio o error) ---------------- */

  function showResultView(record, inputSize, failed) {
    const extChip = el('magic-result-ext');
    const nameEl = el('magic-result-name');
    const sizesEl = el('magic-result-sizes');
    const actions = document.querySelector('#image-drawer-magic-result .magic-result-actions');

    if (extChip) extChip.textContent = failed ? '!' : downloadExtLabel(record.filename);
    if (nameEl) nameEl.textContent = failed ? 'No se pudo completar la transformación' : record.filename;
    if (sizesEl) {
      if (failed) {
        sizesEl.textContent = 'Probá de nuevo con otro archivo u otra opción.';
      } else if (inputSize > 0 && record.totalBytes > 0) {
        const delta = Math.round((1 - record.totalBytes / inputSize) * 100);
        const deltaTxt = delta > 0 ? ` (−${delta}%)` : delta < 0 ? ` (+${-delta}%)` : '';
        sizesEl.textContent = `${formatBytes(inputSize)} → ${formatBytes(record.totalBytes)}${deltaTxt}`;
      } else {
        sizesEl.textContent = formatBytes(record.totalBytes);
      }
    }
    if (actions) actions.classList.toggle('hidden', !!failed);

    const openBtn = el('magic-result-open');
    const folderBtn = el('magic-result-folder');
    if (openBtn) {
      openBtn.onclick = failed ? null : () => api.openDownloadFile(record.id).catch(() => {});
    }
    if (folderBtn) {
      folderBtn.onclick = failed ? null : () => api.showDownloadInFolder(record.id).catch(() => {});
    }

    showMagicView('result');
  }

  /* ---------------- Trabajos ---------------- */

  async function startJob(target) {
    const file = state.file;
    if (!file || state.jobId) return;

    showLoaderView(file);
    let res;
    try {
      res = await api.magicTransform(file.path, state.action, target);
    } catch {
      res = { ok: false, error: 'IPC' };
    }
    if (!res || !res.ok) {
      if (res && res.error === 'BUSY') {
        pushDockToast({
          id: `magic-busy-${Date.now()}`,
          sourceName: 'Cajón mágico',
          title: 'Ya hay una transformación en curso',
          body: 'Esperá a que termine para lanzar otra.',
        });
        hideMagicViews();
        el('image-drawer-placeholder')?.classList.remove('hidden');
        return;
      }
      showResultView({ filename: file.name, totalBytes: 0 }, 0, true);
      return;
    }
    state.jobId = String(res.id);
  }

  function onJobUpdated(payload) {
    if (!state.jobId || String(payload.id) !== state.jobId) return;
    if (state.view !== 'loader') return;
    if (payload.totalBytes > 0) {
      setLoaderProgress(Math.min(100, (payload.receivedBytes / payload.totalBytes) * 100));
    }
  }

  function onJobDone(payload) {
    if (!state.jobId || String(payload.id) !== state.jobId) return;
    const jobId = state.jobId;
    state.jobId = null;

    const record = downloadsRegistry.get(jobId) || payload;
    const ok = record.state === 'completed';
    const inputSize = state.file ? state.file.size : 0;

    if (ok) {
      // Tile destacada hasta que el usuario la toque.
      freshDownloadIds.add(jobId);
      renderDownloadsHome();
    }

    // Si el usuario ya se puso a mirar otra cosa en el visor, no lo pisamos:
    // queda el toast de fin y la tile destacada.
    if (state.view !== 'loader') return;

    if (!ok) {
      showResultView({ filename: (state.file && state.file.name) || '', totalBytes: 0 }, 0, true);
      return;
    }
    if (isPreviewableDownload(record) && record.savePath) {
      hideMagicViews();
      openImageDrawer(record);
      return;
    }
    showResultView(record, inputSize, false);
  }

  /* ---------------- Drag & drop sobre los cajones ---------------- */

  function dragHasFiles(e) {
    const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
    return types.includes('Files');
  }

  function rejectZone(zone) {
    zone.classList.remove('is-rejected');
    // Reinicia la animación de shake aunque se repita el rechazo.
    void zone.offsetWidth;
    zone.classList.add('is-rejected');
    setTimeout(() => zone.classList.remove('is-rejected'), 500);
  }

  function acceptsKind(zone, kind, ext) {
    const accepts = String(zone.dataset.accepts || '').split(/\s+/);
    if (!kind) return false;
    // GIF: se comprime/convierte como video, nunca como imagen.
    if (ext === 'gif' && zone.dataset.action === 'compress-image') return false;
    return accepts.includes(kind);
  }

  function bindZone(zone) {
    zone.addEventListener('dragenter', (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      zone.classList.add('is-drag-over');
    });
    zone.addEventListener('dragover', (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch {
        /* noop */
      }
    });
    zone.addEventListener('dragleave', (e) => {
      if (zone.contains(e.relatedTarget)) return;
      zone.classList.remove('is-drag-over');
    });
    zone.addEventListener('drop', (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('is-drag-over');

      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const f = files[0];
      if (!f) return;

      const filePath = api.getPathForFile(f);
      if (!filePath) {
        rejectZone(zone);
        return;
      }
      const kind = magicFileKind(f.name);
      const ext = magicFileExt(f.name);
      if (!acceptsKind(zone, kind, ext)) {
        rejectZone(zone);
        return;
      }
      if (state.jobId) {
        rejectZone(zone);
        pushDockToast({
          id: `magic-busy-${Date.now()}`,
          sourceName: 'Cajón mágico',
          title: 'Ya hay una transformación en curso',
          body: 'Esperá a que termine para lanzar otra.',
        });
        return;
      }
      showOptionsView(zone.dataset.action, {
        path: filePath,
        name: f.name,
        size: f.size || 0,
        kind,
        ext,
      });
    });
  }

  /* ---------------- Init ---------------- */

  document.querySelectorAll('.magic-zone').forEach(bindZone);

  el('magic-options-cancel')?.addEventListener('click', () => {
    hideMagicViews();
    el('image-drawer-placeholder')?.classList.remove('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (state.view === 'options' || state.view === 'result')) {
      hideMagicViews();
      el('image-drawer-placeholder')?.classList.remove('hidden');
    }
  });

  if (api.onDownloadUpdated) api.onDownloadUpdated(onJobUpdated);
  if (api.onDownloadDone) api.onDownloadDone(onJobDone);

  /* Integración con renderer.js (visor y tiles destacadas). */
  window.MagicDrawerUI = {
    hideViews: hideMagicViews,
    isFreshDownload: (id) => freshDownloadIds.has(String(id)),
    clearFreshDownload: (id) => freshDownloadIds.delete(String(id)),
  };
})();

const toggleArea = document.getElementById('toggle-area');
const toggleBtn = document.getElementById('toggle-btn');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const sidebar = document.getElementById('sidebar');
const dockHomeAddBtn = document.getElementById('dock-home-add-btn');
const shortcutsEditToggleBtn = document.getElementById('shortcuts-edit-toggle');
const dockEditModeBanner = document.getElementById('dock-edit-mode-banner');
const dockExitEditModeBtn = document.getElementById('dock-exit-edit-mode-btn');
const shortcutsContainer = document.getElementById('shortcuts-container');
const dockHomeBtn = document.getElementById('dock-home-btn');
const dockDownloadsBtn = document.getElementById('dock-downloads-btn');
const modalOverlay = document.getElementById('modal-overlay');
const dockInlineEditor = document.getElementById('dock-inline-editor');
const shortcutModalCard = document.getElementById('modal');
const settingsModalOverlay = document.getElementById('settings-modal-overlay');
const appearanceModalOverlay = document.getElementById('appearance-modal-overlay');
const dockToastStack = document.getElementById('dock-toast-stack');
/** @type {Map<string, object>} descargas por id (más reciente primero al render) */
const downloadsRegistry = new Map();
/** @type {Map<string, { el: HTMLElement, timer: ReturnType<typeof setTimeout> | null }>} */
const dockToastRegistry = new Map();
const DOCK_TOAST_MAX = 5;
const DOCK_TOAST_TTL_MS = 11000;
const modalTitle = document.getElementById('modal-title');
const shortcutForm = document.getElementById('shortcut-form');
const inputName = document.getElementById('input-name');
const inputType = document.getElementById('input-type');
const inputUrl = document.getElementById('input-url');
const labelUrl = document.getElementById('label-url');
const modalCancel = document.getElementById('modal-cancel');
const modalDelete = document.getElementById('modal-delete');
const browseGroup = document.getElementById('browse-group');
const browsePathBtn = document.getElementById('browse-path-btn');
const inputIcon = document.getElementById('input-icon');
const iconSelectWrap = document.getElementById('icon-select-wrap');
const iconSelectTrigger = document.getElementById('icon-select-trigger');
const iconSelectTriggerThumb = document.getElementById('icon-select-trigger-thumb');
const iconSelectTriggerText = document.getElementById('icon-select-trigger-text');
const iconSelectList = document.getElementById('icon-select-list');
const shortcutWebOptions = document.getElementById('shortcut-web-options');
const inputWebNotificationsMuted = document.getElementById('input-web-notifications-muted');
const inputWebAudioMuted = document.getElementById('input-web-audio-muted');
const shortcutOrderGroup = document.getElementById('shortcut-order-group');
const shortcutMoveUpBtn = document.getElementById('shortcut-move-up');
const shortcutMoveDownBtn = document.getElementById('shortcut-move-down');

/** @type {{ value: string, label: string, src: string | null }[]} */
let iconBuiltinRows = [];
/** Opciones extra (p. ej. emoji antiguo al editar) */
let iconDynamicExtras = [];
let iconPickerReady = false;
let iconDropdownOpen = false;
/** Data URL del favicon aplicado solo, para no pisar un icono elegido a mano. */
let autoFaviconValue = '';
let suppressAutoFavicon = false;
let faviconSeq = 0;
let faviconTimer = null;
let faviconWait = null;
let faviconLookupPending = false;

/** Sentinel: abre el panel de emoji (no se guarda en shortcuts) */
const CUSTOM_EMOJI_VALUE = '__emoji__';

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Icono guardado: ruta bajo assets/icons/… o emoji antiguo */
function shortcutIconMarkup(icon) {
  if (!icon) return '';
  if (icon.includes('/') || /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(icon)) {
    return `<img class="shortcut-icon-img shell-shortcut-icon-img" src="${escapeAttr(icon)}" alt="" role="presentation" draggable="false" />`;
  }
  return `<span class="shortcut-icon shell-shortcut-icon-emoji" aria-hidden="true">${escapeHtmlText(icon)}</span>`;
}

/** Fallback: si el shortcut no tiene icono, muestra la primera letra del nombre. */
function shortcutFallbackMarkup(name) {
  const trimmed = (name || '').trim();
  const letter = trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  return `<span class="shell-shortcut-icon-fallback" aria-hidden="true">${escapeHtmlText(letter)}</span>`;
}

let shortcuts = [];
/** @type {Record<string, number>} */
const titleBadges = {};
/** Claves `${partition}::${url}` con ventana web abierta (main/open-shortcut.js). */
let openWebWindowKeys = new Set();
let editingId = null;
let dragOperationActive = false;
/** Panel de accesos: en modo edición se reordenan los iconos, el lápiz abre el editor y el tacho elimina. */
let shortcutsEditMode = false;
/** Sesión de arrastre para reordenar iconos. Null si no hay un dedo/puntero apoyado. */
let shortcutReorder = null;
/** Ignora el click que dispara el navegador al soltar un arrastre. */
let shortcutReorderSuppressClicksUntil = 0;

document.addEventListener(
  'click',
  (event) => {
    if (Date.now() >= shortcutReorderSuppressClicksUntil) return;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);
/** Evita spam IPC a ventanas chrome en cada renderShortcuts. */
let lastSyncedShortcutsEditModeToChrome = null;
/** Modo Foco: colección de mapKeys de shortcuts dentro del foco. */
let focusModeState = { active: false, members: new Set() };

let lastPointer = { x: 0, y: 0 };
let lastPassthroughIgnore = true;
let passthroughRaf = 0;

function syncPointerPassthrough(clientX, clientY) {
  if (dragOperationActive) {
    if (lastPassthroughIgnore !== false) {
      lastPassthroughIgnore = false;
      window.usualDesk.setIgnoreMouse(false);
    }
    return;
  }
  const inlineShortcutFormOpen =
    !!(dockInlineEditor && !dockInlineEditor.classList.contains('hidden'));
  const modalOpen =
    !modalOverlay.classList.contains('hidden') ||
    inlineShortcutFormOpen ||
    document.documentElement.classList.contains('doc-modal-open') ||
    document.documentElement.classList.contains('gesture-coach-open') ||
    !!(settingsModalOverlay && !settingsModalOverlay.classList.contains('hidden')) ||
    !!(appearanceModalOverlay && !appearanceModalOverlay.classList.contains('hidden'));
  let overUi = modalOpen;
  if (!overUi) {
    const stack = document.elementsFromPoint(clientX, clientY);
    overUi = stack.some((el) => el.closest && el.closest('[data-mouse-hit]'));
  }
  const ignore = !overUi;
  if (ignore === lastPassthroughIgnore) return;
  lastPassthroughIgnore = ignore;
  window.usualDesk.setIgnoreMouse(ignore);
}

function setDragOperationActive(active) {
  dragOperationActive = active === true;
  if (dragOperationActive) {
    lastPassthroughIgnore = false;
    window.usualDesk.setIgnoreMouse(false);
    return;
  }
  lastPassthroughIgnore = null;
  schedulePointerPassthroughSync();
}

function schedulePointerPassthroughSync() {
  if (passthroughRaf) return;
  passthroughRaf = requestAnimationFrame(() => {
    passthroughRaf = 0;
    syncPointerPassthrough(lastPointer.x, lastPointer.y);
  });
}

window.__dockSchedulePointerPassthrough = schedulePointerPassthroughSync;

function syncIgnoreMouseForToasts() {
  if (dockToastRegistry.size > 0) {
    // Con toasts visibles capturamos clic inmediato aunque el sidebar esté cerrado.
    if (lastPassthroughIgnore !== false) {
      lastPassthroughIgnore = false;
      window.usualDesk.setIgnoreMouse(false);
    }
    return;
  }
  lastPassthroughIgnore = null;
  schedulePointerPassthroughSync();
}

function initFooter() {
  const quitBtn = document.getElementById('quit-app-btn');
  if (quitBtn) {
    quitBtn.addEventListener('click', () => {
      window.usualDesk.closeApp();
    });
  }
}

/** Lienzo de inicio: tareas (logo) o descargas (flecha). */
let homeView = 'todos';

function applyHomeView(view) {
  homeView = view === 'downloads' ? 'downloads' : 'todos';
  const panel = document.getElementById('dock-home-panel');
  if (panel) panel.setAttribute('data-home-view', homeView);
  if (homeView === 'downloads') kickDownloadPreviews();
  else pauseDrawerVideo();
}

function syncDockHomeStripBtn() {
  const btn = document.getElementById('dock-home-btn');
  const downloadsBtn = document.getElementById('dock-downloads-btn');
  if (!btn && !downloadsBtn) return;
  const editor = document.getElementById('dock-inline-editor');
  const lnSurface = document.getElementById('loose-nav-surface');
  const editorOpen = editor && !editor.classList.contains('hidden');
  const looseOpen = lnSurface && !lnSurface.classList.contains('hidden');
  const homeVisible = !editorOpen && !looseOpen;
  if (btn) {
    const on = homeVisible && homeView === 'todos';
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (downloadsBtn) {
    const on = homeVisible && homeView === 'downloads';
    downloadsBtn.classList.toggle('is-active', on);
    downloadsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const internetBtn = document.getElementById('open-url-btn');
  if (internetBtn) {
    internetBtn.classList.toggle('is-active', !!looseOpen);
    internetBtn.setAttribute('aria-pressed', looseOpen ? 'true' : 'false');
  }
}

async function goToDockWelcomeHome(view) {
  applyHomeView(view === 'downloads' ? 'downloads' : 'todos');
  try {
    closeModal();
    if (looseNavState?.active && typeof window.usualDesk?.looseNavClose === 'function') {
      await window.usualDesk.looseNavClose().catch(() => {});
    }
  } finally {
    syncDockHomeStripBtn();
  }
}

function applyDockPositionToDom(pos) {
  const p = pos === 'right' || pos === 'center' ? pos : 'left';
  document.documentElement.setAttribute('data-dock-position', p);
  document.documentElement.setAttribute('data-dock-layout', p === 'center' ? 'modal' : 'topbar');
  const formOpen =
    (dockInlineEditor && !dockInlineEditor.classList.contains('hidden')) ||
    !modalOverlay.classList.contains('hidden');
  if (formOpen && shortcutModalCard) {
    showShortcutFormShell();
  }
}

function applySidebarDensityToDom(density) {
  const d = density === 'minimal' ? 'minimal' : 'normal';
  document.documentElement.setAttribute('data-sidebar-density', d);
  refreshShortcutCardsAccessibility();
}

function syncDockPositionSegmentedUI(selected) {
  const seg = document.getElementById('dock-position-segmented');
  if (!seg) return;
  const v = selected === 'right' || selected === 'center' ? selected : 'left';
  seg.querySelectorAll('.type-segment').forEach((btn) => {
    const on = btn.dataset.value === v;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.classList.toggle('is-selected', on);
  });
}

function syncSidebarDensitySegmentedUI(selected) {
  const seg = document.getElementById('sidebar-density-segmented');
  if (!seg) return;
  const v = selected === 'minimal' ? 'minimal' : 'normal';
  seg.querySelectorAll('.type-segment').forEach((btn) => {
    const on = btn.dataset.value === v;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.classList.toggle('is-selected', on);
  });
}

function applyWebHostModeToDom() {
  document.documentElement.setAttribute('data-web-host-mode', 'separate');
}

function refreshShortcutCardsAccessibility() {
  shortcutsContainer.querySelectorAll('.shortcut-card[data-shortcut-id]').forEach((card) => {
    const id = card.dataset.shortcutId;
    const s = shortcuts.find((x) => x.id === id);
    if (!s) return;
    const hint = shortcutsEditMode
      ? `${s.name}. Arrastra para mover de lugar. Clic para editar.`
      : s.name;
    card.setAttribute('aria-label', hint);
    card.setAttribute('data-tooltip', hint);
  });
}

function closeSettingsModal() {
  if (!settingsModalOverlay) return;
  settingsModalOverlay.classList.add('hidden');
  schedulePointerPassthroughSync();
}

function currentCanvasTheme() {
  if (window.InplaizeCanvasTheme && typeof window.InplaizeCanvasTheme.isLight === 'function') {
    return window.InplaizeCanvasTheme.isLight() === true ? 'light' : 'dark';
  }
  return document.documentElement.getAttribute('data-canvas-theme') === 'light' ? 'light' : 'dark';
}

function syncAppearanceThemeUI(theme) {
  const group = document.getElementById('appearance-theme-options');
  if (!group) return;
  const next = theme === 'light' ? 'light' : 'dark';
  group.querySelectorAll('.appearance-theme-option').forEach((btn) => {
    const on = btn.dataset.value === next;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function applyCanvasTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  if (window.InplaizeCanvasTheme && typeof window.InplaizeCanvasTheme.set === 'function') {
    window.InplaizeCanvasTheme.set(next);
  } else {
    if (next === 'light') document.documentElement.setAttribute('data-canvas-theme', 'light');
    else document.documentElement.removeAttribute('data-canvas-theme');
    try {
      localStorage.setItem('inplaize.canvasTheme', next);
    } catch {
      /* el tema sigue en esta sesión */
    }
  }
  syncAppearanceThemeUI(next);
}

function openAppearanceModal() {
  if (!appearanceModalOverlay) return;
  syncAppearanceThemeUI(currentCanvasTheme());
  appearanceModalOverlay.classList.remove('hidden');
  schedulePointerPassthroughSync();
  appearanceModalOverlay.querySelector('.appearance-theme-option.is-selected')?.focus();
}

function closeAppearanceModal() {
  if (!appearanceModalOverlay) return;
  appearanceModalOverlay.classList.add('hidden');
  schedulePointerPassthroughSync();
}

function syncInAppNotificationCheckboxFromSettings(s) {
  const el = document.getElementById('settings-in-app-notifications');
  if (!el || !s) return;
  el.checked = s.inAppWebNotifications !== false;
}

function removeDockToast(id) {
  const rec = dockToastRegistry.get(id);
  if (!rec) return;
  if (rec.timer) clearTimeout(rec.timer);
  rec.el.remove();
  dockToastRegistry.delete(id);
  window.usualDesk.dismissDockInAppNotification(id).catch(() => {});
  syncIgnoreMouseForToasts();
}

function pushDockToast(payload) {
  if (!dockToastStack || !payload || payload.id == null) return;
  const id = String(payload.id);
  while (dockToastRegistry.size >= DOCK_TOAST_MAX) {
    const k = dockToastRegistry.keys().next().value;
    removeDockToast(k);
  }

  const card = document.createElement('article');
  card.className = 'dock-toast-card';
  card.setAttribute('role', 'status');
  card.setAttribute('data-mouse-hit', '');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dock-toast-close';
  closeBtn.setAttribute('aria-label', 'Cerrar');
  closeBtn.textContent = '×';

  const inner = document.createElement('div');
  inner.className = 'dock-toast-inner';

  const icon = document.createElement('img');
  icon.className = 'dock-toast-icon';
  icon.alt = '';
  const iconUrl = payload.icon && String(payload.icon).trim();
  if (iconUrl && /^https?:\/\//i.test(iconUrl)) {
    icon.src = iconUrl;
    icon.removeAttribute('hidden');
  } else {
    icon.setAttribute('hidden', 'true');
  }

  const textWrap = document.createElement('div');
  textWrap.className = 'dock-toast-text';

  const source = document.createElement('span');
  source.className = 'dock-toast-source';
  source.textContent = payload.sourceName || 'Web';

  const titleEl = document.createElement('h4');
  titleEl.className = 'dock-toast-title';
  titleEl.textContent = payload.title || 'Aviso';

  const bodyEl = document.createElement('p');
  bodyEl.className = 'dock-toast-body';
  bodyEl.textContent = payload.body || '';

  textWrap.append(source, titleEl, bodyEl);
  inner.append(icon, textWrap);
  card.append(closeBtn, inner);

  const bigUrl = payload.image && String(payload.image).trim();
  if (bigUrl && /^https?:\/\//i.test(bigUrl)) {
    const big = document.createElement('img');
    big.className = 'dock-toast-image';
    big.src = bigUrl;
    big.alt = '';
    card.append(big);
  }

  let timer = null;
  if (!payload.requireInteraction) {
    timer = setTimeout(() => removeDockToast(id), DOCK_TOAST_TTL_MS);
  }

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeDockToast(id);
  });

  card.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    if (e.target === closeBtn) return;
    // Toast de descarga: imágenes, videos y PDFs abren el visor interno; el
    // resto se abre con la app del sistema (si ya terminó).
    if (payload.downloadId) {
      const d = downloadsRegistry.get(String(payload.downloadId));
      if (d && d.state === 'completed' && isPreviewableDownload(d) && d.savePath) {
        openImageDrawer(d);
        removeDockToast(id);
        return;
      }
      try {
        const res = await window.usualDesk.openDownloadFile(payload.downloadId);
        if (res && res.ok) removeDockToast(id);
      } catch {
        /* aún no disponible: se abrirá cuando termine */
      }
      return;
    }
    const key = payload.webMapKey;
    if (!key) return;
    try {
      const ok = await window.usualDesk.focusWebWindowByMapKey(key, {
        title: payload.title || '',
        body: payload.body || '',
        tag: payload.tag || '',
        data: payload.data ?? null,
      });
      if (ok) removeDockToast(id);
    } catch {
      /* noop */
    }
  });

  dockToastRegistry.set(id, { el: card, timer });
  dockToastStack.appendChild(card);
  syncIgnoreMouseForToasts();
}

function initDockInAppToasts() {
  if (!dockToastStack) return;
  window.usualDesk.onDockInAppNotification((p) => pushDockToast(p));
  window.usualDesk.onDockInAppNotificationDismiss((nid) => {
    if (nid != null) removeDockToast(String(nid));
  });
}

/* ---------------- Descargas centralizadas ---------------- */

/** Extensión en mayúsculas para el chip del icono (PDF, PNG, ZIP…). */
function downloadExtLabel(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'FILE';
  return name.slice(dot + 1).toUpperCase().slice(0, 4);
}

function downloadInProgress(d) {
  return d.state === 'progressing' || d.state === 'paused';
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
/** Formatos que Chromium reproduce en un <video>. El resto (mkv, avi, wmv…) sigue abriéndose con la app del sistema. */
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg']);

/** Documentos cuya miniatura genera la propia app (no el shell de Windows). */
const DOC_THUMB_EXTS = new Set(['pdf', 'xlsx', 'xlsm', 'xls', 'csv']);

/** Versión de miniatura por descarga: se incrementa al guardar una edición
 *  para invalidar la caché del <img> (misma ruta de archivo). */
const downloadThumbVersions = new Map();

/** Caché renderer de miniaturas de documentos: id → url file:// o 'error'.
 *  Evita re-pedir la miniatura al proceso principal en cada re-render. */
const docThumbCache = new Map();

function extOfName(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** ¿El archivo se puede previsualizar como imagen? */
function isImageDownload(d) {
  const ext = extOfName(d && d.filename);
  return ext ? IMAGE_EXTS.has(ext) : false;
}

/** ¿La app puede generar una miniatura del documento (PDF/Excel/CSV)? */
function isDocThumbDownload(d) {
  const ext = extOfName(d && d.filename);
  return ext ? DOC_THUMB_EXTS.has(ext) : false;
}

/** ¿Es un PDF? Se previsualiza en el drawer con el visor de Chromium. */
function isPdfDownload(d) {
  return String(d.filename || '')
    .toLowerCase()
    .endsWith('.pdf');
}

/** ¿El video se puede reproducir en el panel de la derecha? */
function isVideoDownload(d) {
  const ext = extOfName(d && d.filename);
  return ext ? VIDEO_EXTS.has(ext) : false;
}

/** ¿La descarga se puede abrir en el drawer de vista previa? */
function isPreviewableDownload(d) {
  return isImageDownload(d) || isPdfDownload(d) || isVideoDownload(d);
}

/** Inserta una miniatura (URL file://) cubriendo el tile y quita el chip.
 *  El tile puede aún no estar insertado en el DOM (caso caché durante el
 *  re-render): igualmente se agrega la <img> y se conecta al añadir la celda. */
function swapInDocThumb(tile, extChip, url) {
  if (!tile) return;
  if (tile.querySelector('.download-tile-thumb')) return;
  const img = document.createElement('img');
  img.className = 'download-tile-thumb';
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.src = url;
  img.addEventListener('load', () => {
    if (extChip && extChip.parentNode) extChip.remove();
  });
  img.addEventListener('error', () => {
    img.remove();
  });
  tile.prepend(img);
}

/** ¿El panel de descargas está a la vista? Ahí recién se piden miniaturas. */
function downloadsPanelVisible() {
  if (homeView !== 'downloads') return false;
  const sidebarEl = document.getElementById('sidebar');
  return !!(sidebarEl && sidebarEl.classList.contains('open'));
}

/** Cola de vistas previas: de a pocas, y solo de los tiles que se están viendo. */
const PREVIEW_CONCURRENCY = 2;
let previewInflight = 0;
const previewQueue = [];
const previewQueuedIds = new Set();
const previewTiles = new Map();
let previewObserver = null;

function livePreviewTile(id) {
  return previewTiles.get(id) || null;
}

function getPreviewObserver() {
  if (previewObserver) return previewObserver;
  const root = document.getElementById('downloads-home-grid');
  previewObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const tile = entry.target;
        const id = tile.dataset.previewId;
        if (!id) continue;
        const cached = docThumbCache.get(id);
        if (cached === 'error') {
          previewObserver.unobserve(tile);
          continue;
        }
        if (cached) {
          swapInDocThumb(tile, tile._previewExt, cached);
          previewObserver.unobserve(tile);
          continue;
        }
        enqueueDownloadPreview(tile);
      }
      pumpDownloadPreviews();
    },
    { root: root || null, rootMargin: '160px' },
  );
  return previewObserver;
}

function enqueueDownloadPreview(tile) {
  const id = tile.dataset.previewId;
  if (!id || docThumbCache.has(id)) return;
  previewTiles.set(id, tile);
  if (previewQueuedIds.has(id)) return;
  previewQueuedIds.add(id);
  previewQueue.push(id);
}

/** Vuelve a medir qué tiles se ven. Hace falta al abrir el panel: mientras
 *  estaba oculto el observer no los marcaba como visibles. */
function kickDownloadPreviews() {
  if (previewObserver) {
    const tiles = document.querySelectorAll('.download-tile[data-preview-id]');
    previewObserver.disconnect();
    tiles.forEach((tile) => previewObserver.observe(tile));
  }
  pumpDownloadPreviews();
}

function pumpDownloadPreviews() {
  if (!downloadsPanelVisible()) return;
  if (!window.usualDesk || !window.usualDesk.getDownloadThumbnail) return;
  while (previewInflight < PREVIEW_CONCURRENCY && previewQueue.length) {
    const id = previewQueue.shift();
    const cached = docThumbCache.get(id);
    if (cached) {
      previewQueuedIds.delete(id);
      if (cached !== 'error') {
        const tile = livePreviewTile(id);
        if (tile && tile.isConnected) swapInDocThumb(tile, tile._previewExt, cached);
      }
      continue;
    }
    const tile = livePreviewTile(id);
    if (!tile || !tile.isConnected) {
      previewQueuedIds.delete(id);
      previewTiles.delete(id);
      continue;
    }
    previewInflight += 1;
    window.usualDesk
      .getDownloadThumbnail(id)
      .then((res) => {
        if (res && res.ok && res.url) {
          docThumbCache.set(id, res.url);
          const live = livePreviewTile(id);
          if (live && live.isConnected) swapInDocThumb(live, live._previewExt, res.url);
        } else {
          docThumbCache.set(id, 'error');
        }
      })
      .catch(() => {
        docThumbCache.set(id, 'error');
      })
      .finally(() => {
        previewQueuedIds.delete(id);
        previewInflight -= 1;
        pumpDownloadPreviews();
      });
  }
}

/** Chip primero. La miniatura (chica y cacheada) entra cuando el tile se ve. */
function scheduleTilePreview(tile, extChip, d) {
  const cached = docThumbCache.get(d.id);
  if (cached === 'error') return;
  if (cached) {
    swapInDocThumb(tile, extChip, cached);
    return;
  }
  tile.dataset.previewId = d.id;
  tile._previewExt = extChip;
  previewTiles.set(d.id, tile);
  getPreviewObserver().observe(tile);
}

/** Convierte una ruta local de Windows en una URL file:// utilizable en <img>. */
function fileUrlFromPath(p) {
  if (!p) return '';
  const norm = String(p).replace(/\\/g, '/');
  return `file:///${encodeURI(norm).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** Arrastre interno de un archivo del home. No recorta la ventana. */
let internalFileDrag = null;

function downloadDragFile(id) {
  const d = downloadsRegistry.get(String(id));
  if (!d || d.state !== 'completed' || !d.savePath) return null;
  return {
    path: d.savePath,
    name: d.filename || 'archivo',
    size: Number(d.totalBytes) || Number(d.receivedBytes) || 0,
  };
}

function magicZoneAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  return hit && hit.closest ? hit.closest('.magic-zone') : null;
}

/** El puntero salió del panel abierto (otra app, otro monitor). */
function pointerOutsideOpenDock(ev) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || !sidebar.classList.contains('open')) return false;
  const r = sidebar.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return false;
  const pad = 12;
  return (
    ev.clientX < r.left - pad ||
    ev.clientX > r.right + pad ||
    ev.clientY < r.top - pad ||
    ev.clientY > r.bottom + pad
  );
}

function endInternalFileDrag() {
  const session = internalFileDrag;
  if (!session) return;
  session.ghost.remove();
  document.removeEventListener('keydown', session.onKey, true);
  document.documentElement.classList.remove('is-internal-file-drag');
  window.MagicDrawerUI?.clearDragHover?.();
  internalFileDrag = null;
}

function moveInternalFileDrag(ev) {
  const session = internalFileDrag;
  if (!session) return;
  session.ghost.style.left = `${ev.clientX}px`;
  session.ghost.style.top = `${ev.clientY}px`;
  window.MagicDrawerUI?.hoverDragZone?.(magicZoneAt(ev.clientX, ev.clientY), session.file);
}

function beginInternalFileDrag(tile, id) {
  const file = downloadDragFile(id);
  if (!file) return null;
  const rect = tile.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'download-drag-ghost';
  ghost.textContent = file.name;
  // Fuera del panel: #sidebar tiene transform y un fixed adentro no sigue al cursor.
  document.body.appendChild(ghost);
  const onKey = (e) => {
    if (e.key !== 'Escape' || !internalFileDrag) return;
    e.preventDefault();
    endInternalFileDrag();
  };
  document.addEventListener('keydown', onKey, true);
  document.documentElement.classList.add('is-internal-file-drag');
  internalFileDrag = {
    id: String(id),
    file,
    tile,
    anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ghost,
    onKey,
    handedOff: false,
    pointerId: null,
  };
  return internalFileDrag;
}

/**
 * Suelta el arrastre interno y pasa a un drag nativo para dejar el archivo
 * en otra app. Recorta la ventana: solo tiene sentido ya fuera del panel.
 */
function handoffInternalFileDrag() {
  const session = internalFileDrag;
  if (!session || session.handedOff) return;
  session.handedOff = true;
  const { id, anchor, tile, pointerId } = session;
  try {
    if (pointerId != null && tile.hasPointerCapture?.(pointerId)) {
      tile.releasePointerCapture(pointerId);
    }
  } catch {
    /* noop */
  }
  endInternalFileDrag();
  window.usualDesk.startDownloadDrag?.(id, anchor);
}

/**
 * Dentro del panel el archivo se arrastra sin cerrar la pantalla, para
 * poder soltarlo en comprimir/convertir. Si el puntero sale del panel, ahí
 * sí empieza el drag nativo (WhatsApp, escritorio, etc.).
 * @param {HTMLElement} tile
 * @param {string} id
 */
function bindDownloadTileNativeDrag(tile, id) {
  let press = null;
  // El drag HTML del botón no lleva el archivo real.
  tile.addEventListener('dragstart', (ev) => ev.preventDefault());
  const clearPress = () => {
    if (!press) return;
    try {
      if (press.pointerId != null && tile.hasPointerCapture?.(press.pointerId)) {
        tile.releasePointerCapture(press.pointerId);
      }
    } catch {
      /* noop */
    }
    window.removeEventListener('pointermove', press.move);
    window.removeEventListener('pointerup', press.up);
    window.removeEventListener('pointercancel', press.cancel);
    press = null;
  };
  tile.addEventListener('pointerdown', (e) => {
    if (tile.dataset.suppressClick === '1') delete tile.dataset.suppressClick;
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.download-tile-remove, .download-tile-folder')) return;
    clearPress();
    const originX = e.clientX;
    const originY = e.clientY;
    const move = (ev) => {
      if (!press) return;
      if (!press.dragging) {
        if (Math.hypot(ev.clientX - originX, ev.clientY - originY) < 5) return;
        press.dragging = true;
        tile.dataset.suppressClick = '1';
        const session = beginInternalFileDrag(tile, id);
        if (!session) {
          clearPress();
          return;
        }
        session.pointerId = press.pointerId;
      }
      if (pointerOutsideOpenDock(ev)) {
        handoffInternalFileDrag();
        clearPress();
        return;
      }
      moveInternalFileDrag(ev);
    };
    const finish = (ev, allowDrop) => {
      const session = internalFileDrag;
      if (allowDrop && press && press.dragging && session && !session.handedOff) {
        const zone = magicZoneAt(ev.clientX, ev.clientY);
        const file = session.file;
        endInternalFileDrag();
        if (zone) window.MagicDrawerUI?.dropOnZone?.(zone, file);
      } else if (session && !session.handedOff) {
        endInternalFileDrag();
      }
      clearPress();
    };
    const up = (ev) => finish(ev, true);
    const cancel = () => finish(null, false);
    press = { move, up, cancel, dragging: false, pointerId: e.pointerId };
    try {
      tile.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });
}

/** Crea el tile (icono) de una descarga en el home. */
function buildDownloadTile(d) {
  const cell = document.createElement('div');
  cell.className = 'download-tile-cell';
  cell.dataset.state = d.state;
  cell.dataset.downloadId = String(d.id);

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'download-tile';
  tile.title = d.filename || '';

  // Recién salida del cajón mágico: pulso destacado hasta que el usuario la toca.
  if (window.MagicDrawerUI?.isFreshDownload(d.id)) {
    tile.classList.add('is-fresh');
    tile.addEventListener(
      'pointerenter',
      () => {
        tile.classList.remove('is-fresh');
        window.MagicDrawerUI?.clearFreshDownload(d.id);
      },
      { once: true },
    );
  }

  // Siempre el chip primero. Fotos, PDF y planillas piden una miniatura
  // chica recién cuando el tile está a la vista; el archivo original no se
  // decodifica en la grilla.
  const ext = document.createElement('span');
  ext.className = 'download-tile-ext';
  ext.textContent = downloadExtLabel(d.filename);
  tile.appendChild(ext);
  if (
    d.state === 'completed' &&
    d.savePath &&
    (isImageDownload(d) || isDocThumbDownload(d))
  ) {
    scheduleTilePreview(tile, ext, d);
  }

  // Aro/barra de progreso mientras descarga.
  if (downloadInProgress(d)) {
    const bar = document.createElement('span');
    bar.className = 'download-tile-progress';
    const fill = document.createElement('span');
    fill.className = 'download-tile-progress-fill';
    if (d.totalBytes > 0) {
      const pct = Math.min(100, (d.receivedBytes / d.totalBytes) * 100);
      fill.style.width = `${pct}%`;
    } else {
      fill.classList.add('is-indeterminate');
    }
    bar.appendChild(fill);
    tile.appendChild(bar);
  }

  // Botón quitar (esquina).
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'download-tile-remove';
  removeBtn.setAttribute('aria-label', 'Quitar de la lista');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.usualDesk.removeDownload(d.id).catch(() => {});
    downloadsRegistry.delete(d.id);
    renderDownloadsHome();
  });

  // Botón "ver carpeta" (esquina, solo completadas).
  if (d.state === 'completed') {
    const folderBtn = document.createElement('button');
    folderBtn.type = 'button';
    folderBtn.className = 'download-tile-folder';
    folderBtn.setAttribute('aria-label', 'Ver en carpeta');
    folderBtn.textContent = '⌕';
    folderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.usualDesk.showDownloadInFolder(d.id).catch(() => {});
    });
    tile.appendChild(folderBtn);
  }

  tile.appendChild(removeBtn);

  // Arrastrar el tile (no un drag HTML del botón/miniatura) inicia un drag
  // nativo del archivo: se puede soltar en WhatsApp, mail, el escritorio, etc.
  if (d.state === 'completed' && d.savePath) {
    tile.classList.add('is-draggable');
    bindDownloadTileNativeDrag(tile, d.id);
  }

  // Click en el tile: imágenes, videos y PDFs abren el drawer de vista previa;
  // el resto se abre con la app del sistema. Si va en curso, cancela.
  tile.addEventListener('click', (e) => {
    if (tile.dataset.suppressClick === '1') {
      delete tile.dataset.suppressClick;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (d.state === 'completed') {
      // Ver el archivo no cambia el orden: la grilla queda por fecha de descarga.
      if (isPreviewableDownload(d) && d.savePath) {
        openImageDrawer(d);
      } else {
        window.usualDesk.openDownloadFile(d.id).catch(() => {});
      }
    } else if (downloadInProgress(d)) {
      window.usualDesk.cancelDownload(d.id).catch(() => {});
    }
  });

  // Nombre del archivo superpuesto arriba de la imagen (con backdrop-filter).
  const label = document.createElement('span');
  label.className = 'download-tile-label';
  label.textContent = d.filename || 'descarga';
  tile.appendChild(label);

  cell.append(tile);
  return cell;
}

/** Orden y atenuación por fecha de descarga. Abrir un archivo no lo mueve. */
function effectiveTsOf(d) {
  return Number(d && d.startedAt) || 0;
}

/** Clasifica un timestamp (ms) en una de las secciones del home. */
function downloadBucketOf(ts, now, todayMs) {
  if (now - ts < 3600000) return 'recien';
  if (ts >= todayMs) return 'hoy';
  return 'mas_antiguos';
}

/** Clase de opacidad por antigüedad: recién = normal; hoy = 70%; antes = 40%. */
const DOWNLOAD_BUCKET_CLASS = {
  recien: '',
  hoy: 'is-today',
  mas_antiguos: 'is-older',
};

function renderDownloadsHome() {
  const container = document.getElementById('downloads-home-grid');
  const empty = document.getElementById('downloads-home-empty');
  if (!container) return;

  const items = [...downloadsRegistry.values()].sort(
    (a, b) => effectiveTsOf(b) - effectiveTsOf(a),
  );

  // El tile del QR (#downloads-phone-cell) es fijo y queda primero; solo se
  // reemplazan los tiles generados dinámicamente.
  for (const el of [...container.children]) {
    if (el.id !== 'downloads-phone-cell') el.remove();
  }

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  // Sin divisores: los tiles fluyen continuos y se atenúan según su antigüedad
  // (recién = opaco, hoy = 70%, ayer o antes = 40%). El orden ya viene de más
  // nuevo a más viejo, así que los grupos quedan agrupados naturalmente.
  for (const d of items) {
    const bucket = downloadBucketOf(effectiveTsOf(d), now, todayMs);
    const tile = buildDownloadTile(d);
    const cls = DOWNLOAD_BUCKET_CLASS[bucket];
    if (cls) tile.classList.add(cls);
    container.appendChild(tile);
  }

  if (empty) empty.classList.toggle('hidden', items.length > 0);
  schedulePointerPassthroughSync();
}

function handleDownloadEvent(payload, phase) {
  if (!payload || payload.id == null) return;
  const id = String(payload.id);
  downloadsRegistry.set(id, { ...payload, id });
  renderDownloadsHome();

  if (phase === 'started') {
    pushDockToast({
      id: `dl-start-${id}`,
      downloadId: id,
      sourceName: payload.sourceName || 'Web',
      title: 'Descargando',
      body: payload.filename || '',
    });
  } else if (phase === 'done') {
    const done = downloadsRegistry.get(id);
    const ok = done && done.state === 'completed';
    // Al terminar, reemplazamos el toast de inicio por el de fin (mismo id base).
    removeDockToast(`dl-start-${id}`);
    pushDockToast({
      id: `dl-done-${id}`,
      downloadId: id,
      sourceName: payload.sourceName || 'Web',
      title: ok ? 'Descarga completa · abrir' : 'Descarga no finalizada',
      body: payload.filename || '',
    });
  }
}

/* Tile del teléfono: QR generado en el main con la IP LAN actual. */
function initPhoneUploadTile() {
  const tile = document.getElementById('downloads-phone-tile');
  const qrImg = document.getElementById('downloads-phone-qr');
  const hint = document.getElementById('downloads-phone-hint');
  if (!tile || !qrImg || !hint || !window.usualDesk.getPhoneUploadInfo) return;

  const loadQr = async () => {
    qrImg.classList.add('hidden');
    hint.classList.remove('hidden');
    hint.textContent = 'Generando…';
    try {
      const info = await window.usualDesk.getPhoneUploadInfo();
      if (info && info.ok && info.qrDataUrl) {
        qrImg.src = info.qrDataUrl;
        qrImg.classList.remove('hidden');
        hint.classList.add('hidden');
      } else if (info && info.error === 'NO_LAN') {
        hint.textContent = 'Sin Wi-Fi. Conectate a una red e intentá de nuevo.';
      } else {
        hint.textContent = 'No se pudo generar el QR. Tocá para reintentar.';
      }
    } catch {
      hint.textContent = 'No se pudo generar el QR. Tocá para reintentar.';
    }
  };

  loadQr();
  tile.addEventListener('click', loadQr);
}

async function initDownloadsUI() {
  initPhoneUploadTile();

  if (window.usualDesk.onDownloadStarted) {
    window.usualDesk.onDownloadStarted((p) => handleDownloadEvent(p, 'started'));
  }
  if (window.usualDesk.onDownloadUpdated) {
    window.usualDesk.onDownloadUpdated((p) => handleDownloadEvent(p, 'updated'));
  }
  if (window.usualDesk.onDownloadDone) {
    window.usualDesk.onDownloadDone((p) => handleDownloadEvent(p, 'done'));
  }

  try {
    const hist = await window.usualDesk.getDownloads();
    if (Array.isArray(hist)) {
      for (const d of hist) {
        if (d && d.id != null) downloadsRegistry.set(String(d.id), { ...d, id: String(d.id) });
      }
      renderDownloadsHome();
    }
  } catch {
    /* noop */
  }
}

/* ---------------- Visor fijo de vista previa / edición de imágenes ---------------- */

/**
 * Panel fijo (1/3 derecho de la pantalla de inicio) para previsualizar
 * imágenes, PDFs y videos descargados, con edición mínima de imágenes: rotar 90°,
 * espejar horizontal y guardar (sobrescribe el archivo). Solo se puede
 * guardar en formatos re-codificables (png/jpg/webp); el resto (gif, svg,
 * ico…) se previsualiza en modo solo lectura. Al hacer click en otro archivo
 * se reemplaza la vista al instante; sin selección muestra un placeholder.
 */
const imageDrawerState = {
  download: null,
  mode: 'image', // 'image' | 'pdf' | 'video'
  img: null,
  rotation: 0, // 0 | 90 | 180 | 270
  flipH: false,
  dirty: false,
  editable: false,
};

/** Mime de salida si el formato admite re-codificación desde canvas. */
function imageEditMime(filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  return null;
}

function imageDrawerIsOpen() {
  return !!imageDrawerState.download;
}

/** Redibuja el canvas aplicando rotación y espejado sobre el tamaño natural. */
function drawImageDrawerCanvas() {
  const canvas = document.getElementById('image-drawer-canvas');
  const { img, rotation, flipH } = imageDrawerState;
  if (!canvas || !img) return;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const swapped = rotation === 90 || rotation === 270;
  canvas.width = swapped ? h : w;
  canvas.height = swapped ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  if (flipH) ctx.scale(-1, 1);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function syncImageDrawerControls() {
  const { dirty, editable } = imageDrawerState;
  const saveBtn = document.getElementById('image-drawer-save');
  if (saveBtn) {
    saveBtn.disabled = !dirty || !editable;
    saveBtn.textContent = 'Guardar';
  }
  for (const id of ['image-drawer-rotate-left', 'image-drawer-rotate-right', 'image-drawer-flip']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !editable || !imageDrawerState.img;
  }
}

const DRAWER_LOAD_ERROR = 'No se pudo cargar el archivo.';
const DRAWER_VIDEO_ERROR = 'No se puede reproducir este video acá.';

function drawerVideoEl() {
  return document.getElementById('image-drawer-video');
}

/** Pausa sin soltar el archivo, para cuando el panel deja de verse. */
function pauseDrawerVideo() {
  const video = drawerVideoEl();
  if (video && !video.paused) video.pause();
}

/** Corta el video sin disparar una carga vacía (se va a asignar otro src). */
function detachDrawerVideo() {
  const video = drawerVideoEl();
  if (!video) return;
  video.onerror = null;
  video.pause();
  video.removeAttribute('src');
  video.classList.add('hidden');
}

/** Suelta el archivo de video para que deje de sonar y no quede trabado. */
function unloadDrawerVideo() {
  const video = drawerVideoEl();
  detachDrawerVideo();
  if (!video) return;
  try {
    video.load();
  } catch {
    /* noop */
  }
}

function hideDrawerPdf() {
  const pdfFrame = document.getElementById('image-drawer-pdf');
  if (!pdfFrame) return;
  if (pdfFrame.src && pdfFrame.src !== 'about:blank') pdfFrame.src = 'about:blank';
  pdfFrame.classList.add('hidden');
}

/** Muestra una descarga completada (imagen, PDF o video) en el visor fijo. */
function openImageDrawer(d) {
  const drawer = document.getElementById('image-drawer');
  const title = document.getElementById('image-drawer-title');
  const canvas = document.getElementById('image-drawer-canvas');
  const pdfFrame = document.getElementById('image-drawer-pdf');
  const video = drawerVideoEl();
  const errorEl = document.getElementById('image-drawer-error');
  const placeholder = document.getElementById('image-drawer-placeholder');
  if (!drawer || !canvas) return;

  const isPdf = isPdfDownload(d);
  const isVideo = isVideoDownload(d);
  imageDrawerState.download = d;
  imageDrawerState.mode = isPdf ? 'pdf' : isVideo ? 'video' : 'image';
  imageDrawerState.img = null;
  imageDrawerState.rotation = 0;
  imageDrawerState.flipH = false;
  imageDrawerState.dirty = false;
  imageDrawerState.editable = !isPdf && !isVideo && !!imageEditMime(d.filename);

  if (title) title.textContent = d.filename || '';
  if (errorEl) {
    errorEl.textContent = DRAWER_LOAD_ERROR;
    errorEl.classList.add('hidden');
  }
  placeholder?.classList.add('hidden');
  window.MagicDrawerUI?.hideViews();
  drawer.classList.toggle('is-video', isVideo);
  syncImageDrawerControls();

  canvas.classList.add('hidden');
  hideDrawerPdf();

  if (isVideo) {
    detachDrawerVideo();
    if (!video) {
      errorEl?.classList.remove('hidden');
    } else {
      const url = fileUrlFromPath(d.savePath);
      video.onerror = () => {
        if (imageDrawerState.download !== d || imageDrawerState.mode !== 'video') return;
        if (video.getAttribute('src') !== url) return;
        video.classList.add('hidden');
        if (errorEl) {
          errorEl.textContent = DRAWER_VIDEO_ERROR;
          errorEl.classList.remove('hidden');
        }
      };
      video.classList.remove('hidden');
      video.src = url;
      video.play().catch(() => {});
      video.focus({ preventScroll: true });
    }
  } else if (isPdf) {
    unloadDrawerVideo();
    // PDF: visor integrado de Chromium en un <webview>; sin herramientas de edición.
    if (pdfFrame) {
      // El webview debe estar visible ANTES de navegar: oculto (display:none)
      // no tiene webContents adjunto y la carga falla.
      pdfFrame.classList.remove('hidden');
      pdfFrame.src = fileUrlFromPath(d.savePath);
    } else {
      errorEl?.classList.remove('hidden');
    }
  } else {
    unloadDrawerVideo();
    canvas.classList.remove('hidden');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const img = new Image();
    const v = downloadThumbVersions.get(d.id);
    img.onload = () => {
      if (imageDrawerState.download !== d) return; // se abrió otra imagen mientras cargaba
      imageDrawerState.img = img;
      drawImageDrawerCanvas();
      syncImageDrawerControls();
    };
    img.onerror = () => {
      if (imageDrawerState.download !== d) return;
      canvas.classList.add('hidden');
      errorEl?.classList.remove('hidden');
    };
    img.src = fileUrlFromPath(d.savePath) + (v ? `?v=${v}` : '');
  }

  drawer.classList.remove('is-empty');
}

/** Vuelve el visor al estado vacío (placeholder), sin archivo seleccionado. */
function closeImageDrawer() {
  const drawer = document.getElementById('image-drawer');
  drawer?.classList.add('is-empty');
  drawer?.classList.remove('is-video');
  const title = document.getElementById('image-drawer-title');
  if (title) title.textContent = '';
  const canvas = document.getElementById('image-drawer-canvas');
  canvas?.classList.add('hidden');
  hideDrawerPdf();
  unloadDrawerVideo();
  const errorEl = document.getElementById('image-drawer-error');
  if (errorEl) {
    errorEl.textContent = DRAWER_LOAD_ERROR;
    errorEl.classList.add('hidden');
  }
  window.MagicDrawerUI?.hideViews();
  document.getElementById('image-drawer-placeholder')?.classList.remove('hidden');
  imageDrawerState.download = null;
  imageDrawerState.mode = 'image';
  imageDrawerState.img = null;
  imageDrawerState.dirty = false;
}

async function saveImageDrawerEdit() {
  const { download: d, img, editable } = imageDrawerState;
  const canvas = document.getElementById('image-drawer-canvas');
  const saveBtn = document.getElementById('image-drawer-save');
  if (!d || !img || !editable || !canvas) return;
  const mime = imageEditMime(d.filename);
  if (!mime) return;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando…';
  }
  try {
    const dataUrl = canvas.toDataURL(mime, mime === 'image/png' ? undefined : 0.92);
    const res = await window.usualDesk.saveDownloadImageEdit(d.id, dataUrl);
    if (res && res.ok) {
      imageDrawerState.dirty = false;
      downloadThumbVersions.set(d.id, (downloadThumbVersions.get(d.id) || 0) + 1);
      docThumbCache.delete(d.id);
      renderDownloadsHome();
      if (saveBtn) saveBtn.textContent = 'Guardado ✓';
      setTimeout(() => syncImageDrawerControls(), 1200);
      return;
    }
  } catch {
    /* cae al estado de error de abajo */
  }
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Reintentar';
  }
}

function initImageDrawer() {
  document.getElementById('image-drawer-close')?.addEventListener('click', closeImageDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !imageDrawerIsOpen()) return;
    // Escape primero sale de pantalla completa del video; no cierra el visor.
    if (document.fullscreenElement) return;
    closeImageDrawer();
  });

  const applyEdit = (mutate) => {
    if (!imageDrawerState.img || !imageDrawerState.editable) return;
    mutate();
    imageDrawerState.dirty = true;
    drawImageDrawerCanvas();
    syncImageDrawerControls();
  };
  document.getElementById('image-drawer-rotate-left')?.addEventListener('click', () => {
    applyEdit(() => {
      imageDrawerState.rotation = (imageDrawerState.rotation + 270) % 360;
    });
  });
  document.getElementById('image-drawer-rotate-right')?.addEventListener('click', () => {
    applyEdit(() => {
      imageDrawerState.rotation = (imageDrawerState.rotation + 90) % 360;
    });
  });
  document.getElementById('image-drawer-flip')?.addEventListener('click', () => {
    applyEdit(() => {
      imageDrawerState.flipH = !imageDrawerState.flipH;
    });
  });

  document.getElementById('image-drawer-open-external')?.addEventListener('click', () => {
    const d = imageDrawerState.download;
    if (d) window.usualDesk.openDownloadFile(d.id).catch(() => {});
  });
  document.getElementById('image-drawer-show-folder')?.addEventListener('click', () => {
    const d = imageDrawerState.download;
    if (d) window.usualDesk.showDownloadInFolder(d.id).catch(() => {});
  });
  document.getElementById('image-drawer-save')?.addEventListener('click', saveImageDrawerEdit);
}

async function refreshChromeCookieImportUi() {
  const section = document.getElementById('chrome-import-section');
  const select = document.getElementById('chrome-import-profile');
  const btn = document.getElementById('chrome-import-btn');
  const statusEl = document.getElementById('chrome-import-status');
  if (!section || !select || !btn || !statusEl) return;

  const api = window.usualDesk;
  if (!api || typeof api.getChromeImportStatus !== 'function') {
    section.classList.add('hidden');
    return;
  }

  let status;
  try {
    status = await api.getChromeImportStatus();
  } catch {
    status = { platformSupported: false, chromeFound: false, chromeRunning: false };
  }

  if (!status.platformSupported) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  if (!status.chromeFound) {
    select.innerHTML = '<option value="">No se encontró Chrome instalado</option>';
    select.disabled = true;
    btn.disabled = true;
    statusEl.textContent = 'No se detectó Google Chrome en este equipo.';
    return;
  }

  let profiles = [];
  try {
    profiles = await api.listChromeProfiles();
  } catch {
    profiles = [];
  }
  if (!Array.isArray(profiles) || profiles.length === 0) {
    profiles = [{ directory: 'Default', name: 'Default', userName: '' }];
  }

  const previous = select.value;
  select.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.directory;
    const labelName = p.name || p.directory;
    opt.textContent = p.userName ? `${labelName} (${p.userName})` : labelName;
    select.appendChild(opt);
  }
  if (previous && profiles.some((p) => p.directory === previous)) {
    select.value = previous;
  }
  select.disabled = false;

  if (status.chromeRunning) {
    btn.disabled = true;
    statusEl.textContent = 'Cerrá Chrome antes de importar (no puede haber procesos chrome.exe abiertos).';
  } else {
    btn.disabled = false;
    statusEl.textContent = '';
  }
}

function initChromeCookieImportUI() {
  const btn = document.getElementById('chrome-import-btn');
  const select = document.getElementById('chrome-import-profile');
  const statusEl = document.getElementById('chrome-import-status');
  if (!btn || !select || !statusEl) return;

  const api = window.usualDesk;
  if (!api || typeof api.importChromeGoogleCookies !== 'function') return;

  btn.addEventListener('click', async () => {
    const profile = select.value || 'Default';
    btn.disabled = true;
    const previousLabel = btn.textContent;
    btn.textContent = 'Importando…';
    statusEl.textContent = 'Lanzando Chrome en segundo plano y leyendo cookies…';
    try {
      const res = await api.importChromeGoogleCookies(profile);
      if (res && res.ok) {
        statusEl.textContent = `Listo. Importadas ${res.imported} cookies de Google (${res.considered} candidatas, ${res.total} totales). Recargá la pestaña para que el sitio las vea.`;
      } else {
        const code = res && res.error ? res.error : 'IMPORT_FAILED';
        statusEl.textContent = friendlyChromeImportError(code);
      }
    } catch (err) {
      console.error('chrome-import-google-cookies', err);
      statusEl.textContent = 'No se pudo completar la importación.';
    } finally {
      btn.textContent = previousLabel;
      refreshChromeCookieImportUi();
    }
  });
}

function friendlyChromeImportError(code) {
  switch (code) {
    case 'CHROME_RUNNING':
      return 'Cerrá todas las ventanas de Chrome y volvé a intentarlo.';
    case 'CHROME_NOT_FOUND':
      return 'No se encontró el ejecutable de Chrome.';
    case 'CHROME_PROFILE_DIR_NOT_FOUND':
      return 'No se encontró la carpeta de perfiles de Chrome (User Data).';
    case 'NOT_SUPPORTED_PLATFORM':
      return 'La importación solo está disponible en Windows.';
    case 'MISSING_PARTITION':
      return 'Error interno: falta el destino de las cookies.';
    default:
      return `No se pudo completar la importación (${code}).`;
  }
}

async function openSettingsModalFromMenu() {
  try {
    const s = await window.usualDesk.getAppSettings();
    syncDockPositionSegmentedUI(s.dockPosition);
    syncSidebarDensitySegmentedUI(s.sidebarDensity);
    applyWebHostModeToDom();
    syncInAppNotificationCheckboxFromSettings(s);
  } catch {
    syncDockPositionSegmentedUI('left');
    syncSidebarDensitySegmentedUI('normal');
    applyWebHostModeToDom();
    syncInAppNotificationCheckboxFromSettings({ inAppWebNotifications: true });
  }
  settingsModalOverlay.classList.remove('hidden');
  refreshChromeCookieImportUi();
  schedulePointerPassthroughSync();
}

function initAppSettingsUI() {
  const seg = document.getElementById('dock-position-segmented');
  const closeBtn = document.getElementById('settings-modal-close');

  seg?.querySelectorAll('.type-segment').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const v = btn.dataset.value;
      if (!v) return;
      try {
        await window.usualDesk.setAppSettings({ dockPosition: v });
      } catch (err) {
        console.error('set-app-settings', err);
      }
      applyDockPositionToDom(v);
      syncDockPositionSegmentedUI(v);
      schedulePointerPassthroughSync();
    });
  });

  const densitySeg = document.getElementById('sidebar-density-segmented');
  densitySeg?.querySelectorAll('.type-segment').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const v = btn.dataset.value;
      if (!v || (v !== 'normal' && v !== 'minimal')) return;
      try {
        await window.usualDesk.setAppSettings({ sidebarDensity: v });
      } catch (err) {
        console.error('set-app-settings sidebarDensity', err);
      }
      applySidebarDensityToDom(v);
      syncSidebarDensitySegmentedUI(v);
      schedulePointerPassthroughSync();
    });
  });

  const inAppNotifyCb = document.getElementById('settings-in-app-notifications');
  inAppNotifyCb?.addEventListener('change', async () => {
    try {
      await window.usualDesk.setAppSettings({ inAppWebNotifications: !!inAppNotifyCb.checked });
    } catch (err) {
      console.error('set-app-settings inAppWebNotifications', err);
    }
  });

  initChromeCookieImportUI();

  const replayBtn = document.getElementById('onboarding-replay-btn');
  replayBtn?.addEventListener('click', async () => {
    if (!window.UsualDeskOnboarding || typeof window.UsualDeskOnboarding.start !== 'function') {
      return;
    }
    closeSettingsModal();
    // El panel ya estaba abierto (estábamos en Internal); aseguramos
    // que siga así por si algún listener lo hubiese colapsado.
    try {
      if (window.usualDesk.expandSidebar) {
        await window.usualDesk.expandSidebar();
      }
    } catch {
      /* no crítico */
    }
    setTimeout(() => {
      try {
        window.UsualDeskOnboarding.start({ preview: true });
      } catch (err) {
        console.error('onboarding-preview-start', err);
      }
    }, 120);
  });

  closeBtn?.addEventListener('click', () => closeSettingsModal());

  settingsModalOverlay?.addEventListener('click', (e) => {
    if (e.target === settingsModalOverlay) closeSettingsModal();
  });

  const appearanceGroup = document.getElementById('appearance-theme-options');
  appearanceGroup?.querySelectorAll('.appearance-theme-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.value;
      if (v !== 'light' && v !== 'dark') return;
      applyCanvasTheme(v);
    });
  });
  document.getElementById('appearance-modal-close')?.addEventListener('click', () => closeAppearanceModal());
  appearanceModalOverlay?.addEventListener('click', (e) => {
    if (e.target === appearanceModalOverlay) closeAppearanceModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (appearanceModalOverlay && !appearanceModalOverlay.classList.contains('hidden')) {
      closeAppearanceModal();
      return;
    }
    if (settingsModalOverlay && !settingsModalOverlay.classList.contains('hidden')) {
      closeSettingsModal();
    }
  });

  window.usualDesk.onAppSettingsChanged((s) => {
    if (s && s.dockPosition) {
      applyDockPositionToDom(s.dockPosition);
      syncDockPositionSegmentedUI(s.dockPosition);
      schedulePointerPassthroughSync();
    }
    if (s && s.sidebarDensity) {
      applySidebarDensityToDom(s.sidebarDensity);
      syncSidebarDensitySegmentedUI(s.sidebarDensity);
    }
    if (s && typeof s.inAppWebNotifications === 'boolean') {
      syncInAppNotificationCheckboxFromSettings(s);
    }
    if (s) {
      applyDockHotkeyLabel(s);
      applyWebHostModeToDom();
      window.usualDesk
        .getOpenWebWindowKeys()
        .then((keys) => {
          openWebWindowKeys = new Set(Array.isArray(keys) ? keys : []);
          updateAllShortcutWebInactiveStates();
        })
        .catch(() => {});
    }
  });
}

function applyDockHotkeyLabel(settings) {
  const keys = settings && Array.isArray(settings.dockHotkey) ? settings.dockHotkey : null;
  const label = keys && keys.length === 3 ? keys.join(' + ') : 'Ctrl + Alt + D';
  const toggle = document.getElementById('toggle-btn');
  if (toggle) {
    toggle.setAttribute(
      'data-tooltip',
      'Abrir o cerrar el panel del dock (clic). Atajo global: si la home o una ventana está al frente, oculta inplaize; si no, trae la última (home o ventana) al frente ('
        + label
        + ')',
    );
  }
  const help = document.getElementById('settings-onboarding-help');
  if (help) {
    help.textContent =
      'Volvé a ver el recorrido guiado: el atajo '
      + label
      + ' y cómo agregar tu primera ventana.';
  }
}

async function loadInitialDockPosition() {
  try {
    const s = await window.usualDesk.getAppSettings();
    applyDockPositionToDom(s.dockPosition);
    syncDockPositionSegmentedUI(s.dockPosition);
    applySidebarDensityToDom(s.sidebarDensity);
    syncSidebarDensitySegmentedUI(s.sidebarDensity);
    applyWebHostModeToDom();
    applyDockHotkeyLabel(s);
  } catch {
    applyDockPositionToDom('left');
    syncDockPositionSegmentedUI('left');
    applySidebarDensityToDom('normal');
    syncSidebarDensitySegmentedUI('normal');
    applyWebHostModeToDom();
  }
}

function isAssetIconPath(v) {
  if (!v || typeof v !== 'string') return false;
  return v.includes('/') || /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(v);
}

function isSiteIconValue(v) {
  return typeof v === 'string' && v.startsWith('data:image/');
}

/** Solo nombre legible, sin extensión ni nombre de archivo */
function formatIconPrettyName(title, file) {
  const stem = title || file.replace(/\.[^.]+$/, '');
  const raw = stem.replace(/[-_]/g, ' ');
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

function allIconRows() {
  return [...iconBuiltinRows, ...iconDynamicExtras];
}

function rowForValue(v) {
  return allIconRows().find((r) => r.value === v);
}

function dropStaleSiteIconRows(keep) {
  iconDynamicExtras = iconDynamicExtras.filter((row) => !isSiteIconValue(row.value) || row.value === keep);
}

function ensureDynamicRowForValue(v) {
  if (!v) return;
  if (rowForValue(v)) return;
  const label = isSiteIconValue(v)
    ? 'Icono del sitio'
    : isAssetIconPath(v)
      ? formatIconPrettyName('', pathBaseName(v))
      : 'Personalizado';
  iconDynamicExtras.push({
    value: v,
    label,
    src: isAssetIconPath(v) ? v : null,
  });
}

function pathBaseName(p) {
  if (!p || typeof p !== 'string') return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

function renderIconList() {
  if (!iconSelectList) return;
  iconSelectList.innerHTML = '';
  const current = (inputIcon && inputIcon.value ? inputIcon.value : '').trim();
  const currentIsEmoji = current.length > 0 && !isAssetIconPath(current);

  allIconRows().forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'icon-select-option';
    li.setAttribute('role', 'option');
    li.dataset.value = entry.value;
    let selected = false;
    if (entry.isEmojiPicker) {
      selected = currentIsEmoji;
    } else {
      selected = entry.value === current;
    }
    li.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) li.classList.add('is-selected');

    if (entry.src) {
      const img = document.createElement('img');
      img.className = 'icon-select-option-thumb';
      img.src = entry.src;
      img.alt = '';
      img.loading = 'lazy';
      li.appendChild(img);
    } else if (entry.isEmojiPicker) {
      const ph = document.createElement('span');
      ph.className = 'icon-select-option-emoji';
      ph.textContent = '😀';
      ph.setAttribute('aria-hidden', 'true');
      li.appendChild(ph);
    } else {
      const ph = document.createElement('span');
      ph.className = 'icon-select-option-empty';
      ph.textContent = '—';
      li.appendChild(ph);
    }
    const span = document.createElement('span');
    span.className = 'icon-select-option-label';
    span.textContent = entry.label;
    li.appendChild(span);

    li.addEventListener('click', (e) => {
      e.stopPropagation();
      onIconOptionChosen(entry.isEmojiPicker ? CUSTOM_EMOJI_VALUE : entry.value);
      closeIconDropdown();
    });
    iconSelectList.appendChild(li);
  });
}

function updateTriggerDisplay() {
  if (!inputIcon || !iconSelectTriggerThumb || !iconSelectTriggerText) return;
  const v = (inputIcon.value || '').trim();
  iconSelectTriggerThumb.innerHTML = '';
  if (!v) {
    iconSelectTriggerText.textContent = faviconLookupPending ? 'Buscando icono…' : 'Sin icono';
    return;
  }
  if (isAssetIconPath(v)) {
    const row = rowForValue(v);
    if (row && row.src) {
      const img = document.createElement('img');
      img.src = row.src;
      img.alt = '';
      iconSelectTriggerThumb.appendChild(img);
    }
    iconSelectTriggerText.textContent = row ? row.label : 'Icono';
    return;
  }
  const span = document.createElement('span');
  span.className = 'icon-select-trigger-emoji';
  span.textContent = v;
  span.setAttribute('aria-hidden', 'true');
  iconSelectTriggerThumb.appendChild(span);
  iconSelectTriggerText.textContent = 'Personalizado';
}

function setCustomEmojiPanel(visible) {
  const wrap = document.getElementById('icon-custom-emoji-wrap');
  const inp = document.getElementById('input-custom-emoji');
  if (!wrap || !inp) return;
  wrap.classList.toggle('hidden', !visible);
  if (visible) {
    inp.value = (inputIcon && inputIcon.value && !isAssetIconPath(inputIcon.value.trim())
      ? inputIcon.value.trim()
      : '');
    requestAnimationFrame(() => inp.focus());
  } else {
    inp.value = '';
  }
}

function openIconDropdown() {
  if (!iconSelectList || !iconSelectTrigger) return;
  iconDropdownOpen = true;
  iconSelectList.classList.remove('hidden');
  iconSelectTrigger.setAttribute('aria-expanded', 'true');
  renderIconList();
}

function closeIconDropdown() {
  if (!iconSelectList || !iconSelectTrigger) return;
  iconDropdownOpen = false;
  iconSelectList.classList.add('hidden');
  iconSelectTrigger.setAttribute('aria-expanded', 'false');
}

function onDocumentPointerDown(e) {
  if (!iconDropdownOpen || !iconSelectWrap) return;
  if (iconSelectWrap.contains(e.target)) return;
  closeIconDropdown();
}

async function initIconPicker() {
  if (iconPickerReady) return;
  iconPickerReady = true;
  let icons = [];
  try {
    icons = await window.usualDesk.listBuiltinIcons();
  } catch (err) {
    console.error('list-builtin-icons', err);
  }
  iconBuiltinRows = [
    { value: '', label: 'Sin icono', src: null },
    ...icons.map(({ relPath, title, file }) => ({
      value: relPath,
      label: formatIconPrettyName(title, file),
      src: relPath,
    })),
    {
      value: CUSTOM_EMOJI_VALUE,
      label: 'Personalizado (emoji)',
      src: null,
      isEmojiPicker: true,
    },
  ];
  iconDynamicExtras = [];
  renderIconList();
  updateTriggerDisplay();

  const customEmojiInp = document.getElementById('input-custom-emoji');
  if (customEmojiInp) {
    customEmojiInp.addEventListener('input', () => {
      let t = customEmojiInp.value.trim().slice(0, 8);
      customEmojiInp.value = t;
      if (!inputIcon) return;
      faviconSeq += 1;
      if (faviconTimer) {
        clearTimeout(faviconTimer);
        faviconTimer = null;
      }
      if (!t) {
        suppressAutoFavicon = false;
        autoFaviconValue = '';
        scheduleWebFaviconLookup();
      } else {
        suppressAutoFavicon = true;
      }
      inputIcon.value = t;
      ensureDynamicRowForValue(t);
      updateTriggerDisplay();
      if (iconDropdownOpen) renderIconList();
    });
  }

  if (iconSelectTrigger) {
    iconSelectTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (iconDropdownOpen) {
        closeIconDropdown();
      } else {
        ensureDynamicRowForValue((inputIcon && inputIcon.value ? inputIcon.value : '').trim());
        openIconDropdown();
      }
    });
  }
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (shortcutReorder) return;
    if (iconDropdownOpen) {
      closeIconDropdown();
      return;
    }
    if (modalOverlay && !modalOverlay.classList.contains('hidden')) {
      closeModal();
    }
  });
}

function trimIconSelectToBuiltin() {
  iconDynamicExtras = [];
  if (iconDropdownOpen) closeIconDropdown();
  renderIconList();
}

function setSelectedIcon(iconPath) {
  if (!inputIcon) return;
  const raw = iconPath || '';
  const v = raw.trim();

  if (v === CUSTOM_EMOJI_VALUE) {
    setCustomEmojiPanel(true);
    if (isAssetIconPath((inputIcon.value || '').trim())) {
      inputIcon.value = '';
    }
    updateTriggerDisplay();
    renderIconList();
    return;
  }

  ensureDynamicRowForValue(v);
  inputIcon.value = v;
  if (v && !isAssetIconPath(v)) {
    setCustomEmojiPanel(true);
  } else {
    setCustomEmojiPanel(false);
  }
  renderIconList();
  updateTriggerDisplay();
}

function cancelFaviconLookup() {
  faviconSeq += 1;
  faviconLookupPending = false;
  if (faviconTimer) {
    clearTimeout(faviconTimer);
    faviconTimer = null;
  }
}

function scheduleWebFaviconLookup() {
  if (faviconTimer) clearTimeout(faviconTimer);
  faviconTimer = null;
  if (suppressAutoFavicon) return;
  if (!inputType || inputType.value !== 'web' || !inputUrl) return;
  if (!inputUrl.value.trim()) return;
  faviconTimer = setTimeout(() => {
    faviconTimer = null;
    lookupWebFavicon().catch(() => {});
  }, 700);
}

async function lookupWebFavicon() {
  if (suppressAutoFavicon) return null;
  if (!inputType || inputType.value !== 'web' || !inputUrl) return null;
  const raw = inputUrl.value.trim();
  if (!raw) return null;
  const current = inputIcon && inputIcon.value ? inputIcon.value.trim() : '';
  if (current && current !== autoFaviconValue) return null;
  const seq = ++faviconSeq;
  faviconLookupPending = true;
  if (!current) updateTriggerDisplay();
  const pending = window.usualDesk.fetchWebFavicon(raw).catch(() => null);
  faviconWait = pending;
  let result = null;
  try {
    result = await pending;
  } finally {
    if (faviconWait === pending) faviconWait = null;
  }
  if (seq !== faviconSeq) return null;
  faviconLookupPending = false;
  const dataUrl = result && typeof result.dataUrl === 'string' ? result.dataUrl : '';
  if (!dataUrl.startsWith('data:image/')) {
    updateTriggerDisplay();
    return null;
  }
  if (!inputType || inputType.value !== 'web') return null;
  const now = inputIcon && inputIcon.value ? inputIcon.value.trim() : '';
  if (now && now !== autoFaviconValue) return null;
  dropStaleSiteIconRows(dataUrl);
  autoFaviconValue = dataUrl;
  setSelectedIcon(dataUrl);
  return dataUrl;
}

function onIconOptionChosen(next) {
  cancelFaviconLookup();
  if (next === CUSTOM_EMOJI_VALUE) {
    suppressAutoFavicon = true;
    setSelectedIcon(next);
    return;
  }
  if (!next) {
    suppressAutoFavicon = false;
    autoFaviconValue = '';
    setSelectedIcon('');
    scheduleWebFaviconLookup();
    return;
  }
  if (next !== autoFaviconValue) suppressAutoFavicon = true;
  setSelectedIcon(next);
}

function setTitleBadgeOnCard(shortcutId, count) {
  if (count == null || count < 1) {
    delete titleBadges[shortcutId];
  } else {
    titleBadges[shortcutId] = count;
  }
  const card = shortcutsContainer.querySelector(`.shortcut-card[data-shortcut-id="${shortcutId}"]`);
  if (!card) return;
  const badge = card.querySelector('.shortcut-badge');
  if (!badge) return;
  const n = titleBadges[shortcutId];
  if (n == null) {
    badge.hidden = true;
    badge.textContent = '';
    badge.removeAttribute('aria-label');
    badge.setAttribute('aria-hidden', 'true');
  } else {
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = false;
    badge.setAttribute('aria-label', `${n} notificaciones`);
    badge.setAttribute('aria-hidden', 'false');
  }
}

async function exitDockShortcutEditModeFromChrome() {
  if (!shortcutsEditMode) {
    try {
      await window.usualDesk.collapseSidebar();
    } catch {
      /* noop */
    }
    return;
  }
  shortcutsEditMode = false;
  closeModal();
  try {
    await window.usualDesk.collapseSidebar();
  } catch {
    /* noop */
  }
}

async function init() {
  await loadInitialDockPosition();
  shortcuts = await window.usualDesk.getShortcuts();
  let migrated = false;
  for (const s of shortcuts) {
    if (s.type === 'web' && (!s.sessionId || typeof s.sessionId !== 'string' || !s.sessionId.trim())) {
      s.sessionId = webSessionIdForShortcut(s.name, s.id);
      migrated = true;
    }
  }
  if (migrated) {
    await window.usualDesk.saveShortcuts(shortcuts);
  }
  await initIconPicker();
  await refreshOpenWebWindowKeys();
  renderShortcuts();
  initAppSettingsUI();
  initDockInAppToasts();
  initDownloadsUI();
  initImageDrawer();
  initFooter();
  initDockHomeMenu();
  schedulePointerPassthroughSync();
  maybeStartOnboarding();
  if (typeof window.usualDesk.onDockOpenWelcomeHome === 'function') {
    window.usualDesk.onDockOpenWelcomeHome((view) => {
      goToDockWelcomeHome(view === 'downloads' ? 'downloads' : 'todos').catch(() => {});
    });
  }
  window.usualDesk.onShortcutTitleBadge(({ shortcutId, count }) => {
    setTitleBadgeOnCard(shortcutId, count);
  });
  window.usualDesk.onOpenWebWindowKeys((keys) => {
    openWebWindowKeys = new Set(Array.isArray(keys) ? keys : []);
    updateAllShortcutWebInactiveStates();
    // Las cerraduras de arrastre sólo valen para ventanas abiertas; repintamos
    // para re-enlazar los gestos en base al nuevo set de aperturas.
    renderShortcuts();
  });
  if (window.usualDesk.onFocusModeChanged) {
    window.usualDesk.onFocusModeChanged((state) => applyFocusModeStateToDock(state));
  }
  if (window.usualDesk.getFocusModeState) {
    try {
      const state = await window.usualDesk.getFocusModeState();
      applyFocusModeStateToDock(state);
    } catch {
      /* noop */
    }
  }
  if (window.usualDesk.onOpenShortcutEditor) {
    window.usualDesk.onOpenShortcutEditor((payload) => {
      const raw = payload && payload.shortcutId != null ? String(payload.shortcutId).trim() : '';
      shortcutsEditMode = true;
      const s = raw ? shortcuts.find((x) => String(x.id) === raw) : null;
      if (s) {
        openEditModal(s);
      } else {
        renderShortcuts();
      }
    });
  }
  if (window.usualDesk.onExitShortcutEditMode) {
    window.usualDesk.onExitShortcutEditMode(() => {
      exitDockShortcutEditModeFromChrome().catch(() => {});
    });
  }
}

function applyFocusModeStateToDock(state) {
  const active = !!(state && state.active);
  const members = state && Array.isArray(state.members) ? state.members : [];
  focusModeState = { active, members: new Set(members) };
  document.documentElement.classList.toggle('focus-mode-active', active);
  syncWebMutedCheckboxesLockedByFocusMode();
  updateAllShortcutFocusMemberStates();
}

/**
 * Onboarding de primera vez. Solo se dispara si el usuario nunca lo terminó
 * Y la lista de shortcuts está vacía: así no molestamos a usuarios que ya
 * tenían el dock configurado y vienen de una versión previa.
 */
async function maybeStartOnboarding() {
  if (!window.UsualDeskOnboarding || typeof window.UsualDeskOnboarding.start !== 'function') {
    return;
  }
  if (shortcuts.length > 0) return;
  let settings = null;
  try {
    settings = await window.usualDesk.getAppSettings();
  } catch {
    /* sin settings asumimos onboarding pendiente: estado por defecto */
  }
  if (settings && settings.onboardingCompleted === true) return;
  // En topbar la ventana del dock arranca de 4 px de alto: el overlay no se
  // vería. Expandimos el panel para que el usuario tenga lienzo completo
  // donde leer el bocadillo y el spotlight pueda dibujarse libre.
  try {
    if (window.usualDesk.expandSidebar) {
      await window.usualDesk.expandSidebar();
    }
  } catch {
    /* si falla, igualmente intentamos arrancar el wizard */
  }
  // Diferimos un tick para que el primer paint de la barra ya esté listo y
  // las posiciones de #toggle-btn sean estables al medirlas.
  setTimeout(() => {
    try {
      window.UsualDeskOnboarding.start();
    } catch (err) {
      console.error('onboarding-start', err);
    }
  }, 250);
}

document.addEventListener(
  'pointermove',
  (e) => {
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    schedulePointerPassthroughSync();
  },
  { passive: true },
);

document.addEventListener('inplaize-doc-modal', () => {
  lastPassthroughIgnore = null;
  syncPointerPassthrough(lastPointer.x, lastPointer.y);
});

function suggestNameFromPath(filePath) {
  const normalized = filePath.replace(/\//g, '\\');
  const parts = normalized.split('\\');
  const base = parts[parts.length - 1] || '';
  return base.replace(/\.(exe|lnk|app)$/i, '') || base || 'App';
}

/** Primera URL http(s) en un drag desde Chrome, Edge, etc. */
function extractHttpUrlFromDataTransfer(dt) {
  if (!dt) return null;
  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const cell = t.split('\t')[0].trim();
      try {
        const u = new URL(cell);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
      } catch {
        if (/^https?:\/\//i.test(cell)) return cell;
      }
    }
  }
  const plain = dt.getData('text/plain');
  if (plain) {
    const first = plain.split(/\r?\n/)[0].trim();
    try {
      const u = new URL(first);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch {
      const m = plain.match(/\bhttps?:\/\/[^\s<>"']+/i);
      if (m) return m[0];
    }
  }
  const html = dt.getData('text/html');
  if (html) {
    const m = html.match(/\bhttps?:\/\/[^\s"'<>]+/i);
    if (m) return m[0];
  }
  return null;
}

function normalizeUrlKey(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return href.trim().toLowerCase();
  }
}

/** Igual que main/open-shortcut.js + session-partition (ventanas web abiertas). */
function partitionStringForWebWindowKey(shortcut) {
  const id = normalizeSessionId(shortcut.sessionId || '');
  if (!id) return 'persist:dock-default';
  return `persist:${id}`;
}

function webShortcutMapKey(shortcut) {
  if (!shortcut || shortcut.type !== 'web') return '';
  return `${partitionStringForWebWindowKey(shortcut)}::${normalizeUrlKey(shortcut.url)}`;
}

async function refreshOpenWebWindowKeys() {
  try {
    const keys = await window.usualDesk.getOpenWebWindowKeys();
    openWebWindowKeys = new Set(Array.isArray(keys) ? keys : []);
  } catch {
    openWebWindowKeys = new Set();
  }
}

function applyWebInactiveClassToCard(card, shortcut) {
  if (!card || !shortcut) return;
  if (shortcut.type !== 'web') {
    card.classList.remove('shortcut-web-inactive');
    return;
  }
  card.classList.toggle('shortcut-web-inactive', !openWebWindowKeys.has(webShortcutMapKey(shortcut)));
}

function updateAllShortcutWebInactiveStates() {
  shortcutsContainer.querySelectorAll('.shortcut-card[data-shortcut-id]').forEach((card) => {
    const id = card.dataset.shortcutId;
    const s = shortcuts.find((x) => x.id === id);
    applyWebInactiveClassToCard(card, s);
  });
}

/** Misma regla que en main/session-partition.js (solo a-z, 0-9, guion). */
function normalizeSessionId(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 64);
}

/**
 * Slug para partición web. Debe coincidir con main/session-partition.js.
 * Solo se usa al crear un acceso web o para rellenar sessionId ausente (migración);
 * el nombre visible puede cambiar sin tocar sessionId guardado.
 */
function sessionIdFromName(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalizeSessionId(slug);
}

/**
 * Asigna sessionId inicial (o migración). No recalcular desde el nombre al renombrar.
 * Si el nombre no produce slug válido, usa id del acceso para no mezclar particiones.
 */
function webSessionIdForShortcut(name, shortcutId) {
  const sid = sessionIdFromName(name);
  if (sid) return sid;
  const raw = `id-${shortcutId}`;
  return normalizeSessionId(raw.replace(/[^a-z0-9-]/g, '')) || String(raw).slice(0, 64);
}

function isNameTaken(name, excludeId) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return false;
  return shortcuts.some(
    (s) => s.id !== excludeId && s.name.trim().toLowerCase() === n,
  );
}

function ensureUniqueDisplayName(base) {
  let name = (base || 'Web').trim() || 'Web';
  let candidate = name;
  let i = 2;
  while (shortcuts.some((s) => s.name.trim().toLowerCase() === candidate.toLowerCase())) {
    candidate = `${name} (${i})`;
    i += 1;
  }
  return candidate;
}

function suggestNameFromUrl(href) {
  try {
    const host = new URL(href).hostname || '';
    return host.replace(/^www\./i, '') || 'Web';
  } catch {
    return 'Web';
  }
}

function staysInDockDropZones(node) {
  return node && node.nodeType === 1 && !!(node.closest('#sidebar') || node.closest('#toggle-area'));
}

async function ensureSidebarOpen() {
  if (sidebar.classList.contains('open')) return;
  await window.usualDesk.expandSidebar();
  updateSidebarUI(true);
}

async function addShortcutFromDroppedUrl(url) {
  const key = normalizeUrlKey(url);
  const name = ensureUniqueDisplayName(suggestNameFromUrl(url));
  if (
    shortcuts.some(
      (s) =>
        s.type === 'web' &&
        normalizeUrlKey(s.url) === key &&
        s.name.trim().toLowerCase() === name.trim().toLowerCase(),
    )
  ) {
    return;
  }

  const id = Date.now().toString();
  let icon = '';
  try {
    const fav = await window.usualDesk.fetchWebFavicon(url);
    if (fav && typeof fav.dataUrl === 'string' && fav.dataUrl.startsWith('data:image/')) {
      icon = fav.dataUrl;
    }
  } catch {
    /* sin red o sin favicon: queda la inicial del nombre */
  }
  const entry = {
    id,
    name,
    type: 'web',
    url,
    sessionId: webSessionIdForShortcut(name, id),
  };
  if (icon) entry.icon = icon;
  shortcuts.push(entry);
  await window.usualDesk.saveShortcuts(shortcuts);
  renderShortcuts();
}

/** ¿El drag en curso lleva archivos locales (p. ej. desde el Explorador)? */
function isFileDrag(e) {
  const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
  // En Windows el Explorador suele incluir Files y text/uri-list (file://…).
  // Los drags de URL desde el navegador traen text/uri-list pero no Files.
  return types.includes('Files');
}

function getDroppedFilePaths(e) {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length || typeof window.usualDesk.getPathForFile !== 'function') return [];
  return files.map((f) => window.usualDesk.getPathForFile(f)).filter(Boolean);
}

async function ingestDroppedFilesFromEvent(e) {
  const paths = getDroppedFilePaths(e);
  if (!paths.length || typeof window.usualDesk.ingestDroppedFiles !== 'function') return false;
  await goToDockWelcomeHome('downloads');
  await window.usualDesk.ingestDroppedFiles(paths);
  return true;
}

/**
 * Spring-loading al arrastrar un archivo sobre el icono de una pestaña: trae
 * (o abre) la ventana de ese acceso y aparta el dock —colapsa el panel y deja
 * pasar el mouse— para que el usuario pueda soltar el archivo directamente
 * dentro de la página (p. ej. adjuntarlo en WhatsApp Web).
 */
async function springLoadShortcutForFileDrag(shortcut) {
  try {
    window.usualDesk.openShortcut(shortcut);
  } catch {
    /* noop */
  }
  try {
    await window.usualDesk.collapseSidebar();
  } catch {
    /* noop */
  }
  updateSidebarUI(false);
  closeImageDrawer();
  // El drag nativo sigue en curso: el dock no recibe mousemove hasta soltar,
  // así que forzamos passthrough para que el drop llegue a la ventana de abajo.
  lastPassthroughIgnore = true;
  window.usualDesk.setIgnoreMouse(true);
}

const FILE_DRAG_SPRING_DELAY_MS = 300;

/** Engancha el spring-loading de archivos sobre un card de acceso web. */
function bindFileDragSpringTarget(card, shortcut) {
  if (shortcut.type !== 'web') return;
  let springTimer = null;

  const cancel = () => {
    if (springTimer) {
      clearTimeout(springTimer);
      springTimer = null;
    }
    card.classList.remove('file-drag-hover');
  };

  card.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    card.classList.add('file-drag-hover');
    if (!springTimer) {
      springTimer = setTimeout(() => {
        springTimer = null;
        card.classList.remove('file-drag-hover');
        springLoadShortcutForFileDrag(shortcut);
      }, FILE_DRAG_SPRING_DELAY_MS);
    }
  });
  card.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch {
      /* ignore */
    }
  });
  card.addEventListener('dragleave', cancel);
  // Soltar sobre el icono: no podemos inyectar el archivo en la página, pero
  // al menos traemos la ventana al frente para que el próximo intento sea ahí.
  card.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
    ingestDroppedFilesFromEvent(e).catch(() => {});
  });
}

function bindUrlDropTargets() {
  const zones = [sidebar, toggleArea];
  const setHighlight = (on) => {
    sidebar.classList.toggle('drop-target-active', on);
    toggleArea.classList.toggle('drop-target-active', on);
  };

  function onDragEnter(e) {
    if (isFileDrag(e)) return; // los archivos se manejan por tile/spring-loading
    e.preventDefault();
    setDragOperationActive(true);
    setHighlight(true);
  }

  function onDragOver(e) {
    if (isFileDrag(e)) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch {
      /* ignore */
    }
  }

  function onDragLeave(e) {
    if (staysInDockDropZones(e.relatedTarget)) return;
    setHighlight(false);
    setDragOperationActive(false);
  }

  async function onDrop(e) {
    if (isFileDrag(e)) return;
    e.preventDefault();
    setHighlight(false);
    const url = extractHttpUrlFromDataTransfer(e.dataTransfer);
    if (url) {
      await ensureSidebarOpen();
      await addShortcutFromDroppedUrl(url);
    }
    setDragOperationActive(false);
  }

  zones.forEach((el) => {
    el.addEventListener('dragenter', onDragEnter);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
  });

  // Red de seguridad: si el navegador termina el drag fuera del dock (Alt+Tab,
  // drop sobre otra app, Escape) sin disparar dragleave/drop, igual liberamos
  // el passthrough para que el dock vuelva a dejar pasar los clics.
  const releaseDrag = () => {
    if (dragOperationActive) {
      setHighlight(false);
      setDragOperationActive(false);
    }
  };
  window.addEventListener('dragend', releaseDrag);
  window.addEventListener('mouseup', releaseDrag);
  window.addEventListener('blur', releaseDrag);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') releaseDrag();
  });
}

/** ¿El destino del drop debe ignorarse para la ingesta a Descargas? */
function shouldSkipFileDropTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return !!target.closest(
    '.magic-zone, .magic-drawer, .loose-nav-bar, .doc-modal-overlay, '
    + '#dock-inline-editor, .modal, .download-tile',
  );
}

/**
 * Soltar archivos en el dock los copia a la carpeta Descargas y los muestra
 * en el home (excepto sobre cajones mágicos, accesos directos, etc.).
 */
function bindFileDropToDownloads() {
  const downloadsHome = document.getElementById('downloads-home');
  const dockHomePanel = document.getElementById('dock-home-panel');
  let fileDragActive = false;

  const setFileDragHighlight = (on) => {
    fileDragActive = on === true;
    downloadsHome?.classList.toggle('is-file-drag-over', fileDragActive);
    dockHomePanel?.classList.toggle('is-file-drag-over', fileDragActive);
  };

  const releaseFileDrag = () => {
    if (!fileDragActive) return;
    setFileDragHighlight(false);
    setDragOperationActive(false);
  };

  async function ingestDroppedFiles(e) {
    await ingestDroppedFilesFromEvent(e);
  }

  function onDragEnter(e) {
    if (!isFileDrag(e)) return;
    if (shouldSkipFileDropTarget(e.target)) return;
    e.preventDefault();
    setFileDragHighlight(true);
    setDragOperationActive(true);
  }

  function onDragOver(e) {
    if (!isFileDrag(e)) return;
    if (shouldSkipFileDropTarget(e.target)) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch {
      /* ignore */
    }
  }

  function onDragLeave(e) {
    if (!isFileDrag(e)) return;
    if (e.relatedTarget && document.contains(e.relatedTarget)) return;
    releaseFileDrag();
  }

  async function onDrop(e) {
    if (!isFileDrag(e)) return;
    if (shouldSkipFileDropTarget(e.target)) return;
    e.preventDefault();
    releaseFileDrag();
    await ingestDroppedFiles(e);
  }

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  // Evita el cursor prohibido sobre la franja de iconos (webkit-app-region: drag).
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch {
      /* ignore */
    }
  }, true);
  window.addEventListener('dragend', releaseFileDrag);
  window.addEventListener('mouseup', releaseFileDrag);
  window.addEventListener('blur', releaseFileDrag);
}

function syncTypeSegments() {
  const seg = document.getElementById('type-segmented');
  if (!seg || !inputType) return;
  const v = inputType.value;
  seg.querySelectorAll('.type-segment').forEach((btn) => {
    const checked = btn.dataset.value === v;
    btn.setAttribute('aria-checked', checked ? 'true' : 'false');
    btn.classList.toggle('is-selected', checked);
  });
}

function updateFormTypeUI() {
  syncTypeSegments();
  const isApp = inputType.value === 'app';
  browseGroup.classList.toggle('hidden', !isApp);
  labelUrl.textContent = isApp ? 'Ruta (.exe o .lnk)' : 'URL';
  inputUrl.placeholder = isApp
    ? 'C:\\Ruta\\app.exe o pulsa «Buscar…»'
    : 'https://ejemplo.com';
  if (shortcutWebOptions) {
    shortcutWebOptions.classList.toggle('hidden', isApp);
  }
  syncWebMutedCheckboxesLockedByFocusMode();
  if (!isApp) {
    scheduleWebFaviconLookup();
  } else if (inputIcon && (inputIcon.value || '').trim() === autoFaviconValue && autoFaviconValue) {
    autoFaviconValue = '';
    setSelectedIcon('');
  }
}

/**
 * Mientras Modo Foco esté activo, el audio y las notificaciones de cada
 * shortcut web están decididos por la colección y no por los checkboxes.
 * Los deshabilitamos en el formulario para no prometer una acción que el
 * estado de foco está ignorando (y se restaurará al salir del modo foco).
 */
function syncWebMutedCheckboxesLockedByFocusMode() {
  const locked = !!focusModeState.active;
  const applyLock = (el) => {
    if (!el) return;
    el.disabled = locked;
    const label = el.closest('label');
    if (label) {
      label.classList.toggle('is-locked-by-focus-mode', locked);
      if (locked) {
        label.setAttribute(
          'data-tooltip',
          'Desactiva Modo foco para cambiar audio y notificaciones de este acceso',
        );
      } else {
        label.removeAttribute('data-tooltip');
      }
    }
  };
  applyLock(inputWebNotificationsMuted);
  applyLock(inputWebAudioMuted);
}

function bindTypeSegmented() {
  const seg = document.getElementById('type-segmented');
  if (!seg) return;
  seg.querySelectorAll('.type-segment').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.value;
      if (inputType.value === v) return;
      inputType.value = v;
      updateFormTypeUI();
    });
  });
}

const SHORTCUT_EDIT_PENCIL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4.2L19.4 8.8a2.2 2.2 0 0 0-3.1-3.1L5.1 16.9V20z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.6 6.4l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const SHORTCUT_EDIT_TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 7h15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 7V5.4A1.4 1.4 0 0 1 10.4 4h3.2A1.4 1.4 0 0 1 15 5.4V7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M7.4 7l.7 12.1a1.4 1.4 0 0 0 1.4 1.3h5a1.4 1.4 0 0 0 1.4-1.3L16.6 7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

function shortcutEditActionsMarkup(name) {
  const label = escapeAttr((name || '').trim() || 'acceso');
  return (
    '<span class="shortcut-edit-actions">' +
    `<button type="button" class="shortcut-edit-action shortcut-edit-pencil" data-tooltip="Editar" data-tooltip-placement="bottom" aria-label="Editar ${label}">${SHORTCUT_EDIT_PENCIL_SVG}</button>` +
    `<button type="button" class="shortcut-edit-action shortcut-edit-trash" data-tooltip="Eliminar" data-tooltip-placement="bottom" aria-label="Eliminar ${label}">${SHORTCUT_EDIT_TRASH_SVG}</button>` +
    '</span>'
  );
}

function shortcutCardsInStrip() {
  if (!shortcutsContainer) return [];
  return [...shortcutsContainer.querySelectorAll('.shortcut-card[data-shortcut-id]')];
}

function commitShortcutOrderFromDom() {
  const ids = shortcutCardsInStrip().map((el) => el.dataset.shortcutId);
  const byId = new Map(shortcuts.map((item) => [String(item.id), item]));
  const next = [];
  for (const id of ids) {
    const item = byId.get(String(id));
    if (item) next.push(item);
  }
  if (next.length !== shortcuts.length) return false;
  const changed = next.some((item, index) => item !== shortcuts[index]);
  if (!changed) return false;
  shortcuts = next;
  return true;
}

function restoreShortcutDomOrder(ids) {
  if (!shortcutsContainer || !Array.isArray(ids)) return;
  const addBtn = document.getElementById('strip-add-shortcut');
  const byId = new Map();
  shortcutCardsInStrip().forEach((el) => {
    byId.set(el.dataset.shortcutId, el);
  });
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) continue;
    if (addBtn && addBtn.parentElement === shortcutsContainer) {
      shortcutsContainer.insertBefore(el, addBtn);
    } else {
      shortcutsContainer.appendChild(el);
    }
  }
}

function positionReorderGhost(session) {
  if (!session.ghost) return;
  const dx = session.lastX - session.startX;
  const dy = session.lastY - session.startY;
  session.ghost.style.left = `${Math.round(session.originLeft + dx)}px`;
  session.ghost.style.top = `${Math.round(session.originTop + dy)}px`;
}

function autoScrollShortcutsForReorder(x, y) {
  if (!shortcutsContainer) return;
  const rect = shortcutsContainer.getBoundingClientRect();
  const edge = 32;
  const maxStep = 16;
  if (isDockTopbarLayout()) {
    if (x < rect.left + edge) {
      const t = Math.min(1, (rect.left + edge - x) / edge);
      shortcutsContainer.scrollLeft -= Math.ceil(maxStep * t);
    } else if (x > rect.right - edge) {
      const t = Math.min(1, (x - (rect.right - edge)) / edge);
      shortcutsContainer.scrollLeft += Math.ceil(maxStep * t);
    }
    return;
  }
  if (y < rect.top + edge) {
    const t = Math.min(1, (rect.top + edge - y) / edge);
    shortcutsContainer.scrollTop -= Math.ceil(maxStep * t);
  } else if (y > rect.bottom - edge) {
    const t = Math.min(1, (y - (rect.bottom - edge)) / edge);
    shortcutsContainer.scrollTop += Math.ceil(maxStep * t);
  }
}

function placeShortcutCardAtPointer(card, x, y) {
  const cards = shortcutCardsInStrip().filter((el) => el !== card);
  if (!cards.length || !card.parentElement) return;
  const horizontal = isDockTopbarLayout();
  let best = cards[0];
  let bestDist = Infinity;
  for (const other of cards) {
    const rect = other.getBoundingClientRect();
    const cx = Math.max(rect.left, Math.min(x, rect.right));
    const cy = Math.max(rect.top, Math.min(y, rect.bottom));
    const dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = other;
    }
  }
  const rect = best.getBoundingClientRect();
  const sameRow = y >= rect.top && y <= rect.bottom;
  const before = horizontal || sameRow ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2;
  const parent = card.parentElement;
  if (before) {
    if (card.nextElementSibling === best) return;
    parent.insertBefore(card, best);
    return;
  }
  const after = best.nextElementSibling;
  if (after === card) return;
  if (after) parent.insertBefore(card, after);
  else parent.appendChild(card);
}

function finishShortcutReorder(session, opts) {
  if (!session || shortcutReorder !== session) return;
  shortcutReorder = null;
  const save = !!(opts && opts.save);
  const restore = !!(opts && opts.restore);
  window.removeEventListener('pointermove', session.onMove);
  window.removeEventListener('pointerup', session.onUp);
  window.removeEventListener('pointercancel', session.onUp);
  window.removeEventListener('keydown', session.onKey);
  window.removeEventListener('blur', session.onBlur);
  if (session.raf) cancelAnimationFrame(session.raf);
  session.raf = 0;
  session.active = false;
  if (session.ghost) {
    session.ghost.remove();
    session.ghost = null;
  }
  if (session.card) {
    session.card.classList.remove('reorder-placeholder');
    session.card.removeAttribute('aria-grabbed');
    try {
      session.card.releasePointerCapture(session.pointerId);
    } catch {
      /* el puntero ya se soltó */
    }
  }
  if (shortcutsContainer) shortcutsContainer.classList.remove('reorder-active');
  document.documentElement.classList.remove('is-shortcut-reordering');
  if (restore && session.originalIds) restoreShortcutDomOrder(session.originalIds);
  const changed = save ? commitShortcutOrderFromDom() : false;
  setDragOperationActive(false);
  if (changed && window.usualDesk && window.usualDesk.saveShortcuts) {
    window.usualDesk.saveShortcuts(shortcuts).catch((err) => {
      console.error('shortcut-order', err);
    });
  }
}

function activateShortcutReorder(session) {
  if (session.active || !session.card) return;
  session.active = true;
  session.originalIds = shortcutCardsInStrip().map((el) => el.dataset.shortcutId);
  const rect = session.card.getBoundingClientRect();
  session.originLeft = rect.left;
  session.originTop = rect.top;
  const ghost = session.card.cloneNode(true);
  ghost.classList.add('reorder-ghost');
  ghost.classList.remove('reorder-placeholder');
  ghost.querySelectorAll('.shortcut-badge').forEach((el) => el.remove());
  ghost.removeAttribute('data-tooltip');
  ghost.removeAttribute('data-onboarding-target');
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);
  session.ghost = ghost;
  session.card.classList.add('reorder-placeholder');
  session.card.setAttribute('aria-grabbed', 'true');
  shortcutsContainer.classList.add('reorder-active');
  document.documentElement.classList.add('is-shortcut-reordering');
  setDragOperationActive(true);
  const loop = () => {
    if (shortcutReorder !== session || !session.active) return;
    positionReorderGhost(session);
    autoScrollShortcutsForReorder(session.lastX, session.lastY);
    placeShortcutCardAtPointer(session.card, session.lastX, session.lastY);
    session.raf = requestAnimationFrame(loop);
  };
  session.raf = requestAnimationFrame(loop);
}

function onShortcutReorderMove(session, event) {
  if (shortcutReorder !== session || event.pointerId !== session.pointerId) return;
  session.lastX = event.clientX;
  session.lastY = event.clientY;
  if (!session.active) {
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (dx * dx + dy * dy < 25) return;
    activateShortcutReorder(session);
  }
  if (event.cancelable) event.preventDefault();
}

function onShortcutReorderEnd(session, event) {
  if (shortcutReorder !== session) return;
  if (event && event.pointerId != null && event.pointerId !== session.pointerId) return;
  const didDrag = session.active === true;
  if (didDrag) {
    shortcutReorderSuppressClicksUntil = Date.now() + 500;
    if (typeof session.suppressClick === 'function') session.suppressClick();
  }
  finishShortcutReorder(session, { save: didDrag, restore: false });
}

function bindShortcutReorder(card, suppressClick) {
  card.addEventListener('pointerdown', (event) => {
    if (!shortcutsEditMode || event.button !== 0) return;
    if (event.target.closest && event.target.closest('.shortcut-edit-action')) return;
    if (shortcutReorder) return;
    const session = {
      card,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      originLeft: 0,
      originTop: 0,
      active: false,
      ghost: null,
      originalIds: null,
      raf: 0,
      suppressClick,
    };
    session.onMove = (ev) => onShortcutReorderMove(session, ev);
    session.onUp = (ev) => onShortcutReorderEnd(session, ev);
    session.onKey = (ev) => {
      if (ev.key !== 'Escape' || shortcutReorder !== session) return;
      ev.preventDefault();
      finishShortcutReorder(session, { save: false, restore: session.active === true });
    };
    session.onBlur = () => {
      if (shortcutReorder !== session) return;
      finishShortcutReorder(session, { save: session.active === true, restore: false });
    };
    shortcutReorder = session;
    window.addEventListener('pointermove', session.onMove);
    window.addEventListener('pointerup', session.onUp);
    window.addEventListener('pointercancel', session.onUp);
    window.addEventListener('keydown', session.onKey);
    window.addEventListener('blur', session.onBlur);
    try {
      card.setPointerCapture(event.pointerId);
    } catch {
      /* sin captura igual seguimos con los listeners de window */
    }
  });
}

async function deleteShortcutById(id) {
  if (id == null || id === '') return;
  if (shortcutReorder) {
    finishShortcutReorder(shortcutReorder, { save: false, restore: true });
  }
  const sid = String(id);
  Object.keys(titleBadges).forEach((key) => {
    if (String(key) === sid) delete titleBadges[key];
  });
  if (!shortcuts.some((item) => String(item.id) === sid)) return;
  shortcuts = shortcuts.filter((item) => String(item.id) !== sid);
  await window.usualDesk.saveShortcuts(shortcuts);
  if (editingId != null && String(editingId) === sid) {
    closeModal();
    return;
  }
  renderShortcuts();
}

function bindShortcutEditActions(card, shortcut, suppressClick) {
  const pencil = card.querySelector('.shortcut-edit-pencil');
  const trash = card.querySelector('.shortcut-edit-trash');
  const stopPointer = (event) => {
    event.stopPropagation();
  };
  if (pencil) {
    pencil.addEventListener('pointerdown', stopPointer);
    pencil.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < shortcutReorderSuppressClicksUntil) return;
      openEditModal(shortcut);
    });
  }
  if (trash) {
    trash.addEventListener('pointerdown', stopPointer);
    trash.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < shortcutReorderSuppressClicksUntil) return;
      deleteShortcutById(shortcut.id).catch((err) => console.error('shortcut-delete', err));
    });
  }
  bindShortcutReorder(card, suppressClick);
}

function applyShortcutsEditModeUi() {
  shortcutsContainer.classList.toggle('shortcuts-edit-mode', shortcutsEditMode);
  document.documentElement.setAttribute(
    'data-shortcuts-edit',
    shortcutsEditMode ? 'on' : 'off',
  );
  if (shortcutsEditToggleBtn) {
    shortcutsEditToggleBtn.setAttribute('aria-checked', shortcutsEditMode ? 'true' : 'false');
    shortcutsEditToggleBtn.classList.toggle('is-on', shortcutsEditMode);
    shortcutsEditToggleBtn.setAttribute(
      'aria-label',
      shortcutsEditMode ? 'Modo edición activo; desactivar para uso normal' : 'Modo edición desactivado; activar para editar accesos',
    );
    shortcutsEditToggleBtn.setAttribute(
      'data-tooltip',
      shortcutsEditMode
        ? 'Modo edición activo: arrastra los iconos para moverlos. Desactivar para volver a abrir las ventanas'
        : 'Modo edición inactivo: activar para mover, editar o eliminar accesos',
    );
  }
  if (dockEditModeBanner) {
    const bannerVisible = shortcutsEditMode && isDockTopbarLayout();
    dockEditModeBanner.setAttribute('aria-hidden', bannerVisible ? 'false' : 'true');
  }
  requestAnimationFrame(() => {
    if (typeof window.__dockInvalidateLooseNavViewport === 'function') {
      window.__dockInvalidateLooseNavViewport();
    }
  });
  if (
    lastSyncedShortcutsEditModeToChrome !== shortcutsEditMode &&
    window.usualDesk.notifyShortcutsEditMode
  ) {
    lastSyncedShortcutsEditModeToChrome = shortcutsEditMode;
    window.usualDesk.notifyShortcutsEditMode(shortcutsEditMode).catch(() => {});
  }
}

function renderShortcuts() {
  if (shortcutReorder) {
    finishShortcutReorder(shortcutReorder, {
      save: shortcutReorder.active === true,
      restore: false,
    });
  }
  const stripAddBtn = document.getElementById('strip-add-shortcut');
  if (stripAddBtn) stripAddBtn.remove();
  shortcutsContainer.innerHTML = '';

  if (shortcuts.length === 0) {
    // En topbar dejamos el strip totalmente vacío: durante el onboarding el
    // spotlight apunta al menú (≡) de la cabecera, donde se crean ventanas.
    // En sidebar/center mantenemos el CTA chiquito como fallback útil.
    if (!isDockTopbarLayout()) {
      const wrap = document.createElement('div');
      wrap.className = 'shortcuts-empty';
      wrap.innerHTML =
        '<p class="shortcuts-empty-text">Aún no tienes accesos directos. Ve a Inicio (logo de inplaize arriba) y pulsa «Añadir acceso directo», o el botón de abajo.</p>'
        + '<button type="button" class="btn-empty-add">+ Añadir acceso directo</button>';
      wrap.querySelector('.btn-empty-add').addEventListener('click', () => openAddModal());
      shortcutsContainer.appendChild(wrap);
    }
    applyShortcutsEditModeUi();
    syncDockHomeStripBtn();
    if (stripAddBtn) shortcutsContainer.appendChild(stripAddBtn);
    return;
  }

  const isTopbar = isDockTopbarLayout();
  shortcuts.forEach((shortcut, index) => {
    const card = document.createElement('div');
    card.className = isTopbar ? 'shortcut-card shell-shortcut-item' : 'shortcut-card';
    card.dataset.shortcutId = shortcut.id;
    card.dataset.shortcutType = shortcut.type || '';
    if (index === 0) {
      // Bandera para que el wizard de onboarding pueda hacer spotlight sobre
      // el primer icono del usuario en los pasos "Cerrar" y "Modo Foco".
      card.dataset.onboardingTarget = 'first-shortcut';
    }
    card.draggable = false;
    const bc = titleBadges[shortcut.id];
    const showBadge = bc != null && bc >= 1;
    const badgeText = showBadge ? (bc > 99 ? '99+' : String(bc)) : '';
    const badgeHidden = showBadge ? '' : ' hidden';
    const badgeAria = showBadge
      ? ` aria-label="${bc} notificaciones" aria-hidden="false"`
      : ' aria-hidden="true"';
    const iconHtml = shortcut.icon
      ? shortcutIconMarkup(shortcut.icon)
      : isTopbar
        ? shortcutFallbackMarkup(shortcut.name)
        : '<span class="shortcut-icon-slot" aria-hidden="true"></span>';
    const editActions = shortcutsEditMode ? shortcutEditActionsMarkup(shortcut.name) : '';
    if (isTopbar) {
      card.innerHTML = `
        <span class="shell-shortcut-icon-wrap">${iconHtml}</span>
        <span class="shortcut-badge shell-strip-badge"${badgeHidden}${badgeAria}>${badgeText}</span>
        ${editActions}
      `;
    } else {
      card.innerHTML = `
        ${iconHtml}
        <span class="shortcut-name">${shortcut.name}</span>
        <span class="shortcut-badge"${badgeHidden}${badgeAria}>${badgeText}</span>
        ${editActions}
      `;
    }

    let ignoreClickUntil = 0;
    card.addEventListener('click', (event) => {
      if (event.target.closest && event.target.closest('.shortcut-edit-action')) return;
      if (Date.now() < ignoreClickUntil) return;
      if (Date.now() < shortcutReorderSuppressClicksUntil) return;
      if (shortcutsEditMode) {
        openEditModal(shortcut);
        return;
      }
      // Left-click sobre un icono que NO es miembro del Modo Foco lo cancela
      // (estás saliendo del foco para ir a otra app). Si el icono SÍ es miembro,
      // solo navegamos hacia esa ventana sin romper el foco, para poder moverse
      // entre las pestañas que forman parte del foco.
      const isFocusMember =
        shortcut.type === 'web' &&
        focusModeState.active &&
        focusModeState.members.has(webShortcutMapKey(shortcut));
      if (focusModeState.active && !isFocusMember && window.usualDesk.exitFocusMode) {
        window.usualDesk.exitFocusMode().catch(() => {});
      }
      window.usualDesk.openShortcut(shortcut);
    });

    shortcutsContainer.appendChild(card);
    bindFileDragSpringTarget(card, shortcut);
    applyWebInactiveClassToCard(card, shortcut);
    applyFocusMemberClassToCard(card, shortcut);
    if (editingId && String(editingId) === String(shortcut.id)) {
      card.classList.add('shortcut-card-editing');
    }
    if (shortcutsEditMode) {
      bindShortcutEditActions(card, shortcut, () => {
        ignoreClickUntil = Date.now() + 500;
      });
    } else if (shortcut.type === 'web') {
      const suppressMs =
        (window.UsualDeskStripGestures && window.UsualDeskStripGestures.SUPPRESS_CLICK_MS) || 900;
      bindDockShortcutGestures(card, shortcut, () => {
        ignoreClickUntil = Date.now() + suppressMs;
      });
    }
  });

  applyShortcutsEditModeUi();
  refreshShortcutCardsAccessibility();

  // Onboarding: si el usuario acaba de crear su primera ventana, los cards ya
  // están montados y el wizard puede hacer spotlight sobre el primero. La API
  // ignora la llamada salvo que el paso actual espere este evento.
  if (
    shortcuts.length > 0 &&
    window.UsualDeskOnboarding &&
    typeof window.UsualDeskOnboarding.advance === 'function'
  ) {
    window.UsualDeskOnboarding.advance('shortcuts-non-empty');
  }
  syncDockHomeStripBtn();
  if (stripAddBtn) shortcutsContainer.appendChild(stripAddBtn);
}

function applyFocusMemberClassToCard(card, shortcut) {
  if (!card || !shortcut) {
    if (card) card.classList.remove('shell-focus-member');
    return;
  }
  const isMember =
    shortcut.type === 'web' &&
    focusModeState.active &&
    focusModeState.members.has(webShortcutMapKey(shortcut));
  card.classList.toggle('shell-focus-member', isMember);
}

function updateAllShortcutFocusMemberStates() {
  shortcutsContainer.querySelectorAll('.shortcut-card[data-shortcut-id]').forEach((card) => {
    const id = card.dataset.shortcutId;
    const s = shortcuts.find((x) => x.id === id);
    applyFocusMemberClassToCard(card, s);
  });
}

function bindDockShortcutGestures(card, shortcut, suppressNextClick) {
  const gestures = window.UsualDeskStripGestures;
  if (!gestures || typeof gestures.bindIconStripGestures !== 'function') return;
  const mapKey = webShortcutMapKey(shortcut);
  const isOpen = openWebWindowKeys.has(mapKey);
  gestures.bindIconStripGestures(card, {
    onClose: isOpen && mapKey
      ? () => {
          suppressNextClick();
          if (window.usualDesk.closeWebWindowByMapKey) {
            window.usualDesk.closeWebWindowByMapKey(mapKey).catch(() => {});
          }
        }
      : null,
    onLongPressFocus: () => {
      suppressNextClick();
      if (window.usualDesk.toggleFocusModeMember) {
        window.usualDesk.toggleFocusModeMember(String(shortcut.id)).catch(() => {});
      }
    },
    suppressNextActivation: suppressNextClick,
  });
}

/*
 * El panel solo se abre con Ctrl+Alt+D (main); no hay clic en la franja toggle para abrirlo.
 * Respaldo: mouseenter/mouseleave sobre #toggle-btn para desactivar click-through en esa zona.
 */
toggleBtn.addEventListener('mouseenter', () => {
  lastPassthroughIgnore = false;
  window.usualDesk.setIgnoreMouse(false);
});
toggleBtn.addEventListener('mouseleave', () => {
  lastPassthroughIgnore = null;
  schedulePointerPassthroughSync();
});

function updateSidebarUI(expanded) {
  const on = expanded === true;
  sidebar.classList.toggle('open', on);
  toggleArea.classList.toggle('expanded', on);
  if (sidebarBackdrop) {
    sidebarBackdrop.classList.toggle('hidden', !on);
  }
}

// Listen for programmatic sidebar close (e.g. on blur)
window.usualDesk.onSidebarState((expanded) => {
  updateSidebarUI(expanded === true);
  lastPassthroughIgnore = null;
  schedulePointerPassthroughSync();
  if (expanded === true) kickDownloadPreviews();
  else pauseDrawerVideo();
});

// Clic fuera del panel (capa transparente a pantalla completa)
if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener('pointerdown', async (e) => {
    if (!modalOverlay.classList.contains('hidden')) return;
    if (dockInlineEditor && !dockInlineEditor.classList.contains('hidden')) return;
    if (settingsModalOverlay && !settingsModalOverlay.classList.contains('hidden')) return;
    if (appearanceModalOverlay && !appearanceModalOverlay.classList.contains('hidden')) return;
    e.preventDefault();
    try {
      await window.usualDesk.collapseSidebar();
    } catch (err) {
      console.error('collapse-sidebar', err);
    }
    lastPassthroughIgnore = null;
    schedulePointerPassthroughSync();
  });
}

function initDockHomeMenu() {
  if (!window.UsualDeskShellHomeMenu) return;

  window.UsualDeskShellHomeMenu.init({
    openAddShortcut: () => openAddModal(),
    enterShortcutsEditMode: async () => {
      if (shortcutsEditMode) return;
      let prefId = null;
      try {
        if (window.usualDesk.peekSuggestedShortcutEditorTarget) {
          prefId = await window.usualDesk.peekSuggestedShortcutEditorTarget();
        }
      } catch {
        /* noop */
      }
      shortcutsEditMode = true;
      const s =
        prefId != null ? shortcuts.find((x) => String(x.id) === String(prefId)) : null;
      if (s) {
        openEditModal(s);
      } else {
        renderShortcuts();
      }
    },
    exitShortcutsEditMode: () => exitShortcutsEditModeFromUi(),
    openAppearance: () => openAppearanceModal(),
    openSettings: () => openSettingsModalFromMenu(),
    quitApp: () => window.usualDesk.closeApp(),
    onDrawerOpenChange: (open, editMode) => {
      if (document.documentElement.getAttribute('data-loose-nav') !== 'on') return;
      const toggle = document.getElementById('shortcuts-edit-toggle');
      const editOn = editMode === true || !!(
        toggle
        && (toggle.classList.contains('is-on') || toggle.getAttribute('aria-checked') === 'true')
      );
      window.usualDesk.setMenuOverlayOpen?.(open === true, editOn);
    },
  });

  const menu = document.getElementById('dock-home-menu');
  const menuBtn = document.getElementById('dock-home-menu-btn');
  if (menu && menuBtn) {
    const syncDockMenuPassthrough = () => {
      schedulePointerPassthroughSync();
      if (typeof window.__dockInvalidateLooseNavViewport === 'function') {
        window.__dockInvalidateLooseNavViewport();
      }
    };
    const observer = new MutationObserver(syncDockMenuPassthrough);
    observer.observe(menu, { attributes: true, attributeFilter: ['class'] });
    observer.observe(menuBtn, { attributes: true, attributeFilter: ['class'] });
  }
}

browsePathBtn.addEventListener('click', async () => {
  const picked = await window.usualDesk.pickAppOrShortcut();
  if (!picked) return;
  inputUrl.value = picked;
  if (!inputName.value.trim()) {
    inputName.value = suggestNameFromPath(picked);
  }
});

// Add shortcut / modo edición / ajustes: menú hamburguesa (shell-home-menu.js)

if (dockHomeBtn) {
  dockHomeBtn.addEventListener('click', () => {
    goToDockWelcomeHome('todos').catch(() => {});
  });
}

if (dockDownloadsBtn) {
  dockDownloadsBtn.addEventListener('click', () => {
    goToDockWelcomeHome('downloads').catch(() => {});
  });
}

async function exitShortcutsEditModeFromUi() {
  const formWasOpen =
    isDockTopbarLayout() &&
    ((dockInlineEditor && !dockInlineEditor.classList.contains('hidden')) ||
      (modalOverlay && !modalOverlay.classList.contains('hidden')));
  const looseNavOpen = looseNavSurface && !looseNavSurface.classList.contains('hidden');
  shortcutsEditMode = false;
  closeModal();
  if (formWasOpen || looseNavOpen) {
    try {
      await window.usualDesk.collapseSidebar();
    } catch {
      /* noop */
    }
  }
}

if (dockExitEditModeBtn) {
  dockExitEditModeBtn.addEventListener('click', () => {
    if (!shortcutsEditMode) return;
    exitShortcutsEditModeFromUi().catch(() => {});
  });
}

function clearShortcutNameError() {
  const el = document.getElementById('shortcut-name-error');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

function showShortcutNameError(message) {
  const el = document.getElementById('shortcut-name-error');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  if (inputName) inputName.focus();
}

function openAddModal() {
  editingId = null;
  cancelFaviconLookup();
  autoFaviconValue = '';
  suppressAutoFavicon = false;
  clearShortcutNameError();
  modalTitle.textContent = 'Añadir acceso directo';
  modalDelete.classList.add('hidden');
  if (shortcutOrderGroup) shortcutOrderGroup.classList.add('hidden');
  trimIconSelectToBuiltin();
  shortcutForm.reset();
  setSelectedIcon('');
  if (inputWebNotificationsMuted) inputWebNotificationsMuted.checked = false;
  if (inputWebAudioMuted) inputWebAudioMuted.checked = false;
  updateFormTypeUI();
  applyLooseEditUiLock(false);
  showShortcutFormShell();
  lastPassthroughIgnore = null;
  syncPointerPassthrough(lastPointer.x, lastPointer.y);
}

function openEditModal(shortcut) {
  editingId = shortcut.id;
  cancelFaviconLookup();
  const existingIcon = shortcut.icon ? String(shortcut.icon).trim() : '';
  autoFaviconValue = isSiteIconValue(existingIcon) ? existingIcon : '';
  suppressAutoFavicon = !!(existingIcon && !autoFaviconValue);
  clearShortcutNameError();
  modalTitle.textContent = 'Editar acceso directo';
  modalDelete.classList.remove('hidden');
  if (shortcutOrderGroup) shortcutOrderGroup.classList.remove('hidden');
  inputName.value = shortcut.name;
  setSelectedIcon(shortcut.icon || '');
  const isLoose = shortcut.type === 'loose';
  inputType.value = isLoose ? 'web' : shortcut.type;
  inputUrl.value = isLoose ? '' : shortcut.url;
  if (inputWebNotificationsMuted) {
    inputWebNotificationsMuted.checked = shortcut.notificationsMuted === true;
  }
  if (inputWebAudioMuted) {
    inputWebAudioMuted.checked = shortcut.audioMuted === true;
  }
  updateFormTypeUI();
  applyLooseEditUiLock(isLoose);
  showShortcutFormShell();
  lastPassthroughIgnore = null;
  syncPointerPassthrough(lastPointer.x, lastPointer.y);
  renderShortcuts();
}

/**
 * Bloquea los campos que no aplican al acceso especial de “Navegación suelta”
 * (no tiene URL ni tipo configurable; solo nombre/icono/orden).
 */
function applyLooseEditUiLock(locked) {
  const typeRow = document.querySelector('.form-row-type');
  if (typeRow) typeRow.classList.toggle('hidden', !!locked);
  const urlGroup = inputUrl ? inputUrl.closest('.form-group') : null;
  if (urlGroup) urlGroup.classList.toggle('hidden', !!locked);
  if (inputUrl) inputUrl.required = !locked;
  if (shortcutWebOptions) {
    if (locked) shortcutWebOptions.classList.add('hidden');
  }
  if (browseGroup) {
    if (locked) browseGroup.classList.add('hidden');
  }
}

function closeModal() {
  clearShortcutNameError();
  modalOverlay.classList.add('hidden');
  if (dockInlineEditor && shortcutModalCard && dockInlineEditor.contains(shortcutModalCard)) {
    shortcutModalCard.classList.remove('shortcut-modal-embed');
    modalOverlay.appendChild(shortcutModalCard);
    dockInlineEditor.classList.add('hidden');
    dockInlineEditor.setAttribute('aria-hidden', 'true');
  }
  if (iconDropdownOpen) closeIconDropdown();
  setCustomEmojiPanel(false);
  editingId = null;
  if (shortcutOrderGroup) shortcutOrderGroup.classList.add('hidden');
  lastPassthroughIgnore = null;
  schedulePointerPassthroughSync();
  renderShortcuts();
}

modalCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

if (dockInlineEditor) {
  dockInlineEditor.addEventListener('click', (e) => {
    if (e.target === dockInlineEditor) closeModal();
  });
}

function isDockTopbarLayout() {
  return document.documentElement.getAttribute('data-dock-layout') === 'topbar';
}

/** Muestra el formulario de acceso directo en un modal centrado. */
function showShortcutFormShell() {
  if (!shortcutModalCard || !modalOverlay) return;
  shortcutModalCard.classList.toggle('shortcut-modal-embed', isDockTopbarLayout());
  if (shortcutModalCard.parentElement !== modalOverlay) {
    modalOverlay.appendChild(shortcutModalCard);
  }
  if (dockInlineEditor) {
    dockInlineEditor.classList.add('hidden');
    dockInlineEditor.setAttribute('aria-hidden', 'true');
  }
  modalOverlay.classList.remove('hidden');
  syncDockHomeStripBtn();
}

// Save shortcut
if (inputName) {
  inputName.addEventListener('input', () => clearShortcutNameError());
}

if (inputUrl) {
  inputUrl.addEventListener('input', () => {
    if (!inputType || inputType.value !== 'web') return;
    faviconSeq += 1;
    faviconLookupPending = false;
    suppressAutoFavicon = false;
    scheduleWebFaviconLookup();
  });
  inputUrl.addEventListener('blur', () => {
    if (!faviconTimer) return;
    clearTimeout(faviconTimer);
    faviconTimer = null;
    lookupWebFavicon().catch(() => {});
  });
}

const stripAddShortcutBtn = document.getElementById('strip-add-shortcut');
if (stripAddShortcutBtn) {
  stripAddShortcutBtn.addEventListener('click', () => openAddModal());
}

shortcutForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const editingOriginal = editingId ? shortcuts.find((s) => s.id === editingId) : null;
  const isLoose = !!(editingOriginal && editingOriginal.type === 'loose');

  if (!isLoose && inputType && inputType.value === 'web') {
    const iconNow = inputIcon && inputIcon.value ? inputIcon.value.trim() : '';
    if (!iconNow && !suppressAutoFavicon) {
      if (faviconTimer) {
        clearTimeout(faviconTimer);
        faviconTimer = null;
      }
      try {
        if (faviconWait) await faviconWait;
        const stillEmpty = !(inputIcon && inputIcon.value && inputIcon.value.trim());
        if (stillEmpty) await lookupWebFavicon();
      } catch {
        /* se guarda igual; la franja usa la inicial del nombre */
      }
    }
  }

  const data = {
    id: editingId || Date.now().toString(),
    name: inputName.value.trim(),
    type: isLoose ? 'loose' : inputType.value,
    url: isLoose ? '' : inputUrl.value.trim(),
  };

  const iconVal = inputIcon && inputIcon.value ? inputIcon.value.trim() : '';
  if (iconVal) {
    data.icon = iconVal;
  } else {
    delete data.icon;
  }

  if (!data.name) return;
  if (!isLoose && !data.url) return;

  if (isNameTaken(data.name, editingId)) {
    showShortcutNameError(
      'Ya existe un acceso con ese nombre. Usá otro para separar sesiones (por ejemplo, distintas cuentas de WhatsApp).',
    );
    return;
  }

  if (data.type === 'web') {
    const prevForSession = editingId ? shortcuts.find((s) => s.id === editingId) : null;
    if (prevForSession && prevForSession.type === 'web' && prevForSession.sessionId) {
      data.sessionId = prevForSession.sessionId;
    } else {
      data.sessionId = webSessionIdForShortcut(data.name, data.id);
    }
    if (inputWebNotificationsMuted && inputWebNotificationsMuted.checked) {
      data.notificationsMuted = true;
    } else {
      delete data.notificationsMuted;
    }
    if (inputWebAudioMuted && inputWebAudioMuted.checked) {
      data.audioMuted = true;
    } else {
      delete data.audioMuted;
    }
  } else {
    delete data.sessionId;
    delete data.audioMuted;
    delete data.notificationsMuted;
  }

  if (editingId) {
    const idx = shortcuts.findIndex((s) => s.id === editingId);
    if (idx !== -1) shortcuts[idx] = data;
  } else {
    shortcuts.push(data);
  }

  await window.usualDesk.saveShortcuts(shortcuts);
  const saved = shortcuts.find((s) => s.id === data.id);
  if (saved && saved.type === 'web') {
    try {
      await window.usualDesk.setWebShortcutNotificationsMuted(
        saved,
        saved.notificationsMuted === true,
      );
      await window.usualDesk.setWebShortcutMuted(saved, saved.audioMuted === true);
    } catch (err) {
      console.error('web-shortcut-flags', err);
    }
  }
  renderShortcuts();
  closeModal();
});

// Delete shortcut
modalDelete.addEventListener('click', () => {
  if (!editingId) return;
  deleteShortcutById(editingId).catch((err) => console.error('shortcut-delete', err));
});

window.usualDesk.onOpenAddShortcutModal(() => {
  openAddModal();
});

window.usualDesk.onOpenSettingsModal(() => {
  openSettingsModalFromMenu();
});

window.usualDesk.onOpenAppearanceModal(() => {
  openAppearanceModal();
});

async function moveShortcutInList(delta) {
  if (!editingId) return;
  const i = shortcuts.findIndex((s) => s.id === editingId);
  if (i === -1) return;
  const j = i + delta;
  if (j < 0 || j >= shortcuts.length) return;
  const tmp = shortcuts[i];
  shortcuts[i] = shortcuts[j];
  shortcuts[j] = tmp;
  try {
    await window.usualDesk.saveShortcuts(shortcuts);
  } catch (err) {
    console.error('shortcut-order', err);
  }
  renderShortcuts();
}

if (shortcutMoveUpBtn) {
  shortcutMoveUpBtn.addEventListener('click', () => moveShortcutInList(-1));
}
if (shortcutMoveDownBtn) {
  shortcutMoveDownBtn.addEventListener('click', () => moveShortcutInList(1));
}

bindUrlDropTargets();
bindFileDropToDownloads();
bindTypeSegmented();
if (window.usualDesk && typeof window.usualDesk.onGestureCoachShow === 'function') {
  window.usualDesk.onGestureCoachShow(() => {
    try {
      if (window.UsualDeskOnboarding && typeof window.UsualDeskOnboarding.showGestureCoach === 'function') {
        window.UsualDeskOnboarding.showGestureCoach();
        return;
      }
    } catch (err) {
      console.error('gesture-coach', err);
    }
    if (typeof window.usualDesk.closeGestureCoach === 'function') {
      window.usualDesk.closeGestureCoach({ defer: true }).catch(() => {});
    }
  });
}

init();

/* ==========================================================================
   Navegación suelta (pestañas embebidas dentro del dock).
   El main gestiona las pestañas y su BrowserView; el renderer solo pinta la
   barra arriba, escucha el estado y le indica dónde colocarse (bounds del
   viewport dentro de #dock-viewport).
   ========================================================================== */

const looseNavBar = document.getElementById('loose-nav-bar');
const looseNavTabsStrip = document.getElementById('loose-nav-tabs-strip');
const looseNavNewTabBtn = document.getElementById('loose-nav-new-tab-btn');
const dockViewport = document.getElementById('dock-viewport');
const looseNavSurface = document.getElementById('loose-nav-surface');

/** Último estado recibido del main. */
let looseNavState = {
  active: false,
  tabs: [],
  activeTabId: null,
  activeUrl: '',
  activeCanGoBack: false,
  activeCanGoForward: false,
  activeLoading: false,
};

let lastSentViewportBounds = null;
let viewportBoundsFrame = 0;
let looseNavActiveShortcutId = null;

/** Borrador al pulsar “+”: el enlace se escribe donde irían favicon y nombre. */
let looseNavComposer = null;
let looseNavComposerFocusGen = 0;

const LOOSE_NAV_BACK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const LOOSE_NAV_FORWARD_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const LOOSE_NAV_RELOAD_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M21 3v5h-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

function findLooseShortcut() {
  return shortcuts.find((s) => s && s.type === 'loose') || null;
}

function computeViewportBoundsPayload() {
  if (!dockViewport) return null;
  const r = dockViewport.getBoundingClientRect();
  const w = Math.max(0, Math.round(r.width));
  const h = Math.max(0, Math.round(r.height));
  if (w <= 0 || h <= 0) return null;
  return {
    x: Math.max(0, Math.round(r.left)),
    y: Math.max(0, Math.round(r.top)),
    width: w,
    height: h,
  };
}

function sendLooseNavViewportBounds() {
  if (!looseNavState.active) return;
  const bounds = computeViewportBoundsPayload();
  if (!bounds) return;
  if (
    lastSentViewportBounds &&
    lastSentViewportBounds.x === bounds.x &&
    lastSentViewportBounds.y === bounds.y &&
    lastSentViewportBounds.width === bounds.width &&
    lastSentViewportBounds.height === bounds.height
  ) {
    return;
  }
  lastSentViewportBounds = bounds;
  try {
    window.usualDesk.looseNavSetViewportBounds(bounds);
  } catch {
    /* noop */
  }
}

function scheduleLooseNavViewportSync() {
  if (viewportBoundsFrame) return;
  viewportBoundsFrame = requestAnimationFrame(() => {
    viewportBoundsFrame = 0;
    sendLooseNavViewportBounds();
  });
}

function invalidateLooseNavViewport() {
  lastSentViewportBounds = null;
  scheduleLooseNavViewportSync();
}

window.__dockInvalidateLooseNavViewport = invalidateLooseNavViewport;

function faviconFallbackEl(initial) {
  const letter = (initial || '?').trim().charAt(0).toUpperCase() || '?';
  const span = document.createElement('span');
  span.className = 'loose-nav-tab-fav is-placeholder';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = letter;
  return span;
}

function makeLooseNavIconButton(className, label, svg, enabled, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.setAttribute('aria-label', label);
  btn.dataset.tooltip = label;
  btn.dataset.tooltipPlacement = 'bottom';
  btn.disabled = !enabled;
  btn.innerHTML = svg;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return btn;
}

/** Atrás y adelante solo en la pestaña activa. Recargar, en cada una. */
function appendLooseNavControls(el, tab) {
  const nav = document.createElement('span');
  nav.className = 'loose-nav-tab-nav';
  nav.addEventListener('click', (ev) => ev.stopPropagation());
  if (tab.isActive) {
    nav.appendChild(makeLooseNavIconButton(
      'loose-nav-tab-nav-btn',
      'Atrás',
      LOOSE_NAV_BACK_SVG,
      !!tab.canGoBack,
      () => window.usualDesk.looseNavBack().catch(() => {})
    ));
    nav.appendChild(makeLooseNavIconButton(
      'loose-nav-tab-nav-btn',
      'Adelante',
      LOOSE_NAV_FORWARD_SVG,
      !!tab.canGoForward,
      () => window.usualDesk.looseNavForward().catch(() => {})
    ));
  }
  nav.appendChild(makeLooseNavIconButton(
    'loose-nav-tab-nav-btn loose-nav-tab-reload',
    'Recargar',
    LOOSE_NAV_RELOAD_SVG,
    true,
    () => window.usualDesk.looseNavReload(tab.id).catch(() => {})
  ));
  el.appendChild(nav);
}

function appendLooseNavClose(el, label, onClose) {
  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'loose-nav-tab-close';
  closeEl.setAttribute('aria-label', label);
  closeEl.textContent = '\u00d7';
  closeEl.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClose();
  });
  el.appendChild(closeEl);
}

function buildLooseNavComposer() {
  const el = document.createElement('div');
  el.className = 'loose-nav-tab is-composing';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'loose-nav-tab-url';
  input.placeholder = 'Escribí un enlace';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Enlace de la pestaña nueva');
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      cancelLooseNavComposer();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      commitLooseNavComposer(input.value);
    }
  });
  el.appendChild(input);
  appendLooseNavClose(el, 'Cancelar pestaña', () => cancelLooseNavComposer());
  return el;
}

function focusLooseNavComposerInput(input, justOpened, selStart, selEnd) {
  const gen = ++looseNavComposerFocusGen;
  requestAnimationFrame(() => {
    if (gen !== looseNavComposerFocusGen || !input.isConnected) return;
    input.focus();
    if (!justOpened && selStart != null && selEnd != null) {
      try { input.setSelectionRange(selStart, selEnd); } catch { /* noop */ }
    } else if (justOpened && input.value) {
      const end = input.value.length;
      try { input.setSelectionRange(end, end); } catch { /* noop */ }
    }
  });
}

function openLooseNavComposer() {
  if (!looseNavState.active) return;
  if (looseNavComposer) {
    looseNavTabsStrip?.querySelector('.loose-nav-tab-url')?.focus();
    return;
  }
  looseNavComposer = { focus: true };
  renderLooseNavTabs(looseNavState);
}

function cancelLooseNavComposer() {
  if (!looseNavComposer) return;
  looseNavComposer = null;
  looseNavComposerFocusGen += 1;
  renderLooseNavTabs(looseNavState);
}

async function commitLooseNavComposer(raw) {
  const val = String(raw || '').trim();
  if (!val) return;
  looseNavComposer = null;
  looseNavComposerFocusGen += 1;
  renderLooseNavTabs(looseNavState);
  try {
    await window.usualDesk.looseNavNewTab(val);
  } catch {
    looseNavComposer = { focus: true, value: val };
    renderLooseNavTabs(looseNavState);
  }
}

function renderLooseNavTabs(state) {
  if (!looseNavTabsStrip) return;

  const previousComposer = looseNavTabsStrip.querySelector('.loose-nav-tab.is-composing');
  const previousInput = previousComposer?.querySelector('.loose-nav-tab-url');
  const composerWasFocused = !!(previousInput && document.activeElement === previousInput);
  const composerSelStart = previousInput ? previousInput.selectionStart : null;
  const composerSelEnd = previousInput ? previousInput.selectionEnd : null;
  if (previousComposer && looseNavComposer) previousComposer.remove();

  looseNavTabsStrip.innerHTML = '';

  if (looseNavComposer) {
    const node = previousComposer || buildLooseNavComposer();
    looseNavTabsStrip.appendChild(node);
    const input = node.querySelector('.loose-nav-tab-url');
    const justOpened = !!looseNavComposer.focus;
    const pendingValue = looseNavComposer.value || '';
    looseNavComposer.focus = false;
    looseNavComposer.value = '';
    if (input && justOpened && pendingValue) input.value = pendingValue;
    if (input && (justOpened || composerWasFocused)) {
      focusLooseNavComposerInput(input, justOpened, composerSelStart, composerSelEnd);
    }
    looseNavTabsStrip.scrollLeft = 0;
  }

  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'loose-nav-tab';
    el.setAttribute('role', 'tab');
    el.dataset.tabId = tab.id;
    el.setAttribute('aria-selected', tab.isActive ? 'true' : 'false');
    if (tab.isActive) el.classList.add('is-active');
    if (tab.loading) el.classList.add('is-loading');
    el.setAttribute('data-tooltip', tab.title || tab.url || 'Pestaña');

    appendLooseNavControls(el, tab);

    if (tab.loading) {
      const spin = document.createElement('span');
      spin.className = 'loose-nav-tab-fav is-loading';
      spin.setAttribute('aria-hidden', 'true');
      el.appendChild(spin);
    } else if (tab.favicon && /^(https?:|data:)/i.test(tab.favicon)) {
      const img = document.createElement('img');
      img.className = 'loose-nav-tab-fav';
      img.src = tab.favicon;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.replaceWith(faviconFallbackEl(tab.title || tab.url));
      });
      el.appendChild(img);
    } else {
      el.appendChild(faviconFallbackEl(tab.title || tab.url));
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'loose-nav-tab-title';
    titleEl.textContent = tab.title || tab.url || 'Pestaña';
    el.appendChild(titleEl);

    appendLooseNavClose(el, 'Cerrar pestaña', () => {
      window.usualDesk.looseNavCloseTab(tab.id).catch(() => {});
    });

    el.addEventListener('click', () => {
      if (tab.isActive) return;
      if (looseNavComposer) cancelLooseNavComposer();
      window.usualDesk.looseNavSelectTab(tab.id).catch(() => {});
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        window.usualDesk.looseNavCloseTab(tab.id).catch(() => {});
      }
    });

    looseNavTabsStrip.appendChild(el);
  }
}

function renderLooseNavBar(state) {
  const wasLoose = !!looseNavState.active;
  looseNavState = state || looseNavState;

  if (!looseNavBar) return;

  const show = !!looseNavState.active;
  looseNavBar.classList.toggle('hidden', !show);
  if (looseNavSurface) looseNavSurface.classList.toggle('hidden', !show);
  document.documentElement.setAttribute('data-loose-nav', show ? 'on' : 'off');

  // Marcar el acceso directo “Navegación suelta” como activo visualmente.
  const looseSc = findLooseShortcut();
  looseNavActiveShortcutId = show && looseSc ? looseSc.id : null;
  shortcutsContainer?.querySelectorAll('.shortcut-card.loose-nav-active').forEach((c) => {
    c.classList.remove('loose-nav-active');
  });
  if (looseNavActiveShortcutId) {
    const card = shortcutsContainer?.querySelector(
      `.shortcut-card[data-shortcut-id="${looseNavActiveShortcutId}"]`,
    );
    card?.classList.add('loose-nav-active');
  }

  if (show) {
    renderLooseNavTabs(looseNavState);
    scheduleLooseNavViewportSync();
    if (!wasLoose && document.documentElement.getAttribute('data-home-menu-open') === 'on') {
      const toggle = document.getElementById('shortcuts-edit-toggle');
      const editOn = !!(
        toggle
        && (toggle.classList.contains('is-on') || toggle.getAttribute('aria-checked') === 'true')
      );
      window.usualDesk.setMenuOverlayOpen?.(true, editOn);
    }
  } else {
    looseNavComposer = null;
    looseNavComposerFocusGen += 1;
    lastSentViewportBounds = null;
    if (wasLoose) window.usualDesk.hideMenuOverlay?.();
  }
  syncDockHomeStripBtn();
}

function initLooseNavUiEvents() {
  if (!looseNavBar) return;

  looseNavNewTabBtn?.addEventListener('click', () => {
    openLooseNavComposer();
  });

  window.addEventListener('resize', () => scheduleLooseNavViewportSync());

  if (typeof ResizeObserver === 'function' && dockViewport) {
    const ro = new ResizeObserver(() => scheduleLooseNavViewportSync());
    ro.observe(dockViewport);
  }

  if (typeof window.usualDesk.onLooseNavState === 'function') {
    window.usualDesk.onLooseNavState((s) => renderLooseNavBar(s));
  }

  // Si el sidebar se cierra, pedimos al main cerrar el modo (detach del view).
  window.usualDesk.onSidebarState((expanded) => {
    if (!expanded && looseNavState.active) {
      window.usualDesk.looseNavClose().catch(() => {});
    } else if (expanded && looseNavState.active) {
      scheduleLooseNavViewportSync();
    }
  });

  // Estado inicial (por si el main ya tenía pestañas al recargar).
  if (typeof window.usualDesk.looseNavGetState === 'function') {
    window.usualDesk.looseNavGetState()
      .then((s) => { if (s) renderLooseNavBar(s); })
      .catch(() => {});
  }
}

initLooseNavUiEvents();


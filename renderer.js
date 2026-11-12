const toggleArea = document.getElementById('toggle-area');
const toggleBtn = document.getElementById('toggle-btn');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const sidebar = document.getElementById('sidebar');
const shortcutsEditToggleBtn = document.getElementById('shortcuts-edit-toggle');
const shortcutsContainer = document.getElementById('shortcuts-container');
const dockHomeBtn = document.getElementById('dock-home-btn');
const dockDownloadsBtn = document.getElementById('dock-downloads-btn');
const modalOverlay = document.getElementById('modal-overlay');
const dockInlineEditor = document.getElementById('dock-inline-editor');
const shortcutModalCard = document.getElementById('modal');
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
/** Cruz para quitar en modo edición: accesos y perfiles de la navegación libre. */
const LOOSE_NAV_REMOVE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
  '</svg>';
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
    (document.documentElement.classList.contains('doc-modal-open') &&
      !document.documentElement.classList.contains('doc-modal-away')) ||
    document.documentElement.classList.contains('gesture-coach-open') ||
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
  homeView =
    view === 'downloads' ? 'downloads' : view === 'history' ? 'history' : 'todos';
  const panel = document.getElementById('dock-home-panel');
  if (panel) {
    panel.setAttribute('data-home-view', homeView);
    panel.classList.remove('is-file-preview');
  }
  kickDownloadPreviews();
  if (homeView !== 'downloads') pauseDrawerVideo();
  if (homeView === 'history') {
    wireHistoryHome();
    renderHistoryHome();
  }
  syncHomeNav();
}

function syncHomeNav() {
  document.querySelectorAll('.home-nav-item').forEach((btn) => {
    const on = btn.dataset.homeNav === homeView;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
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
    btn.classList.toggle('is-active', homeVisible);
    btn.setAttribute('aria-pressed', homeVisible ? 'true' : 'false');
  }
  if (downloadsBtn) {
    const on = homeView === 'downloads' && homeVisible;
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
  applyHomeView(view === 'downloads' ? 'downloads' : view === 'history' ? 'history' : 'todos');
  try {
    closeModal();
    if (looseNavState?.active && typeof window.usualDesk?.looseNavClose === 'function') {
      await window.usualDesk.looseNavClose().catch(() => {});
    }
  } finally {
    syncDockHomeStripBtn();
  }
}

function applySidebarDensityToDom(density) {
  const d = density === 'minimal' ? 'minimal' : 'normal';
  document.documentElement.setAttribute('data-sidebar-density', d);
  refreshShortcutCardsAccessibility();
}

function refreshShortcutCardsAccessibility() {
  shortcutsContainer.querySelectorAll('.shortcut-card[data-shortcut-id]').forEach((card) => {
    const id = card.dataset.shortcutId;
    const s = shortcuts.find((x) => x.id === id);
    if (!s) return;
    const hint = shortcutsEditMode
      ? `${s.name}. Arrastra para mover de lugar; la cruz lo elimina.`
      : s.name;
    card.setAttribute('aria-label', hint);
    card.setAttribute('data-tooltip', hint);
  });
}

let dockModalHidesLooseNav = false;

/** La navegación suelta es una vista nativa: tapa cualquier modal HTML, así que se despega mientras hay uno abierto. */
function syncLooseNavForDockModals() {
  const open = !!appearanceModalOverlay && !appearanceModalOverlay.classList.contains('hidden');
  if (open === dockModalHidesLooseNav) return;
  dockModalHidesLooseNav = open;
  window.usualDesk.setUrlPromptOpen?.(open)?.catch?.(() => {});
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
  window.usualDesk
    .getAppSettings()
    .then(syncAnalyticsCheckboxFromSettings)
    .catch(() => syncAnalyticsCheckboxFromSettings({ analyticsEnabled: true }));
  appearanceModalOverlay.classList.remove('hidden');
  syncLooseNavForDockModals();
  schedulePointerPassthroughSync();
  appearanceModalOverlay.querySelector('.appearance-theme-option.is-selected')?.focus();
}

function closeAppearanceModal() {
  if (!appearanceModalOverlay) return;
  appearanceModalOverlay.classList.add('hidden');
  syncLooseNavForDockModals();
  schedulePointerPassthroughSync();
}

function syncAnalyticsCheckboxFromSettings(s) {
  const el = document.getElementById('settings-analytics-enabled');
  if (!el || !s) return;
  el.checked = s.analyticsEnabled !== false;
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
  if (tile.dataset.previewKind === 'icon') {
    img.classList.add('is-icon');
    tile.classList.add('has-icon');
  }
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

/** ¿El panel de descargas está a la vista (vista completa o franja)?
 *  Ahí recién se piden miniaturas. */
function downloadsPanelVisible() {
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
    const fetchPreview =
      tile.dataset.previewKind === 'icon'
        ? window.usualDesk.getDownloadFileIcon
        : window.usualDesk.getDownloadThumbnail;
    Promise.resolve(fetchPreview ? fetchPreview(id) : null)
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
function scheduleTilePreview(tile, extChip, d, kind) {
  if (kind) tile.dataset.previewKind = kind;
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

/** Acceso web bajo el puntero (WhatsApp, mail…) al que se le puede soltar el archivo. */
function springCardAt(x, y) {
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    if (fileDragSpringShortcuts.has(el)) return el;
  }
  return null;
}

function clearInternalDragSpring(session) {
  if (!session) return;
  if (session.springTimer) clearTimeout(session.springTimer);
  session.springTimer = null;
  session.springCard?.classList.remove('file-drag-hover');
  session.springCard = null;
}

/**
 * El drag interno no dispara dragenter en los iconos: el spring-loading se
 * resuelve acá y después pasa a drag nativo para soltar dentro de la página.
 */
function updateInternalDragSpring(session, x, y) {
  const card = springCardAt(x, y);
  if (card === session.springCard) return;
  clearInternalDragSpring(session);
  if (!card) return;
  session.springCard = card;
  card.classList.add('file-drag-hover');
  session.springTimer = setTimeout(() => {
    session.springTimer = null;
    if (internalFileDrag !== session || session.handedOff) return;
    const shortcut = fileDragSpringShortcuts.get(card);
    clearInternalDragSpring(session);
    if (!shortcut) return;
    springLoadShortcutForFileDrag(shortcut);
    handoffInternalFileDrag({ keepDockShape: false });
  }, FILE_DRAG_SPRING_DELAY_MS);
}

function endInternalFileDrag() {
  const session = internalFileDrag;
  if (!session) return;
  clearInternalDragSpring(session);
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
  updateInternalDragSpring(session, ev.clientX, ev.clientY);
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
    springCard: null,
    springTimer: null,
  };
  return internalFileDrag;
}

/**
 * Suelta el arrastre interno y pasa a un drag nativo para dejar el archivo
 * en otra app. Recorta la ventana: solo tiene sentido ya fuera del panel.
 * Con keepDockShape en false el dock queda sin región visible (el panel ya
 * se cerró para mostrar la ventana del acceso).
 * @param {{ keepDockShape?: boolean }} [opts]
 */
function handoffInternalFileDrag(opts) {
  const session = internalFileDrag;
  if (!session || session.handedOff) return;
  session.handedOff = true;
  const { id, tile, pointerId } = session;
  const anchor = opts && opts.keepDockShape === false ? null : session.anchor;
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
  if (imageDrawerState.download && String(imageDrawerState.download.id) === String(d.id)) {
    tile.classList.add('is-selected');
  }

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
  if (d.state === 'completed' && d.savePath) {
    if (isImageDownload(d) || isDocThumbDownload(d)) {
      scheduleTilePreview(tile, ext, d);
    } else {
      scheduleTilePreview(tile, ext, d, 'icon');
    }
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
        // Desde la columna el visor ocupa el lugar de la página.
        if (homeView === 'history') {
          applyHomeView('downloads');
          syncDockHomeStripBtn();
        }
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

/** Marca la tarjeta del archivo abierto en el visor y activa el modo vista previa. */
function syncFilePreviewSelection() {
  const d = imageDrawerState.download;
  const selectedId = d ? String(d.id) : null;
  for (const cell of document.querySelectorAll('.download-tile-cell[data-download-id]')) {
    cell
      .querySelector('.download-tile')
      ?.classList.toggle('is-selected', cell.dataset.downloadId === selectedId);
  }
  document.getElementById('dock-home-panel')?.classList.toggle('is-file-preview', !!d);
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
  document.getElementById('image-drawer-pdf')?.remove();
}

/**
 * webview (no iframe): el visor de PDF de Chromium no funciona en iframes dentro de Electron.
 * Un webview es un proceso aparte aunque esté vacío, así que existe solo mientras se ve un PDF.
 */
function createDrawerPdf() {
  const video = drawerVideoEl();
  if (!video) return null;
  const el = document.createElement('webview');
  el.id = 'image-drawer-pdf';
  el.className = 'image-drawer-pdf';
  el.setAttribute('plugins', 'true');
  video.before(el);
  return el;
}

/** Muestra una descarga completada (imagen, PDF o video) en el visor fijo. */
function openImageDrawer(d) {
  const drawer = document.getElementById('image-drawer');
  const title = document.getElementById('image-drawer-title');
  const canvas = document.getElementById('image-drawer-canvas');
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
    const pdfFrame = createDrawerPdf();
    if (pdfFrame) {
      // El webview debe estar visible ANTES de navegar: oculto (display:none)
      // no tiene webContents adjunto y la carga falla.
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
  syncFilePreviewSelection();
  schedulePointerPassthroughSync();
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
  syncFilePreviewSelection();
  schedulePointerPassthroughSync();
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

function initAppSettingsUI() {
  const analyticsCb = document.getElementById('settings-analytics-enabled');
  analyticsCb?.addEventListener('change', async () => {
    try {
      await window.usualDesk.setAppSettings({ analyticsEnabled: !!analyticsCb.checked });
    } catch (err) {
      console.error('set-app-settings analyticsEnabled', err);
    }
  });

  const replayBtn = document.getElementById('onboarding-replay-btn');
  replayBtn?.addEventListener('click', async () => {
    if (!window.UsualDeskOnboarding || typeof window.UsualDeskOnboarding.start !== 'function') {
      return;
    }
    closeAppearanceModal();
    // El panel ya estaba abierto (estábamos en Configuración); aseguramos
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
    }
  });

  window.usualDesk.onAppSettingsChanged((s) => {
    if (s && s.sidebarDensity) {
      applySidebarDensityToDom(s.sidebarDensity);
    }
    if (s && typeof s.analyticsEnabled === 'boolean') {
      syncAnalyticsCheckboxFromSettings(s);
    }
    if (s) {
      applyDockHotkeyLabel(s);
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

async function loadInitialDockSettings() {
  try {
    const s = await window.usualDesk.getAppSettings();
    applySidebarDensityToDom(s.sidebarDensity);
    applyDockHotkeyLabel(s);
  } catch {
    applySidebarDensityToDom('normal');
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
  const iconHint = addShortcutPageFavicon && addShortcutPageFavicon.pageUrl === raw ? addShortcutPageFavicon.iconUrl : '';
  const pending = window.usualDesk.fetchWebFavicon(raw, iconHint).catch(() => null);
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
  try {
    await loadInitialDockSettings();
  } catch (err) {
    console.error('init-dock-settings', err);
  }
  try {
    shortcuts = await window.usualDesk.getShortcuts();
  } catch (err) {
    console.error('init-shortcuts', err);
    shortcuts = [];
  }
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
  // El tour de primera vez no puede depender de que todo el resto del panel
  // cargue bien: en una instalación nueva no hay nada en disco y cualquier
  // paso de acá puede fallar, dejando al usuario frente a una barra vacía y
  // sin explicación. Por eso va en `finally` y cada pieza se aísla.
  try {
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
  } catch (err) {
    console.error('init-dock-ui', err);
  } finally {
    maybeStartOnboarding();
  }
  if (window.usualDesk.onOnboardingLaunch) {
    window.usualDesk.onOnboardingLaunch(() => {
      maybeStartOnboarding(true);
    });
  }
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
async function maybeStartOnboarding(force) {
  if (!window.UsualDeskOnboarding || typeof window.UsualDeskOnboarding.start !== 'function') {
    return;
  }
  let fromInstaller = force === true;
  if (!fromInstaller && window.usualDesk.consumeOnboardingLaunch) {
    try {
      fromInstaller = (await window.usualDesk.consumeOnboardingLaunch()) === true;
    } catch {
      fromInstaller = false;
    }
  }
  // El instalador abre la app con --onboarding: el tour es el paso siguiente,
  // aunque ya hubiera un acceso de una versión anterior.
  if (!fromInstaller && shortcuts.length > 0) return;
  let settings = null;
  try {
    settings = await window.usualDesk.getAppSettings();
  } catch {
    /* sin settings asumimos onboarding pendiente: estado por defecto */
  }
  if (!fromInstaller && settings && settings.onboardingCompleted === true) return;
  // Marcamos el tour como activo ANTES de expandir. Recién instalada, la app
  // suele arrancar detrás del instalador o del escritorio: sin esta bandera
  // el main colapsa el panel al primer blur y el tour queda dibujado dentro
  // de una franja de 4 px, invisible.
  try {
    if (window.usualDesk.setOnboardingActive) {
      await window.usualDesk.setOnboardingActive(true);
    }
  } catch {
    /* seguimos: el tour igual se dibuja, solo queda expuesto al blur */
  }
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
      try {
        window.usualDesk.setOnboardingActive?.(false);
      } catch {
        /* noop */
      }
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

/** @type {WeakMap<HTMLElement, object>} card de acceso web → su shortcut */
const fileDragSpringShortcuts = new WeakMap();

/** Engancha el spring-loading de archivos sobre un card de acceso web. */
function bindFileDragSpringTarget(card, shortcut) {
  if (shortcut.type !== 'web') return;
  fileDragSpringShortcuts.set(card, shortcut);
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
    '.magic-zone, .magic-drawer, .loose-nav-bar, .loose-nav-top-tabs, .doc-modal-overlay, '
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
  const anchor = ['strip-add-shortcut', 'strip-end-actions']
    .map((id) => document.getElementById(id))
    .find((el) => el && el.parentElement === shortcutsContainer);
  const byId = new Map();
  shortcutCardsInStrip().forEach((el) => {
    byId.set(el.dataset.shortcutId, el);
  });
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) continue;
    if (anchor) {
      shortcutsContainer.insertBefore(el, anchor);
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
  if (x < rect.left + edge) {
    const t = Math.min(1, (rect.left + edge - x) / edge);
    shortcutsContainer.scrollLeft -= Math.ceil(maxStep * t);
  } else if (x > rect.right - edge) {
    const t = Math.min(1, (x - (rect.right - edge)) / edge);
    shortcutsContainer.scrollLeft += Math.ceil(maxStep * t);
  }
}

const SHORTCUT_REORDER_SHIFT_MS = 180;

/** Rect de layout: sin el desplazamiento de la animación que esté corriendo. */
function shortcutLayoutRect(el) {
  const rect = el.getBoundingClientRect();
  const t = getComputedStyle(el).translate;
  if (!t || t === 'none') return rect;
  const [tx = 0, ty = 0] = t.split(/\s+/).map((v) => parseFloat(v) || 0);
  return new DOMRect(rect.left - tx, rect.top - ty, rect.width, rect.height);
}

/** Mueve tarjetas en el DOM y las desliza desde donde se veían hasta su nuevo lugar. */
function moveShortcutCardsAnimated(mutate) {
  const cards = shortcutCardsInStrip();
  const first = new Map(cards.map((el) => [el, el.getBoundingClientRect()]));
  cards.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
  mutate();
  for (const el of cards) {
    const from = first.get(el);
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    // `translate` y no `transform`: las tarjetas fijan `transform: none !important`.
    el.animate(
      [{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }],
      { duration: SHORTCUT_REORDER_SHIFT_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
  }
}

function placeShortcutCardAtPointer(card, x, y) {
  const cards = shortcutCardsInStrip().filter((el) => el !== card);
  if (!cards.length || !card.parentElement) return;
  let best = cards[0];
  let bestRect = null;
  let bestDist = Infinity;
  for (const other of cards) {
    const rect = shortcutLayoutRect(other);
    const cx = Math.max(rect.left, Math.min(x, rect.right));
    const cy = Math.max(rect.top, Math.min(y, rect.bottom));
    const dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = other;
      bestRect = rect;
    }
  }
  const before = x < bestRect.left + bestRect.width / 2;
  const parent = card.parentElement;
  if (before) {
    if (card.nextElementSibling === best) return;
    moveShortcutCardsAnimated(() => parent.insertBefore(card, best));
    return;
  }
  const after = best.nextElementSibling;
  if (after === card) return;
  moveShortcutCardsAnimated(() => {
    if (after) parent.insertBefore(card, after);
    else parent.appendChild(card);
  });
}

/** Al soltar, el fantasma vuela hasta el hueco en vez de desaparecer de golpe. */
function settleReorderGhost(ghost, card) {
  if (!ghost) return;
  if (!card || !card.isConnected) {
    ghost.remove();
    return;
  }
  const target = shortcutLayoutRect(card);
  const anim = ghost.animate(
    [
      { left: ghost.style.left, top: ghost.style.top },
      { left: `${target.left}px`, top: `${target.top}px` },
    ],
    { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' },
  );
  anim.onfinish = () => ghost.remove();
  anim.oncancel = () => ghost.remove();
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
  const ghost = session.ghost;
  session.ghost = null;
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
  if (restore && session.originalIds) {
    moveShortcutCardsAnimated(() => restoreShortcutDomOrder(session.originalIds));
  }
  settleReorderGhost(ghost, session.card);
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
  ghost.querySelectorAll('.shortcut-badge, .shortcut-card-remove').forEach((el) => el.remove());
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
    if (shortcutReorder) return;
    if (event.target instanceof Element && event.target.closest('.shortcut-card-remove')) return;
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
  const addBtn = document.getElementById('strip-add-shortcut');
  const endActions = document.getElementById('strip-end-actions');
  if (addBtn) addBtn.remove();
  if (endActions) endActions.remove();
  shortcutsContainer.innerHTML = '';
  syncStripEndActions(addBtn, endActions);

  if (shortcuts.length === 0) {
    // El strip queda vacío: durante el onboarding el spotlight apunta al
    // menú (≡) de la cabecera, donde se crean ventanas.
    applyShortcutsEditModeUi();
    syncDockHomeStripBtn();
    if (addBtn) shortcutsContainer.appendChild(addBtn);
    if (endActions) shortcutsContainer.appendChild(endActions);
    return;
  }

  shortcuts.forEach((shortcut, index) => {
    const card = document.createElement('div');
    card.className = 'shortcut-card shell-shortcut-item';
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
      : shortcutFallbackMarkup(shortcut.name);
    card.innerHTML = `
      <span class="shell-shortcut-icon-wrap">${iconHtml}</span>
      <span class="shortcut-badge shell-strip-badge"${badgeHidden}${badgeAria}>${badgeText}</span>
    `;
    if (shortcutsEditMode) {
      const remove = document.createElement('span');
      remove.className = 'shortcut-card-remove';
      remove.setAttribute('role', 'button');
      remove.setAttribute('aria-label', `Eliminar ${shortcut.name}`);
      remove.innerHTML = LOOSE_NAV_REMOVE_SVG;
      card.appendChild(remove);
    }

    let ignoreClickUntil = 0;
    card.addEventListener('click', (ev) => {
      if (Date.now() < ignoreClickUntil) return;
      if (Date.now() < shortcutReorderSuppressClicksUntil) return;
      if (shortcutsEditMode) {
        if (ev.target instanceof Element && ev.target.closest('.shortcut-card-remove')) {
          deleteShortcutById(shortcut.id).catch((err) => console.error('shortcut-delete', err));
        }
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
      bindShortcutReorder(card, () => {
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
  if (addBtn) shortcutsContainer.appendChild(addBtn);
  if (endActions) shortcutsContainer.appendChild(endActions);
}

/**
 * Lápiz a la derecha en uso normal; en modo edición, "+" tras el último icono
 * y "listo" a la derecha. Sin accesos, solo el "+".
 */
function syncStripEndActions(addBtn, endActions) {
  const empty = shortcuts.length === 0;
  const editBtn = endActions && endActions.querySelector('#strip-edit-toggle');
  const doneBtn = endActions && endActions.querySelector('#strip-edit-done');
  if (editBtn) editBtn.hidden = empty || shortcutsEditMode;
  if (addBtn) addBtn.hidden = !(empty || shortcutsEditMode);
  if (doneBtn) doneBtn.hidden = !shortcutsEditMode;
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
    // Durante el tour el fondo oscuro es parte del tutorial: un clic al lado
    // del bocadillo cerraría el panel y se perdería el recorrido.
    if (window.UsualDeskOnboarding?.isActive?.()) return;
    if (!modalOverlay.classList.contains('hidden')) return;
    if (dockInlineEditor && !dockInlineEditor.classList.contains('hidden')) return;
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
    openHistory: () => goToDockWelcomeHome('history').catch(() => {}),
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
  dockHomeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.__dockToggleInternet?.();
  });
}

if (dockDownloadsBtn) {
  dockDownloadsBtn.addEventListener('click', () => {
    goToDockWelcomeHome(homeView === 'downloads' ? 'todos' : 'downloads').catch(() => {});
  });
}

/* ---------------- Página de Historial ---------------- */

let historyHomeWired = false;
let historySearchTimer = 0;
const HISTORY_PAGE_SIZE = 300;
/** Entradas ya cargadas, de la visita más reciente a la más vieja. */
let historyItems = [];
/** Posición en la lista del proceso principal hasta donde ya pedimos. */
let historyOffset = 0;
let historyHasMore = false;
let historyLoading = false;
let historyLoadSeq = 0;
/** Grupos de un mismo sitio desplegados (clave: día + host + primera URL). */
const historyExpandedGroups = new Set();
let historyMoreObserver = null;

function formatHistoryTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function historyDayLabel(ts) {
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const d = new Date(ts);
  const today = startOf(new Date());
  const day = startOf(d);
  if (day === today) return 'Hoy';
  if (day === today - 86400000) return 'Ayer';
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  try {
    const s = d.toLocaleDateString([], opts);
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return '';
  }
}

function openHistoryUrl(url) {
  try {
    window.usualDesk.looseNavNewTab(url);
  } catch {
    /* noop */
  }
}

function historyFavEl(host) {
  const fav = document.createElement('span');
  fav.className = 'history-row-fav';
  fav.textContent = (host || '?').charAt(0).toUpperCase();
  if (host) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => fav.classList.add('has-img'));
    img.addEventListener('error', () => img.remove());
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
    fav.appendChild(img);
  }
  return fav;
}

function historyDelButton(label, onDelete) {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'history-row-del';
  del.textContent = '\u00d7';
  del.setAttribute('aria-label', label);
  del.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onDelete();
  });
  return del;
}

async function removeHistoryUrls(urls) {
  try {
    await window.usualDesk.removeHistory(urls.length === 1 ? urls[0] : urls);
  } catch {
    /* noop */
  }
  const gone = new Set(urls);
  const before = historyItems.length;
  historyItems = historyItems.filter((it) => !gone.has(it.url));
  historyOffset = Math.max(0, historyOffset - (before - historyItems.length));
  paintHistoryHome();
}

/**
 * Agrupa por día y, dentro del día, junta las visitas seguidas al mismo sitio
 * (p. ej. varias notas de infobae una tras otra).
 */
function groupHistoryItems(items) {
  const days = [];
  for (const it of items) {
    const label = (it.lastVisit && historyDayLabel(it.lastVisit)) || 'Sin fecha';
    let day = days[days.length - 1];
    if (!day || day.label !== label) {
      day = { label, blocks: [] };
      days.push(day);
    }
    const last = day.blocks[day.blocks.length - 1];
    if (last && it.host && last.host === it.host) last.items.push(it);
    else day.blocks.push({ host: it.host, items: [it] });
  }
  return days;
}

function buildHistoryRow(it, nested) {
  const row = document.createElement('div');
  row.className = nested ? 'history-row is-nested' : 'history-row';
  row.title = it.url;

  const body = document.createElement('div');
  body.className = 'history-row-body';
  const title = document.createElement('span');
  title.className = 'history-row-title';
  title.textContent = it.title || it.host || it.url;
  const url = document.createElement('span');
  url.className = 'history-row-url';
  url.textContent = it.url.replace(/^https?:\/\/(www\.)?/i, '');
  body.append(title, url);

  const time = document.createElement('span');
  time.className = 'history-row-time';
  time.textContent = formatHistoryTime(it.lastVisit);

  const del = historyDelButton('Quitar del historial', () => removeHistoryUrls([it.url]));
  if (nested) row.append(time, body, del);
  else row.append(time, historyFavEl(it.host), body, del);
  row.addEventListener('click', () => openHistoryUrl(it.url));
  return row;
}

function buildHistoryGroup(block, key) {
  const { items, host } = block;
  const wrap = document.createElement('div');
  wrap.className = 'history-group';

  const head = document.createElement('div');
  head.className = 'history-row history-group-head';
  head.tabIndex = 0;
  head.setAttribute('role', 'button');

  const body = document.createElement('div');
  body.className = 'history-row-body';
  const title = document.createElement('span');
  title.className = 'history-row-title';
  const name = document.createElement('span');
  name.textContent = host;
  const count = document.createElement('span');
  count.className = 'history-group-count';
  count.textContent = `${items.length} páginas`;
  title.append(name, count);
  const preview = document.createElement('span');
  preview.className = 'history-row-url';
  preview.textContent = items
    .slice(0, 3)
    .map((it) => it.title || it.url)
    .join('  ·  ');
  body.append(title, preview);

  const time = document.createElement('span');
  time.className = 'history-row-time';
  const newest = formatHistoryTime(items[0].lastVisit);
  const oldest = formatHistoryTime(items[items.length - 1].lastVisit);
  if (oldest && oldest !== newest) {
    time.classList.add('is-range');
    const top = document.createElement('span');
    top.textContent = newest;
    const bottom = document.createElement('span');
    bottom.textContent = oldest;
    time.append(top, bottom);
    time.title = `${oldest} – ${newest}`;
  } else {
    time.textContent = newest;
  }

  const chevron = document.createElement('span');
  chevron.className = 'history-group-chevron';
  chevron.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const del = historyDelButton(`Quitar las ${items.length} páginas de ${host}`, () =>
    removeHistoryUrls(items.map((it) => it.url)),
  );
  head.append(time, historyFavEl(host), body, del, chevron);

  const children = document.createElement('div');
  children.className = 'history-group-items';

  const setExpanded = (on) => {
    if (on) historyExpandedGroups.add(key);
    else historyExpandedGroups.delete(key);
    wrap.classList.toggle('is-expanded', on);
    head.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on && !children.childElementCount) {
      for (const it of items) children.appendChild(buildHistoryRow(it, true));
    }
  };
  head.addEventListener('click', () => setExpanded(!wrap.classList.contains('is-expanded')));
  head.addEventListener('keydown', (ev) => {
    if (ev.target !== head || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    setExpanded(!wrap.classList.contains('is-expanded'));
  });

  wrap.append(head, children);
  setExpanded(historyExpandedGroups.has(key));
  return wrap;
}

function paintHistoryHome() {
  const list = document.getElementById('history-home-list');
  const empty = document.getElementById('history-home-empty');
  if (!list) return;
  const scrollTop = list.scrollTop;
  if (historyMoreObserver) historyMoreObserver.disconnect();
  list.innerHTML = '';
  if (empty) empty.hidden = historyItems.length > 0 || historyLoading;
  if (!historyItems.length) return;

  for (const day of groupHistoryItems(historyItems)) {
    const section = document.createElement('section');
    section.className = 'history-day';
    const sep = document.createElement('div');
    sep.className = 'history-day-sep';
    sep.textContent = day.label;
    const card = document.createElement('div');
    card.className = 'history-day-card';
    for (const block of day.blocks) {
      if (block.items.length > 1) {
        card.appendChild(buildHistoryGroup(block, `${day.label}|${block.host}|${block.items[0].url}`));
      } else {
        card.appendChild(buildHistoryRow(block.items[0], false));
      }
    }
    section.append(sep, card);
    list.appendChild(section);
  }

  if (historyHasMore) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'history-load-more';
    more.textContent = 'Cargar historial más antiguo';
    more.addEventListener('click', () => loadHistoryPage(false));
    list.appendChild(more);
    if (!historyMoreObserver && typeof IntersectionObserver === 'function') {
      historyMoreObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadHistoryPage(false);
        },
        { root: list, rootMargin: '600px 0px' },
      );
    }
    historyMoreObserver?.observe(more);
  }
  list.scrollTop = scrollTop;
}

async function loadHistoryPage(reset) {
  if (historyLoading && !reset) return;
  const seq = reset ? ++historyLoadSeq : historyLoadSeq;
  const query = (document.getElementById('history-search-input')?.value || '').trim();
  historyLoading = true;
  let page = [];
  try {
    page =
      (await window.usualDesk.listHistory(query, HISTORY_PAGE_SIZE, reset ? 0 : historyOffset)) || [];
  } catch {
    page = [];
  }
  if (seq !== historyLoadSeq) return;
  historyLoading = false;
  historyHasMore = page.length === HISTORY_PAGE_SIZE;
  historyOffset = (reset ? 0 : historyOffset) + page.length;
  if (reset) {
    historyItems = page;
  } else {
    // Una visita nueva entre páginas corre los offsets: evitamos duplicados.
    const seen = new Set(historyItems.map((it) => it.url));
    historyItems = historyItems.concat(page.filter((it) => !seen.has(it.url)));
  }
  paintHistoryHome();
  if (reset) {
    const list = document.getElementById('history-home-list');
    if (list) list.scrollTop = 0;
  }
}

function renderHistoryHome() {
  return loadHistoryPage(true);
}

function wireHistoryHome() {
  if (historyHomeWired) return;
  historyHomeWired = true;
  const input = document.getElementById('history-search-input');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(historySearchTimer);
      historySearchTimer = setTimeout(() => renderHistoryHome(), 150);
    });
  }
  const clearBtn = document.getElementById('history-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      try {
        await window.usualDesk.clearHistory();
      } catch {
        /* noop */
      }
      if (input) input.value = '';
      renderHistoryHome();
    });
  }
}

document.getElementById('downloads-expand-btn')?.addEventListener('click', () => {
  goToDockWelcomeHome('downloads').catch(() => {});
});

document.querySelectorAll('.home-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.homeNav === 'downloads' ? 'downloads' : 'todos';
    goToDockWelcomeHome(view).catch(() => {});
  });
});

/** Ancho de la columna de archivos: el borde derecho se arrastra y los tiles
 *  acompañan el tamaño. Doble clic vuelve al tamaño por defecto. */
const DOWNLOADS_STRIP_KEY = 'inplaize.downloadsStripTile';
const DOWNLOADS_STRIP_DEFAULT = 96;
const DOWNLOADS_STRIP_MIN = 56;
const DOWNLOADS_STRIP_MAX = 260;

(function initDownloadsStripResizer() {
  const panel = document.getElementById('dock-home-panel');
  const handle = document.getElementById('downloads-strip-resizer');
  if (!panel || !handle) return;

  const clamp = (px) => Math.min(DOWNLOADS_STRIP_MAX, Math.max(DOWNLOADS_STRIP_MIN, Math.round(px)));
  const apply = (px) => panel.style.setProperty('--downloads-strip-tile', `${px}px`);
  const save = (px) => {
    try {
      localStorage.setItem(DOWNLOADS_STRIP_KEY, String(px));
    } catch {
      /* noop */
    }
  };

  let size = DOWNLOADS_STRIP_DEFAULT;
  try {
    size = clamp(parseInt(localStorage.getItem(DOWNLOADS_STRIP_KEY), 10) || DOWNLOADS_STRIP_DEFAULT);
  } catch {
    /* noop */
  }
  apply(size);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startSize = size;
    handle.classList.add('is-dragging');
    panel.classList.add('is-strip-resizing');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    const move = (ev) => {
      size = clamp(startSize + ev.clientX - startX);
      apply(size);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('is-dragging');
      panel.classList.remove('is-strip-resizing');
      save(size);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });

  handle.addEventListener('dblclick', () => {
    size = DOWNLOADS_STRIP_DEFAULT;
    apply(size);
    save(size);
  });
})();

async function exitShortcutsEditModeFromUi() {
  const formWasOpen =
    (dockInlineEditor && !dockInlineEditor.classList.contains('hidden')) ||
    (modalOverlay && !modalOverlay.classList.contains('hidden'));
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

/** Sesión del perfil de la página desde la que se abrió el alta; si no, el acceso estrena la suya. */
let addShortcutPageSessionId = '';
/** Favicon que ya mostró la pestaña: vale solo mientras la URL del formulario siga siendo la de la página. */
let addShortcutPageFavicon = null;

function openAddModal() {
  editingId = null;
  addShortcutPageSessionId = '';
  addShortcutPageFavicon = null;
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

/** El alta de acceso se abrió encima de la navegación libre, con la página de fondo. */
let addShortcutCoversLooseNav = false;

/** La vista nativa tapa el modal: se cambia por una foto de la página mientras está abierto. */
async function coverLooseNavPage() {
  let shot = '';
  try {
    shot = (await window.usualDesk.looseNavCoverPage?.(true)) || '';
  } catch {
    shot = '';
  }
  addShortcutCoversLooseNav = true;
  if (looseNavSurface && shot) {
    looseNavSurface.style.backgroundImage = `url("${shot}")`;
    looseNavSurface.classList.add('is-covered');
  }
}

function clearLooseNavCover() {
  if (!looseNavSurface) return;
  looseNavSurface.style.backgroundImage = '';
  looseNavSurface.classList.remove('is-covered');
}

/** Al cancelar, la página real vuelve a su lugar. */
function uncoverLooseNavPage() {
  if (!addShortcutCoversLooseNav) return;
  addShortcutCoversLooseNav = false;
  clearLooseNavCover();
  window.usualDesk.looseNavCoverPage?.(false)?.catch?.(() => {});
}

/**
 * "Añadir a accesos directos" desde la navegación libre: el formulario se abre
 * encima de la página; recién al guardar se pasa a los accesos.
 * @param {{ url?: string, title?: string, sessionId?: string, favicon?: string } | null} page
 */
async function openAddShortcutForPage(page) {
  const url = page && typeof page.url === 'string' ? page.url : '';
  if (!url) return;
  if (looseNavState?.active) await coverLooseNavPage();
  else await goToDockWelcomeHome();
  openAddModal();
  addShortcutPageSessionId = String((page && page.sessionId) || '');
  const favicon = String((page && page.favicon) || '');
  if (inputType) {
    inputType.value = 'web';
    updateFormTypeUI();
  }
  if (inputName) inputName.value = String((page && page.title) || '').trim().slice(0, 60);
  if (inputUrl) {
    inputUrl.value = url.trim();
    if (favicon.startsWith('data:image/')) {
      dropStaleSiteIconRows(favicon);
      autoFaviconValue = favicon;
      setSelectedIcon(favicon);
    } else {
      addShortcutPageFavicon = favicon ? { pageUrl: url.trim(), iconUrl: favicon } : null;
      inputUrl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  inputName?.focus();
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
  if (typeRow) typeRow.classList.add('hidden');
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
  uncoverLooseNavPage();
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
document.getElementById('modal-close')?.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

if (dockInlineEditor) {
  dockInlineEditor.addEventListener('click', (e) => {
    if (e.target === dockInlineEditor) closeModal();
  });
}

/** Muestra el formulario de acceso directo en un modal centrado. */
function showShortcutFormShell() {
  if (!shortcutModalCard || !modalOverlay) return;
  shortcutModalCard.classList.add('shortcut-modal-embed');
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

document.getElementById('strip-edit-toggle')?.addEventListener('click', () => {
  if (shortcutsEditMode) return;
  shortcutsEditMode = true;
  renderShortcuts();
});

document.getElementById('strip-edit-done')?.addEventListener('click', () => {
  if (!shortcutsEditMode) return;
  exitShortcutsEditModeFromUi().catch(() => {});
});

// En captura: corre antes que el Escape que cierra el formulario, así ese
// primer Escape solo cierra el formulario y no también el modo edición.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !shortcutsEditMode || shortcutReorder) return;
    if (!modalOverlay.classList.contains('hidden')) return;
    if (dockInlineEditor && !dockInlineEditor.classList.contains('hidden')) return;
    if (appearanceModalOverlay && !appearanceModalOverlay.classList.contains('hidden')) return;
    exitShortcutsEditModeFromUi().catch(() => {});
  },
  true,
);

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
    } else if (!editingId && addShortcutPageSessionId) {
      data.sessionId = addShortcutPageSessionId;
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
  if (addShortcutCoversLooseNav) {
    // La página no vuelve a aparecer: se sale directo a los accesos, donde quedó el nuevo.
    addShortcutCoversLooseNav = false;
    await goToDockWelcomeHome();
    clearLooseNavCover();
    window.usualDesk.looseNavCoverPage?.(false)?.catch?.(() => {});
    return;
  }
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
const looseNavControls = document.getElementById('loose-nav-controls');
const looseNavNewTabBtn = document.getElementById('loose-nav-new-tab-btn');
const dockViewport = document.getElementById('dock-viewport');
const looseNavSurface = document.getElementById('loose-nav-surface');
const looseNavAccountsRail = document.getElementById('loose-nav-accounts');
const looseNavOmnibox = document.getElementById('loose-nav-omnibox');
const looseNavOmniboxInput = document.getElementById('loose-nav-omnibox-input');
const looseNavAddShortcutBtn = document.getElementById('loose-nav-add-shortcut-btn');

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

/** Dock oculto con "www" abierto: la franja se queda como está hasta que se retome al volver. */
let looseNavResumePending = false;

let lastSentViewportBounds = null;
let viewportBoundsFrame = 0;
let looseNavActiveShortcutId = null;
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
  // El dropdown de sugerencias no puede dibujarse sobre la vista nativa: en vez
  // de taparla, empujamos la página hacia abajo `inset` px y mostramos el
  // dropdown (DOM) en el hueco que queda bajo la barra.
  const inset = looseNavSuggestInset || 0;
  const h = Math.max(0, Math.round(r.height) - inset);
  if (w <= 0 || h <= 0) return null;
  return {
    x: Math.max(0, Math.round(r.left)),
    y: Math.max(0, Math.round(r.top) + inset),
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

/* ---------------- Sugerencias de la barra de direcciones ----------------
 * La navegación suelta se dibuja con una vista nativa que taparía un dropdown
 * HTML. Para mostrarlo, insetamos la página desde arriba (ver
 * computeViewportBoundsPayload) y ubicamos el dropdown, en position:fixed, en el
 * hueco resultante bajo la barra. */
const looseNavSuggest = { box: null, items: [], active: -1, seq: 0, inputEl: null, onCommit: null };
let looseNavSuggestInset = 0;

function setLooseNavSuggestInset(px) {
  const next = Math.max(0, Math.round(px || 0));
  if (next === looseNavSuggestInset) return;
  looseNavSuggestInset = next;
  invalidateLooseNavViewport();
}

function closeLooseNavSuggest() {
  looseNavSuggest.items = [];
  looseNavSuggest.active = -1;
  looseNavSuggest.inputEl = null;
  looseNavSuggest.onCommit = null;
  looseNavSuggest.seq += 1;
  if (looseNavSuggest.box) {
    looseNavSuggest.box.remove();
    looseNavSuggest.box = null;
  }
  setLooseNavSuggestInset(0);
}

function positionLooseNavSuggest() {
  if (!looseNavSuggest.box || !looseNavSuggest.inputEl || !dockViewport) return;
  // Verticalmente va en el hueco al tope del área de contenido (donde empujamos
  // la vista nativa). Horizontalmente se alinea al ancho de la barra de
  // direcciones, como la omnibox de Chrome (no ocupa toda la pantalla).
  const anchor = looseNavSuggest.inputEl.closest('.loose-nav-omnibox') || looseNavSuggest.inputEl;
  const ar = anchor.getBoundingClientRect();
  const vr = dockViewport.getBoundingClientRect();
  const left = Math.max(vr.left, Math.round(ar.left));
  const width = Math.min(Math.round(vr.width), Math.max(320, Math.round(ar.width)));
  looseNavSuggest.box.style.top = `${Math.round(vr.top)}px`;
  looseNavSuggest.box.style.left = `${left}px`;
  looseNavSuggest.box.style.width = `${width}px`;
}

/** `true` si el texto parece una URL/host navegable en vez de una búsqueda. */
function looseNavLooksLikeUrl(q) {
  const s = String(q || '').trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(s);
}

function looseNavHostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Arma las filas: fila de acción (ir a / buscar) + coincidencias del historial. */
function buildLooseNavSuggestItems(q, hist) {
  const items = [];
  const seen = new Set();
  if (looseNavLooksLikeUrl(q)) {
    const url = /^https?:\/\//i.test(q) ? q : `https://${q}`;
    seen.add(url);
    items.push({ kind: 'nav', value: url, title: q, sub: looseNavHostOf(url) || url, host: looseNavHostOf(url) });
  } else {
    items.push({ kind: 'search', value: q, title: q, sub: 'Búsqueda de Google', host: '' });
  }
  for (const h of hist) {
    if (!h || !h.url || seen.has(h.url)) continue;
    seen.add(h.url);
    items.push({
      kind: 'url',
      value: h.url,
      title: h.title || h.host || h.url,
      sub: h.url,
      host: h.host || looseNavHostOf(h.url),
    });
    if (items.length >= 8) break;
  }
  return items;
}

/** Ícono: favicon del sitio (con fallback a inicial) o una lupa para búsquedas. */
function looseNavSuggestIcon(item) {
  const wrap = document.createElement('span');
  wrap.className = 'loose-nav-suggest-fav';
  if (item.kind === 'search') {
    wrap.classList.add('is-search');
    wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    return wrap;
  }
  if (item.host) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(item.host)}&sz=32`;
    img.addEventListener('error', () => {
      wrap.classList.add('is-fallback');
      wrap.textContent = (item.host.charAt(0) || '?').toUpperCase();
    });
    wrap.appendChild(img);
  } else {
    wrap.classList.add('is-fallback');
    wrap.textContent = (String(item.title || '?').charAt(0) || '?').toUpperCase();
  }
  return wrap;
}

/** Resalta la parte del texto que coincide con la consulta (como Chrome). */
function looseNavHighlight(text, q) {
  const span = document.createElement('span');
  const t = String(text || '');
  const needle = String(q || '').trim().toLowerCase();
  const idx = needle ? t.toLowerCase().indexOf(needle) : -1;
  if (idx === -1) {
    span.textContent = t;
    return span;
  }
  span.append(document.createTextNode(t.slice(0, idx)));
  const b = document.createElement('b');
  b.textContent = t.slice(idx, idx + needle.length);
  span.append(b, document.createTextNode(t.slice(idx + needle.length)));
  return span;
}

function paintLooseNavSuggest(q) {
  if (!looseNavSuggest.items.length) {
    closeLooseNavSuggest();
    return;
  }
  if (!looseNavSuggest.box) {
    const box = document.createElement('div');
    box.className = 'loose-nav-suggest';
    box.setAttribute('data-mouse-hit', '');
    document.body.appendChild(box);
    looseNavSuggest.box = box;
  }
  const box = looseNavSuggest.box;
  box.innerHTML = '';
  const query = q != null ? q : (looseNavSuggest.inputEl?.value || '');
  looseNavSuggest.items.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'loose-nav-suggest-row' + (i === looseNavSuggest.active ? ' is-active' : '');
    row.appendChild(looseNavSuggestIcon(s));
    const text = document.createElement('span');
    text.className = 'loose-nav-suggest-text';
    const primary = looseNavHighlight(s.title, query);
    primary.className = 'loose-nav-suggest-primary';
    text.appendChild(primary);
    if (s.sub) {
      const secondary = document.createElement('span');
      secondary.className = 'loose-nav-suggest-url';
      secondary.textContent = s.sub;
      text.appendChild(secondary);
    }
    row.appendChild(text);
    row.addEventListener('mouseenter', () => {
      looseNavSuggest.active = i;
      box.querySelectorAll('.loose-nav-suggest-row').forEach((el, j) => {
        el.classList.toggle('is-active', j === i);
      });
    });
    row.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      commitLooseNavSuggestItem(i, { forceNewTab: ev.altKey });
    });
    box.appendChild(row);
  });
  positionLooseNavSuggest();
  // Medimos la altura real para liberar exactamente ese hueco sobre la vista nativa.
  requestAnimationFrame(() => {
    if (!looseNavSuggest.box) return;
    setLooseNavSuggestInset(looseNavSuggest.box.offsetHeight + 8);
  });
}

function commitLooseNavSuggestItem(i, opts = {}) {
  const item = looseNavSuggest.items[i];
  if (!item) return;
  const onCommit = looseNavSuggest.onCommit;
  const value = item.value;
  closeLooseNavSuggest();
  if (typeof onCommit === 'function') onCommit(value, opts);
}

async function refreshLooseNavSuggest(input, onCommit) {
  const q = (input.value || '').trim();
  looseNavSuggest.inputEl = input;
  if (typeof onCommit === 'function') looseNavSuggest.onCommit = onCommit;
  if (q.length < 1) {
    closeLooseNavSuggest();
    return;
  }
  const seq = ++looseNavSuggest.seq;
  let hist = [];
  if (typeof window.usualDesk?.suggestHistory === 'function') {
    try {
      hist = await window.usualDesk.suggestHistory(q, 7);
    } catch {
      hist = [];
    }
  }
  if (seq !== looseNavSuggest.seq || !input.isConnected || document.activeElement !== input) return;
  looseNavSuggest.inputEl = input;
  if (typeof onCommit === 'function') looseNavSuggest.onCommit = onCommit;
  looseNavSuggest.items = buildLooseNavSuggestItems(q, Array.isArray(hist) ? hist : []);
  looseNavSuggest.active = -1;
  paintLooseNavSuggest(q);
}

function looseNavSuggestKeydown(ev, input) {
  if (ev.key === 'Escape') {
    if (looseNavSuggest.box) {
      ev.preventDefault();
      ev.stopPropagation();
      closeLooseNavSuggest();
      return true;
    }
    return false;
  }
  if (!looseNavSuggest.items.length) return false;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    looseNavSuggest.active = (looseNavSuggest.active + 1) % looseNavSuggest.items.length;
    paintLooseNavSuggest();
    return true;
  }
  if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    const n = looseNavSuggest.items.length;
    looseNavSuggest.active = (looseNavSuggest.active - 1 + n) % n;
    paintLooseNavSuggest();
    return true;
  }
  if (ev.key === 'Enter' && looseNavSuggest.active >= 0) {
    ev.preventDefault();
    commitLooseNavSuggestItem(looseNavSuggest.active, { forceNewTab: ev.altKey });
    return true;
  }
  return false;
}

window.__dockToggleInternet = () => {
  if (looseNavState.active) {
    goToDockWelcomeHome(homeView);
    return;
  }
  window.usualDesk.openAppBrowser?.().catch(() => {});
};

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

let looseNavControlButtons = null;

/** Atrás, adelante y recargar fijos a la izquierda de las pestañas; actúan sobre la activa. */
function renderLooseNavControls(state) {
  if (!looseNavControls) return;
  if (!looseNavControlButtons) {
    looseNavControlButtons = {
      back: makeLooseNavIconButton('loose-nav-tab-nav-btn', 'Atrás', LOOSE_NAV_BACK_SVG, false,
        () => window.usualDesk.looseNavBack().catch(() => {})),
      forward: makeLooseNavIconButton('loose-nav-tab-nav-btn', 'Adelante', LOOSE_NAV_FORWARD_SVG, false,
        () => window.usualDesk.looseNavForward().catch(() => {})),
      reload: makeLooseNavIconButton('loose-nav-tab-nav-btn', 'Recargar', LOOSE_NAV_RELOAD_SVG, false,
        () => window.usualDesk.looseNavReload().catch(() => {})),
    };
    looseNavControls.append(looseNavControlButtons.back, looseNavControlButtons.forward, looseNavControlButtons.reload);
  }
  const active = state.tabs.find((t) => t.isActive);
  looseNavControlButtons.back.disabled = !active?.canGoBack;
  looseNavControlButtons.forward.disabled = !active?.canGoForward;
  looseNavControlButtons.reload.disabled = !active;
}

const LOOSE_NAV_AUDIBLE_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/>' +
  '<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '</svg>';
const LOOSE_NAV_MUTED_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/>' +
  '<path d="m15.5 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '</svg>';

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

function looseNavProfileHue(partition) {
  let h = 0;
  for (const ch of String(partition || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** Pone el cursor en la barra de dirección; `clear` la deja vacía para escribir de cero. */
function focusLooseNavOmnibox({ clear = false } = {}) {
  if (!looseNavOmniboxInput || !looseNavState.active) return;
  looseNavOmniboxInput.focus();
  if (clear) looseNavOmniboxInput.value = '';
  else looseNavOmniboxInput.select();
}

/** Como Chrome: el "+" abre la pestaña y lleva a la barra de dirección para escribir ahí. */
function openLooseNavBlankTab() {
  if (!looseNavState.active) return;
  focusLooseNavOmnibox({ clear: true });
  window.usualDesk.looseNavNewTab('', { partition: looseNavOmniboxPartition(), nextToActive: true }).catch(() => {});
}

function renderLooseNavTabs(state) {
  if (!looseNavTabsStrip) return;
  renderLooseNavControls(state);

  looseNavTabsStrip.innerHTML = '';

  const sessionTabs = state.tabs.filter((t) => !state.activePartition || t.partition === state.activePartition);
  for (const tab of sessionTabs) {
    const el = document.createElement('div');
    el.className = 'loose-nav-tab';
    el.setAttribute('role', 'tab');
    el.dataset.tabId = tab.id;
    el.setAttribute('aria-selected', tab.isActive ? 'true' : 'false');
    if (tab.isActive) el.classList.add('is-active');
    if (tab.loading) el.classList.add('is-loading');
    const tabTip = tab.title || tab.url || 'Pestaña';
    el.setAttribute(
      'data-tooltip',
      tab.isDefaultProfile ? tabTip : `${tabTip} · Perfil: ${tab.profileLabel || ''}`
    );
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

    if (tab.pinned) {
      el.classList.add('is-pinned');
    } else {
      const titleEl = document.createElement('span');
      titleEl.className = 'loose-nav-tab-title';
      titleEl.textContent = tab.title || tab.url || 'Pestaña';
      el.appendChild(titleEl);
    }

    if (tab.audible || tab.muted) {
      const audio = document.createElement('button');
      audio.type = 'button';
      audio.className = 'loose-nav-tab-audio';
      const audioLabel = tab.muted ? 'Activar sonido del sitio' : 'Silenciar sitio';
      audio.setAttribute('aria-label', audioLabel);
      audio.setAttribute('data-tooltip', audioLabel);
      audio.setAttribute('data-tooltip-placement', 'bottom');
      audio.innerHTML = tab.muted ? LOOSE_NAV_MUTED_SVG : LOOSE_NAV_AUDIBLE_SVG;
      audio.addEventListener('click', (ev) => {
        ev.stopPropagation();
        window.usualDesk.looseNavToggleMute(tab.id).catch(() => {});
      });
      el.appendChild(audio);
    }

    if (!tab.pinned) {
      appendLooseNavClose(el, 'Cerrar pestaña', () => {
        window.usualDesk.looseNavCloseTab(tab.id).catch(() => {});
      });
    }

    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      window.usualDesk.looseNavOpenTabMenu(tab.id, ev.clientX, ev.clientY).catch(() => {});
    });

    el.addEventListener('click', () => {
      if (tab.isActive) return;
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

  looseNavTabsStrip
    .querySelector('.loose-nav-tab.is-active')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

let looseNavAccountBusy = '';
let looseNavAccountsSig = '';
/** Modo edición del riel de perfiles: se reordenan arrastrando, la cruz quita y el "+" agrega. */
let looseNavProfilesEditMode = false;
/** @type {{ el: HTMLElement, pointerId: number, startX: number, active: boolean } | null} */
let looseNavProfileDrag = null;
let looseNavAccountsRenderPending = false;
const looseNavProfilesEditBtn = document.getElementById('loose-nav-profiles-edit');
const looseNavProfilesDoneBtn = document.getElementById('loose-nav-profiles-done');
function setLooseNavProfilesEditMode(on) {
  const next = on === true;
  if (looseNavProfilesEditMode === next) return;
  looseNavProfilesEditMode = next;
  if (looseNavProfilesEditBtn) looseNavProfilesEditBtn.hidden = next;
  if (looseNavProfilesDoneBtn) looseNavProfilesDoneBtn.hidden = !next;
  looseNavAccountsRail?.classList.toggle('is-editing', next);
  document.documentElement.setAttribute('data-profiles-edit', next ? 'on' : 'off');
  // Mientras se editan los perfiles la página no se ve, como la home en los accesos.
  window.usualDesk.setUrlPromptOpen?.(next)?.catch?.(() => {});
  renderLooseNavAccounts(looseNavState);
}

function looseNavReorderableProfiles() {
  return looseNavAccountsRail
    ? [...looseNavAccountsRail.querySelectorAll('.loose-nav-account[data-partition]')]
    : [];
}

function moveLooseNavProfileToPointer(btn, x) {
  const others = looseNavReorderableProfiles().filter((el) => el !== btn);
  const next = others.find((el) => {
    const r = el.getBoundingClientRect();
    return x < r.left + r.width / 2;
  });
  if (next) {
    if (btn.nextElementSibling !== next) looseNavAccountsRail.insertBefore(btn, next);
    return;
  }
  const last = others[others.length - 1];
  if (last && last.nextElementSibling !== btn) last.after(btn);
}

function bindLooseNavProfileReorder(btn) {
  btn.addEventListener('pointerdown', (ev) => {
    if (!looseNavProfilesEditMode || ev.button !== 0 || looseNavProfileDrag) return;
    if (ev.target instanceof Element && ev.target.closest('.loose-nav-account-remove')) return;
    const drag = { el: btn, pointerId: ev.pointerId, startX: ev.clientX, active: false };
    looseNavProfileDrag = drag;
    const onMove = (e) => {
      if (e.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.abs(e.clientX - drag.startX) < 5) return;
        drag.active = true;
        btn.classList.add('is-dragging');
        document.documentElement.classList.add('is-shortcut-reordering');
      }
      if (e.cancelable) e.preventDefault();
      moveLooseNavProfileToPointer(btn, e.clientX);
    };
    const finish = (e) => {
      if (e && e.pointerId != null && e.pointerId !== drag.pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      btn.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-shortcut-reordering');
      looseNavProfileDrag = null;
      if (drag.active) {
        const order = looseNavReorderableProfiles().map((el) => el.dataset.partition);
        window.usualDesk.looseNavReorderProfiles?.(order).catch(() => {});
      }
      if (looseNavAccountsRenderPending) {
        looseNavAccountsRenderPending = false;
        renderLooseNavAccounts(looseNavState);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  });
}

function looseNavAddProfileButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'shell-shortcut-item strip-add-shortcut strip-add-inline strip-add-secondary';
  btn.innerHTML =
    '<span class="shell-shortcut-icon-wrap" aria-hidden="true">' +
    '<svg class="strip-add-plus" viewBox="0 0 24 24" fill="none">' +
    '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
    '</svg></span><span>Agregar perfil</span>';
  btn.addEventListener('click', () => {
    const r = btn.getBoundingClientRect();
    window.usualDesk.looseNavOpenAddProfileMenu?.(r.left, r.bottom).catch(() => {});
  });
  return btn;
}

const LOOSE_NAV_INCOGNITO_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M6.5 10.5 8 5.6a1 1 0 0 1 1.3-.66L12 6l2.7-1.06a1 1 0 0 1 1.3.66l1.5 4.9z" fill="currentColor"/>' +
  '<path d="M3.5 11h17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '<circle cx="7.5" cy="16" r="2.6" stroke="currentColor" stroke-width="1.8"/>' +
  '<circle cx="16.5" cy="16" r="2.6" stroke="currentColor" stroke-width="1.8"/>' +
  '<path d="M10.1 16c1.2-.7 2.6-.7 3.8 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '</svg>';
/** Corre una acción del riel con la cuenta marcada como ocupada hasta que termine. */
async function runLooseNavAccountAction(key, el, action) {
  if (looseNavAccountBusy) return;
  looseNavAccountBusy = key;
  el.classList.add('is-busy');
  try {
    await action();
  } catch {
    /* el main muestra el error si no pudo traer la cuenta */
  } finally {
    looseNavAccountBusy = '';
    renderLooseNavAccounts(looseNavState);
  }
}

function looseNavAccountButton({
  key, label, tooltip, avatar, seed, incognito, active, isDefault, count = 0, partition, onClick, onSetDefault, onRemove,
}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'loose-nav-account';
  if (partition) btn.dataset.partition = partition;
  if (looseNavProfilesEditMode) {
    const hints = [partition ? 'arrastrá para moverlo' : '', onRemove ? 'la cruz lo quita' : ''].filter(Boolean);
    tooltip = hints.length ? `${label} · ${hints.join(' · ')}` : label;
  }
  btn.title = tooltip;
  btn.setAttribute('aria-label', tooltip);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  if (active) btn.classList.add('is-active');
  if (isDefault) btn.classList.add('is-default');
  if (looseNavAccountBusy === key) btn.classList.add('is-busy');
  if (incognito) {
    const glyph = document.createElement('span');
    glyph.className = 'loose-nav-account-incognito';
    glyph.innerHTML = LOOSE_NAV_INCOGNITO_SVG;
    btn.appendChild(glyph);
  } else if (avatar && avatar.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = '';
    btn.appendChild(img);
  } else {
    const letter = document.createElement('span');
    letter.className = 'loose-nav-account-letter';
    letter.textContent = (label || '?').trim().charAt(0).toUpperCase() || '?';
    letter.style.setProperty('--loose-nav-profile-hue', String(looseNavProfileHue(seed)));
    btn.appendChild(letter);
  }
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'loose-nav-account-count';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = count > 99 ? '99+' : String(count);
    btn.appendChild(badge);
  }
  if (looseNavProfilesEditMode && onRemove) {
    const remove = document.createElement('span');
    remove.className = 'loose-nav-account-remove';
    remove.title = `Quitar ${label}`;
    remove.innerHTML = LOOSE_NAV_REMOVE_SVG;
    btn.appendChild(remove);
  }
  if (looseNavProfilesEditMode && partition) bindLooseNavProfileReorder(btn);
  btn.addEventListener('click', (ev) => {
    if (!looseNavProfilesEditMode) {
      runLooseNavAccountAction(key, btn, onClick);
      return;
    }
    if (onRemove && ev.target instanceof Element && ev.target.closest('.loose-nav-account-remove')) {
      runLooseNavAccountAction(key, btn, onRemove);
    }
  });
  if (onSetDefault) {
    btn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (isDefault || looseNavProfilesEditMode) return;
      runLooseNavAccountAction(key, btn, onSetDefault);
    });
  }
  return btn;
}

/**
 * Fila de perfiles en la franja de arriba (en lugar de los accesos directos):
 * cada sesión con sus pestañas; tocar una entra a las de esa sesión. Clic
 * derecho la deja como predeterminada de las pestañas nuevas (estrella).
 */
function renderLooseNavAccounts(state) {
  if (!looseNavAccountsRail) return;
  const accounts = (state.accounts && state.accounts.accounts) || [];
  const chrome = (state.accounts && state.accounts.chrome) || [];
  const counts = state.tabCounts || {};
  const defaultPartition = (state.defaultProfile && state.defaultProfile.partition) || '';
  const show = !!state.active;
  if (looseNavProfileDrag) {
    looseNavAccountsRenderPending = true;
    return;
  }
  const sig = show
    ? JSON.stringify([
      state.activePartition, defaultPartition, looseNavAccountBusy, looseNavProfilesEditMode, counts, accounts, chrome,
    ])
    : '';
  if (sig === looseNavAccountsSig) return;
  looseNavAccountsSig = sig;
  looseNavAccountsRail.innerHTML = '';
  if (!show) return;

  for (const a of accounts) {
    const display = a.incognito ? `${a.name} (incógnito)` : a.name || a.email;
    const who = a.name && a.email ? `${a.name} (${a.email})` : display;
    const count = counts[a.partition] || 0;
    const tabsLabel = count === 1 ? '1 pestaña' : `${count} pestañas`;
    const isDefault = a.partition === defaultPartition;
    const opts = {
      key: a.partition,
      label: a.name || a.email,
      tooltip: `${who} · ${tabsLabel} · ${isDefault ? 'predeterminado' : 'clic derecho: usar como predeterminado'}`,
      avatar: a.avatar,
      seed: a.email || a.partition,
      incognito: !!a.incognito,
      active: a.partition === state.activePartition,
      isDefault,
      count,
      partition: a.partition,
      onClick: () => window.usualDesk.looseNavUseAccount({ partition: a.partition }),
      onSetDefault: () => window.usualDesk.looseNavSetDefaultProfile({ partition: a.partition }),
      onRemove: a.incognito ? null : () => window.usualDesk.looseNavRemoveProfile({ partition: a.partition }),
    };
    looseNavAccountsRail.appendChild(looseNavAccountButton(opts));
  }
  if (chrome.length) {
    for (const c of chrome) {
      const who = c.email || c.name;
      const opts = {
        key: `chrome:${c.directory}`,
        label: c.email || c.name,
        tooltip: `${who} · traer desde Chrome · clic derecho: usar como predeterminado`,
        avatar: c.avatar,
        seed: c.email || c.name,
        active: false,
        onClick: () => window.usualDesk.looseNavUseAccount({ chromeDirectory: c.directory }),
        onSetDefault: () => window.usualDesk.looseNavSetDefaultProfile({ chromeDirectory: c.directory }),
        onRemove: () => window.usualDesk.looseNavRemoveProfile({ chromeDirectory: c.directory }),
      };
      looseNavAccountsRail.appendChild(looseNavAccountButton(opts));
    }
  }
  if (looseNavProfilesEditMode) looseNavAccountsRail.appendChild(looseNavAddProfileButton());
}

function looseNavDisplayUrl(state) {
  const url = state && state.active && state.activeTabId ? String(state.activeUrl || '') : '';
  return /^about:blank/i.test(url) ? '' : url;
}

function looseNavOmniboxPartition() {
  return looseNavState.activePartition
    || (looseNavState.activeProfile && looseNavState.activeProfile.partition)
    || '';
}

/** Navega en la pestaña activa; si no hay ninguna, abre una con el perfil seleccionado. */
function looseNavOmniboxGo(value) {
  if (looseNavState.tabs.some((t) => t.isActive)) return window.usualDesk.looseNavNavigate(value);
  return window.usualDesk.looseNavNewTab(value, { partition: looseNavOmniboxPartition(), nextToActive: true });
}

/** El acceso abre con la misma sesión que el perfil de la pestaña: `persist:<sessionId>`. */
function looseNavTabSessionId(tab) {
  return String((tab && tab.partition) || '').replace(/^persist:/, '');
}

function looseNavActivePage() {
  const tab = looseNavState.tabs.find((t) => t.isActive);
  if (!tab || !/^https?:\/\//i.test(String(tab.url || ''))) return null;
  return tab;
}

function findShortcutForLooseNavTab(tab) {
  const key = normalizeUrlKey(tab.url);
  const sessionId = looseNavTabSessionId(tab);
  return shortcuts.find(
    (s) => s.type === 'web' && normalizeUrlKey(s.url || '') === key && (s.sessionId || '') === sessionId,
  ) || null;
}

function syncLooseNavAddShortcutBtn() {
  if (!looseNavAddShortcutBtn) return;
  const tab = looseNavState.active ? looseNavActivePage() : null;
  looseNavAddShortcutBtn.hidden = !tab;
  if (!tab) return;
  const saved = !!findShortcutForLooseNavTab(tab);
  looseNavAddShortcutBtn.classList.toggle('is-saved', saved);
  looseNavAddShortcutBtn.querySelector('.loose-nav-add-shortcut-label').textContent = saved ? 'Fijado' : 'Fijar';
  const profile = tab.profileLabel ? ` con el perfil ${tab.profileLabel}` : '';
  const hint = saved ? 'Esta página ya está fijada en inplaize' : `Fijar esta página en inplaize${profile}`;
  looseNavAddShortcutBtn.setAttribute('aria-label', hint);
  looseNavAddShortcutBtn.dataset.tooltip = hint;
}

/** El favicon sube del botón al logo de inplaize: muestra adónde va a parar la página. */
function flyLooseNavPageToHome(tab) {
  const from = looseNavAddShortcutBtn?.querySelector('.loose-nav-add-shortcut-icon');
  const target = document.getElementById('dock-home-btn');
  if (!from || !target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve();
  }
  const a = from.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const size = 20;
  const fav = /^(https?:|data:image\/)/i.test(String(tab.favicon || '')) ? tab.favicon : '';
  const ghost = document.createElement(fav ? 'img' : 'span');
  ghost.className = 'loose-nav-fly-ghost';
  if (fav) ghost.src = fav;
  ghost.style.left = `${a.left + a.width / 2 - size / 2}px`;
  ghost.style.top = `${a.top + a.height / 2 - size / 2}px`;
  document.body.appendChild(ghost);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const flight = ghost.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.35}px, ${dy * 0.75}px) scale(1.15)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0.2 },
    ],
    { duration: 380, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  );
  return flight.finished
    .catch(() => {})
    .then(() => {
      ghost.remove();
      return target
        .animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
          { duration: 180, easing: 'ease-out' },
        )
        .finished.catch(() => {});
    });
}

/** Abre el alta de acceso con la página actual y su perfil de Google ya cargados. */
async function addLooseNavPageShortcut() {
  const tab = looseNavActivePage();
  if (!tab || findShortcutForLooseNavTab(tab)) return;
  await flyLooseNavPageToHome(tab);
  const title = String(tab.title || '').trim();
  return openAddShortcutForPage({
    url: tab.url,
    title: ensureUniqueDisplayName(title && title !== 'Cargando…' ? title : suggestNameFromUrl(tab.url)),
    sessionId: looseNavTabSessionId(tab),
    favicon: tab.favicon,
  });
}

/** Barra de dirección bajo las pestañas: muestra la URL de la pestaña activa y navega en ella. */
function renderLooseNavOmnibox(state) {
  if (!looseNavOmniboxInput) return;
  const profile = state.activeProfile || state.defaultProfile || null;
  const label = profile && profile.label ? profile.label : '';
  const hint = label ? `Abrir en ${label}` : 'Abrir en el perfil seleccionado';
  looseNavOmniboxInput.placeholder = label
    ? `Buscá o escribí un enlace para abrir en ${label}`
    : 'Buscá en Google o escribí un enlace';
  looseNavOmniboxInput.setAttribute('aria-label', hint);
  if (document.activeElement !== looseNavOmniboxInput) {
    looseNavOmniboxInput.value = looseNavDisplayUrl(state);
  }
  syncLooseNavAddShortcutBtn();
}

function initLooseNavOmnibox() {
  if (!looseNavOmnibox || !looseNavOmniboxInput) return;
  looseNavOmnibox.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const val = looseNavOmniboxInput.value.trim();
    if (!val || !looseNavState.active) return;
    looseNavOmniboxInput.blur();
    try {
      await looseNavOmniboxGo(val);
    } catch {
      looseNavOmniboxInput.value = val;
      looseNavOmniboxInput.focus();
    }
  });
  looseNavAddShortcutBtn?.addEventListener('click', () => {
    addLooseNavPageShortcut().catch(() => {});
  });
  looseNavOmnibox.addEventListener('mousedown', (ev) => {
    if (ev.target !== looseNavOmnibox) return;
    ev.preventDefault();
    looseNavOmniboxInput.focus();
  });
  const omniboxCommit = (val, opts = {}) => {
    const value = String(val || '').trim();
    if (!value || !looseNavState.active) return;
    looseNavOmniboxInput.blur();
    looseNavOmniboxGo(value).catch(() => {});
  };
  looseNavOmniboxInput.addEventListener('focus', () => {
    looseNavOmniboxInput.select();
  });
  looseNavOmniboxInput.addEventListener('input', () => {
    refreshLooseNavSuggest(looseNavOmniboxInput, omniboxCommit);
  });
  looseNavOmniboxInput.addEventListener('blur', () => {
    setTimeout(() => closeLooseNavSuggest(), 150);
    looseNavOmniboxInput.value = looseNavDisplayUrl(looseNavState);
  });
  looseNavOmniboxInput.addEventListener('keydown', (ev) => {
    if (looseNavSuggestKeydown(ev, looseNavOmniboxInput)) return;
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    looseNavOmniboxInput.blur();
  });
}

const STRIP_SWAP_FADE_MS = 80;
let stripSwapTimer = null;
let stripSwapSeq = 0;

/** Franja de arriba: accesos directos o perfiles. Apaga la fila vieja, cambia y enciende la nueva. */
function applyStripMode(mode) {
  const root = document.documentElement;
  const current = root.getAttribute('data-strip-mode');
  if (current === null) {
    root.setAttribute('data-strip-mode', mode);
    return;
  }
  if (current === mode && !root.classList.contains('strip-swap-out')) return;
  const seq = ++stripSwapSeq;
  clearTimeout(stripSwapTimer);
  root.classList.add('strip-swap-out');
  stripSwapTimer = setTimeout(() => {
    if (seq !== stripSwapSeq) return;
    root.setAttribute('data-strip-mode', mode);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (seq === stripSwapSeq) root.classList.remove('strip-swap-out');
    }));
  }, STRIP_SWAP_FADE_MS);
}

function renderLooseNavBar(state) {
  const wasLoose = !!looseNavState.active;
  looseNavState = state || looseNavState;

  if (!looseNavBar) return;
  if (looseNavState.active) {
    looseNavResumePending = false;
  } else if (looseNavResumePending) {
    lastSentViewportBounds = null;
    return;
  }

  const show = !!looseNavState.active;
  if (!show) setLooseNavProfilesEditMode(false);
  looseNavBar.classList.toggle('hidden', !show);
  if (looseNavSurface) looseNavSurface.classList.toggle('hidden', !show);
  document.documentElement.setAttribute('data-loose-nav', show ? 'on' : 'off');
  applyStripMode(show ? 'accounts' : 'shortcuts');

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

  renderLooseNavAccounts(looseNavState);
  renderLooseNavOmnibox(looseNavState);
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
    lastSentViewportBounds = null;
    if (wasLoose) window.usualDesk.hideMenuOverlay?.();
  }
  syncDockHomeStripBtn();
}

function initLooseNavUiEvents() {
  if (!looseNavBar) return;

  looseNavNewTabBtn?.addEventListener('click', () => {
    openLooseNavBlankTab();
  });

  looseNavProfilesEditBtn?.addEventListener('click', () => setLooseNavProfilesEditMode(true));
  looseNavProfilesDoneBtn?.addEventListener('click', () => setLooseNavProfilesEditMode(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !looseNavProfilesEditMode || looseNavProfileDrag) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    ev.preventDefault();
    setLooseNavProfilesEditMode(false);
  });

  initLooseNavOmnibox();

  const looseNavPageMenuBtn = document.getElementById('loose-nav-page-menu-btn');
  looseNavPageMenuBtn?.addEventListener('click', () => {
    const r = looseNavPageMenuBtn.getBoundingClientRect();
    window.usualDesk.looseNavOpenPageMenu?.(r.left, r.bottom).catch(() => {});
  });

  const looseNavTabsRow = looseNavBar.querySelector('.loose-nav-tabs-row');
  const looseNavFindBar =
    looseNavTabsRow && window.UsualDeskPageFindBar && window.usualDesk.looseNavFindInPage
      ? window.UsualDeskPageFindBar.create(looseNavTabsRow, {
          find: (text, opts) => window.usualDesk.looseNavFindInPage(text, opts),
          stop: () => window.usualDesk.looseNavStopFindInPage(),
        })
      : null;
  window.usualDesk.onLooseNavPageCommand?.((msg) => {
    if (!msg) return;
    if (msg.command === 'find-open') looseNavFindBar?.open();
    else if (msg.command === 'find-result') looseNavFindBar?.showResult(msg.payload);
    else if (msg.command === 'downloads') goToDockWelcomeHome('downloads').catch(() => {});
    else if (msg.command === 'add-shortcut') {
      const tab = looseNavActivePage();
      openAddShortcutForPage({
        ...msg.payload,
        sessionId: looseNavTabSessionId(tab),
        favicon: tab && tab.url === msg.payload?.url ? tab.favicon : '',
      }).catch(() => {});
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (!looseNavState.active || !looseNavFindBar) return;
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && String(ev.key || '').toLowerCase() === 'f') {
      ev.preventDefault();
      looseNavFindBar.open();
    }
  });

  const runLooseNavShortcut = (action) => {
    if (action === 'edit-address') focusLooseNavOmnibox();
    else if (action === 'new-tab') openLooseNavBlankTab();
    else if (action === 'exit-profiles-edit') setLooseNavProfilesEditMode(false);
  };
  window.usualDesk.onLooseNavShortcut?.(runLooseNavShortcut);
  document.addEventListener('keydown', (ev) => {
    if (!looseNavState.active) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (target && target !== looseNavOmniboxInput
      && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = String(ev.key || '').toLowerCase();
    let action = '';
    if ((mod && key === 'l') || (ev.altKey && key === 'd') || key === 'f6') action = 'edit-address';
    else if (mod && ev.shiftKey && key === 't') action = 'reopen-tab';
    else if (mod && key === 't') action = 'new-tab';
    if (!action) return;
    ev.preventDefault();
    if (action === 'reopen-tab') {
      window.usualDesk.looseNavReopenClosedTab?.().catch(() => {});
      return;
    }
    runLooseNavShortcut(action);
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
  // Las pestañas quedan en memoria y, por perfil, en disco: al volver a abrir
  // el dock se retoma la que estaba activa.
  window.usualDesk.onSidebarState((expanded) => {
    if (!expanded && looseNavState.active) {
      looseNavResumePending = true;
      window.usualDesk.looseNavClose().catch(() => {});
    } else if (!expanded) {
      looseNavResumePending = false;
    } else if (looseNavState.active) {
      looseNavResumePending = false;
      scheduleLooseNavViewportSync();
    } else if (looseNavResumePending) {
      const resume = window.usualDesk.looseNavOpen?.() || Promise.reject();
      resume.catch(() => {
        looseNavResumePending = false;
        renderLooseNavBar(looseNavState);
      });
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


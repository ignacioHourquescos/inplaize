const toggleArea = document.getElementById('toggle-area');
const toggleBtn = document.getElementById('toggle-btn');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const sidebar = document.getElementById('sidebar');
const addBtn = document.getElementById('add-btn');
const shortcutsEditToggleBtn = document.getElementById('shortcuts-edit-toggle');
const closeBtn = document.getElementById('close-btn');
const shortcutsContainer = document.getElementById('shortcuts-container');
const modalOverlay = document.getElementById('modal-overlay');
const dockInlineEditor = document.getElementById('dock-inline-editor');
const shortcutModalCard = document.getElementById('modal');
const settingsModalOverlay = document.getElementById('settings-modal-overlay');
const dockToastStack = document.getElementById('dock-toast-stack');
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
    return `<img class="shortcut-icon-img shell-shortcut-icon-img" src="${escapeAttr(icon)}" alt="" role="presentation" />`;
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
/** Panel de accesos: con el lápiz activo, un clic en un icono abre la edición abajo. */
let shortcutsEditMode = false;
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
    !!(settingsModalOverlay && !settingsModalOverlay.classList.contains('hidden'));
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
    const hint = shortcutsEditMode ? `${s.name}. Modo edición: pulsa para editar abajo.` : s.name;
    card.setAttribute('aria-label', hint);
    card.setAttribute('data-tooltip', hint);
  });
}

function closeSettingsModal() {
  if (!settingsModalOverlay) return;
  settingsModalOverlay.classList.add('hidden');
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

function initAppSettingsUI() {
  const seg = document.getElementById('dock-position-segmented');
  const settingsBtn = document.getElementById('settings-btn');
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

  settingsBtn?.addEventListener('click', async () => {
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

  closeBtn?.addEventListener('click', () => closeSettingsModal());

  settingsModalOverlay?.addEventListener('click', (e) => {
    if (e.target === settingsModalOverlay) closeSettingsModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
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

async function loadInitialDockPosition() {
  try {
    const s = await window.usualDesk.getAppSettings();
    applyDockPositionToDom(s.dockPosition);
    syncDockPositionSegmentedUI(s.dockPosition);
    applySidebarDensityToDom(s.sidebarDensity);
    syncSidebarDensitySegmentedUI(s.sidebarDensity);
    applyWebHostModeToDom();
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

function ensureDynamicRowForValue(v) {
  if (!v) return;
  if (rowForValue(v)) return;
  const label = isAssetIconPath(v)
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
      setSelectedIcon(entry.isEmojiPicker ? CUSTOM_EMOJI_VALUE : entry.value);
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
    iconSelectTriggerText.textContent = 'Sin icono';
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
    if (e.key === 'Escape' && iconDropdownOpen) {
      closeIconDropdown();
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
  initFooter();
  schedulePointerPassthroughSync();
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
}

function applyFocusModeStateToDock(state) {
  const active = !!(state && state.active);
  const members = state && Array.isArray(state.members) ? state.members : [];
  focusModeState = { active, members: new Set(members) };
  document.documentElement.classList.toggle('focus-mode-active', active);
  syncWebMutedCheckboxesLockedByFocusMode();
  updateAllShortcutFocusMemberStates();
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
  const expanded = await window.usualDesk.toggleSidebar();
  updateSidebarUI(expanded === true);
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
  shortcuts.push({
    id,
    name,
    type: 'web',
    url,
    sessionId: webSessionIdForShortcut(name, id),
  });
  await window.usualDesk.saveShortcuts(shortcuts);
  renderShortcuts();
}

function bindUrlDropTargets() {
  const zones = [sidebar, toggleArea];
  const setHighlight = (on) => {
    sidebar.classList.toggle('drop-target-active', on);
    toggleArea.classList.toggle('drop-target-active', on);
  };

  function onDragEnter(e) {
    e.preventDefault();
    setDragOperationActive(true);
    setHighlight(true);
  }

  function onDragOver(e) {
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

function applyShortcutsEditModeUi() {
  shortcutsContainer.classList.toggle('shortcuts-edit-mode', shortcutsEditMode);
  document.documentElement.setAttribute(
    'data-shortcuts-edit',
    shortcutsEditMode ? 'on' : 'off',
  );
  if (shortcutsEditToggleBtn) {
    shortcutsEditToggleBtn.setAttribute('aria-pressed', shortcutsEditMode ? 'true' : 'false');
    shortcutsEditToggleBtn.setAttribute(
      'data-tooltip',
      shortcutsEditMode
        ? 'Dejar de editar (clic en un icono para cambiar sus datos abajo)'
        : 'Editar accesos: pulsa un icono para ver nombre, URL, notificaciones y orden abajo',
    );
  }
}

function renderShortcuts() {
  shortcutsContainer.innerHTML = '';

  if (shortcuts.length === 0) {
    const wrap = document.createElement('div');
    wrap.className = 'shortcuts-empty';
    wrap.innerHTML =
      '<p class="shortcuts-empty-text">Aún no tienes accesos directos. Pulsa + arriba o aquí abajo para añadir uno (web o programa).</p>'
      + '<button type="button" class="btn-empty-add">+ Añadir acceso directo</button>';
    wrap.querySelector('.btn-empty-add').addEventListener('click', () => openAddModal());
    shortcutsContainer.appendChild(wrap);
    applyShortcutsEditModeUi();
    return;
  }

  const isTopbar = isDockTopbarLayout();
  shortcuts.forEach((shortcut) => {
    const card = document.createElement('div');
    card.className = isTopbar ? 'shortcut-card shell-shortcut-item' : 'shortcut-card';
    card.dataset.shortcutId = shortcut.id;
    card.dataset.shortcutType = shortcut.type || '';
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
    if (isTopbar) {
      card.innerHTML = `
        <span class="shell-shortcut-icon-wrap">${iconHtml}</span>
        <span class="shortcut-name">${shortcut.name}</span>
        <span class="shortcut-badge shell-strip-badge"${badgeHidden}${badgeAria}>${badgeText}</span>
      `;
    } else {
      card.innerHTML = `
        ${iconHtml}
        <span class="shortcut-name">${shortcut.name}</span>
        <span class="shortcut-badge"${badgeHidden}${badgeAria}>${badgeText}</span>
      `;
    }

    let ignoreClickUntil = 0;
    card.addEventListener('click', () => {
      if (Date.now() < ignoreClickUntil) return;
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
    applyWebInactiveClassToCard(card, shortcut);
    applyFocusMemberClassToCard(card, shortcut);
    if (editingId && String(editingId) === String(shortcut.id)) {
      card.classList.add('shortcut-card-editing');
    }
    if (!shortcutsEditMode && shortcut.type === 'web') {
      const suppressMs =
        (window.UsualDeskStripGestures && window.UsualDeskStripGestures.SUPPRESS_CLICK_MS) || 900;
      bindDockShortcutGestures(card, shortcut, () => {
        ignoreClickUntil = Date.now() + suppressMs;
      });
    }
  });

  applyShortcutsEditModeUi();
  refreshShortcutCardsAccessibility();
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

// Toggle sidebar (modo contenedor: el mismo IPC abre el envoltorio web vía main)
toggleBtn.addEventListener('click', async () => {
  try {
    const expanded = await window.usualDesk.toggleSidebar();
    updateSidebarUI(expanded === true);
  } catch (err) {
    console.error('toggle-sidebar', err);
  }
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
});

// Clic fuera del panel (capa transparente a pantalla completa)
if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener('pointerdown', async (e) => {
    if (!modalOverlay.classList.contains('hidden')) return;
    if (dockInlineEditor && !dockInlineEditor.classList.contains('hidden')) return;
    if (settingsModalOverlay && !settingsModalOverlay.classList.contains('hidden')) return;
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

// X: ocultar panel (no cerrar la app)
closeBtn.addEventListener('click', async () => {
  try {
    await window.usualDesk.collapseSidebar();
    updateSidebarUI(false);
    lastPassthroughIgnore = null;
    schedulePointerPassthroughSync();
  } catch (err) {
    console.error('collapse-sidebar', err);
  }
});

browsePathBtn.addEventListener('click', async () => {
  const picked = await window.usualDesk.pickAppOrShortcut();
  if (!picked) return;
  inputUrl.value = picked;
  if (!inputName.value.trim()) {
    inputName.value = suggestNameFromPath(picked);
  }
});

// Add shortcut
addBtn.addEventListener('click', () => {
  openAddModal();
});

if (shortcutsEditToggleBtn) {
  shortcutsEditToggleBtn.addEventListener('click', () => {
    if (shortcutsEditMode) {
      closeModal();
    }
    shortcutsEditMode = !shortcutsEditMode;
    renderShortcuts();
  });
}

function openAddModal() {
  editingId = null;
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

/** Muestra el formulario en overlay (lateral/centro) o en el lienzo negro (topbar). */
function showShortcutFormShell() {
  if (!shortcutModalCard) return;
  if (isDockTopbarLayout() && dockInlineEditor) {
    dockInlineEditor.appendChild(shortcutModalCard);
    shortcutModalCard.classList.add('shortcut-modal-embed');
    dockInlineEditor.classList.remove('hidden');
    dockInlineEditor.setAttribute('aria-hidden', 'false');
    modalOverlay.classList.add('hidden');
  } else {
    shortcutModalCard.classList.remove('shortcut-modal-embed');
    modalOverlay.appendChild(shortcutModalCard);
    if (dockInlineEditor) {
      dockInlineEditor.classList.add('hidden');
      dockInlineEditor.setAttribute('aria-hidden', 'true');
    }
    modalOverlay.classList.remove('hidden');
  }
}

// Save shortcut
shortcutForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const editingOriginal = editingId ? shortcuts.find((s) => s.id === editingId) : null;
  const isLoose = !!(editingOriginal && editingOriginal.type === 'loose');

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
    window.alert(
      'Ya existe un acceso con ese nombre. Usa otro nombre para separar sesiones (p. ej. distintas cuentas de WhatsApp).',
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
modalDelete.addEventListener('click', async () => {
  if (!editingId) return;
  delete titleBadges[editingId];
  shortcuts = shortcuts.filter((s) => s.id !== editingId);
  await window.usualDesk.saveShortcuts(shortcuts);
  renderShortcuts();
  closeModal();
});

window.usualDesk.onOpenAddShortcutModal(() => {
  openAddModal();
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
bindTypeSegmented();
init();

/* ==========================================================================
   Navegación suelta (pestañas embebidas dentro del dock).
   El main gestiona las pestañas y su BrowserView; el renderer solo pinta la
   barra arriba, escucha el estado y le indica dónde colocarse (bounds del
   viewport dentro de #dock-viewport).
   ========================================================================== */

const looseNavBar = document.getElementById('loose-nav-bar');
const looseNavTabsStrip = document.getElementById('loose-nav-tabs-strip');
const looseNavBackBtn = document.getElementById('loose-nav-back');
const looseNavForwardBtn = document.getElementById('loose-nav-forward');
const looseNavReloadBtn = document.getElementById('loose-nav-reload');
const looseNavNewTabBtn = document.getElementById('loose-nav-new-tab-btn');
const looseNavCloseModeBtn = document.getElementById('loose-nav-close-mode');
const looseNavUrlForm = document.getElementById('loose-nav-url-form');
const looseNavUrlInput = document.getElementById('loose-nav-url-input');
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

function faviconFallbackEl(initial) {
  const letter = (initial || '?').trim().charAt(0).toUpperCase() || '?';
  const span = document.createElement('span');
  span.className = 'loose-nav-tab-fav is-placeholder';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = letter;
  span.style.display = 'inline-flex';
  span.style.alignItems = 'center';
  span.style.justifyContent = 'center';
  span.style.color = '#fff';
  span.style.fontSize = '9px';
  span.style.fontWeight = '700';
  return span;
}

function renderLooseNavTabs(state) {
  if (!looseNavTabsStrip) return;
  looseNavTabsStrip.innerHTML = '';
  for (const tab of state.tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'loose-nav-tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.tabId = tab.id;
    btn.setAttribute('aria-selected', tab.isActive ? 'true' : 'false');
    if (tab.isActive) btn.classList.add('is-active');
    if (tab.loading) btn.classList.add('is-loading');
    btn.setAttribute('data-tooltip', tab.title || tab.url || 'Pestaña');

    if (tab.favicon && /^(https?:|data:)/i.test(tab.favicon)) {
      const img = document.createElement('img');
      img.className = 'loose-nav-tab-fav';
      img.src = tab.favicon;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.replaceWith(faviconFallbackEl(tab.title || tab.url));
      });
      btn.appendChild(img);
    } else {
      btn.appendChild(faviconFallbackEl(tab.title || tab.url));
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'loose-nav-tab-title';
    titleEl.textContent = tab.title || tab.url || 'Pestaña';
    btn.appendChild(titleEl);

    const closeEl = document.createElement('span');
    closeEl.className = 'loose-nav-tab-close';
    closeEl.setAttribute('role', 'button');
    closeEl.setAttribute('aria-label', 'Cerrar pestaña');
    closeEl.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      window.usualDesk.looseNavCloseTab(tab.id).catch(() => {});
    });
    btn.appendChild(closeEl);

    btn.addEventListener('click', () => {
      if (!tab.isActive) window.usualDesk.looseNavSelectTab(tab.id).catch(() => {});
    });
    btn.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        window.usualDesk.looseNavCloseTab(tab.id).catch(() => {});
      }
    });

    looseNavTabsStrip.appendChild(btn);
  }
}

function renderLooseNavBar(state) {
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
    if (looseNavBackBtn) looseNavBackBtn.disabled = !looseNavState.activeCanGoBack;
    if (looseNavForwardBtn) looseNavForwardBtn.disabled = !looseNavState.activeCanGoForward;
    if (looseNavUrlInput && document.activeElement !== looseNavUrlInput) {
      looseNavUrlInput.value = looseNavState.activeUrl || '';
    }
    scheduleLooseNavViewportSync();
  } else {
    lastSentViewportBounds = null;
  }
}

function initLooseNavUiEvents() {
  if (!looseNavBar) return;

  looseNavBackBtn?.addEventListener('click', () => {
    window.usualDesk.looseNavBack().catch(() => {});
  });
  looseNavForwardBtn?.addEventListener('click', () => {
    window.usualDesk.looseNavForward().catch(() => {});
  });
  looseNavReloadBtn?.addEventListener('click', () => {
    window.usualDesk.looseNavReload().catch(() => {});
  });
  looseNavNewTabBtn?.addEventListener('click', () => {
    window.usualDesk.looseNavNewTab().catch(() => {});
  });
  looseNavCloseModeBtn?.addEventListener('click', () => {
    window.usualDesk.looseNavClose().catch(() => {});
  });

  looseNavUrlForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!looseNavUrlInput) return;
    const val = looseNavUrlInput.value.trim();
    if (!val) return;
    window.usualDesk.looseNavNavigate(val).catch(() => {});
    looseNavUrlInput.blur();
  });

  looseNavUrlInput?.addEventListener('focus', () => {
    try { looseNavUrlInput.select(); } catch { /* noop */ }
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


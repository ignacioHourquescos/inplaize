const strip = document.getElementById('shortcut-strip');
const subtabStrip = document.getElementById('subtab-strip');
const api = window.usualDeskDetached;

/** @type {Record<string, number>} */
const stripTitleBadges = {};

let focusModeState = { active: false, members: [] };

function applyFocusModeToDom(state) {
  focusModeState = state && typeof state === 'object'
    ? { active: !!state.active, members: Array.isArray(state.members) ? state.members : [] }
    : { active: false, members: [] };
  document.documentElement.classList.toggle('focus-mode-active', focusModeState.active);
}

function applyStripBadge(btn, shortcutId) {
  const sid = String(shortcutId);
  const bc = stripTitleBadges[sid];
  const show = bc != null && bc >= 1;
  const existing = btn.querySelector('.shell-strip-badge');
  if (!show) {
    if (existing) existing.remove();
    return;
  }
  const el = existing || document.createElement('span');
  if (!existing) {
    el.className = 'shell-strip-badge';
    btn.appendChild(el);
  }
  el.textContent = bc > 99 ? '99+' : String(bc);
  el.setAttribute('aria-label', `${bc} en título`);
}

function isAssetIconPath(v) {
  if (!v || typeof v !== 'string') return false;
  return v.includes('/') || /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(v);
}

/**
 * @param {string} icon
 * @param {string} name
 * @returns {HTMLElement}
 */
function buildShortcutIcon(icon, name) {
  const label = name || 'Acceso';
  if (isAssetIconPath(icon)) {
    const img = document.createElement('img');
    img.className = 'shell-shortcut-icon-img';
    img.src = icon;
    img.alt = '';
    img.setAttribute('role', 'presentation');
    img.loading = 'lazy';
    return img;
  }
  if (icon && String(icon).trim()) {
    const span = document.createElement('span');
    span.className = 'shell-shortcut-icon-emoji';
    span.textContent = icon;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  const fb = document.createElement('span');
  fb.className = 'shell-shortcut-icon-fallback';
  fb.textContent = label.trim() ? label.trim().charAt(0).toUpperCase() : '?';
  return fb;
}

const SUPPRESS_CLICK_MS =
  (window.UsualDeskStripGestures && window.UsualDeskStripGestures.SUPPRESS_CLICK_MS) || 800;

/** ¿El drag en curso lleva archivos? (Explorador o home de descargas del dock). */
function isFileDrag(e) {
  const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
  if (types.includes('Files') || types.includes('FileNameW') || types.includes('FileName')) return true;
  const files = e.dataTransfer && e.dataTransfer.files;
  return !!(files && files.length);
}

function getDroppedFilePaths(e) {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length || typeof api.getPathForFile !== 'function') return [];
  return files.map((f) => api.getPathForFile(f)).filter(Boolean);
}

async function ingestDroppedFilesFromEvent(e) {
  const paths = getDroppedFilePaths(e);
  if (!paths.length || typeof api.ingestDroppedFiles !== 'function') return false;
  await api.ingestDroppedFiles(paths);
  if (typeof api.openDockWelcomeHome === 'function') {
    await api.openDockWelcomeHome('downloads');
  }
  return true;
}

function bindShellFileDragAcceptance() {
  const onDragOver = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch {
      /* noop */
    }
  };
  document.addEventListener('dragover', onDragOver, true);
}

const FILE_DRAG_SPRING_DELAY_MS = 300;

/** Arrastrar un archivo sobre el icono de una pestaña activa esa ventana
 *  (spring-loading) para poder soltar el archivo dentro de su página. */
function bindFileDragSpringTarget(btn, shortcutId) {
  let springTimer = null;
  const cancel = () => {
    if (springTimer) {
      clearTimeout(springTimer);
      springTimer = null;
    }
    btn.classList.remove('file-drag-hover');
  };
  btn.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    btn.classList.add('file-drag-hover');
    if (!springTimer) {
      springTimer = setTimeout(() => {
        springTimer = null;
        btn.classList.remove('file-drag-hover');
        api.frameAction('activate', shortcutId);
      }, FILE_DRAG_SPRING_DELAY_MS);
    }
  });
  btn.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch {
      /* ignore */
    }
  });
  btn.addEventListener('dragleave', cancel);
  btn.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
    ingestDroppedFilesFromEvent(e).catch(() => {});
  });
}

function renderChrome(payload) {
  window.UsualDeskWorkspace?.close();
  if (payload && payload.focusMode) {
    applyFocusModeToDom(payload.focusMode);
  }
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  if (!strip) return;
  stripEndActionsEl?.remove();
  strip.innerHTML = '';
  stripHasShortcuts = items.length > 0;
  syncStripEndActions();
  if (items.length === 0) {
    const span = document.createElement('span');
    span.className = 'shortcut-strip-empty';
    span.textContent = 'Sin accesos directos';
    strip.appendChild(span);
    appendStripTrailing();
    window.UsualDeskTabPinDrag?.consumePop(strip);
    return;
  }
  for (const it of items) {
    const name = it.name || (it.type === 'app' ? 'Aplicación' : 'Web');
    const cell = document.createElement('div');
    cell.className = 'shell-shortcut-cell';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shell-shortcut-item';
    if (it.isActive) btn.classList.add('is-active');
    if (it.isOpen) btn.classList.add('is-open');
    const isWorkspace = it.type === 'workspace';
    const isWeb = it.type === 'web';
    const canClose = (isWeb || isWorkspace) && it.isOpen && it.mapKey;
    const canFocusGesture = isWeb;
    const webTabClosed = isWeb && !it.isOpen;
    if (webTabClosed) {
      btn.classList.add('shell-shortcut-inactive');
    }
    if (it.isFocusMember) {
      btn.classList.add('shell-focus-member');
    }
    if (it.iconInverted) btn.classList.add('is-icon-inverted');
    if (isWorkspace) btn.classList.add('is-workspace');
    btn.setAttribute('aria-label', name);
    btn.dataset.shortcutId = it.id;
    btn.dataset.shortcutType = it.type || '';

    const wrap = document.createElement('span');
    wrap.className = 'shell-shortcut-icon-wrap';
    if (isWorkspace && window.UsualDeskWorkspace) {
      wrap.appendChild(window.UsualDeskWorkspace.folderGlyph(it.members));
    } else {
      wrap.appendChild(buildShortcutIcon(it.icon || '', name));
    }
    btn.appendChild(wrap);
    applyStripBadge(btn, it.id);

    let ignoreClickUntil = 0;
    btn.addEventListener('click', () => {
      if (Date.now() < ignoreClickUntil) return;
      if (isWorkspace) {
        if (focusModeState.active && !it.isFocusMember && api.exitFocusMode) {
          api.exitFocusMode().catch(() => {});
        }
        api.frameAction('activate', it.id);
        return;
      }
      const addressBar = document.getElementById('shortcut-browser');
      /* La app fijada no está en la fila: el icono vuelve a su página. */
      if (it.isActive && !shortcutOnMain && shortcutMainTabId) {
        api.frameAction('select-subtab', shortcutMainTabId).catch(() => {});
        return;
      }
      if (it.isActive && addressBar && addressBar.classList.contains('is-search-idle')) {
        document.getElementById('shortcut-omnibox-input')?.focus();
        return;
      }
      if (it.isActive && addressBar && !addressBar.hidden && addressBar.classList.contains('is-address-peek')) {
        api.frameAction('hide-address').catch(() => {});
        return;
      }
      if (it.isActive && (!addressBar || addressBar.hidden)) {
        api.frameAction('reveal-address').catch(() => {});
        return;
      }
      // Left-click sobre un icono que NO es miembro del Modo Foco lo cancela.
      // Si SÍ es miembro, solo navegamos hacia esa ventana sin romper el foco,
      // para poder moverse entre las pestañas que forman parte del foco.
      if (focusModeState.active && !it.isFocusMember && api.exitFocusMode) {
        api.exitFocusMode().catch(() => {});
      }
      api.frameAction('activate', it.id);
    });

    if (canClose || canFocusGesture) {
      const gestures = window.UsualDeskStripGestures;
      if (gestures && typeof gestures.bindIconStripGestures === 'function') {
        gestures.bindIconStripGestures(btn, {
          onClose: canClose
            ? () => {
                ignoreClickUntil = Date.now() + SUPPRESS_CLICK_MS;
                api.frameAction('close-tab', String(it.mapKey));
              }
            : null,
          onLongPressFocus: canFocusGesture
            ? () => {
                ignoreClickUntil = Date.now() + SUPPRESS_CLICK_MS;
                if (api.toggleFocusModeMember) {
                  api.toggleFocusModeMember(String(it.id)).catch(() => {});
                }
              }
            : null,
          suppressNextActivation: () => {
            ignoreClickUntil = Date.now() + SUPPRESS_CLICK_MS;
          },
        });
      }
    }

    if (isWeb) {
      bindFileDragSpringTarget(btn, it.id);
    }

    cell.appendChild(btn);

    strip.appendChild(cell);
  }
  appendStripTrailing();
  window.UsualDeskTabPinDrag?.consumePop(strip);
}

const stripEndActionsEl = document.getElementById('strip-end-actions');
let stripHasShortcuts = false;
let stripEditMode = false;

function appendStripTrailing() {
  if (stripEndActionsEl) strip.appendChild(stripEndActionsEl);
}

/**
 * A la derecha: solo el lápiz en uso normal; mientras el dock está en modo
 * edición, "+" y a su derecha "listo". Sin accesos, solo el "+".
 */
function syncStripEndActions() {
  const addBtn = stripEndActionsEl?.querySelector('#strip-add-new');
  const editBtn = stripEndActionsEl?.querySelector('#strip-edit-toggle');
  const doneBtn = stripEndActionsEl?.querySelector('#strip-edit-done');
  if (addBtn) addBtn.hidden = stripHasShortcuts && !stripEditMode;
  if (editBtn) editBtn.hidden = !stripHasShortcuts || stripEditMode;
  if (doneBtn) doneBtn.hidden = !stripEditMode;
}

api.onShortcutsEditModeSync?.((on) => {
  stripEditMode = on === true;
  syncStripEndActions();
});

async function refreshChromeFromMain() {
  try {
    const payload = await api.frameAction('get-chrome');
    renderChrome(payload);
  } catch {
    /* noop */
  }
}

/** Historial de la pestaña activa. Las flechas solo se dibujan en esa solapa. */
let pageNav = { canGoBack: false, canGoForward: false };

/** El "+" deja la barra vacía: Google carga de fondo hasta que se escribe un enlace. */
let shortcutBlankAddress = false;
let shortcutBlankTabId = '';

function isShortcutStartPage(url) {
  const value = String(url || '').trim();
  if (!value || /^about:/i.test(value)) return true;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!/^google\.[a-z]{2,}(?:\.[a-z]{2})?$/.test(host)) return false;
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path && path.toLowerCase() !== '/webhp') return false;
  return !parsed.searchParams.has('q');
}

function forgetShortcutBlankAddress() {
  shortcutBlankAddress = false;
  shortcutBlankTabId = '';
}

function noteShortcutBlankTab(activeId, url, previousId) {
  if (!shortcutBlankAddress) return;
  const tabId = String(activeId || '');
  if (!tabId || tabId === previousId) {
    if (shortcutBlankTabId && tabId === shortcutBlankTabId && url && !isShortcutStartPage(url)) {
      forgetShortcutBlankAddress();
    }
    return;
  }
  if (!isShortcutStartPage(url)) {
    forgetShortcutBlankAddress();
    return;
  }
  shortcutBlankTabId = tabId;
}

function displayAddress(url) {
  const value = String(url || '');
  if (!value || /^about:/i.test(value)) return '';
  if (shortcutBlankAddress && isShortcutStartPage(value)) return '';
  return value;
}

let shortcutAddressIcon = '';
let shortcutAddressIconFor = '';

function paintShortcutAddress(value, favicon) {
  const shown = String(value || '');
  if (arguments.length > 1) {
    shortcutAddressIcon = favicon || '';
    shortcutAddressIconFor = shown;
  } else if (shown !== shortcutAddressIconFor) {
    shortcutAddressIcon = '';
    shortcutAddressIconFor = shown;
  }
  window.UsualDeskTabStripFit?.paintAddressFace(
    document.getElementById('shortcut-omnibox-face'),
    shown,
    shown ? shortcutAddressIcon : ''
  );
}

function focusPeekAddress(url) {
  const input = document.getElementById('shortcut-omnibox-input');
  if (!input) return;
  const shown = displayAddress(url);
  if (shown) input.value = shown;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function applyPageNav(state) {
  pageNav = state && typeof state === 'object'
    ? { canGoBack: !!state.canGoBack, canGoForward: !!state.canGoForward, url: state.url || '' }
    : { canGoBack: false, canGoForward: false, url: '' };
  const back = document.getElementById('shortcut-nav-back');
  const forward = document.getElementById('shortcut-nav-forward');
  if (back) back.disabled = !pageNav.canGoBack;
  if (forward) forward.disabled = !pageNav.canGoForward;
  const input = document.getElementById('shortcut-omnibox-input');
  const idle = document.getElementById('shortcut-browser')?.classList.contains('is-search-idle');
  if (input && idle) {
    if (document.activeElement !== input && !String(input.value || '').trim()) {
      input.value = '';
      paintShortcutAddress('');
    }
    return;
  }
  if (input && document.activeElement !== input && state && typeof state.url === 'string') {
    input.value = displayAddress(state.url);
  }
  if (input && document.activeElement !== input) paintShortcutAddress(input.value);
}

let shortcutSearchManualReveal = false;
let shortcutRevealGuardUntil = 0;
/** La cruz cerró la barra a propósito: no vuelve sola aunque haya pestañas. */
let shortcutNavUserClosed = false;

function paintStripNavToggle(visible) {
  const btn = document.getElementById('strip-search');
  if (!btn) return;
  btn.setAttribute('aria-expanded', visible ? 'true' : 'false');
  btn.setAttribute('aria-label', visible ? 'Cerrar la barra de pestañas' : 'Mostrar la barra de pestañas');
  btn.dataset.tooltip = visible ? 'Cerrar pestañas' : 'Mostrar pestañas';
}
let shortcutHasOpenTabs = false;
let shortcutEmbedded = false;
let shortcutPeekOnly = false;
let addressPeekWasOn = false;

function syncDetachedBarSproutAttr() {
  const root = document.documentElement;
  const chrome = document.getElementById('shortcut-browser');
  const visible = !!(chrome && !chrome.hidden && chrome.classList.contains('is-search-revealed'));
  if (root.dataset.profileLupa === 'on') {
    delete root.dataset.barSprout;
    return;
  }
  if (!visible) {
    delete root.dataset.barSprout;
    return;
  }
  const composingDown = root.classList.contains('is-strip-compose') && root.dataset.urlSlide === 'down';
  const fromLupa = (!shortcutHasOpenTabs && !shortcutPeekOnly) || composingDown;
  root.dataset.barSprout = fromLupa ? 'lupa' : 'session';
}

function syncShortcutBrowserVisibility() {
  const chrome = document.getElementById('shortcut-browser');
  if (!chrome) return;
  const visible = !shortcutEmbedded && !shortcutNavUserClosed && (
    shortcutHasOpenTabs || shortcutSearchManualReveal || shortcutPeekOnly
  );
  chrome.classList.toggle('is-search-revealed', visible);
  chrome.hidden = !visible;
  if (!visible) chrome.classList.remove('is-tabs-forced');
  paintStripNavToggle(visible);
  if (visible) void chrome.offsetHeight;
  syncDetachedBarSproutAttr();
  api.frameAction('set-search-revealed', !shortcutHasOpenTabs && shortcutSearchManualReveal).catch(() => {});
  api.frameAction('set-nav-row-hidden', !visible).catch(() => {});
}

function setShortcutSearchRevealed(on, { guard = false } = {}) {
  const next = on === true;
  shortcutSearchManualReveal = next;
  if (next) shortcutNavUserClosed = false;
  const chrome = document.getElementById('shortcut-browser');
  if (!next && chrome) chrome.classList.remove('is-tabs-forced');
  if (next && guard) shortcutRevealGuardUntil = Date.now() + 550;
  syncShortcutBrowserVisibility();
}

const SHORTCUT_ADDRESS_PLACEHOLDER = 'Buscá en Google o escribí un enlace';
/** La lupa del perfil tiene la barra abierta: Enter no es una pestaña del acceso. */
let profileLupaCompose = false;

function detachedProfilePartition() {
  return window.UsualDeskStripProfileSearch?.partition?.() || '';
}

function detachedProfileLabel() {
  return window.UsualDeskStripProfileSearch?.label?.() || 'el perfil principal';
}

function closeDetachedProfileLupa() {
  if (!profileLupaCompose) return;
  profileLupaCompose = false;
  delete document.documentElement.dataset.profileLupa;
  window.UsualDeskStripProfileSearch?.setOpen(false);
  document.getElementById('shortcut-browser')?.classList.remove('is-profile-search');
  setDetachedStripCompose(false);
  const input = document.getElementById('shortcut-omnibox-input');
  if (input) {
    input.placeholder = SHORTCUT_ADDRESS_PLACEHOLDER;
    const shown = displayAddress(pageNav.url || '');
    input.value = shown;
    paintShortcutAddress(shown);
    if (document.activeElement === input) input.blur();
  }
  setShortcutSearchRevealed(false);
}

function openDetachedProfileLupa() {
  const bar = document.getElementById('shortcut-browser');
  const input = document.getElementById('shortcut-omnibox-input');
  if (!bar || !input) return;
  profileLupaCompose = true;
  shortcutBlankAddress = false;
  document.documentElement.dataset.profileLupa = 'on';
  window.UsualDeskStripProfileSearch?.setOpen(true);
  bar.classList.add('is-profile-search');
  bar.classList.remove('is-tabs-forced');
  shortcutNavUserClosed = false;
  setShortcutSearchRevealed(true, { guard: true });
  setDetachedStripCompose(true, { origin: 'strip' });
  input.placeholder = `Buscar con ${detachedProfileLabel()}`;
  input.value = '';
  paintShortcutAddress('');
  requestAnimationFrame(() => {
    if (!profileLupaCompose) return;
    input.focus();
  });
}

window.__dockToggleProfileSearch = () => {
  if (profileLupaCompose) closeDetachedProfileLupa();
  else openDetachedProfileLupa();
};

window.__dockCloseProfileSearch = () => {
  closeDetachedProfileLupa();
};

/** El + abre la barra. Con la barra abierta el mismo botón es la cruz y la cierra. */
window.__dockRevealNavBar = () => {
  const chrome = document.getElementById('shortcut-browser');
  if (!chrome) return;
  const open = !chrome.hidden && chrome.classList.contains('is-search-revealed');
  if (open) {
    if (profileLupaCompose) closeDetachedProfileLupa();
    shortcutNavUserClosed = true;
    setShortcutSearchRevealed(false);
    if (lastDetachedTabsPayload) renderSubTabs(lastDetachedTabsPayload);
    return;
  }
  shortcutNavUserClosed = false;
  chrome.classList.add('is-tabs-forced');
  setShortcutSearchRevealed(true, { guard: true });
  if (lastDetachedTabsPayload) renderSubTabs(lastDetachedTabsPayload);
  requestAnimationFrame(() => focusShortcutSearch({ force: true }));
};

const knownSubtabIds = new Set();

/** Ids que aparecen cuando ya había pestañas: esas son las que entran animadas. */
function noteSubtabIds(tabs) {
  const alive = new Set();
  const fresh = [];
  const hadAny = knownSubtabIds.size > 0;
  for (const tab of tabs) {
    const id = String((tab && tab.id) || '');
    if (!id) continue;
    alive.add(id);
    if (hadAny && !knownSubtabIds.has(id)) fresh.push(id);
    knownSubtabIds.add(id);
  }
  for (const id of [...knownSubtabIds]) {
    if (!alive.has(id)) knownSubtabIds.delete(id);
  }
  return fresh;
}

function subtabIconSig(tab) {
  if (tab.loading) return 'loading';
  if (tab.favicon && /^(https?:|data:)/i.test(tab.favicon)) return 'img:' + tab.favicon;
  const letter = (tab.title || tab.url || '?').trim().charAt(0).toUpperCase() || '?';
  return 'letter:' + letter;
}

function subtabLetter(tab) {
  return (tab.title || tab.url || '?').trim().charAt(0).toUpperCase() || '?';
}

function makeSubtabIcon(el, tab) {
  if (tab.loading) {
    const spin = document.createElement('span');
    spin.className = 'subtab-icon is-loading';
    spin.setAttribute('aria-hidden', 'true');
    return spin;
  }
  if (tab.favicon && /^(https?:|data:)/i.test(tab.favicon)) {
    const img = document.createElement('img');
    img.className = 'subtab-icon';
    img.src = tab.favicon;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      const current = el._tab || tab;
      const letter = subtabLetter(current);
      const fallback = document.createElement('span');
      fallback.className = 'subtab-icon is-placeholder';
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = letter;
      img.replaceWith(fallback);
      el.dataset.iconSig = 'letter:' + letter;
    });
    return img;
  }
  const fallback = document.createElement('span');
  fallback.className = 'subtab-icon is-placeholder';
  fallback.setAttribute('aria-hidden', 'true');
  fallback.textContent = subtabLetter(tab);
  return fallback;
}

function syncSubtabIcon(el, tab) {
  const sig = subtabIconSig(tab);
  if (el.dataset.iconSig === sig && el.querySelector(':scope > .subtab-icon')) return;
  el.dataset.iconSig = sig;
  const next = makeSubtabIcon(el, tab);
  const prev = el.querySelector(':scope > .subtab-icon');
  const title = el.querySelector(':scope > .subtab-title');
  if (prev) prev.replaceWith(next);
  else el.insertBefore(next, title || el.firstChild);
}

function syncSubtabClose(el, tab) {
  let closeBtn = el.querySelector(':scope > .subtab-close');
  if (tab.isMain) {
    if (closeBtn) closeBtn.remove();
    return;
  }
  if (!closeBtn) {
    closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'subtab-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const current = el._tab;
      if (current) api.frameAction('close-subtab', current.id);
    });
    el.appendChild(closeBtn);
  }
  closeBtn.setAttribute('aria-label', `Cerrar ${tab.title || 'pestaña'}`);
}

function syncSubtabElement(el, tab) {
  el.classList.toggle('is-active', !!tab.isActive);
  el.setAttribute('aria-selected', tab.isActive ? 'true' : 'false');
  el.setAttribute('data-tooltip', tab.title || tab.url || 'Pestaña');
  el.setAttribute('data-tooltip-placement', 'bottom');
  syncSubtabIcon(el, tab);
  const title = el.querySelector(':scope > .subtab-title');
  const text = tab.title || 'Pestaña';
  if (title && title.textContent !== text) title.textContent = text;
  syncSubtabClose(el, tab);
}

function createSubtabElement() {
  const el = document.createElement('div');
  el.className = 'subtab';
  el.setAttribute('role', 'tab');
  const title = document.createElement('span');
  title.className = 'subtab-title';
  el.appendChild(title);
  el.addEventListener('click', () => {
    const tab = el._tab;
    if (!tab) return;
    if (tab.isActive) {
      setDetachedStripCompose(true, { origin: 'tab' });
      shortcutBlankAddress = false;
      const field = document.getElementById('shortcut-omnibox-input');
      if (field) {
        const shown = displayAddress(tab.url || pageNav.url || '');
        field.value = shown;
        field.focus();
        try { field.select(); } catch { /* ignore */ }
        paintShortcutAddress(shown);
      }
      return;
    }
    api.frameAction('select-subtab', tab.id);
  });
  el.addEventListener('auxclick', (ev) => {
    const tab = el._tab;
    if (!tab || tab.isMain || ev.button !== 1) return;
    ev.preventDefault();
    api.frameAction('close-subtab', tab.id);
  });
  return el;
}

function playSubtabEnter(el) {
  if (!el || el.dataset.enterPlayed === '1') return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.dataset.enterPlayed = '1';
  el.classList.add('is-entering');
  const onSlideEnd = (ev) => {
    if (ev.target !== el || ev.animationName !== 'subtab-slide-in') return;
    el.removeEventListener('animationend', onSlideEnd);
    el.classList.remove('is-entering');
  };
  el.addEventListener('animationend', onSlideEnd);
  if (window.InplaizeTabEnter && window.lottie) window.InplaizeTabEnter.play(el);
  else el.classList.add('is-entering-css');
}

let shortcutShownTabId = '';
let shortcutMainTabId = '';
let shortcutOnMain = true;
let lastDetachedTabsPayload = null;

/**
 * La página del acceso fijado no es una pestaña mientras la barra está cerrada.
 * Al abrir el toggle, esa página es la primera pestaña (WhatsApp, Gmail, etc.).
 * Las que se abrieron aparte siguen a continuación.
 */
function renderSubTabs(payload) {
  lastDetachedTabsPayload = payload || { tabs: [] };
  const chrome = document.getElementById('shortcut-browser');
  const tabs = payload && Array.isArray(payload.tabs) ? payload.tabs : [];
  const extras = tabs.filter((tab) => !tab.isMain);
  const mainTab = tabs.find((tab) => tab.isMain);
  const activeNow = tabs.find((tab) => tab.isActive);
  shortcutMainTabId = mainTab && mainTab.id ? String(mainTab.id) : '';
  shortcutOnMain = !activeNow || !!activeNow.isMain;
  shortcutEmbedded = !!(payload && payload.embedded);
  const addressPeek = !!(payload && payload.addressPeek);
  const searchIdle = extras.length === 0;
  const showMainAsTab = !!(
    chrome
    && chrome.classList.contains('is-tabs-forced')
    && mainTab
    && searchIdle
    && !addressPeek
    && !profileLupaCompose
  );
  const listed = showMainAsTab ? [mainTab] : extras;
  shortcutHasOpenTabs = !searchIdle;
  shortcutPeekOnly = addressPeek && searchIdle;
  const openingPeek = shortcutPeekOnly && !addressPeekWasOn;
  addressPeekWasOn = shortcutPeekOnly;
  if (!searchIdle) {
    shortcutSearchManualReveal = false;
  }
  if (chrome) {
    chrome.classList.toggle('is-search-idle', searchIdle && !shortcutPeekOnly);
    chrome.classList.toggle('is-address-peek', shortcutPeekOnly);
    chrome.classList.remove('is-url-hidden');
    syncShortcutBrowserVisibility();
  }
  if (openingPeek) {
    const activeTab = tabs.find((tab) => tab.isActive) || tabs[0];
    focusPeekAddress(activeTab ? activeTab.url : '');
  }
  if (!subtabStrip) return;
  const freshIds = noteSubtabIds(listed);
  if (listed.length === 0) {
    subtabStrip.innerHTML = '';
    syncShortcutAddPage(shortcutPeekOnly ? tabs : []);
    const input = document.getElementById('shortcut-omnibox-input');
    if (!shortcutPeekOnly && input && document.activeElement !== input && !String(input.value || '').trim()) {
      input.value = '';
      paintShortcutAddress('');
    }
    return;
  }
  subtabStrip.hidden = false;
  const fresh = new Set(freshIds);
  const existing = new Map();
  for (const node of subtabStrip.querySelectorAll(':scope > .subtab')) {
    if (node.dataset.tabId) existing.set(node.dataset.tabId, node);
  }
  const keep = new Set();
  for (const tab of listed) {
    const id = String(tab.id);
    keep.add(id);
    let el = existing.get(id);
    if (!el) {
      el = createSubtabElement();
      el.dataset.tabId = id;
    }
    el._tab = tab;
    syncSubtabElement(el, tab);
    subtabStrip.appendChild(el);
  }
  for (const [id, node] of existing) {
    if (!keep.has(id)) node.remove();
  }

  const active = tabs.find((tab) => tab.isActive);
  const input = document.getElementById('shortcut-omnibox-input');
  const activeId = active && active.id ? String(active.id) : '';
  const previousId = shortcutShownTabId;
  noteShortcutBlankTab(activeId, active ? active.url : '', previousId);
  const typingBlank = shortcutBlankAddress && input && document.activeElement === input;
  if (input && active && !typingBlank && (document.activeElement !== input || activeId !== shortcutShownTabId)) {
    input.value = displayAddress(active.url);
  }
  if (input && document.activeElement !== input) paintShortcutAddress(input.value, active ? active.favicon : '');
  shortcutShownTabId = activeId;
  const fit = window.UsualDeskTabStripFit;
  if (fit) {
    fit.watchTabStrip(subtabStrip, '.subtab');
    fit.fitTabStrip(subtabStrip, '.subtab');
  }
  if (fresh.size) {
    for (const el of subtabStrip.querySelectorAll(':scope > .subtab')) {
      if (fresh.has(el.dataset.tabId)) playSubtabEnter(el);
    }
  }
  syncShortcutAddPage(tabs);
}

/** Igual que en la navegación libre: fija la página activa en la barra de accesos. */
function syncShortcutAddPage(tabs) {
  const btn = document.getElementById('shortcut-add-page');
  if (!btn) return;
  const tab = (tabs || []).find((item) => item.isActive && item.canPin);
  btn.hidden = false;
  btn.disabled = !tab;
  if (!tab) {
    btn.classList.remove('is-saved');
    btn._pinPage = null;
    return;
  }
  const saved = !!tab.pinned;
  btn.classList.toggle('is-saved', saved);
  const label = btn.querySelector('.shortcut-add-page-label');
  if (label) label.textContent = saved ? 'Acceso directo creado' : 'Generar acceso directo…';
  const hint = saved
    ? 'Esta página ya está en la barra de arriba'
    : 'Generar acceso directo en la barra de arriba';
  btn.setAttribute('aria-label', hint);
  btn.dataset.tooltip = hint;
  btn._pinPage = tab;
}

function bindShortcutBrowserChrome() {
  document.getElementById('shortcut-nav-back')?.addEventListener('click', () => {
    api.goBack?.().catch(() => {});
  });
  document.getElementById('shortcut-nav-forward')?.addEventListener('click', () => {
    api.goForward?.().catch(() => {});
  });
  document.getElementById('shortcut-nav-reload')?.addEventListener('click', () => {
    api.frameAction('reload-tab', '').catch(() => {});
  });
  document.getElementById('shortcut-new-tab')?.addEventListener('click', () => {
    if (profileLupaCompose) {
      profileLupaCompose = false;
      delete document.documentElement.dataset.profileLupa;
      window.UsualDeskStripProfileSearch?.setOpen(false);
      document.getElementById('shortcut-browser')?.classList.remove('is-profile-search');
      const field = document.getElementById('shortcut-omnibox-input');
      if (field) field.placeholder = SHORTCUT_ADDRESS_PLACEHOLDER;
    }
    shortcutBlankAddress = true;
    shortcutBlankTabId = '';
    setDetachedStripCompose(true, { origin: 'strip' });
    const field = document.getElementById('shortcut-omnibox-input');
    if (field) {
      field.value = '';
      field.focus();
    }
    api.frameAction('new-subtab').catch(() => {
      setDetachedStripCompose(false);
      forgetShortcutBlankAddress();
    });
  });
  document.getElementById('shortcut-add-page')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const tab = event.currentTarget._pinPage;
    if (!tab || tab.pinned || !tab.canPin) return;
    api.openAddShortcutForPage?.({
      url: tab.url,
      title: tab.pinTitle || tab.title || '',
      sessionId: tab.sessionId || '',
      favicon: tab.favicon || '',
    }).catch(() => {});
  });
  function elementBehindUrlEditor(editor, x, y) {
    if (!editor) return null;
    const fields = editor.querySelectorAll('input, button');
    const prev = editor.style.pointerEvents;
    const prevFields = [];
    editor.style.pointerEvents = 'none';
    fields.forEach((el) => {
      prevFields.push(el.style.pointerEvents);
      el.style.pointerEvents = 'none';
    });
    const under = document.elementFromPoint(x, y);
    editor.style.pointerEvents = prev;
    fields.forEach((el, i) => {
      el.style.pointerEvents = prevFields[i];
    });
    return under;
  }

  const form = document.getElementById('shortcut-omnibox');
  const input = document.getElementById('shortcut-omnibox-input');
  if (form && input) {
    const syncUrlEditing = () => {
      form.classList.toggle('is-editing', document.activeElement === input);
    };
    input.addEventListener('focus', () => {
      syncUrlEditing();
      if (shortcutBlankAddress) input.value = '';
    });
    input.addEventListener('blur', () => {
      syncUrlEditing();
      const bar = document.getElementById('shortcut-browser');
      if (!bar || !bar.classList.contains('is-address-peek') || profileLupaCompose) return;
      requestAnimationFrame(() => {
        if (!bar.classList.contains('is-address-peek') || profileLupaCompose) return;
        if (bar.contains(document.activeElement)) return;
        api.frameAction('hide-address').catch(() => {});
      });
    });
  }
  form?.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) return;
    const under = elementBehindUrlEditor(form, event.clientX, event.clientY);
    const tab = under?.closest('.subtab, .shortcut-browser-new, .subtab-close');
    if (tab) {
      event.preventDefault();
      input?.blur();
      tab.click();
      return;
    }
    if (event.target.closest('input')) return;
    event.preventDefault();
    input?.focus();
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    window.UsualDeskStripProfileSearch?.setOpen(false);
    const value = input ? String(input.value || '').trim() : '';
    if (profileLupaCompose) {
      if (!value) return;
      const known = detachedProfilePartition();
      closeDetachedProfileLupa();
      const go = (partition) => {
        api.looseNavNewTab?.(value, partition ? { partition } : undefined).catch(() => {});
      };
      if (known) {
        go(known);
        return;
      }
      Promise.resolve(api.looseNavGetState?.())
        .then((state) => {
          const part = state && state.defaultProfile && state.defaultProfile.partition;
          go(typeof part === 'string' ? part : '');
        })
        .catch(() => go(''));
      return;
    }
    const idleBar = document.getElementById('shortcut-browser');
    if (idleBar && idleBar.classList.contains('is-search-idle')) {
      if (!value) return;
      setDetachedStripCompose(false);
      api.frameAction('new-subtab', value).catch(() => {});
      input?.blur();
      return;
    }
    const composing = document.documentElement.classList.contains('is-strip-compose');
    const peek = document.getElementById('shortcut-browser')?.classList.contains('is-address-peek');
    /* Lupa / compose: Enter siempre genera la pestaña y recién ahí muestra el strip. */
    if (composing) {
      setDetachedStripCompose(false);
      if (value) api.frameAction('new-subtab', value).catch(() => {});
      input?.blur();
      return;
    }
    if (peek) {
      const current = displayAddress(pageNav.url || '').trim();
      if (value && value !== current) api.frameAction('navigate', value).catch(() => {});
      input?.blur();
      return;
    }
    setDetachedStripCompose(false);
    api.frameAction('new-subtab', value).catch(() => {});
    input?.blur();
  });
  input?.addEventListener('blur', () => {
    paintShortcutAddress(input.value);
    window.setTimeout(() => {
      if (Date.now() < shortcutRevealGuardUntil) return;
      if (document.activeElement === input) return;
      if (profileLupaCompose) {
        closeDetachedProfileLupa();
        return;
      }
      if (document.documentElement.classList.contains('is-strip-compose')) {
        setDetachedStripCompose(false);
      }
      if (shortcutSearchManualReveal) {
        setShortcutSearchRevealed(false);
      }
    }, 180);
  });
  input?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    if (profileLupaCompose) {
      closeDetachedProfileLupa();
      return;
    }
    if (document.documentElement.classList.contains('is-strip-compose')) {
      setDetachedStripCompose(false);
    }
    setShortcutSearchRevealed(false);
    if (shortcutPeekOnly) api.frameAction('hide-address').catch(() => {});
    input.blur();
  });
  api.onFocusSearchBar?.(() => {
    setTimeout(() => focusShortcutSearch({ force: true }), 40);
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!shortcutSearchManualReveal && !profileLupaCompose) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    if (target.closest('#shortcut-browser, #strip-search, #strip-profile-search')) return;
    if (profileLupaCompose) {
      closeDetachedProfileLupa();
      return;
    }
    setShortcutSearchRevealed(false);
  });
}

function shortcutFocusIsEditor(el) {
  const field = document.getElementById('shortcut-omnibox-input');
  if (!el || el === field || !(el instanceof Element)) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"]');
}

/** Deja el cursor en el buscador de la app. Con la ventana ya abierta, selecciona la dirección. */
function focusShortcutSearch({ force = false } = {}) {
  const input = document.getElementById('shortcut-omnibox-input');
  const bar = document.getElementById('shortcut-browser');
  if (!input || !bar) return;
  if (!force && shortcutFocusIsEditor(document.activeElement)) return;
  setShortcutSearchRevealed(true, { guard: true });
  const idle = bar.classList.contains('is-search-idle');
  input.focus();
  if (idle) {
    const len = input.value.length;
    try { input.setSelectionRange(len, len); } catch { /* ignore */ }
    return;
  }
  try { input.select(); } catch { /* ignore */ }
}

/**
 * Buscador de la franja → omnibox (mismo handoff Arc que el dock).
 * `commit` navega al llegar; si no, deja el texto listo para editar.
 */
function setDetachedStripCompose(on, { origin = 'strip' } = {}) {
  const next = on === true;
  const root = document.documentElement;
  if (origin === 'tab') root.dataset.urlSlide = 'up';
  else if (origin === 'strip') root.dataset.urlSlide = 'down';

  if (next) {
    root.classList.add('is-strip-compose');
    syncDetachedBarSproutAttr();
    api.frameAction('set-url-compose', true).catch(() => {});
    return;
  }

  root.classList.remove('is-strip-compose');
  delete root.dataset.urlSlide;
  syncDetachedBarSproutAttr();
  api.frameAction('set-url-compose', false).catch(() => {});
}

/**
 * Lupa desde un acceso directo: salimos de esa sesión y abrimos el buscador
 * en el primer perfil de la franja (dock), no como pestaña del acceso.
 */
/** La lupa del acceso busca en Sin sesión / incógnito del dock. */
async function guestSearchPartition() {
  const rail = document.getElementById('loose-nav-accounts');
  const marked = rail && rail.querySelector('.loose-nav-account[data-incognito="1"][data-partition]');
  if (marked && marked.dataset.partition) return String(marked.dataset.partition);
  const withGlyph = rail
    && [...rail.querySelectorAll('.loose-nav-account[data-partition]')].find(
      (el) => el.querySelector('.loose-nav-account-incognito')
    );
  if (withGlyph && withGlyph.dataset.partition) return String(withGlyph.dataset.partition);
  try {
    const state = await api.looseNavGetState?.();
    const accounts = (state && state.accounts && state.accounts.accounts) || [];
    const guest = accounts.find((a) => a && (a.incognito || /browse-guest/.test(String(a.partition || ''))));
    if (guest && guest.partition) return String(guest.partition);
  } catch {
    /* noop */
  }
  return 'persist:browse-guest';
}

window.__dockHandoffStripSearch = async (seed = '', { commit = false } = {}) => {
  const text = String(seed || '').trim();
  const stripBtn = document.getElementById('strip-search');
  if (stripBtn && document.activeElement === stripBtn) stripBtn.blur();

  setDetachedStripCompose(false);

  if (typeof api.looseNavNewTab !== 'function') return;

  const partition = await guestSearchPartition();
  const profile = {
    ...(partition ? { partition } : {}),
    slideIn: true,
  };

  try {
    /* Sale del acceso: una pestaña en Sin sesión del dock. */
    await api.looseNavNewTab(commit && text ? text : '', profile);
  } catch {
    /* noop */
  }
};

async function refreshSubTabsFromMain() {
  try {
    const payload = await api.frameAction('get-tabs');
    renderSubTabs(payload);
  } catch {
    /* noop */
  }
}

bindShortcutBrowserChrome();
bindSubtabPinDrag();

/** Soltar una pestaña sobre la franja de arriba crea el acceso directo ahí. */
function bindSubtabPinDrag() {
  const pin = window.UsualDeskTabPinDrag;
  if (!subtabStrip || !pin) return;
  pin.bind({
    root: subtabStrip,
    tabSelector: '.subtab',
    ignoreSelector: '.subtab-close',
    strip: () => document.getElementById('shortcut-strip'),
    pageFromTab(el) {
      const tab = el._tab;
      if (!tab || tab.canPin === false) return null;
      const url = String(tab.url || '');
      if (!/^https?:\/\//i.test(url)) return null;
      return {
        url,
        title: tab.pinTitle || tab.title || '',
        sessionId: tab.sessionId || '',
        favicon: tab.favicon || '',
      };
    },
    onPin: (page, index, ontoId) => api.pinTabAsShortcut?.({ ...page, index, ontoId }),
  });
}

if (api.onTabs) {
  api.onTabs(renderSubTabs);
}
if (api.onUrlBarHidden) {
  api.onUrlBarHidden((hidden) => {
    if (hidden === true) return;
    document.getElementById('shortcut-browser')?.classList.remove('is-url-hidden');
    if (window.UsualDeskTabStripFit && subtabStrip) {
      window.UsualDeskTabStripFit.fitTabStrip(subtabStrip, '.subtab');
    }
  });
}
if (api.onNavState) api.onNavState(applyPageNav);
if (api.getNavState) api.getNavState().then(applyPageNav).catch(() => {});
refreshSubTabsFromMain();

if (api.onChrome) {
  api.onChrome(renderChrome);
}
if (api.onShortcutsChanged) {
  api.onShortcutsChanged(() => {
    refreshChromeFromMain();
    refreshSubTabsFromMain();
  });
}

if (api.onFocusModeChanged) {
  api.onFocusModeChanged((state) => {
    applyFocusModeToDom(state);
    refreshChromeFromMain();
  });
}

if (api.getFocusModeState) {
  api.getFocusModeState()
    .then((state) => applyFocusModeToDom(state))
    .catch(() => {});
}

if (api.onTitleBadge) {
  api.onTitleBadge((payload) => {
    if (!payload || payload.shortcutId == null) return;
    const sid = String(payload.shortcutId);
    if (payload.count == null) {
      delete stripTitleBadges[sid];
    } else {
      stripTitleBadges[sid] = payload.count;
    }
    if (!strip) return;
    const btn = strip.querySelector(`.shell-shortcut-item[data-shortcut-id="${sid}"]`);
    if (btn) applyStripBadge(btn, sid);
  });
}

refreshChromeFromMain();

/** Página en reposo: su última imagen ocupa el hueco hasta que la ventana vuelva a usarse. */
function bindHibernationCover() {
  if (!api.onHibernated) return;
  const cover = document.createElement('div');
  cover.className = 'page-hibernated-cover';
  cover.hidden = true;
  const note = document.createElement('span');
  note.className = 'page-hibernated-note';
  note.textContent = 'En reposo para ahorrar memoria · se recarga al volver';
  cover.appendChild(note);
  document.body.appendChild(cover);
  api.onHibernated((payload) => {
    const snapshot = payload && typeof payload.snapshot === 'string' ? payload.snapshot : '';
    cover.style.backgroundImage = snapshot ? `url("${snapshot}")` : '';
    cover.hidden = !payload;
  });
}

bindHibernationCover();

document.getElementById('strip-add-new')?.addEventListener('click', () => {
  api.openAddShortcut?.().catch(() => {});
});

document.getElementById('strip-edit-toggle')?.addEventListener('click', () => {
  api.enterShortcutsEditMode?.().catch(() => {});
});

document.getElementById('strip-edit-done')?.addEventListener('click', () => {
  api.requestExitShortcutEditMode?.().catch(() => {});
});

const detachedShellHomeBtn = document.getElementById('shell-home-btn');
if (detachedShellHomeBtn && window.usualDeskDetached.openDockWelcomeHome) {
  detachedShellHomeBtn.addEventListener('click', () => {
    window.usualDeskDetached.openDockWelcomeHome('todos').catch(() => {});
  });
}

const detachedShellDownloadsBtn = document.getElementById('shell-downloads-btn');
if (detachedShellDownloadsBtn && window.usualDeskDetached.openDockWelcomeHome) {
  detachedShellDownloadsBtn.addEventListener('click', () => {
    window.usualDeskDetached.openDockWelcomeHome('downloads').catch(() => {});
  });
}

function initShellHomeMenuChrome(api) {
  if (!window.UsualDeskShellHomeMenu) return;
  window.UsualDeskShellHomeMenu.mountChrome();
  window.UsualDeskShellHomeMenu.init({
    openAddShortcut: () => api.openAddShortcut?.().catch(() => {}),
    enterShortcutsEditMode: () => api.enterShortcutsEditMode?.().catch(() => {}),
    exitShortcutsEditMode: () => api.requestExitShortcutEditMode?.().catch(() => {}),
    openAppearance: () => api.openAppearance?.().catch(() => {}),
    hidePanel: () => api.collapseDockSidebar?.().catch(() => {}),
    quitApp: () => api.closeApp?.().catch(() => {}),
    onShortcutsEditModeSync: (cb) => api.onShortcutsEditModeSync?.(cb),
    onDrawerOpenChange: (open, editMode) => api.notifyShellMenuDrawer?.(open === true, editMode === true),
  });
}

function initFramelessChrome() {
  if (!api?.framelessChrome) return;
  document.documentElement.setAttribute('data-shell-frameless', 'true');
  initShellHomeMenuChrome(api);
}

const PAGE_MENU_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
  '<circle cx="12" cy="5" r="1.8" fill="currentColor"/>' +
  '<circle cx="12" cy="12" r="1.8" fill="currentColor"/>' +
  '<circle cx="12" cy="19" r="1.8" fill="currentColor"/>' +
  '</svg>';

/** Botón ⋮ con las opciones de la página (zoom, imprimir, Lens, traducir…). */
function mountPageMenuButton() {
  const header = document.querySelector('.shell-top');
  if (!header || !api.openPageMenu || document.getElementById('page-menu-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'page-menu-btn';
  btn.className = 'page-menu-btn';
  btn.setAttribute('aria-label', 'Opciones de la página');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.dataset.tooltip = 'Opciones de la página';
  btn.dataset.tooltipPlacement = 'bottom';
  btn.innerHTML = PAGE_MENU_SVG;
  btn.addEventListener('click', () => {
    const r = btn.getBoundingClientRect();
    api.openPageMenu(r.left, r.bottom).catch(() => {});
  });
  const wrap = document.getElementById('header-actions');
  if (wrap) wrap.insertBefore(btn, wrap.firstChild);
  else {
    const anchor = header.querySelector('.shell-win-btns');
    if (anchor) header.insertBefore(btn, anchor);
    else header.appendChild(btn);
  }
}

function bindPageCommands() {
  const header = document.querySelector('.shell-top');
  const findBar =
    header && api.findInPage && window.UsualDeskPageFindBar
      ? window.UsualDeskPageFindBar.create(header, {
          find: (text, opts) => api.findInPage(text, opts),
          stop: () => api.stopFindInPage(),
        })
      : null;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f' && findBar) {
      e.preventDefault();
      findBar.open();
    }
  });
  if (!api.onPageCommand) return;
  api.onPageCommand((msg) => {
    if (!msg) return;
    if (msg.command === 'find-open' && findBar) findBar.open();
    else if (msg.command === 'find-result' && findBar) findBar.showResult(msg.payload);
    else if (msg.command === 'downloads') api.openDockWelcomeHome?.('downloads').catch(() => {});
  });
}

initFramelessChrome();
mountPageMenuButton();
bindPageCommands();
bindShellFileDragAcceptance();
window.UsualDeskShellNavProfiles?.init?.();

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
  return types.includes('Files');
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
  if (payload && payload.focusMode) {
    applyFocusModeToDom(payload.focusMode);
  }
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  if (!strip) return;
  strip.innerHTML = '';
  if (items.length === 0) {
    const span = document.createElement('span');
    span.className = 'shortcut-strip-empty';
    span.textContent = 'Sin accesos directos';
    strip.appendChild(span);
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
    const isWeb = it.type === 'web';
    const canClose = isWeb && it.isOpen && it.mapKey;
    const canFocusGesture = isWeb;
    const webTabClosed = isWeb && !it.isOpen;
    if (webTabClosed) {
      btn.classList.add('shell-shortcut-inactive');
    }
    if (it.isFocusMember) {
      btn.classList.add('shell-focus-member');
    }
    btn.setAttribute('aria-label', name);
    btn.dataset.shortcutId = it.id;
    btn.dataset.shortcutType = it.type || '';

    const wrap = document.createElement('span');
    wrap.className = 'shell-shortcut-icon-wrap';
    wrap.appendChild(buildShortcutIcon(it.icon || '', name));
    btn.appendChild(wrap);
    applyStripBadge(btn, it.id);

    let ignoreClickUntil = 0;
    btn.addEventListener('click', () => {
      if (Date.now() < ignoreClickUntil) return;
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
}

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

const SUBTAB_NAV_BACK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const SUBTAB_NAV_FORWARD_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

function applyPageNav(state) {
  pageNav = state && typeof state === 'object'
    ? { canGoBack: !!state.canGoBack, canGoForward: !!state.canGoForward }
    : { canGoBack: false, canGoForward: false };
  if (!subtabStrip) return;
  const back = subtabStrip.querySelector('.subtab-nav-back');
  const forward = subtabStrip.querySelector('.subtab-nav-forward');
  if (back) back.disabled = !pageNav.canGoBack;
  if (forward) forward.disabled = !pageNav.canGoForward;
}

function makeSubtabNavButton(className, label, svg, enabled, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `subtab-nav-btn ${className}`;
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

/** Flechas de historial, únicamente en la solapa activa. */
function appendActiveTabNav(el) {
  const nav = document.createElement('span');
  nav.className = 'subtab-nav';
  nav.addEventListener('click', (ev) => ev.stopPropagation());
  nav.appendChild(makeSubtabNavButton(
    'subtab-nav-back',
    'Atrás',
    SUBTAB_NAV_BACK_SVG,
    pageNav.canGoBack,
    () => api.goBack?.().catch(() => {})
  ));
  nav.appendChild(makeSubtabNavButton(
    'subtab-nav-forward',
    'Adelante',
    SUBTAB_NAV_FORWARD_SVG,
    pageNav.canGoForward,
    () => api.goForward?.().catch(() => {})
  ));
  el.appendChild(nav);
}

/**
 * Fila de sub-pestañas: solo visible cuando hay más de una pestaña
 * (la principal del servicio + las abiertas con Ctrl+click / target=_blank).
 */
function renderSubTabs(payload) {
  if (!subtabStrip) return;
  const tabs = payload && Array.isArray(payload.tabs) ? payload.tabs : [];
  if (tabs.length <= 1) {
    subtabStrip.hidden = true;
    subtabStrip.innerHTML = '';
    return;
  }
  subtabStrip.hidden = false;
  subtabStrip.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'subtab';
    if (tab.isActive) el.classList.add('is-active');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', tab.isActive ? 'true' : 'false');
    el.title = tab.title || '';

    if (tab.isActive) appendActiveTabNav(el);

    const icon = document.createElement('span');
    icon.className = 'subtab-icon';
    if (tab.loading) {
      icon.classList.add('is-loading');
    } else if (tab.favicon) {
      const img = document.createElement('img');
      img.src = tab.favicon;
      img.alt = '';
      img.loading = 'lazy';
      icon.appendChild(img);
    }
    el.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'subtab-title';
    label.textContent = tab.title || 'Pestaña';
    el.appendChild(label);

    el.addEventListener('click', () => {
      if (!tab.isActive) api.frameAction('select-subtab', tab.id);
    });

    if (!tab.isMain) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'subtab-close';
      closeBtn.setAttribute('aria-label', `Cerrar ${tab.title || 'pestaña'}`);
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        api.frameAction('close-subtab', tab.id);
      });
      el.appendChild(closeBtn);

      el.addEventListener('auxclick', (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          api.frameAction('close-subtab', tab.id);
        }
      });
    }

    subtabStrip.appendChild(el);
  }
}

async function refreshSubTabsFromMain() {
  try {
    const payload = await api.frameAction('get-tabs');
    renderSubTabs(payload);
  } catch {
    /* noop */
  }
}

if (api.onTabs) {
  api.onTabs(renderSubTabs);
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
    openSettings: () => api.openSettings?.().catch(() => {}),
    hidePanel: () => api.collapseDockSidebar?.().catch(() => {}),
    quitApp: () => api.closeApp?.().catch(() => {}),
    onShortcutsEditModeSync: (cb) => api.onShortcutsEditModeSync?.(cb),
    onDrawerOpenChange: (open) => api.notifyShellMenuDrawer?.(open === true),
  });
}

function initFramelessChrome() {
  if (!api?.framelessChrome) return;
  document.documentElement.setAttribute('data-shell-frameless', 'true');
  initShellHomeMenuChrome(api);
}

initFramelessChrome();
bindShellFileDragAcceptance();

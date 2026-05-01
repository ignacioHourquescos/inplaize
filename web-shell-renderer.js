const strip = document.getElementById('shortcut-strip');

/** @type {Record<string, number>} */
const stripTitleBadges = {};

/** Último estado de Modo Foco conocido por el renderer. */
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
    const hints = [];
    if (canClose) hints.push('mantén pulsado para cerrar');
    if (canFocusGesture) hints.push('clic derecho para alternar Modo Foco');
    let title = hints.length ? `${name} — ${hints.join(' · ')}` : name;
    let ariaLabel = name;
    if (canClose) {
      ariaLabel = `${name}. Mantén pulsado para cerrar. Clic derecho para alternar Modo Foco.`;
    } else if (webTabClosed) {
      title = `${name} — pestaña cerrada (clic para abrir · clic derecho para alternar Modo Foco)`;
      ariaLabel = `${name}. Pestaña cerrada. Pulsa para abrir. Clic derecho para alternar Modo Foco.`;
    }
    btn.setAttribute('data-tooltip', title);
    btn.setAttribute('data-tooltip-placement', 'bottom');
    btn.setAttribute('aria-label', ariaLabel);
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
      if (focusModeState.active && !it.isFocusMember && window.usualDeskShell.exitFocusMode) {
        window.usualDeskShell.exitFocusMode().catch(() => {});
      }
      window.usualDeskShell.activateShortcut(it.id);
    });

    if (canClose || canFocusGesture) {
      const gestures = window.UsualDeskStripGestures;
      if (gestures && typeof gestures.bindIconStripGestures === 'function') {
        gestures.bindIconStripGestures(btn, {
          onClose: canClose
            ? () => {
                ignoreClickUntil = Date.now() + SUPPRESS_CLICK_MS;
                window.usualDeskShell.closeTab(String(it.mapKey));
              }
            : null,
          onLongPressFocus: canFocusGesture
            ? () => {
                ignoreClickUntil = Date.now() + SUPPRESS_CLICK_MS;
                window.usualDeskShell
                  .toggleFocusModeMember(String(it.id))
                  .catch(() => {});
              }
            : null,
          suppressNextActivation: () => {
            ignoreClickUntil = Date.now() + SUPPRESS_CLICK_MS;
          },
        });
      }
    }

    cell.appendChild(btn);

    strip.appendChild(cell);
  }
}

async function refreshChromeFromMain() {
  try {
    const payload = await window.usualDeskShell.getChromeState();
    renderChrome(payload);
  } catch {
    /* noop */
  }
}

window.usualDeskShell.onChrome(renderChrome);
window.usualDeskShell.onShortcutsChanged(() => {
  refreshChromeFromMain();
});

if (window.usualDeskShell.onFocusModeChanged) {
  window.usualDeskShell.onFocusModeChanged((state) => {
    applyFocusModeToDom(state);
    refreshChromeFromMain();
  });
}

if (window.usualDeskShell.getFocusModeState) {
  window.usualDeskShell
    .getFocusModeState()
    .then((state) => applyFocusModeToDom(state))
    .catch(() => {});
}

if (window.usualDeskShell.onTitleBadge) {
  window.usualDeskShell.onTitleBadge((payload) => {
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

function initFramelessChrome() {
  if (!window.usualDeskShell?.framelessChrome) return;
  document.documentElement.setAttribute('data-shell-frameless', 'true');

  const minBtn = document.getElementById('shell-win-min');
  const maxBtn = document.getElementById('shell-win-max');
  const closeBtn = document.getElementById('shell-win-close');
  if (!minBtn || !maxBtn || !closeBtn) return;

  function setMaxVisual(isMax) {
    const label = isMax ? 'Restaurar' : 'Maximizar';
    maxBtn.setAttribute('data-tooltip', label);
    maxBtn.setAttribute('aria-label', label);
    if (isMax) {
      maxBtn.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="4" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/><rect x="4" y="2" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
    } else {
      maxBtn.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
    }
  }

  setMaxVisual(false);

  minBtn.addEventListener('click', () => {
    window.usualDeskShell.windowMinimize();
  });
  maxBtn.addEventListener('click', async () => {
    try {
      const isMax = await window.usualDeskShell.windowToggleMaximize();
      setMaxVisual(!!isMax);
    } catch {
      /* noop */
    }
  });
  closeBtn.addEventListener('click', () => {
    window.usualDeskShell.windowClose();
  });

  window.usualDeskShell.onWindowMaximized((isMax) => {
    setMaxVisual(isMax);
  });
}

initFramelessChrome();

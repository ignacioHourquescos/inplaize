(function () {
  const iconsEl = document.getElementById('focus-deck-icons');
  const dismissBtn = document.getElementById('focus-deck-dismiss');
  const collapseBtn = document.getElementById('focus-deck-collapse');
  const bubbleBtn = document.getElementById('focus-deck-bubble');
  const bubbleBadge = document.getElementById('focus-deck-bubble-badge');
  const expandedView = document.getElementById('focus-deck-expanded-view');
  const api = window.focusDeck;
  if (!api || !iconsEl || !bubbleBtn) return;

  /** @type {Set<string>} */
  let top4Ids = new Set();
  /** @type {Record<string, number>} */
  const badgeById = {};

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

  function iconMarkup(icon) {
    if (!icon) return '';
    if (icon.includes('/') || /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(icon)) {
      return `<img class="shortcut-icon-img" src="${escapeAttr(icon)}" alt="" role="presentation" />`;
    }
    return `<span class="shortcut-icon" aria-hidden="true">${escapeHtmlText(icon)}</span>`;
  }

  function recomputeTop4Ids(list) {
    const slice = (Array.isArray(list) ? list : []).slice(0, 4);
    top4Ids = new Set(
      slice.map((s) => (s && s.id != null ? String(s.id) : '')).filter(Boolean),
    );
    syncBubbleTotal();
  }

  function syncBubbleTotal() {
    if (!bubbleBadge) return;
    let sum = 0;
    top4Ids.forEach((id) => {
      const n = badgeById[id];
      if (typeof n === 'number' && n > 0) sum += n;
    });
    if (sum < 1) {
      bubbleBadge.setAttribute('hidden', '');
      bubbleBadge.textContent = '';
      bubbleBadge.removeAttribute('aria-label');
    } else {
      const label = sum > 99 ? '99+' : String(sum);
      bubbleBadge.textContent = label;
      bubbleBadge.removeAttribute('hidden');
      bubbleBadge.setAttribute('aria-label', `${sum} notificaciones en los cuatro primeros accesos`);
    }
  }

  function onTitleBadge(payload) {
    if (!payload || typeof payload !== 'object') return;
    const id = payload.shortcutId != null ? String(payload.shortcutId) : '';
    const count = payload.count;
    if (!id) return;
    if (count == null || count < 1) {
      delete badgeById[id];
    } else {
      badgeById[id] = count;
    }
    syncBubbleTotal();
  }

  function applyExpandedUi(expanded) {
    const on = expanded === true;
    document.body.classList.toggle('is-focus-deck-expanded', on);
    bubbleBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    bubbleBtn.setAttribute(
      'title',
      on ? 'Ocultar accesos directos' : 'Mostrar accesos directos',
    );
    bubbleBtn.setAttribute(
      'aria-label',
      on ? 'Ocultar los cuatro primeros accesos directos' : 'Mostrar los cuatro primeros accesos directos',
    );
    if (expandedView) {
      expandedView.hidden = !on;
    }
  }

  async function render() {
    let list = [];
    try {
      list = await api.getShortcuts();
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    const top4 = list.slice(0, 4);
    recomputeTop4Ids(top4);
    iconsEl.innerHTML = '';
    for (let i = 0; i < 4; i += 1) {
      const s = top4[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'focus-deck-slot';
      if (s) {
        btn.innerHTML = iconMarkup(s.icon);
        btn.setAttribute('data-tooltip', s.name || 'Abrir');
        btn.setAttribute('aria-label', s.name || 'Abrir acceso directo');
        btn.addEventListener('click', () => {
          api.openShortcut(s).catch(() => {});
        });
      } else {
        btn.disabled = true;
        btn.setAttribute('aria-hidden', 'true');
      }
      iconsEl.appendChild(btn);
    }
  }

  bubbleBtn.addEventListener('click', async () => {
    const next = !document.body.classList.contains('is-focus-deck-expanded');
    try {
      const expanded = await api.setExpanded(next);
      applyExpandedUi(expanded === true);
    } catch {
      applyExpandedUi(next);
    }
  });

  dismissBtn.addEventListener('click', () => {
    api.close().catch(() => {});
  });

  if (collapseBtn) {
    collapseBtn.addEventListener('click', async () => {
      try {
        const expanded = await api.setExpanded(false);
        applyExpandedUi(expanded === true);
      } catch {
        applyExpandedUi(false);
      }
    });
  }

  api.onShortcutsChanged(() => {
    render();
  });

  api.onShortcutTitleBadge(onTitleBadge);

  api.onExpandedState((expanded) => {
    applyExpandedUi(expanded === true);
  });

  (async function init() {
    try {
      const st = await api.getUiState();
      applyExpandedUi(st && st.expanded === true);
    } catch {
      applyExpandedUi(false);
    }
    try {
      const badges = await api.getTitleBadges();
      if (badges && typeof badges === 'object') {
        Object.keys(badges).forEach((k) => {
          const v = badges[k];
          if (typeof v === 'number' && v > 0) {
            badgeById[String(k)] = v;
          }
        });
      }
    } catch {
      /* */
    }
    await render();
  })();
})();

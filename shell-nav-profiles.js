/**
 * Riel de perfiles en la franja de ventanas web (web-shell / detached):
 * mismos iconos que en el dock, a la izquierda del divider violeta.
 * Clic abre la navegación suelta con esa sesión en el dock.
 */
(function initShellNavProfiles(global) {
  const INCOGNITO_SVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M4 11.5 7.2 6.8A3 3 0 0 1 9.7 5.5h4.6a3 3 0 0 1 2.5 1.3L20 11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M3.5 11h17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<circle cx="7.5" cy="16" r="2.6" stroke="currentColor" stroke-width="1.8"/>' +
    '<circle cx="16.5" cy="16" r="2.6" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M10.1 16c1.2-.7 2.6-.7 3.8 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '</svg>';

  function bridge() {
    if (global.usualDeskShell) return global.usualDeskShell;
    if (global.usualDeskDetached) return global.usualDeskDetached;
    return null;
  }

  function profileHue(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 20 + (h % 300);
  }

  function accountButton(opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'loose-nav-account';
    if (opts.partition) btn.dataset.partition = opts.partition;
    btn.title = opts.tooltip;
    btn.setAttribute('aria-label', opts.tooltip);
    btn.setAttribute('aria-pressed', opts.active ? 'true' : 'false');
    if (opts.active) btn.classList.add('is-active');
    if (opts.isDefault) btn.classList.add('is-default');

    if (opts.incognito) {
      const glyph = document.createElement('span');
      glyph.className = 'loose-nav-account-incognito';
      glyph.innerHTML = INCOGNITO_SVG;
      btn.appendChild(glyph);
    } else if (opts.avatar && String(opts.avatar).startsWith('data:image/')) {
      const img = document.createElement('img');
      img.src = opts.avatar;
      img.alt = '';
      btn.appendChild(img);
    } else {
      const letter = document.createElement('span');
      letter.className = 'loose-nav-account-letter';
      letter.textContent = (opts.label || '?').trim().charAt(0).toUpperCase() || '?';
      letter.style.setProperty('--loose-nav-profile-hue', String(profileHue(opts.seed)));
      btn.appendChild(letter);
    }

    btn.addEventListener('click', () => {
      opts.onClick?.();
    });
    return btn;
  }

  function render(state) {
    const rail = document.getElementById('loose-nav-accounts');
    if (!rail) return;
    const accounts = (state && state.accounts && state.accounts.accounts) || [];
    const chrome = (state && state.accounts && state.accounts.chrome) || [];
    const counts = (state && state.tabCounts) || {};
    const defaultPartition = (state && state.defaultProfile && state.defaultProfile.partition) || '';
    const navActive = !!(state && state.active);
    const api = bridge();

    rail.innerHTML = '';
    for (const a of accounts) {
      const display = a.incognito ? `${a.name} (incógnito)` : a.name || a.email;
      const who = a.name && a.email ? `${a.name} (${a.email})` : display;
      const count = counts[a.partition] || 0;
      const tabsLabel = count === 1 ? '1 pestaña' : `${count} pestañas`;
      const isDefault = a.partition === defaultPartition;
      rail.appendChild(
        accountButton({
          label: a.name || a.email,
          tooltip: `${who} · ${tabsLabel}`,
          avatar: a.avatar,
          seed: a.email || a.partition,
          incognito: !!a.incognito,
          active: navActive && a.partition === state.activePartition,
          isDefault,
          partition: a.partition,
          onClick: () => api?.looseNavUseAccount?.({ partition: a.partition }),
        }),
      );
    }
    for (const c of chrome) {
      const who = c.email || c.name;
      rail.appendChild(
        accountButton({
          label: c.email || c.name,
          tooltip: `${who} · traer desde Chrome`,
          avatar: c.avatar,
          seed: c.email || c.name,
          incognito: false,
          active: false,
          isDefault: false,
          onClick: () => api?.looseNavUseAccount?.({ chromeDirectory: c.directory }),
        }),
      );
    }
  }

  function init() {
    const api = bridge();
    if (!api) return;
    if (typeof api.onLooseNavState === 'function') {
      api.onLooseNavState((s) => render(s || {}));
    }
    if (typeof api.looseNavGetState === 'function') {
      api.looseNavGetState()
        .then((s) => {
          if (s) render(s);
        })
        .catch(() => {});
    }
  }

  global.UsualDeskShellNavProfiles = { init, render };
})(window);

/**
 * Icono de lupa en la franja: al clic enfoca la omnibox (misma fila que pestañas).
 * No es un campo de texto; el tipeo vive en la barra de dirección.
 */
(function initStripSearch(global) {
  let pinning = false;
  let handingOff = false;

  function bridge() {
    if (global.usualDesk && typeof global.usualDesk.looseNavNewTab === 'function') return global.usualDesk;
    if (global.usualDeskShell && typeof global.usualDeskShell.looseNavNewTab === 'function') return global.usualDeskShell;
    if (global.usualDeskDetached && typeof global.usualDeskDetached.looseNavNewTab === 'function') {
      return global.usualDeskDetached;
    }
    return null;
  }

  function firstPartition() {
    const rail = document.getElementById('loose-nav-accounts');
    const btn = rail && rail.querySelector('.loose-nav-account[data-partition]');
    const partition = btn && btn.dataset.partition ? btn.dataset.partition : '';
    return partition;
  }

  function hasHandoff() {
    return typeof global.__dockHandoffStripSearch === 'function';
  }

  function handoffToOmnibox(seed, opts) {
    if (!hasHandoff() || handingOff) return false;
    handingOff = true;
    try {
      global.__dockHandoffStripSearch(seed, opts || {});
    } finally {
      queueMicrotask(() => {
        handingOff = false;
      });
    }
    return true;
  }

  function goSearch(text) {
    const value = String(text || '').trim();
    if (!value) return;
    const api = bridge();
    if (!api) return;
    /* Desde un acceso directo: buscar en el primer perfil del dock, no en el acceso. */
    const partition = firstPartition();
    const profile = {
      ...(partition ? { partition } : {}),
      slideIn: true,
    };
    if (global.usualDeskDetached && api === global.usualDeskDetached) {
      api.looseNavNewTab(value, profile).catch(() => {});
      return;
    }
    api.looseNavNewTab(value, profile).catch(() => {});
  }

  function ensureButton() {
    let btn = document.getElementById('strip-search');
    if (btn && btn.tagName === 'BUTTON') return btn;
    if (btn && btn.tagName !== 'BUTTON') {
      btn.remove();
      btn = null;
    }
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'strip-search';
    btn.className = 'strip-search';
    btn.setAttribute('data-mouse-hit', '');
    btn.setAttribute('data-tooltip', 'Buscar');
    btn.setAttribute('data-tooltip-placement', 'bottom');
    btn.setAttribute('aria-label', 'Buscar');
    btn.innerHTML =
      '<svg class="strip-search-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="10.5" cy="10.5" r="6" stroke="currentColor" stroke-width="2.2"/>' +
      '<path d="M15.2 15.2 20 20" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
      '</svg>';
    return btn;
  }

  function pinBesideProfiles() {
    if (pinning) return;
    const rail = document.getElementById('loose-nav-accounts');
    if (!rail || !rail.parentElement) return;
    pinning = true;
    try {
      const btn = ensureButton();
      let cluster = rail.parentElement.classList.contains('strip-leading')
        ? rail.parentElement
        : null;
      if (!cluster) {
        cluster = document.createElement('div');
        cluster.className = 'strip-leading';
        if (rail.hasAttribute('data-mouse-hit')) cluster.setAttribute('data-mouse-hit', '');
        rail.parentElement.insertBefore(cluster, rail);
        cluster.appendChild(rail);
      }
      const host = cluster.parentElement;
      let divider =
        (host && host.querySelector(':scope > .strip-search-divider'))
        || cluster.querySelector(':scope > .strip-search-divider');
      if (!divider) {
        divider = document.createElement('div');
        divider.className = 'strip-rail-divider strip-search-divider';
        divider.setAttribute('aria-hidden', 'true');
      }
      /* La lupa vive con los perfiles. El divisor queda a la izquierda de ese grupo. */
      if (host && (divider.parentElement !== host || divider.nextElementSibling !== cluster)) {
        host.insertBefore(divider, cluster);
      }
      if (btn.parentElement !== cluster || cluster.firstElementChild !== btn) {
        cluster.insertBefore(btn, cluster.firstChild);
      }
      if (rail.parentElement !== cluster || btn.nextElementSibling !== rail) {
        cluster.insertBefore(rail, btn.nextSibling);
      }
      cluster.style.display = 'flex';
      cluster.style.flexDirection = 'row';
      cluster.style.flexWrap = 'nowrap';
      cluster.style.alignItems = 'center';
      cluster.style.flex = '';
      btn.hidden = false;
      btn.style.display = '';
      btn.style.visibility = '';
      btn.style.opacity = '';
    } finally {
      pinning = false;
    }
  }

  function bind() {
    pinBesideProfiles();
    const btn = document.getElementById('strip-search');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';

    const open = (ev) => {
      ev.preventDefault();
      if (hasHandoff()) {
        handoffToOmnibox('', { commit: false });
        return;
      }
      const api = bridge();
      if (!api) return;
      goSearch('');
    };
    btn.addEventListener('click', open);

    const root = document.getElementById('sidebar-chrome') || document.querySelector('.shell-top');
    if (root && root.dataset.searchWatch !== '1') {
      root.dataset.searchWatch = '1';
      const observer = new MutationObserver(() => pinBesideProfiles());
      observer.observe(root, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})(window);

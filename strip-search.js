/**
 * Control de la franja que abre la barra de pestañas.
 * Es una línea entre perfiles y accesos, con un chevron chico en el medio.
 * Cerrada apunta hacia abajo; abierta, hacia arriba.
 */
(function initStripSearch(global) {
  let pinning = false;

  function chevronMarkup() {
    return '<span class="strip-search-line" aria-hidden="true"></span>'
      + '<span class="strip-search-mark" aria-hidden="true">'
      + '<svg class="strip-search-icon" viewBox="0 0 24 24" fill="none">'
      + '<path d="M6.5 9.5 12 15l5.5-5.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg></span>';
  }

  function ensureButton() {
    let btn = document.getElementById('strip-search');
    const ready = btn && btn.tagName === 'BUTTON'
      && btn.querySelector('.strip-search-line')
      && btn.querySelector('.strip-search-mark .strip-search-icon');
    if (ready) return btn;
    if (btn && btn.tagName === 'BUTTON') {
      btn.innerHTML = chevronMarkup();
      return btn;
    }
    const fresh = document.createElement('button');
    fresh.type = 'button';
    fresh.id = 'strip-search';
    fresh.className = 'strip-search';
    fresh.setAttribute('data-mouse-hit', '');
    fresh.setAttribute('data-tooltip', 'Mostrar pestañas');
    fresh.setAttribute('data-tooltip-placement', 'bottom');
    fresh.setAttribute('aria-label', 'Mostrar la barra de pestañas');
    fresh.setAttribute('aria-expanded', 'false');
    fresh.innerHTML = chevronMarkup();
    if (btn && btn.parentElement) btn.replaceWith(fresh);
    return fresh;
  }

  /** El chevron queda entre el contenedor de perfiles y el de accesos directos. */
  function pinBetweenContainers() {
    if (pinning) return;
    const cluster = document.querySelector('.strip-url-cluster');
    if (!cluster || !cluster.parentElement) return;
    pinning = true;
    try {
      const btn = ensureButton();
      const host = cluster.parentElement;
      if (btn.parentElement !== host || btn.previousElementSibling !== cluster) {
        const after = cluster.nextSibling;
        if (after) host.insertBefore(btn, after);
        else host.appendChild(btn);
      }
    } finally {
      pinning = false;
    }
  }

  function spinIcon(btn) {
    const icon = btn.querySelector('.strip-search-icon');
    if (!icon || typeof icon.animate !== 'function') return;
    const opening = btn.getAttribute('aria-expanded') !== 'true';
    const from = opening ? 0 : 180;
    const to = opening ? 180 : 0;
    const over = opening ? 210 : -30;
    icon.getAnimations().forEach((anim) => anim.cancel());
    icon.animate(
      [
        { transform: 'rotate(' + from + 'deg) scale(1)' },
        { transform: 'rotate(' + over + 'deg) scale(1.28)', offset: 0.58 },
        { transform: 'rotate(' + to + 'deg) scale(1)' },
      ],
      { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
    );
  }

  function bind() {
    pinBetweenContainers();
    const btn = document.getElementById('strip-search');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      spinIcon(btn);
      if (typeof global.__dockRevealNavBar === 'function') global.__dockRevealNavBar();
    });

    const root = document.getElementById('sidebar-chrome') || document.querySelector('.shell-top');
    if (root && root.dataset.searchWatch !== '1') {
      root.dataset.searchWatch = '1';
      const observer = new MutationObserver(() => pinBetweenContainers());
      observer.observe(root, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})(window);

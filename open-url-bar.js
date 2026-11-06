/**
 * Icono de internet (el primero de la franja): abre el navegador de la app.
 * En el dock es un switch: si el navegador ya está abierto, vuelve al inicio.
 */
(function initOpenUrlBar() {
  const btn = document.getElementById('open-url-btn');
  if (!btn) return;

  function bridge() {
    if (window.usualDesk && typeof window.usualDesk.openAppBrowser === 'function') return window.usualDesk;
    if (window.usualDeskShell && typeof window.usualDeskShell.openAppBrowser === 'function') return window.usualDeskShell;
    if (window.usualDeskDetached && typeof window.usualDeskDetached.openAppBrowser === 'function') return window.usualDeskDetached;
    return null;
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof window.__dockToggleInternet === 'function') {
      window.__dockToggleInternet();
      return;
    }
    const api = bridge();
    if (!api || typeof api.openAppBrowser !== 'function') return;
    api.openAppBrowser().catch(() => {});
  });

  /* En el dock, el padding y el hueco entre opciones también alternan el modo.
     Los botones frenan el burbujeo y se encargan solos. */
  const seg = btn.closest('.strip-mode-seg');
  if (seg) {
    let userSwitchTimer = null;
    seg.addEventListener('pointerdown', () => {
      clearTimeout(userSwitchTimer);
      seg.classList.add('is-user-switch');
      userSwitchTimer = setTimeout(() => seg.classList.remove('is-user-switch'), 800);
    }, true);
    seg.addEventListener('click', (e) => {
      if (typeof window.__dockToggleInternet !== 'function') return;
      if (e.target.closest('#open-url-form') || e.target.closest('button')) return;
      e.preventDefault();
      window.__dockToggleInternet();
    });
  }
})();

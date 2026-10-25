/**
 * Icono de internet (el tercero de la franja): abre el navegador de la app.
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
    const api = bridge();
    if (!api || typeof api.openAppBrowser !== 'function') return;
    api.openAppBrowser().catch(() => {});
  });
})();

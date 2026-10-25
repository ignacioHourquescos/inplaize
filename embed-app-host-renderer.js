(function () {
  const titleEl = document.getElementById('embed-title');
  const statusEl = document.getElementById('embed-status');
  const maxBtn = document.getElementById('embed-max');
  const api = window.embedAppHost;

  function applyStatus(payload) {
    if (!payload) return;
    if (titleEl && payload.title) titleEl.textContent = payload.title;
    if (!statusEl) return;
    const text = payload.text || '';
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', !!payload.error);
    statusEl.classList.toggle('is-hidden', !text);
  }

  document.getElementById('embed-min').addEventListener('click', () => api.action('minimize'));
  maxBtn.addEventListener('click', () => api.action('toggle-maximize'));
  document.getElementById('embed-close').addEventListener('click', () => api.action('close'));

  document.getElementById('embed-top').addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    api.action('toggle-maximize');
  });

  api.onStatus(applyStatus);
  api.onMaximized((maximized) => {
    maxBtn.textContent = maximized ? '\u2750' : '\u25a1';
    maxBtn.setAttribute('aria-label', maximized ? 'Restaurar' : 'Maximizar');
  });
})();

'use strict';

(function initStripSearchPopup() {
  const api = window.stripSearchPopup;
  const form = document.getElementById('panel');
  const input = document.getElementById('q');
  if (!api || !form || !input) return;

  function report() {
    const h = Math.ceil(form.getBoundingClientRect().height);
    api.reportHeight(h);
  }

  api.onData((data) => {
    const seed = data && typeof data.seed === 'string' ? data.seed : '';
    const ph = data && typeof data.placeholder === 'string' ? data.placeholder : '';
    if (ph) input.placeholder = ph;
    input.value = seed;
    report();
    requestAnimationFrame(() => {
      input.focus();
      try {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      } catch {
        /* ignore */
      }
      report();
    });
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    api.submit(input.value.trim());
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      api.cancel();
    }
  });

  api.ready();
})();

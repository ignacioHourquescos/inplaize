'use strict';

(function initProfileRailPopup() {
  const CHECK =
    '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  const menu = document.getElementById('menu');
  const api = window.profileRailPopup;
  if (!menu || !api) return;

  function paint(data) {
    const items = Array.isArray(data && data.items) ? data.items : [];
    menu.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item' + (item.active ? ' is-active' : '');
      btn.setAttribute('role', 'menuitem');

      const check = document.createElement('span');
      check.className = 'check';
      check.setAttribute('aria-hidden', 'true');
      if (item.shown) check.innerHTML = CHECK;

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      if (typeof item.icon === 'string' && item.icon.startsWith('data:image/')) {
        const img = document.createElement('img');
        img.src = item.icon;
        img.alt = '';
        avatar.appendChild(img);
      } else {
        avatar.textContent = String(item.label || '?').trim().charAt(0).toUpperCase() || '?';
      }

      const text = document.createElement('span');
      text.className = 'text';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.label || 'Perfil';
      text.appendChild(label);
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = item.detail;
        text.appendChild(detail);
      }

      btn.append(check, avatar, text);
      btn.addEventListener('click', () => api.choose(item.id));
      menu.appendChild(btn);
    }

    requestAnimationFrame(() => {
      const h = Math.ceil(menu.getBoundingClientRect().height);
      api.reportHeight(h);
    });
  }

  api.onData(paint);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') api.cancel();
  });
  api.ready();
})();

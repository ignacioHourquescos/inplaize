/**
 * En la franja se ven hasta tres perfiles. Los tres puntos listan todas las
 * sesiones con tilde al frente en las del riel. Tocá una tildada para sacarla
 * del listado horizontal; tocá una sin tilde para mostrarla y activarla.
 * En el dock el menú es HTML (la página se corre para no taparlo). En la
 * ventana web, que mide solo la franja, es el menú nativo: puede salir de la ventana.
 */
(function initProfileRailMenu(global) {
  const VISIBLE = 3;
  /** Tope del riel. Quien saca al principal al input pide 2 y se siguen viendo tres. */
  let railCap = VISIBLE;
  const DOTS =
    '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="5" r="1.7" fill="currentColor"/>' +
    '<circle cx="12" cy="12" r="1.7" fill="currentColor"/>' +
    '<circle cx="12" cy="19" r="1.7" fill="currentColor"/>' +
    '</svg>';
  const CHECK =
    '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  let openMenu = null;
  let onPointerDown = null;
  let onKey = null;
  let onResize = null;
  /** @type {string[] | null} keys del riel horizontal; null = default (primeras VISIBLE). */
  let railShownKeys = null;

  function itemKey(item) {
    return item && item.key != null && item.key !== '' ? String(item.key) : '';
  }

  function shownCap() {
    return railCap > 0 ? railCap : VISIBLE;
  }

  function defaultShownKeys(list) {
    const max = shownCap();
    const visible = list.slice(0, Math.min(max, list.length));
    const activeAt = list.findIndex((item) => item && item.active);
    if (activeAt >= max && list.length > max) visible[max - 1] = list[activeAt];
    return visible.map(itemKey).filter(Boolean);
  }

  function ensureShownKeys(list) {
    if (railShownKeys == null) railShownKeys = defaultShownKeys(list);
    const valid = new Set(list.map(itemKey).filter(Boolean));
    railShownKeys = railShownKeys.filter((k) => valid.has(k));
    return railShownKeys;
  }

  function pickVisible(items, editing, limit) {
    const list = Array.isArray(items) ? items.slice() : [];
    if (Number.isFinite(limit) && limit > 0) railCap = Math.floor(limit);
    const max = shownCap();
    if (editing) return { visible: list, overflow: [] };
    if (!list.length) return { visible: [], overflow: [] };

    if (railShownKeys == null && list.length <= max) {
      return { visible: list, overflow: [] };
    }

    const before = railShownKeys == null ? 0 : railShownKeys.length;
    const keys = ensureShownKeys(list);
    const dropped = before - keys.length;
    const want = new Set(keys);
    if (dropped > 0 && keys.length < max) {
      for (const item of list) {
        if (keys.length >= max) break;
        const key = itemKey(item);
        if (!key || want.has(key)) continue;
        keys.push(key);
        want.add(key);
      }
    }
    const visible = list.filter((item) => want.has(itemKey(item)));
    const shown = new Set(visible);
    return { visible, overflow: list.filter((item) => !shown.has(item)) };
  }

  function seedShownFromItems(items) {
    if (railShownKeys != null) return;
    railShownKeys = (Array.isArray(items) ? items : [])
      .filter((item) => item && item.shown)
      .map(itemKey)
      .filter(Boolean);
  }

  function hideFromRail(key, items) {
    const k = String(key || '');
    if (!k) return false;
    seedShownFromItems(items);
    if (railShownKeys == null) railShownKeys = [];
    if (!railShownKeys.includes(k)) return false;
    railShownKeys = railShownKeys.filter((x) => x !== k);
    return true;
  }

  function showInRail(key, items) {
    const k = String(key || '');
    if (!k) return false;
    seedShownFromItems(items);
    if (railShownKeys == null) railShownKeys = [];
    railShownKeys = railShownKeys.filter((x) => x !== k);
    railShownKeys.push(k);
    const max = shownCap();
    if (railShownKeys.length > max) {
      railShownKeys = railShownKeys.slice(railShownKeys.length - max);
    }
    return true;
  }

  function notifyRailChanged() {
    if (typeof global.__dockRefreshProfileRail === 'function') {
      global.__dockRefreshProfileRail();
      return;
    }
    if (typeof global.UsualDeskShellNavProfiles?.render === 'function') {
      /* el shell re-renderiza con el próximo estado; forzamos con el bridge si hay */
    }
  }

  /** Todas las sesiones del riel, con `shown` en las que caben en la franja. */
  function menuItems(split) {
    if (!split || !Array.isArray(split.visible)) return [];
    const shown = new Set(split.visible);
    const all = [...split.visible, ...(Array.isArray(split.overflow) ? split.overflow : [])];
    return all.map((item) => ({ ...item, shown: shown.has(item) }));
  }

  function popupApi() {
    const candidates = [global.usualDesk, global.usualDeskShell, global.usualDeskDetached];
    return candidates.find((api) => api && typeof api.popupProfileRail === 'function') || null;
  }

  function unbind() {
    if (onPointerDown) document.removeEventListener('pointerdown', onPointerDown, true);
    if (onKey) document.removeEventListener('keydown', onKey);
    if (onResize) window.removeEventListener('resize', onResize);
    onPointerDown = null;
    onKey = null;
    onResize = null;
  }

  function close() {
    if (!openMenu) return;
    openMenu.anchor.setAttribute('aria-expanded', 'false');
    openMenu.anchor.classList.remove('is-open');
    openMenu.menu.remove();
    openMenu = null;
    unbind();
  }

  /**
   * Columna de la línea violeta / dirección: el menú baja desde la franja de
   * arriba y no se pasa de ese borde (la “línea roja” del mock).
   */
  /**
   * Misma caja en perfiles y en accesos: pegada a la izquierda (logo) hasta
   * la línea violeta que separa el riel de los accesos.
   */
  function columnBox(anchor) {
    const chrome =
      document.getElementById('sidebar-chrome') || document.querySelector('.shell-top');
    const home =
      document.getElementById('dock-home-btn') || document.getElementById('shell-home-btn');
    const leading = document.querySelector('.strip-leading');
    const divider = document.querySelector('.strip-rail-divider');
    const anchorRect = anchor.getBoundingClientRect();

    let left = 0;
    if (home) left = home.getBoundingClientRect().left;
    else if (chrome) left = chrome.getBoundingClientRect().left;
    else if (leading) left = leading.getBoundingClientRect().left;
    else left = anchorRect.left;

    let right;
    if (divider) {
      const d = divider.getBoundingClientRect();
      right = d.left > left ? d.left : left + 280;
    } else if (leading) {
      right = leading.getBoundingClientRect().right;
    } else {
      right = left + 280;
    }

    let top;
    if (chrome) top = chrome.getBoundingClientRect().bottom;
    else if (leading) top = leading.getBoundingClientRect().bottom;
    else top = anchorRect.bottom;

    const width = Math.max(160, Math.round(right - left));
    return {
      left: Math.max(0, Math.round(left)),
      top: Math.round(top),
      width,
    };
  }

  function position(anchor, menu) {
    const box = columnBox(anchor);
    menu.style.left = `${box.left}px`;
    menu.style.top = `${box.top}px`;
    menu.style.width = `${box.width}px`;
    menu.style.maxWidth = `${box.width}px`;
    menu.style.minWidth = `${box.width}px`;
  }

  function buildMenu(items) {
    const menu = document.createElement('div');
    menu.className = 'profile-rail-menu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'profile-rail-menu-item';
      btn.setAttribute('role', 'menuitem');
      if (item.active) btn.classList.add('is-active');
      if (item.shown) btn.classList.add('is-shown');
      const avatar = document.createElement('span');
      avatar.className = 'profile-rail-menu-avatar';
      try {
        const node = item.renderAvatar?.();
        if (node) avatar.appendChild(node);
      } catch {
        /* sin dibujo: queda el nombre */
      }
      const text = document.createElement('span');
      text.className = 'profile-rail-menu-text';
      const label = document.createElement('span');
      label.className = 'profile-rail-menu-label';
      label.textContent = item.label || 'Perfil';
      text.appendChild(label);
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'profile-rail-menu-detail';
        detail.textContent = item.detail;
        text.appendChild(detail);
      }
      const check = document.createElement('span');
      check.className = 'profile-rail-menu-check';
      check.setAttribute('aria-hidden', 'true');
      if (item.shown) check.innerHTML = CHECK;
      btn.append(check, avatar, text);
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const key = itemKey(item);
        if (item.shown) {
          // Tilde de nuevo: se va del riel horizontal.
          close();
          if (key) hideFromRail(key, items);
          notifyRailChanged();
          return;
        }
        close();
        if (key) showInRail(key, items);
        item.onSelect?.();
        notifyRailChanged();
      });
      menu.appendChild(btn);
    }
    return menu;
  }

  function openDom(anchor, items) {
    const menu = buildMenu(items);
    menu.classList.add('is-entering');
    document.body.appendChild(menu);
    openMenu = { menu, anchor };
    anchor.setAttribute('aria-expanded', 'true');
    anchor.classList.add('is-open');
    position(anchor, menu);
    onPointerDown = (ev) => {
      if (!openMenu) return;
      const target = ev.target;
      if (target instanceof Node && (openMenu.menu.contains(target) || openMenu.anchor.contains(target))) return;
      close();
    };
    onKey = (ev) => {
      if (ev.key === 'Escape') close();
    };
    onResize = () => {
      if (!openMenu) return;
      position(openMenu.anchor, openMenu.menu);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    const finishEnter = () => {
      menu.classList.remove('is-entering');
      menu.removeEventListener('animationend', finishEnter);
    };
    menu.addEventListener('animationend', finishEnter);
    requestAnimationFrame(() => {
      if (!openMenu || openMenu.menu !== menu) return;
      position(anchor, menu);
    });
  }

  function applyChoice(items, id) {
    if (id == null || id === '') return;
    const item = items[Number(id)];
    if (!item) return;
    const key = itemKey(item);
    if (item.shown) {
      if (key) hideFromRail(key, items);
      notifyRailChanged();
      return;
    }
    if (key) showInRail(key, items);
    item.onSelect?.();
    notifyRailChanged();
  }

  /**
   * Popup hijo sobre el BrowserView (WhatsApp, dock, etc.): mismo slide-in
   * y ancho de columna, sin empujar la página.
   */
  function openOverlay(api, anchor, items) {
    // Por si quedó un inset viejo del menú HTML que empujaba la vista.
    if (typeof global.__dockSetProfileMenuInset === 'function') global.__dockSetProfileMenuInset(0);
    anchor.setAttribute('aria-expanded', 'true');
    anchor.classList.add('is-open');
    const box = columnBox(anchor);
    const payload = {
      x: box.left,
      y: box.top,
      width: box.width,
      items: items.map((item, index) => ({
        id: index,
        label: item.label || 'Perfil',
        detail: item.detail || '',
        icon: typeof item.icon === 'string' ? item.icon : '',
        shown: !!item.shown,
        active: !!item.active,
      })),
    };
    const done = () => {
      anchor.setAttribute('aria-expanded', 'false');
      anchor.classList.remove('is-open');
    };
    api
      .popupProfileRail(payload)
      .then((id) => {
        done();
        applyChoice(items, id);
      })
      .catch(done);
  }

  function toggle(anchor, items) {
    if (!anchor || !items || !items.length) return;
    if (openMenu && openMenu.anchor === anchor) {
      close();
      return;
    }
    close();
    // Sobre BrowserView (WhatsApp / dock navegando) el HTML del strip no tapa
    // la página: usamos popup overlay. Sin API, caemos al menú DOM local.
    const api = popupApi();
    if (api) {
      openOverlay(api, anchor, items);
      return;
    }
    openDom(anchor, items);
  }

  function mountMore(parent, items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'loose-nav-accounts-more';
    btn.setAttribute('aria-label', 'Más perfiles');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('data-tooltip', 'Más perfiles');
    btn.setAttribute('data-tooltip-placement', 'bottom');
    btn.innerHTML = DOTS;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggle(btn, items);
    });
    parent.appendChild(btn);
    return btn;
  }

  global.UsualDeskProfileRail = {
    VISIBLE,
    pickVisible,
    menuItems,
    mountMore,
    close,
    toggle,
    hideFromRail,
    showInRail,
    columnBox,
  };
})(window);

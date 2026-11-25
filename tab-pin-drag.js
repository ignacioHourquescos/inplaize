/**
 * Arrastrar una pestaña hacia arriba y soltarla en la franja de accesos
 * crea el acceso directo en ese lugar.
 */
(function () {
  const DRAG_PX = 8;
  let popId = '';

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function armPop(id) {
    popId = id ? String(id) : '';
  }

  function consumePop(root) {
    if (!popId || !root) return;
    const el = root.querySelector(`[data-shortcut-id="${cssEscape(popId)}"]`);
    if (!el) return;
    popId = '';
    el.classList.add('is-just-pinned');
    const done = () => el.classList.remove('is-just-pinned');
    el.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400);
  }

  function shortcutNodes(strip) {
    return [...strip.querySelectorAll('[data-shortcut-id]')];
  }

  function clearMarks(strip) {
    if (!strip) return;
    strip.classList.remove('is-tab-drop', 'is-tab-insert-end');
    strip.querySelectorAll('.is-tab-insert-before, .is-tab-stack').forEach((el) => {
      el.classList.remove('is-tab-insert-before', 'is-tab-stack');
    });
  }

  function stackTarget(strip, x, y) {
    for (const el of shortcutNodes(strip)) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      const insetX = rect.width * 0.2;
      const insetY = rect.height * 0.2;
      if (
        x >= rect.left + insetX && x <= rect.right - insetX
        && y >= rect.top + insetY && y <= rect.bottom - insetY
      ) {
        return el;
      }
    }
    return null;
  }

  function indexAt(strip, x) {
    const items = shortcutNodes(strip);
    for (let i = 0; i < items.length; i += 1) {
      const rect = items[i].getBoundingClientRect();
      if (x < rect.left + rect.width / 2) return i;
    }
    return items.length;
  }

  function pointIn(el, x, y) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function markInsert(strip, index) {
    clearMarks(strip);
    strip.classList.add('is-tab-drop');
    const items = shortcutNodes(strip);
    if (index >= items.length) {
      strip.classList.add('is-tab-insert-end');
      return;
    }
    const el = items[index];
    const cell = el.closest('.shell-shortcut-cell');
    (cell || el).classList.add('is-tab-insert-before');
  }

  function ghostFrom(tab, page) {
    const ghost = document.createElement('div');
    ghost.className = 'tab-pin-ghost';
    const img = tab.querySelector('img');
    if (img && img.src) {
      const icon = document.createElement('img');
      icon.src = img.src;
      icon.alt = '';
      ghost.appendChild(icon);
    } else {
      const letter = document.createElement('span');
      letter.className = 'tab-pin-ghost-letter';
      const seed = page.title || page.url || '?';
      letter.textContent = seed.trim().charAt(0).toUpperCase() || '?';
      ghost.appendChild(letter);
    }
    const title = document.createElement('span');
    title.className = 'tab-pin-ghost-title';
    title.textContent = page.title || page.url;
    ghost.appendChild(title);
    document.body.appendChild(ghost);
    return ghost;
  }

  function placeGhost(ghost, x, y) {
    ghost.style.left = `${x + 14}px`;
    ghost.style.top = `${y - 16}px`;
  }

  function bind(opts) {
    const root = opts && opts.root;
    if (!root || root.dataset.tabPinBound === '1') return;
    root.dataset.tabPinBound = '1';
    let drag = null;

    function endListeners() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    }

  function swallowNextClick() {
    const swallow = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener('click', swallow, true);
    };
    document.addEventListener('click', swallow, true);
    setTimeout(() => document.removeEventListener('click', swallow, true), 400);
  }

    function notify(name) {
      const fn = opts && opts[name];
      if (typeof fn !== 'function') return;
      try {
        fn();
      } catch {
        /* el gesto sigue aunque el dock no pueda soltar el mouse */
      }
    }

    function finish(commit) {
    if (!drag) return;
    const current = drag;
    drag = null;
    endListeners();
    notify('onEnd');
    document.documentElement.classList.remove('is-tab-pin-drag', 'is-tab-pin-armed');
    current.tab.classList.remove('is-pin-source');
    if (current.active) swallowNextClick();
    const strip = typeof opts.strip === 'function' ? opts.strip() : null;
    clearMarks(strip);
    if (current.ghost) current.ghost.remove();
      try {
        if (current.tab.hasPointerCapture(current.pointerId)) {
          current.tab.releasePointerCapture(current.pointerId);
        }
      } catch {
        /* el nodo de la pestaña pudo re-renderizarse */
      }
      if (!commit || !current.active || !current.over || !strip) return;
      const page = current.page;
      const index = current.index;
      const ontoId = current.ontoId || '';
      if (!page || typeof opts.onPin !== 'function') return;
      Promise.resolve(opts.onPin(page, index, ontoId))
        .then((result) => {
          const id = result && result.id ? String(result.id) : '';
          if (!id || !(result.ok || result.reason === 'exists')) return;
          armPop(id);
          const host = typeof opts.strip === 'function' ? opts.strip() : null;
          consumePop(host);
        })
        .catch(() => {});
    }

    function onMove(ev) {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        if (dx * dx + dy * dy < DRAG_PX * DRAG_PX) return;
        drag.active = true;
        drag.tab.__suppressPinClick = true;
        drag.tab.classList.add('is-pin-source');
        document.documentElement.classList.add('is-tab-pin-drag');
        drag.ghost = ghostFrom(drag.tab, drag.page);
        try {
          drag.tab.setPointerCapture(drag.pointerId);
        } catch {
          /* sin captura igual seguimos con los listeners de window */
        }
      }
      if (ev.cancelable) ev.preventDefault();
      placeGhost(drag.ghost, ev.clientX, ev.clientY);
      const strip = typeof opts.strip === 'function' ? opts.strip() : null;
      const over = pointIn(strip, ev.clientX, ev.clientY);
      drag.over = over;
      if (!strip || !over) {
        clearMarks(strip);
        drag.index = 0;
        drag.ontoId = '';
        return;
      }
      const stackEl = stackTarget(strip, ev.clientX, ev.clientY);
      if (stackEl && stackEl.dataset.shortcutId) {
        drag.ontoId = stackEl.dataset.shortcutId;
        drag.index = indexAt(strip, ev.clientX);
        clearMarks(strip);
        strip.classList.add('is-tab-drop');
        const cell = stackEl.closest('.shell-shortcut-cell');
        (cell || stackEl).classList.add('is-tab-stack');
        return;
      }
      drag.ontoId = '';
      drag.index = indexAt(strip, ev.clientX);
      markInsert(strip, drag.index);
    }

    function onUp(ev) {
      if (!drag || (ev && ev.pointerId != null && ev.pointerId !== drag.pointerId)) return;
      finish(true);
    }

    function onKey(ev) {
      if (!drag || ev.key !== 'Escape') return;
      ev.preventDefault();
      if (drag.active) drag.tab.__suppressPinClick = true;
      finish(false);
    }

    function onBlur() {
      if (!drag) return;
      if (drag.active) drag.tab.__suppressPinClick = true;
      finish(false);
    }

    root.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || drag) return;
      const tab = ev.target instanceof Element ? ev.target.closest(opts.tabSelector) : null;
      if (!tab || !root.contains(tab)) return;
      if (opts.ignoreSelector && ev.target.closest(opts.ignoreSelector)) return;
      const page = typeof opts.pageFromTab === 'function' ? opts.pageFromTab(tab) : null;
      if (!page || !page.url) return;
      drag = {
        tab,
        page,
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        active: false,
        over: false,
        index: 0,
        ontoId: '',
        ghost: null,
      };
      /* Antes de entrar a la franja: si sigue en drag, Electron se lleva el puntero. */
      document.documentElement.classList.add('is-tab-pin-armed');
      notify('onArm');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('keydown', onKey);
      window.addEventListener('blur', onBlur);
    });

    root.addEventListener('click', (ev) => {
      const tab = ev.target instanceof Element ? ev.target.closest(opts.tabSelector) : null;
      if (!tab || !tab.__suppressPinClick) return;
      tab.__suppressPinClick = false;
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
  }

  window.UsualDeskTabPinDrag = {
    bind,
    armPop,
    consumePop,
  };
})();

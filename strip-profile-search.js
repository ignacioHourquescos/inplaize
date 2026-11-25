/**
 * Lupa del perfil principal en la franja.
 * Cerrada es el icono. Al apretarla se abre un input al lado, en la misma fila.
 * Otra vez, clic afuera o Escape lo cierra. Enter busca en ese perfil y esconde el recuadro.
 * El texto no vive en el riel: el riel se redibuja en cada estado.
 */
(function initStripProfileSearch(global) {
  let avatarKey = '';
  let boundPartition = '';
  let boundLabel = '';
  let committing = false;
  /** Tras mandar la búsqueda, un clic sintético no puede volver a abrir el campo. */
  let blockOpenUntil = 0;

  function formEl() {
    return document.getElementById('strip-profile-search');
  }

  function inputEl(form) {
    return form.querySelector('.strip-profile-search-input');
  }

  function lupaEl(form) {
    return form.querySelector('.strip-profile-search-lupa');
  }

  function setOpen(open) {
    const form = formEl();
    if (!form) return;
    const on = open === true && Date.now() >= blockOpenUntil;
    form.classList.toggle('is-open', on);
    const lupa = lupaEl(form);
    if (lupa) {
      const label = on ? 'Cerrar búsqueda' : 'Buscar con el perfil principal';
      lupa.setAttribute('aria-expanded', on ? 'true' : 'false');
      lupa.setAttribute('aria-label', label);
      lupa.dataset.tooltip = label;
    }
    const input = inputEl(form);
    if (!input) return;
    input.tabIndex = on ? 0 : -1;
    if (on) {
      requestAnimationFrame(() => {
        if (!form.classList.contains('is-open')) return;
        input.focus();
      });
      return;
    }
    input.value = '';
    if (document.activeElement === input) input.blur();
  }

  function toggleInline(form) {
    blockOpenUntil = 0;
    delete form.dataset.collapseOnNav;
    setOpen(!form.classList.contains('is-open'));
  }

  /** Enter ya buscó: el recuadro y el texto no se quedan. */
  function commitSearch(form) {
    if (committing) return;
    committing = true;
    try {
      const input = inputEl(form);
      const value = input ? String(input.value || '').trim() : '';
      if (input) input.value = '';
      if (!value) {
        setOpen(false);
        return;
      }
      blockOpenUntil = Date.now() + 450;
      form.dataset.collapseOnNav = '1';
      delete document.documentElement.dataset.profileLupa;
      setOpen(false);
      const submit = form.__stripProfileSubmit;
      if (typeof submit === 'function') submit(value);
      setOpen(false);
      queueMicrotask(() => setOpen(false));
    } finally {
      committing = false;
    }
  }

  function bind(form) {
    if (form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    const input = inputEl(form);
    const lupa = lupaEl(form);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      commitSearch(form);
    });
    if (lupa) {
      const toggle = () => toggleInline(form);
      lupa.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        lupa.dataset.arm = '1';
        toggle();
      });
      lupa.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (lupa.dataset.arm === '1') {
          delete lupa.dataset.arm;
          return;
        }
        // Enter en el input a veces dispara click en la lupa y la reabría.
        if (Date.now() < blockOpenUntil) return;
        toggle();
      });
    }
    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          input.value = '';
          blockOpenUntil = 0;
          delete form.dataset.collapseOnNav;
          setOpen(false);
          return;
        }
        if (ev.key !== 'Enter' || ev.isComposing) return;
        ev.preventDefault();
        ev.stopPropagation();
        commitSearch(form);
      });
    }
    if (form.dataset.outside !== '1') {
      form.dataset.outside = '1';
      document.addEventListener('pointerdown', (ev) => {
        const current = formEl();
        if (!current || !current.classList.contains('is-open')) return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (target && current.contains(target)) return;
        setOpen(false);
      });
    }
  }

  /**
   * @param {{
   *   profile?: { key?: string, partition?: string, active?: boolean, label?: string, icon?: string } | null,
   *   mountAvatar?: (() => Node) | null,
   *   onSubmit?: ((value: string) => void) | null,
   *   editing?: boolean,
   * }} [opts]
   */
  function sync(opts) {
    const form = formEl();
    if (!form) return;
    bind(form);
    if (form.dataset.collapseOnNav === '1') {
      setOpen(false);
      delete form.dataset.collapseOnNav;
    }
    const editing = !!(opts && opts.editing);
    const profile = !editing && opts && opts.profile ? opts.profile : null;
    form.__stripProfileSubmit = profile && typeof opts.onSubmit === 'function' ? opts.onSubmit : null;
    boundPartition = profile && typeof profile.partition === 'string' ? profile.partition : '';
    boundLabel = profile && profile.label ? String(profile.label) : '';
    if (!profile) {
      const wasOpen = form.classList.contains('is-open');
      form.hidden = true;
      avatarKey = '';
      const slot = form.querySelector('.strip-profile-search-avatar');
      if (slot) slot.replaceChildren();
      if (wasOpen) setOpen(false);
      return;
    }
    form.hidden = false;
    const nextKey = [
      profile.key || '',
      profile.active ? '1' : '0',
      profile.label || '',
      profile.icon || '',
    ].join('\n');
    if (nextKey === avatarKey) return;
    avatarKey = nextKey;
    const slot = form.querySelector('.strip-profile-search-avatar');
    if (!slot) return;
    slot.replaceChildren();
    const node = typeof opts.mountAvatar === 'function' ? opts.mountAvatar() : null;
    if (node) slot.appendChild(node);
  }

  global.UsualDeskStripProfileSearch = {
    sync,
    setOpen,
    isOpen: () => {
      const form = formEl();
      return !!(form && form.classList.contains('is-open'));
    },
    partition: () => boundPartition,
    label: () => boundLabel,
  };
})(window);

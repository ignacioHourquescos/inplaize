'use strict';

/**
 * Drawer de opciones compartido entre el dock y las ventanas web (shell / detached).
 * @param {object} api
 * @param {() => void | Promise<void>} [api.openAddShortcut]
 * @param {() => void | Promise<void>} [api.enterShortcutsEditMode]
 * @param {() => void | Promise<void>} [api.exitShortcutsEditMode]
 * @param {() => void | Promise<void>} [api.openSettings]
 * @param {() => void | Promise<void>} [api.openAppearance]
 * @param {() => void | Promise<void>} [api.hidePanel]
 * @param {() => void | Promise<void>} [api.quitApp]
 * @param {(cb: (on: boolean) => void) => void} [api.onShortcutsEditModeSync]
 */
function paintAppVersion() {
  const el = document.getElementById('dock-app-version');
  if (!el) return;
  const api = window.usualDesk || window.usualDeskShell || window.usualDeskDetached;
  if (!api || typeof api.getAppVersion !== 'function') return;
  api
    .getAppVersion()
    .then((info) => {
      const version = info && info.version ? String(info.version) : '';
      if (!version) return;
      el.textContent = `v${version}`;
      const label = info.display ? `Versión ${info.display}` : `Versión ${version}`;
      el.title = label;
      el.setAttribute('aria-label', label);
      el.hidden = false;
    })
    .catch((err) => {
      console.error('get-app-version', err);
    });
}

function initShellHomeMenu(api) {
  paintAppVersion();
  const menuBtn = document.getElementById('dock-home-menu-btn');
  const menu = document.getElementById('dock-home-menu');
  const backdrop = document.getElementById('dock-home-menu-backdrop');
  const editToggle = document.getElementById('shortcuts-edit-toggle');
  if (!menuBtn || !menu || !backdrop || !api) return;

  function setOpen(open, opts) {
    const isOpen = open === true;
    const silent = !!(opts && opts.silent);
    if (menu.classList.contains('is-open') === isOpen) return;
    menu.classList.toggle('is-open', isOpen);
    backdrop.classList.toggle('is-open', isOpen);
    menuBtn.classList.toggle('is-open', isOpen);
    document.documentElement.setAttribute('data-home-menu-open', isOpen ? 'on' : 'off');
    menuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    menu.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    backdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (!silent && typeof api.onDrawerOpenChange === 'function') {
      const editOn = !!(
        editToggle
        && (editToggle.classList.contains('is-on') || editToggle.getAttribute('aria-checked') === 'true')
      );
      api.onDrawerOpenChange(isOpen, editOn);
    }
  }

  window.__dockHomeMenu = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    setOpen,
    isOpen: () => menu.classList.contains('is-open'),
  };

  const menuBridge = window.usualDeskShell || window.usualDeskDetached || window.usualDesk;
  if (menuBridge && typeof menuBridge.onMenuOverlayApply === 'function' && !menu.dataset.overlayApply) {
    menu.dataset.overlayApply = '1';
    menuBridge.onMenuOverlayApply((open) => setOpen(open === true, { silent: true }));
  }

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains('is-open'));
  });

  backdrop.addEventListener('click', () => {
    if (document.documentElement.classList.contains('shell-menu-host')) return;
    setOpen(false);
  });

  const menuCloseBtn = document.getElementById('dock-home-menu-close');
  menuCloseBtn?.addEventListener('click', () => setOpen(false));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!menu.classList.contains('is-open')) return;
    setOpen(false);
    menuBtn.focus();
  });

  function bindItem(id, handler, keepOpen) {
    const el = document.getElementById(id);
    if (!el || typeof handler !== 'function') return;
    el.addEventListener('click', () => {
      if (!keepOpen) setOpen(false);
      handler();
    });
  }

  bindItem('dock-home-add-btn', () => api.openAddShortcut?.());
  bindItem('quit-app-btn', () => api.quitApp?.());
  bindItem('settings-btn', () => {
    if (typeof api.openAppearance === 'function') api.openAppearance();
    else api.openSettings?.();
  });
  bindItem('internal-btn', () => api.openSettings?.());

  if (editToggle) {
    editToggle.addEventListener('click', () => {
      const on = editToggle.classList.contains('is-on') || editToggle.getAttribute('aria-checked') === 'true';
      if (on) {
        setOpen(false);
        api.exitShortcutsEditMode?.();
      } else {
        api.enterShortcutsEditMode?.();
      }
    });
  }

  if (typeof api.onShortcutsEditModeSync === 'function') {
    api.onShortcutsEditModeSync((on) => {
      if (!editToggle) return;
      editToggle.classList.toggle('is-on', on === true);
      editToggle.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
}

const SHELL_HOME_MENU_DRAWER_HTML = `
<div id="dock-home-menu-backdrop" class="dock-home-menu-backdrop" aria-hidden="true"></div>
<aside id="dock-home-menu" class="dock-home-menu-drawer" aria-hidden="true" aria-label="Opciones">
  <div class="dock-home-menu-drawer-head">
    <span class="dock-home-menu-drawer-title">Menú</span>
    <button type="button" id="dock-home-menu-close" class="dock-home-menu-close" aria-label="Cerrar menú">
      <svg class="dock-home-menu-close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>
  </div>
  <nav id="dock-home-menu-main" class="dock-home-menu-drawer-body" role="menu" aria-label="Opciones">
    <button type="button" id="dock-home-add-btn" class="dock-home-menu-item" role="menuitem">
      <svg class="dock-home-menu-item-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="dock-home-menu-item-label">Añadir acceso</span>
    </button>
    <button type="button" id="shortcuts-edit-toggle" class="dock-home-menu-item" role="menuitemcheckbox" aria-checked="false">
      <svg class="dock-home-menu-item-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <line x1="4" y1="7" x2="20" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <circle cx="15" cy="7" r="2.25" fill="currentColor"/>
        <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <circle cx="9" cy="12" r="2.25" fill="currentColor"/>
        <line x1="4" y1="17" x2="20" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <circle cx="14" cy="17" r="2.25" fill="currentColor"/>
      </svg>
      <span class="dock-home-menu-item-label">Modo edición</span>
    </button>
    <button type="button" id="settings-btn" class="dock-home-menu-item" role="menuitem">
      <svg class="dock-home-menu-item-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.85"/>
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.3 4.3l1.8 1.8M17.9 17.9l1.8 1.8M19.7 4.3l-1.8 1.8M6.1 17.9l-1.8 1.8" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/>
      </svg>
      <span class="dock-home-menu-item-label">Configuración</span>
    </button>
    <button type="button" id="internal-btn" class="dock-home-menu-item" role="menuitem">
      <svg class="dock-home-menu-item-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 3h6M10 3v6L6.2 16.8A3.1 3.1 0 0 0 9 21h6a3.1 3.1 0 0 0 2.8-4.2L14 9V3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8.5 14h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <span class="dock-home-menu-item-label">Internal</span>
    </button>
    <div class="dock-home-menu-sep" role="separator" aria-hidden="true"></div>
    <button type="button" id="quit-app-btn" class="dock-home-menu-item dock-home-menu-item-danger" role="menuitem">
      <svg class="dock-home-menu-item-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 4v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M7.5 6.5a7 7 0 1 0 9 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="dock-home-menu-item-label">Cerrar aplicación</span>
    </button>
  </nav>
</aside>`;

const SHELL_HOME_MENU_BTN_HTML = `
<div id="header-actions" class="dock-chrome-menu-wrap" aria-label="Menú de opciones">
  <span id="dock-app-version" class="dock-app-version" hidden></span>
  <button
    type="button"
    id="dock-home-menu-btn"
    class="dock-home-menu-btn"
    data-tooltip="Menú de opciones"
    data-tooltip-placement="bottom"
    aria-label="Menú de opciones"
    aria-haspopup="menu"
    aria-expanded="false"
    aria-controls="dock-home-menu"
  >
    <svg class="dock-home-menu-btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="4" y1="17" x2="20" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  </button>
</div>`;

/** Monta burger + drawer en ventanas web si aún no existen. */
function mountShellHomeMenuChrome() {
  document.documentElement.classList.add('shell-menu-host');
  if (!document.getElementById('dock-home-menu')) {
    document.body.insertAdjacentHTML('beforeend', SHELL_HOME_MENU_DRAWER_HTML);
  }
  const header = document.querySelector('.shell-top');
  if (!header || document.getElementById('dock-home-menu-btn')) return;
  const winBtns = header.querySelector('.shell-win-btns');
  if (winBtns) {
    winBtns.insertAdjacentHTML('afterend', SHELL_HOME_MENU_BTN_HTML);
    winBtns.remove();
  }
}

if (typeof window !== 'undefined') {
  window.UsualDeskShellHomeMenu = {
    init: initShellHomeMenu,
    mountChrome: mountShellHomeMenuChrome,
    drawerHtml: SHELL_HOME_MENU_DRAWER_HTML,
  };
}

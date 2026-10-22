'use strict';

/**
 * Drawer de opciones compartido entre el dock y las ventanas web (shell / detached).
 * @param {object} api
 * @param {() => void | Promise<void>} [api.openAddShortcut]
 * @param {() => void | Promise<void>} [api.enterShortcutsEditMode]
 * @param {() => void | Promise<void>} [api.exitShortcutsEditMode]
 * @param {() => void | Promise<void>} [api.openSettings]
 * @param {() => void | Promise<void>} [api.hidePanel]
 * @param {() => void | Promise<void>} [api.quitApp]
 * @param {(cb: (on: boolean) => void) => void} [api.onShortcutsEditModeSync]
 */
function escapeMenuText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const VERSION_HISTORY_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function formatVersionHistoryDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!match) return '';
  const month = VERSION_HISTORY_MONTHS[Number(match[2]) - 1];
  if (!month) return '';
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function versionHistoryHostApi() {
  return window.usualDesk || window.usualDeskShell || window.usualDeskDetached || null;
}

function setVersionHistoryVisible(show) {
  const open = show === true;
  const main = document.getElementById('dock-home-menu-main');
  const panel = document.getElementById('dock-version-history');
  const title = document.querySelector('#dock-home-menu .dock-home-menu-drawer-title');
  const back = document.getElementById('dock-version-history-back');
  if (main) main.hidden = open;
  if (panel) panel.hidden = !open;
  if (title) title.textContent = open ? 'Versiones' : 'Menú';
  if (back) back.hidden = !open;
}

function renderVersionHistoryList(list, entries, currentVersion) {
  const items = Array.isArray(entries) ? entries : [];
  if (!items.length) {
    list.innerHTML = '<p class="dock-version-history-status">Todavía no hay versiones para mostrar.</p>';
    return;
  }
  const current = currentVersion ? String(currentVersion) : '';
  list.innerHTML = items
    .map((entry) => {
      const version = entry && entry.version ? String(entry.version) : '';
      if (!version) return '';
      const date = formatVersionHistoryDate(entry.date);
      const notes = Array.isArray(entry.notes) ? entry.notes.map((note) => String(note).trim()).filter(Boolean) : [];
      const isCurrent = current !== '' && version === current;
      const notesHtml = notes.length
        ? `<ul class="dock-version-entry-notes">${notes.map((note) => `<li>${escapeMenuText(note)}</li>`).join('')}</ul>`
        : '';
      const dateHtml = date ? `<time class="dock-version-entry-date" datetime="${escapeMenuText(entry.date)}">${escapeMenuText(date)}</time>` : '';
      const currentHtml = isCurrent ? '<span class="dock-version-entry-current">actual</span>' : '';
      return `<article class="dock-version-entry${isCurrent ? ' is-current' : ''}">
        <div class="dock-version-entry-meta">
          <span class="dock-version-entry-version">v${escapeMenuText(version)}${currentHtml}</span>
          ${dateHtml}
        </div>
        ${notesHtml}
      </article>`;
    })
    .join('');
}

let versionHistoryRequest = 0;

async function loadVersionHistoryList() {
  const list = document.getElementById('dock-version-history-list');
  if (!list) return;
  const requestId = ++versionHistoryRequest;
  list.innerHTML = '<p class="dock-version-history-status">Cargando…</p>';
  const api = versionHistoryHostApi();
  if (!api || typeof api.getVersionHistory !== 'function') {
    list.innerHTML = '<p class="dock-version-history-status">No se pudo cargar el historial.</p>';
    return;
  }
  try {
    const historyPromise = api.getVersionHistory();
    const versionPromise = typeof api.getAppVersion === 'function' ? api.getAppVersion().catch(() => null) : null;
    const [entries, info] = await Promise.all([historyPromise, versionPromise]);
    if (requestId !== versionHistoryRequest) return;
    renderVersionHistoryList(list, entries, info && info.version);
  } catch (err) {
    console.error('get-version-history', err);
    if (requestId !== versionHistoryRequest) return;
    list.innerHTML = '<p class="dock-version-history-status">No se pudo cargar el historial.</p>';
  }
}

function openVersionHistory() {
  setVersionHistoryVisible(true);
  const list = document.getElementById('dock-version-history-list');
  if (list) list.scrollTop = 0;
  const back = document.getElementById('dock-version-history-back');
  back?.focus();
  loadVersionHistoryList();
}

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

  function setOpen(open) {
    const isOpen = open === true;
    if (isOpen) setVersionHistoryVisible(false);
    menu.classList.toggle('is-open', isOpen);
    backdrop.classList.toggle('is-open', isOpen);
    menuBtn.classList.toggle('is-open', isOpen);
    menuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    menu.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    backdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (typeof api.onDrawerOpenChange === 'function') {
      api.onDrawerOpenChange(isOpen);
    }
  }

  window.__dockHomeMenu = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => menu.classList.contains('is-open'),
  };

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
    if (e.key !== 'Escape' || !menu.classList.contains('is-open')) return;
    const history = document.getElementById('dock-version-history');
    if (history && !history.hidden) {
      setVersionHistoryVisible(false);
      menuBtn.focus();
      return;
    }
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
  bindItem('settings-btn', () => api.openSettings?.());
  bindItem('dock-version-history-btn', () => openVersionHistory(), true);
  bindItem('quit-app-btn', () => api.quitApp?.());

  document.getElementById('dock-version-history-back')?.addEventListener('click', () => {
    setVersionHistoryVisible(false);
  });

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
    <button type="button" id="dock-version-history-back" class="dock-home-menu-back" hidden aria-label="Volver al menú">
      <svg class="dock-home-menu-close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M14.5 6.5L8.5 12l6 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
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
    <button type="button" id="dock-version-history-btn" class="dock-home-menu-item" role="menuitem">
      <svg class="dock-home-menu-item-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.85"/>
        <path d="M12 8v4.5l2.5 1.5" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="dock-home-menu-item-label">Historial de versiones</span>
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
  <div id="dock-version-history" class="dock-version-history" hidden>
    <div id="dock-version-history-list" class="dock-version-history-list" role="list" aria-label="Historial de versiones"></div>
  </div>
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
  };
}

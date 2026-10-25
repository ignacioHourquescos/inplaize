'use strict';

const bridge = window.menuOverlay;
const menuApi = window.UsualDeskShellHomeMenu;

const hiddenBtn = document.createElement('button');
hiddenBtn.type = 'button';
hiddenBtn.id = 'dock-home-menu-btn';
hiddenBtn.hidden = true;
hiddenBtn.tabIndex = -1;
document.body.appendChild(hiddenBtn);
document.body.insertAdjacentHTML('beforeend', menuApi.drawerHtml);

function applyEdit(on) {
  const el = document.getElementById('shortcuts-edit-toggle');
  if (!el) return;
  el.classList.toggle('is-on', on === true);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function applyState(state) {
  if (!state || !window.__dockHomeMenu) return;
  window.__dockHomeMenu.setOpen(state.open === true, { silent: true });
  if (Object.prototype.hasOwnProperty.call(state, 'editMode')) applyEdit(state.editMode === true);
}

menuApi.init({
  openAddShortcut: () => bridge.openAddShortcut(),
  enterShortcutsEditMode: () => bridge.enterShortcutsEditMode(),
  exitShortcutsEditMode: () => bridge.exitShortcutsEditMode(),
  openAppearance: () => bridge.openAppearance(),
  openSettings: () => bridge.openSettings(),
  quitApp: () => bridge.quitApp(),
  onShortcutsEditModeSync: (cb) => bridge.onShortcutsEditModeSync(cb),
  onDrawerOpenChange: (open) => bridge.reportOpen(open === true),
});

bridge.onState(applyState);
bridge.ready().then(applyState).catch(() => {});

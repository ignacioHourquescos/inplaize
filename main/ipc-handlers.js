'use strict';



const fs = require('fs');
const path = require('path');
const { ipcMain, BrowserWindow, dialog, app, shell } = require('electron');

const {

  loadShortcuts,

  saveShortcuts,

  broadcastShortcutsChanged,

  pushUndoBeforeChange,

} = require('./shortcuts-store');

const {
  loadStickyNotes,
  saveStickyNotes,
  broadcastStickyNotesChanged,
} = require('./sticky-notes-store');

const {
  loadTodos,
  saveTodos,
  broadcastTodosChanged,
} = require('./todos-store');

const { loadAppSettings, saveAppSettings } = require('./app-settings-store');
const { acceleratorFromHotkey } = require('./hotkey-accelerator');
const { reregisterDockGlobalShortcut } = require('./global-hotkey');

const { getAppVersionPayload } = require('./app-version');
const analytics = require('./analytics');
const { describeShortcut } = require('./usage-snapshot');

const {
  openShortcut,
  openPastedUrl,
  getOpenWebWindowKeys,
  setWebShortcutAudioMuted,
  setWebShortcutNotificationsMuted,
  focusWebWindowByMapKey,
  focusWebWindowFromNotification,
  refreshWebNotificationPatches,
  focusLastWebWindowFromHotkey,
  minimizeAllWebWindows,
  closeWebWindowByMapKey,
  markHomeAsLastFocusedSurface,
  lastFocusedSurfaceIsHome,
  pinWebSurface,
  focusedWebMapKey,
} = require('./open-shortcut');
const { webMapKey } = require('./web-map-key');
const focusMode = require('./focus-mode');
const { applyDockWindowBounds } = require('./window-bounds');
const { raiseAlwaysOnTopWindow, showAppMessageBox } = require('./window-focus');
const { registerShellIpc } = require('./web-shell');
const { registerDetachedFrameIpc } = require('./detached-web-frame');
const {
  registerLooseNavIpc,
  configureHooks: configureLooseNavHooks,
} = require('./loose-nav-window');
const browserImport = require('./browser-import');
const profileImport = require('./profile-import');
const historyStore = require('./history-store');
const bookmarksStore = require('./bookmarks-store');
const passwordsStore = require('./passwords-store');


/**

 * @param {{ mainWindow: BrowserWindow | null, isExpanded: boolean }} state

 */

const IPC_CHANNELS = [

  'collapse-sidebar',

  'expand-sidebar',

  'set-ignore-mouse',

  'get-shortcuts',

  'save-shortcuts',

  'pick-app-or-shortcut',

  'open-shortcut',

  'open-pasted-url',

  'url-prompt-open',

  'url-prompt-show',

  'app-browser-open',

  'close-app',

  'get-user-data-path',

  'get-app-version',

  'open-user-data-folder',

  'list-builtin-icons',

  'fetch-web-favicon',

  'get-app-settings',

  'set-app-settings',

  'get-open-web-window-keys',

  'set-web-shortcut-muted',

  'set-web-shortcut-notifications-muted',

  'save-web-notification-dump',

  'focus-web-window-by-map-key',

  'dismiss-dock-in-app-notification',

  'shell-get-chrome',

  'shell-activate-shortcut',

  'shell-close-tab',

  'shell-window-minimize',

  'shell-window-toggle-maximize',

  'shell-window-close',

  'shell-nav-back',

  'shell-nav-forward',

  'shell-nav-state',

  'shell-menu-drawer-state',

  'menu-overlay-ready',

  'menu-overlay-set-open',

  'menu-overlay-hide',

  'shell-request-shortcut-editor',

  'detached-request-shortcut-editor',

  'peek-suggested-shortcut-editor-target',

  'notify-shortcuts-edit-mode',

  'chrome-request-exit-shortcut-edit-mode',

  'chrome-open-add-shortcut',

  'chrome-open-appearance',

  'chrome-enter-shortcuts-edit-mode',

  'dock-window-minimize',

  'dock-window-toggle-maximize',

  'dock-open-welcome-home',

  'detached-frame-action',

  'loose-nav-open',

  'loose-nav-close',

  'loose-nav-select-tab',

  'loose-nav-close-tab',

  'loose-nav-new-tab',

  'loose-nav-navigate',

  'loose-nav-back',

  'loose-nav-forward',

  'loose-nav-reload',

  'loose-nav-open-external',

  'loose-nav-get-state',

  'loose-nav-set-viewport-bounds',

  'loose-nav-pick-profile',

  'loose-nav-use-account',

  'focus-mode-toggle-member',

  'focus-mode-exit',

  'focus-mode-get-state',

  'close-web-window-by-map-key',

  'browser-import-list-profiles',

  'browser-import-run',

  'history-suggest',

  'history-record',

  'history-list',

  'history-remove',

  'history-clear',

  'bookmarks-list',

  'bookmarks-add',

  'bookmarks-remove',

  'bookmarks-has',

  'passwords-for-host',

  'passwords-save',

  'passwords-list',

  'passwords-remove',

  'get-sticky-notes',

  'save-sticky-notes',

  'get-todos',

  'save-todos',

  'hold-dock-blur',

  'export-document-pdf',

  'gesture-coach-close',

  'set-onboarding-active',

  'set-onboarding-hotkey-trial',

  'onboarding-move-cursor',

  'consume-onboarding-launch',

  'downloads-get-history',

  'downloads-open-file',

  'downloads-mark-opened',

  'downloads-show-in-folder',

  'downloads-remove',

  'downloads-clear',

  'downloads-cancel',

  'downloads-save-image-edit',

  'magic-transform',

];



function trackCountChange(before, after, addedEvent, removedEvent) {
  if (after > before && addedEvent) analytics.track(addedEvent);
  else if (after < before && removedEvent) analytics.track(removedEvent);
}

/** Notas ya contadas como editadas en esta sesión: el renderer guarda en cada tecla. */
const editedNoteIds = new Set();

/**
 * Al arrugar, la nota pasa a `crumpled`; al restaurarla vuelve como nota nueva
 * (otro id), así que se empareja por cantidad y no por id.
 */
function trackStickyNoteChanges(before, after) {
  const beforeNotes = new Map(before.notes.map((n) => [n.id, n]));
  const afterNoteIds = new Set(after.notes.map((n) => n.id));
  const beforeCrumpledIds = new Set(before.crumpled.map((c) => c.id));
  const afterCrumpledIds = new Set(after.crumpled.map((c) => c.id));

  let restorable = before.crumpled.filter((c) => !afterCrumpledIds.has(c.id)).length;
  let crumpledNew = after.crumpled.filter((c) => !beforeCrumpledIds.has(c.id)).length;

  for (const note of after.notes) {
    const prev = beforeNotes.get(note.id);
    if (!prev) {
      if (restorable > 0) {
        restorable -= 1;
        analytics.track('sticky_note_restored');
      } else {
        analytics.track('sticky_note_created');
      }
    } else if (prev.text !== note.text && note.text.trim() && !editedNoteIds.has(note.id)) {
      editedNoteIds.add(note.id);
      analytics.track('sticky_note_edited');
    }
  }
  for (const note of before.notes) {
    if (afterNoteIds.has(note.id)) continue;
    if (crumpledNew > 0) {
      crumpledNew -= 1;
      analytics.track('sticky_note_crumpled');
    } else {
      analytics.track('sticky_note_deleted');
    }
  }
}

function countTodoBlocks(payload) {
  const columns = payload && Array.isArray(payload.columns) ? payload.columns : [];
  let n = 0;
  for (const col of columns) {
    const blocks = col && Array.isArray(col.blocks) ? col.blocks : [];
    for (const b of blocks) if (b && b.type === 'todo') n += 1;
  }
  return n;
}

function registerIpcHandlers(state) {

  /** IDs activos de avisos in-app; mientras exista alguno, el dock ocupa toda la pantalla. */
  const activeDockNotificationIds = new Set();

  function syncDockBoundsForInAppNotifications() {

    const dock = state.mainWindow;

    if (!dock || dock.isDestroyed()) return;

    if (state.isExpanded) return;

    const hasToasts = activeDockNotificationIds.size > 0;

    applyDockWindowBounds(dock, hasToasts);

    // Con avisos visibles debemos capturar el clic aunque la app esté en segundo plano.
    dock.setIgnoreMouseEvents(!hasToasts, hasToasts ? undefined : { forward: true });

  }

  for (const ch of IPC_CHANNELS) {

    try {

      ipcMain.removeHandler(ch);

    } catch {

      /* no registrado */

    }

  }

  registerShellIpc(ipcMain);
  registerDetachedFrameIpc();
  registerLooseNavIpc();
  require('./menu-overlay').registerMenuOverlayIpc();

  function expandDockSidebar() {
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed()) return;
    state.reopenHomeOnFocus = false;
    // El foco viene de la ventana web: un blur espurio cerraría el panel al toque.
    state.dockBlurIgnoreUntil = Date.now() + 500;
    if (state.isExpanded) {
      dock.webContents.send('sidebar-state', true);
      raiseAlwaysOnTopWindow(dock);
      return;
    }
    state.isExpanded = true;
    analytics.track('home_viewed');
    applyDockWindowBounds(dock, true);
    try {
      dock.setIgnoreMouseEvents(false);
    } catch {
      /* noop */
    }
    dock.webContents.send('sidebar-state', true);
    raiseAlwaysOnTopWindow(dock);
  }

  state.expandDock = expandDockSidebar;

  function collapseDockSidebar() {
    state.isExpanded = false;

    const dock = state.mainWindow;

    if (dock && !dock.isDestroyed()) {
      applyDockWindowBounds(dock, false);

      dock.setIgnoreMouseEvents(true, { forward: true });

      dock.webContents.send('sidebar-state', false);
    }
  }

  /**
   * Expande el dock y pide al renderer activar modo edición (y opcionalmente abrir un acceso).
   * @param {string | null | undefined} shortcutId
   */
  function openShortcutEditorOnDock(shortcutId) {
    expandDockSidebar();
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed()) return;
    const sid =
      shortcutId != null && String(shortcutId).trim() !== '' ? String(shortcutId).trim() : '';
    dock.webContents.send('open-shortcut-editor', { shortcutId: sid });
  }

  /**
   * Sincroniza el interruptor "modo edición" en ventanas chrome (shell / detached).
   * @param {boolean} on
   */
  function broadcastShortcutsEditModeToChromeHosts(on) {
    const v = on === true;
    let menuOverlay = null;
    try {
      menuOverlay = require('./menu-overlay');
    } catch {
      menuOverlay = null;
    }
    try {
      const ws = require('./web-shell');
      const sw = ws.getShellWindow && ws.getShellWindow();
      if (sw && !sw.isDestroyed()) {
        sw.webContents.send('shortcuts-edit-mode-sync', v);
        if (menuOverlay) menuOverlay.setEditMode(sw, v);
      }
    } catch {
      /* noop */
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed() || !win.__usualDeskDetachedChromeHost) continue;
      try {
        win.webContents.send('shortcuts-edit-mode-sync', v);
        if (menuOverlay) menuOverlay.setEditMode(win, v);
      } catch {
        /* noop */
      }
    }
  }

  try {
    configureLooseNavHooks({
      expandDock: () => expandDockSidebar(),
      collapseDock: () => collapseDockSidebar(),
    });
  } catch {
    /* noop */
  }

  ipcMain.removeAllListeners('web-window-notification-click');

  ipcMain.on('web-window-notification-click', (event) => {

    collapseDockSidebar();

    const win = BrowserWindow.fromWebContents(event.sender);

    if (!win || win.isDestroyed()) return;

    if (win.isMinimized()) win.restore();

    if (win.isFullScreen()) win.setFullScreen(false);

    if (!win.isMaximized()) win.maximize();

    win.show();

    win.focus();

  });

  ipcMain.removeAllListeners('web-notification-shown');

  ipcMain.on('web-notification-shown', (event) => {
    require('./open-shortcut').markWebPageNotifies(event.sender.__usualDeskWebMapKey);
  });

  ipcMain.removeAllListeners('in-app-notification-show');

  ipcMain.on('in-app-notification-show', (event, payload) => {

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed() && win.__usualDeskNotificationsMuted === true) return;

    const dock = state.mainWindow;

    if (!dock || dock.isDestroyed()) return;

    const p = payload && typeof payload === 'object' ? payload : {};

    const id = p.id == null ? '' : String(p.id);

    if (id) activeDockNotificationIds.add(id);

    syncDockBoundsForInAppNotifications();

    const webMapKey = win && !win.isDestroyed() ? win.__usualDeskWebMapKey : '';

    const sourceName = win && !win.isDestroyed() ? win.__usualDeskShortcutLabel || 'Web' : 'Web';

    dock.webContents.send('dock-in-app-notification', {

      id: p.id,

      title: p.title != null ? String(p.title) : '',

      body: p.body != null ? String(p.body) : '',

      icon: p.icon != null ? String(p.icon) : '',

      image: p.image != null ? String(p.image) : '',

      tag: p.tag != null ? String(p.tag) : '',

      data: p.data ?? null,

      silent: !!p.silent,

      requireInteraction: !!p.requireInteraction,

      webMapKey: webMapKey || '',

      sourceName,

    });

  });

  ipcMain.removeAllListeners('in-app-notification-dismiss');

  ipcMain.on('in-app-notification-dismiss', (_event, id) => {

    const dock = state.mainWindow;

    if (!dock || dock.isDestroyed()) return;

    const k = id == null ? '' : String(id);

    if (k) activeDockNotificationIds.delete(k);

    syncDockBoundsForInAppNotifications();

    dock.webContents.send('dock-in-app-notification-dismiss', id);

  });



  /**
   * Ciclos de abrir y volver a cerrar con el atajo antes de explicar cómo
   * apagar una ventana y cómo dejarla en foco. El popup sale al traer la app
   * al frente, no en el momento en que el usuario acaba de esconderla.
   */
  const GESTURE_COACH_CYCLES = 10;

  function hotkeyUseShouldCount() {
    if (state.onboardingActive || state.gestureCoachOpen) return false;
    const settings = loadAppSettings();
    if (settings.gestureCoachShown) return false;
    if (settings.onboardingCompleted) return true;
    try {
      const list = loadShortcuts();
      return Array.isArray(list) && list.length > 0;
    } catch {
      return false;
    }
  }

  /** La ventana del dock tiene que cubrir la pantalla para que el popup se lea. */
  function holdGestureCoachSurface() {
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed()) return;
    applyDockWindowBounds(dock, true);
    try {
      dock.setIgnoreMouseEvents(false);
    } catch {
      /* noop */
    }
  }

  function releaseGestureCoachSurface() {
    state.gestureCoachOpen = false;
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed()) return;
    applyDockWindowBounds(dock, state.isExpanded === true);
    try {
      if (state.isExpanded) dock.setIgnoreMouseEvents(false);
      else dock.setIgnoreMouseEvents(true, { forward: true });
    } catch {
      /* noop */
    }
  }

  function presentGestureCoach() {
    if (state.gestureCoachOpen) return;
    const settings = loadAppSettings();
    if (settings.gestureCoachShown) return;
    if ((Number(settings.hotkeyToggleCount) || 0) < GESTURE_COACH_CYCLES) return;
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed()) return;
    state.gestureCoachOpen = true;
    holdGestureCoachSurface();
    try {
      raiseAlwaysOnTopWindow(dock);
    } catch {
      /* noop */
    }
    const send = () => {
      if (!state.gestureCoachOpen) return;
      const live = state.mainWindow;
      if (!live || live.isDestroyed()) return;
      try {
        live.webContents.send('gesture-coach-show');
      } catch {
        /* noop */
      }
    };
    send();
    setTimeout(send, 600);
  }

  function recordHotkeyToggle(revealed) {
    if (state.gestureCoachOpen) {
      holdGestureCoachSurface();
      return;
    }
    if (!hotkeyUseShouldCount()) return;
    const settings = loadAppSettings();
    let cycles = Math.floor(Number(settings.hotkeyToggleCount) || 0);
    let awaitingHide = settings.hotkeyCoachAwaitingHide === true;
    if (revealed) {
      awaitingHide = true;
    } else if (awaitingHide) {
      awaitingHide = false;
      cycles += 1;
    }
    saveAppSettings({
      hotkeyToggleCount: cycles,
      hotkeyCoachAwaitingHide: awaitingHide,
    });
    if (revealed && cycles >= GESTURE_COACH_CYCLES) presentGestureCoach();
  }

  /**
   * Atajo global (Ctrl+Alt+D o el que haya elegido).
   * La home cuenta como una ventana: si está al frente, se oculta igual que el mail.
   * Si no hay nada de inplaize al frente, vuelve la última superficie (home o ventana web).
   * `front` es la foto tomada al pulsar, antes de que el foco se mueva.
   * Sin ventanas, abre o cierra el panel.
   * @param {{ kind: 'web', mapKey: string } | { kind: 'home' } | null} [front]
   */
  function raiseAppFromGlobalHotkey(front) {
    // Durante el onboarding el atajo no abre ni esconde inplaize: si no, el
    // panel se va y no se puede seguir el tour. En el paso del atajo solo
    // avisamos para contar la prueba.
    if (state.onboardingActive || state.onboardingHotkeyTrial) {
      if (state.onboardingHotkeyTrial) {
        const dock = state.mainWindow;
        if (dock && !dock.isDestroyed()) dock.webContents.send('onboarding-hotkey-press');
      }
      return;
    }

    let revealed = false;
    /** Qué quedó al frente al mostrar: 'home' o 'web'. */
    let surface = '';

    const dockWin = state.mainWindow;
    if (!dockWin || dockWin.isDestroyed()) return;

    const rememberedWebKey = front && front.kind === 'web' && typeof front.mapKey === 'string' ? front.mapKey : '';
    const webKey = rememberedWebKey || focusedWebMapKey() || '';
    const homeShowing = state.isExpanded === true;
    const homeInFront = !webKey && (homeShowing || (front && front.kind === 'home'));
    if (webKey || homeInFront) {
      // Se guarda la ventana en la que el usuario está parado, no la que reciba el foco al ocultar.
      if (webKey) pinWebSurface(webKey, { holdMs: 700 });
      else markHomeAsLastFocusedSurface({ holdMs: 700 });
      state.reopenHomeOnFocus = false;
      state.suppressHomeReopenUntil = Date.now() + 700;
      minimizeAllWebWindows();
      if (homeShowing) collapseDockSidebar();
    } else if (lastFocusedSurfaceIsHome()) {
      state.reopenHomeOnFocus = false;
      expandDockSidebar();
      revealed = true;
      surface = 'home';
    } else {
      state.reopenHomeOnFocus = false;
      state.suppressHomeReopenUntil = Date.now() + 700;
      if (state.isExpanded) collapseDockSidebar();
      const focusedWeb = focusLastWebWindowFromHotkey();
      if (focusedWeb) {
        revealed = true;
        surface = 'web';
      } else {
        state.isExpanded = !state.isExpanded;
        applyDockWindowBounds(dockWin, state.isExpanded);
        try {
          if (state.isExpanded) {
            dockWin.setIgnoreMouseEvents(false);
          } else {
            dockWin.setIgnoreMouseEvents(true, { forward: true });
          }
        } catch {
          /* noop */
        }
        dockWin.webContents.send('sidebar-state', state.isExpanded);
        if (state.isExpanded) {
          state.dockBlurIgnoreUntil = Date.now() + 500;
          raiseAlwaysOnTopWindow(dockWin);
        }
        revealed = state.isExpanded === true;
        if (revealed) surface = 'home';
      }
    }

    analytics.track('hotkey_used', revealed
      ? { result: 'shown', surface: surface || 'unknown' }
      : { result: 'hidden' });

    recordHotkeyToggle(revealed);
  }

  ipcMain.handle('collapse-sidebar', () => {

    collapseDockSidebar();

    return true;

  });

  ipcMain.handle('dock-window-minimize', () => {
    const dock = state.mainWindow;
    if (dock && !dock.isDestroyed()) dock.minimize();
    return true;
  });

  ipcMain.handle('dock-window-toggle-maximize', () => {
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed()) return false;
    if (dock.isMaximized()) dock.unmaximize();
    else dock.maximize();
    return dock.isMaximized();
  });

  ipcMain.handle('expand-sidebar', () => {
    expandDockSidebar();
    return true;
  });

  ipcMain.handle('dock-open-welcome-home', (_event, view) => {
    expandDockSidebar();
    const dock = state.mainWindow;
    const next = view === 'downloads' ? 'downloads' : 'todos';
    if (dock && !dock.isDestroyed()) {
      dock.webContents.send('dock-open-welcome-home', next);
    }
    return true;
  });

  ipcMain.handle('shell-request-shortcut-editor', () => {
    try {
      const ws = require('./web-shell');
      const id = ws.getActiveShortcutId();
      openShortcutEditorOnDock(id);
    } catch {
      openShortcutEditorOnDock(null);
    }
    return true;
  });

  ipcMain.handle('detached-request-shortcut-editor', (event) => {
    let sid = null;
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed() && win.__usualDeskDetachedChromeHost) {
        const mk = win.__usualDeskDetachedOwnMapKey;
        if (mk) {
          const list = loadShortcuts();
          const s = list.find((x) => x && x.type === 'web' && webMapKey(x) === mk);
          if (s && s.id != null) sid = String(s.id);
        }
      }
    } catch {
      /* noop */
    }
    openShortcutEditorOnDock(sid);
    return true;
  });

  ipcMain.handle('peek-suggested-shortcut-editor-target', () => {
    try {
      const ws = require('./web-shell');
      const a = ws.getActiveShortcutId();
      if (a) return a;
    } catch {
      /* noop */
    }
    try {
      const { getFocusedDetachedHostShortcutId } = require('./detached-web-frame');
      const b = getFocusedDetachedHostShortcutId();
      if (b) return b;
    } catch {
      /* noop */
    }
    return null;
  });

  ipcMain.handle('notify-shortcuts-edit-mode', (event, on) => {
    const dock = state.mainWindow;
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!dock || dock.isDestroyed() || !sender || sender.id !== dock.id) return false;
    broadcastShortcutsEditModeToChromeHosts(on === true);
    try {
      require('./menu-overlay').setEditMode(dock, on === true);
    } catch {
      /* noop */
    }
    return true;
  });

  ipcMain.handle('chrome-request-exit-shortcut-edit-mode', () => {
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed()) return false;
    dock.webContents.send('exit-shortcut-edit-mode');
    return true;
  });

  ipcMain.handle('chrome-open-add-shortcut', () => {
    expandDockSidebar();
    const dock = state.mainWindow;
    if (dock && !dock.isDestroyed()) {
      dock.webContents.send('open-add-shortcut-modal');
    }
    return true;
  });

  ipcMain.handle('chrome-open-appearance', () => {
    expandDockSidebar();
    const dock = state.mainWindow;
    if (dock && !dock.isDestroyed()) {
      dock.webContents.send('open-appearance-modal');
    }
    return true;
  });

  ipcMain.handle('chrome-enter-shortcuts-edit-mode', () => {
    openShortcutEditorOnDock(null);
    return true;
  });



  ipcMain.handle('set-ignore-mouse', (event, ignore) => {

    if (state.gestureCoachOpen && ignore) return;

    try {
      if (require('./downloads-manager').isPassthroughFrozen()) return;
    } catch {
      /* noop */
    }

    const win = BrowserWindow.fromWebContents(event.sender);

    if (!win || win.isDestroyed()) return;

    win.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);

  });



  ipcMain.handle('get-shortcuts', () => loadShortcuts());



  ipcMain.handle('save-shortcuts', (_event, shortcuts) => {

    pushUndoBeforeChange();

    const before = loadShortcuts().length;

    saveShortcuts(shortcuts);

    trackCountChange(before, loadShortcuts().length, 'shortcut_created', 'shortcut_deleted');

    broadcastShortcutsChanged();

    return true;

  });



  ipcMain.handle('pick-app-or-shortcut', async () => {

    const parent =

      BrowserWindow.getFocusedWindow() || state.mainWindow || BrowserWindow.getAllWindows()[0];

    const filters =

      process.platform === 'win32'

        ? [

            { name: 'Programa o acceso directo', extensions: ['exe', 'lnk'] },

            { name: 'Ejecutable (.exe)', extensions: ['exe'] },

            { name: 'Acceso directo (.lnk)', extensions: ['lnk'] },

          ]

        : [{ name: 'Aplicación', extensions: ['exe', 'app', 'App'] }];

    const { canceled, filePaths } = await dialog.showOpenDialog(parent || undefined, {

      title: 'Elegir programa o acceso directo',

      filters,

      properties: ['openFile'],

    });

    if (canceled || !filePaths?.[0]) return null;

    return filePaths[0];

  });



  ipcMain.handle('open-shortcut', async (_event, shortcut) => {

    if (shortcut && typeof shortcut === 'object') {
      analytics.track('shortcut_opened', describeShortcut(shortcut));
    }

    await openShortcut(shortcut);

  });

  ipcMain.handle('analytics-track', (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    analytics.trackFromRenderer(String(raw.name || ''), raw.props);
    return true;
  });

  ipcMain.handle('open-pasted-url', async (_event, raw) => {
    analytics.track('pasted_url_opened');
    try {
      return await openPastedUrl(raw);
    } catch {
      return { ok: false, error: 'No se pudo abrir el enlace' };
    }
  });

  ipcMain.handle('url-prompt-show', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    require('./url-prompt').showUrlPrompt(win && !win.isDestroyed() ? win : null);
    return true;
  });

  ipcMain.handle('app-browser-open', async () => {
    analytics.track('app_browser_opened');
    await require('./loose-nav-window').enterLooseNavMode();
    return true;
  });

  ipcMain.handle('url-prompt-open', (event, open) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const show = open === true;
    if (win && !win.isDestroyed() && win.__usualDeskDetachedChromeHost) {
      require('./detached-web-frame').setHostUrlPromptOpen(win, show);
      return true;
    }
    try {
      const shell = require('./web-shell');
      if (win && shell.getShellWindow() === win) {
        shell.setUrlPromptOpen(show);
        return true;
      }
    } catch {
      /* noop */
    }
    try {
      require('./loose-nav-window').setUrlPromptOpen(show);
    } catch {
      /* noop */
    }
    return true;
  });



  ipcMain.handle('get-open-web-window-keys', () => getOpenWebWindowKeys());



  ipcMain.handle('set-web-shortcut-muted', (_event, payload) => {

    const shortcut = payload && typeof payload === 'object' ? payload.shortcut : null;

    const muted = !!(payload && payload.muted);

    if (!shortcut || shortcut.type !== 'web') return false;

    setWebShortcutAudioMuted(shortcut, muted);

    return true;

  });



  ipcMain.handle('set-web-shortcut-notifications-muted', (_event, payload) => {

    const shortcut = payload && typeof payload === 'object' ? payload.shortcut : null;

    const muted = !!(payload && payload.muted);

    if (!shortcut || shortcut.type !== 'web') return false;

    setWebShortcutNotificationsMuted(shortcut, muted);

    return true;

  });



  ipcMain.handle('save-web-notification-dump', (_event, text) => {

    const p = path.join(app.getPath('userData'), 'last-web-notification-dump.txt');

    fs.writeFileSync(p, String(text ?? ''), 'utf-8');

    return p;

  });



  ipcMain.handle('close-app', () => {

    app.quit();

  });



  ipcMain.handle('get-user-data-path', () => app.getPath('userData'));



  ipcMain.handle('get-app-version', () => getAppVersionPayload());



  ipcMain.handle('open-user-data-folder', async () => {

    const p = app.getPath('userData');

    const err = await shell.openPath(p);

    if (err) throw new Error(err);

    return true;

  });



  ipcMain.handle('list-builtin-icons', () => {

    const dir = path.join(app.getAppPath(), 'assets', 'icons');

    if (!fs.existsSync(dir)) return [];

    return fs

      .readdirSync(dir)

      .filter((f) => /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(f))

      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

      .map((file) => {

        const base = path.basename(file, path.extname(file));

        return {

          file,

          relPath: `assets/icons/${file}`.replace(/\\/g, '/'),

          title: base.replace(/[-_]/g, ' '),

        };

      });

  });



  ipcMain.handle('fetch-web-favicon', async (_event, pageUrl, iconUrlHint) => {
    try {
      const { resolveWebFavicon } = require('./web-favicon');
      const dataUrl = await resolveWebFavicon(pageUrl, iconUrlHint);
      if (!dataUrl || !dataUrl.startsWith('data:image/')) return null;
      return { dataUrl };
    } catch {
      return null;
    }
  });

  ipcMain.handle('get-app-settings', () => loadAppSettings());



  ipcMain.handle('set-app-settings', (_event, partial) => {

    const p = partial && typeof partial === 'object' ? partial : {};

    const prev = loadAppSettings();

    if (Object.prototype.hasOwnProperty.call(p, 'dockHotkey') && !acceleratorFromHotkey(p.dockHotkey)) {
      return Object.assign({}, prev, { dockHotkeyRejected: true });
    }

    const next = saveAppSettings(p);

    if (Object.prototype.hasOwnProperty.call(p, 'analyticsEnabled')) {
      if (prev.analyticsEnabled && !next.analyticsEnabled) analytics.track('analytics_disabled');
      analytics.setAnalyticsEnabled(next.analyticsEnabled);
    }
    if (!prev.onboardingCompleted && next.onboardingCompleted) {
      analytics.track('onboarding_completed');
    }
    if (Object.prototype.hasOwnProperty.call(p, 'dockHotkey')) {
      analytics.track('hotkey_changed');
    }
    if (Object.prototype.hasOwnProperty.call(p, 'dockHotkey')) {
      const registered = reregisterDockGlobalShortcut();
      if (!registered) {
        const reverted = saveAppSettings({ dockHotkey: prev.dockHotkey });
        reregisterDockGlobalShortcut();
        return Object.assign({}, reverted, { dockHotkeyRejected: true });
      }
    }

    if (Object.prototype.hasOwnProperty.call(p, 'inAppWebNotifications')) {

      refreshWebNotificationPatches();

    }

    const win = state.mainWindow;

    if (win && !win.isDestroyed()) {

      applyDockWindowBounds(win, state.isExpanded);

    }

    if (win && !win.isDestroyed()) {

      win.webContents.send('app-settings-changed', next);

    }

    return next;

  });



  ipcMain.handle('focus-web-window-by-map-key', async (_event, payload) => {

    collapseDockSidebar();

    const mapKey =
      payload && typeof payload === 'object'
        ? (typeof payload.mapKey === 'string' ? payload.mapKey : '')
        : (typeof payload === 'string' ? payload : '');

    if (!mapKey) return false;

    const notification =
      payload && typeof payload === 'object' && payload.notification && typeof payload.notification === 'object'
        ? payload.notification
        : null;

    if (notification) {
      return focusWebWindowFromNotification(mapKey, notification);
    }
    return focusWebWindowByMapKey(mapKey);

  });



  ipcMain.handle('close-web-window-by-map-key', (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const mapKey = typeof raw.mapKey === 'string' ? raw.mapKey : String(payload || '');
    if (!mapKey) return false;
    try {
      closeWebWindowByMapKey(mapKey);
    } catch {
      /* noop */
    }
    return true;
  });

  ipcMain.handle('focus-mode-get-state', () => focusMode.getState());

  ipcMain.handle('focus-mode-exit', () => {
    focusMode.exitFocusMode();
    return focusMode.getState();
  });

  ipcMain.handle('focus-mode-toggle-member', async (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const shortcutId = raw.shortcutId == null ? '' : String(raw.shortcutId);
    if (!shortcutId) return focusMode.getState();
    const list = loadShortcuts();
    const shortcut = list.find((s) => String(s.id) === shortcutId);
    if (!shortcut || shortcut.type !== 'web') return focusMode.getState();
    const mk = webMapKey(shortcut);
    if (!mk) return focusMode.getState();
    focusMode.toggleMember(mk);
    analytics.track('focus_mode_toggled', { member: focusMode.isMember(mk) });
    // Si tras alternar el shortcut quedó DENTRO de la colección y aún no
    // estaba abierto, lo abrimos para que reciba sonido/notifs acorde.
    if (focusMode.isMember(mk)) {
      const keys = new Set(getOpenWebWindowKeys());
      if (!keys.has(mk)) {
        try {
          await openShortcut(shortcut);
        } catch {
          /* noop */
        }
      }
    }
    return focusMode.getState();
  });

  ipcMain.handle('dismiss-dock-in-app-notification', (_event, id) => {

    const k = id == null ? '' : String(id);

    if (k) activeDockNotificationIds.delete(k);

    syncDockBoundsForInAppNotifications();

    return true;

  });

  {
    const downloads = require('./downloads-manager');
    // Zona de archivos = espejo de Descargas y del Escritorio: el watcher
    // incorpora también lo que dejen otros programas.
    downloads.watchDownloadsFolder();
    ipcMain.handle('downloads-get-history', () => downloads.getHistory());
    ipcMain.handle('downloads-open-file', (_event, id) => downloads.openFile(String(id)));
    ipcMain.handle('downloads-mark-opened', (_event, id) => downloads.markOpened(String(id)));
    ipcMain.handle('downloads-show-in-folder', (_event, id) => downloads.showInFolder(String(id)));
    ipcMain.handle('downloads-remove', (_event, id) => downloads.removeItem(String(id)));
    ipcMain.handle('downloads-clear', () => downloads.clear());
    ipcMain.handle('downloads-cancel', (_event, id) => downloads.cancelDownload(String(id)));
    ipcMain.handle('downloads-save-image-edit', (_event, id, dataUrl) =>
      downloads.saveImageEdit(String(id), String(dataUrl || ''))
    );
    ipcMain.handle('downloads-ingest-dropped-files', (_event, paths) => {
      analytics.track('files_dropped', { count: Array.isArray(paths) ? paths.length : 0 });
      return downloads.ingestDroppedPaths(paths);
    });
    // Miniatura de documentos (PDF/Excel/CSV) generada por la app, no por el
    // shell del sistema. Devuelve una URL file:// a la miniatura cacheada.
    const thumbnails = require('./thumbnail-service');
    ipcMain.handle('downloads-get-thumbnail', async (_event, id) => {
      try {
        const savePath = downloads.getSavePath(String(id));
        if (!savePath) return { ok: false };
        const url = await thumbnails.getThumbnail(savePath);
        return url ? { ok: true, url } : { ok: false };
      } catch {
        return { ok: false };
      }
    });
    // Icono del sistema (exe, zip, docx…) para los archivos sin miniatura propia.
    // getFileIcon en Windows llega a 32px como mucho; el thumbnail del shell
    // devuelve el icono grande (jumbo) del archivo.
    const fileIconCache = new Map();
    ipcMain.handle('downloads-get-file-icon', async (_event, id) => {
      try {
        const savePath = downloads.getSavePath(String(id));
        if (!savePath) return { ok: false };
        if (fileIconCache.has(savePath)) return { ok: true, url: fileIconCache.get(savePath) };
        const { nativeImage } = require('electron');
        let img = null;
        try {
          img = await nativeImage.createThumbnailFromPath(savePath, { width: 128, height: 128 });
        } catch {
          img = null;
        }
        if (!img || img.isEmpty()) img = await app.getFileIcon(savePath, { size: 'large' });
        if (!img || img.isEmpty()) return { ok: false };
        const url = img.toDataURL();
        fileIconCache.set(savePath, url);
        return { ok: true, url };
      } catch {
        return { ok: false };
      }
    });
    // Drag nativo: el renderer avisa con send (no invoke) y startDrag tiene que
    // correr en ese mismo turno, con el botón del mouse todavía abajo.
    ipcMain.on('downloads-drag-start', (event, payload) => {
      const body = payload && typeof payload === 'object' ? payload : { id: payload };
      try {
        downloads.startNativeDrag(event.sender, String(body.id || ''), body.anchor);
      } catch {
        /* noop */
      }
    });
    downloads.setNativeDragEndHandler((win) => {
      if (!win || win.isDestroyed() || win.isFocused()) return;
      collapseDockSidebar();
    });

    // Cajón mágico: comprimir/convertir archivos con ffmpeg. El resultado
    // entra al mismo historial de descargas (progreso y toasts incluidos).
    const magicDrawer = require('./magic-drawer');
    ipcMain.handle('magic-transform', (_event, payload) => {
      const p = payload || {};
      analytics.track('magic_transform', {
        action: String(p.action || ''),
        target: String(p.target || ''),
      });
      return magicDrawer.transformFile(p);
    });
  }

  {
    // Recibir archivos desde el teléfono (QR en el panel de descargas).
    const phoneUpload = require('./phone-upload-server');
    phoneUpload.startPhoneUploadServer().catch(() => {});
    ipcMain.handle('phone-upload-get-info', () => {
      analytics.track('phone_upload_opened');
      return phoneUpload.getConnectInfo();
    });
  }

  ipcMain.handle('get-sticky-notes', () => loadStickyNotes());

  ipcMain.handle('save-sticky-notes', (event, payload) => {
    const before = loadStickyNotes();
    const saved = saveStickyNotes(payload);
    trackStickyNoteChanges(before, saved);
    broadcastStickyNotesChanged(event.sender);
    return saved;
  });

  ipcMain.removeAllListeners('doc-modal-open');
  ipcMain.on('doc-modal-open', (event, open) => {
    const dock = state.mainWindow;
    if (!dock || dock.isDestroyed() || event.sender !== dock.webContents) return;
    state.docModalOpen = open === true;
    try {
      if (state.docModalOpen) dock.setAlwaysOnTop(false);
      else if (state.isExpanded && dock.isFocused()) raiseAlwaysOnTopWindow(dock);
    } catch {
      /* noop */
    }
  });

  ipcMain.handle('get-todos', () => loadTodos());

  ipcMain.handle('save-todos', (event, payload) => {
    const before = countTodoBlocks(loadTodos());
    const saved = saveTodos(payload);
    trackCountChange(before, countTodoBlocks(saved), 'todo_created', null);
    broadcastTodosChanged(event.sender);
    return saved;
  });

  ipcMain.handle('export-document-pdf', async (event, payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const html = typeof body.html === 'string' ? body.html : '';
    if (!html || html.length > 80 * 1024 * 1024) return { ok: false, error: 'EMPTY' };
    analytics.track('document_pdf_exported');
    const baseName = String(body.title || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Documento';

    const parent = BrowserWindow.fromWebContents(event.sender);
    // El diálogo le quita el foco al dock: sin esto el panel se cierra con el modal abierto.
    state.dockBlurIgnoreUntil = Date.now() + 120000;
    let target = '';
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(parent || undefined, {
        title: 'Exportar como PDF',
        defaultPath: path.join(app.getPath('documents'), `${baseName}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      target = filePath;
    } finally {
      state.dockBlurIgnoreUntil = Date.now() + 500;
    }

    const tmpHtml = path.join(app.getPath('temp'), `inplaize-doc-${process.pid}-${Date.now()}.html`);
    let printer = null;
    try {
      fs.writeFileSync(tmpHtml, html, 'utf8');
      printer = new BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        webPreferences: {
          javascript: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await printer.loadFile(tmpHtml);
      const pdf = await printer.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      });
      fs.writeFileSync(target, pdf);
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      if (printer && !printer.isDestroyed()) printer.destroy();
      fs.rm(tmpHtml, { force: true }, () => {});
    }
  });

  ipcMain.handle('hold-dock-blur', (_event, ms) => {
    const n = Math.max(0, Math.min(60000, Math.round(Number(ms) || 0)));
    state.dockBlurIgnoreUntil = Date.now() + n;
    return true;
  });

  ipcMain.handle('consume-onboarding-launch', () => {
    const pending = state.pendingOnboarding === true;
    state.pendingOnboarding = false;
    return pending;
  });

  ipcMain.handle('set-onboarding-active', (_event, on) => {
    state.onboardingActive = on === true;
    if (!state.onboardingActive) {
      state.onboardingHotkeyTrial = false;
      return true;
    }
    // El tour necesita el panel abierto y al frente. Lo aseguramos desde acá
    // además de desde el renderer: en el primer arranque de una instalación
    // nueva cualquier ventana de Windows puede habernos robado el foco antes.
    expandDockSidebar();
    return true;
  });

  /** Paso del atajo del onboarding: el atajo global solo avisa, no toca el dock ni las ventanas. */
  ipcMain.handle('set-onboarding-hotkey-trial', (_event, on) => {
    state.onboardingHotkeyTrial = on === true && state.onboardingActive === true;
    return true;
  });

  /**
   * Onboarding: lleva el mouse real hasta un punto de la ventana (coordenadas
   * del contenido, en px CSS). Solo Windows y mientras dura el onboarding. No pide
   * foco: la ventana del onboarding puede estar a la vista sin tenerlo.
   */
  ipcMain.handle('onboarding-move-cursor', (event, point) => {
    if (process.platform !== 'win32' || !state.onboardingActive) return false;
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed() || !win.isVisible()) return false;
      const x = Number(point && point.x);
      const y = Number(point && point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const { screen } = require('electron');
      const zoom = event.sender.getZoomFactor() || 1;
      const bounds = win.getContentBounds();
      const target = screen.dipToScreenPoint({
        x: bounds.x + x * zoom,
        y: bounds.y + y * zoom,
      });
      require('./win32-window').glideCursorTo(target.x, target.y, point && point.ms);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('gesture-coach-close', (_event, opts) => {
    const defer = !!(opts && opts.defer);
    if (!defer) saveAppSettings({ gestureCoachShown: true });
    releaseGestureCoachSurface();
    return true;
  });

  /* ---- Importar perfil completo de otro navegador (estilo Comet) ---- */

  ipcMain.handle('browser-import-list-profiles', async () => {
    try {
      const profiles = browserImport.listAllProfiles();
      const running = {};
      for (const b of browserImport.listInstalledBrowsers()) {
        running[b.id] = await browserImport.isBrowserRunning(browserImport.BROWSERS[b.id].processName);
      }
      return {
        platformSupported: process.platform === 'win32',
        vaultAvailable: passwordsStore.available(),
        browsers: browserImport.listInstalledBrowsers(),
        running,
        profiles,
      };
    } catch {
      return {
        platformSupported: process.platform === 'win32',
        vaultAvailable: false,
        browsers: [],
        running: {},
        profiles: [],
      };
    }
  });

  ipcMain.handle('browser-import-run', async (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const browser = String(raw.browser || 'chrome');
    // Puede venir un perfil o varios del mismo navegador.
    const directories = (Array.isArray(raw.directory) ? raw.directory : [raw.directory])
      .map((d) => String(d || '').trim())
      .filter(Boolean);
    if (directories.length === 0) directories.push('Default');
    const parts = raw.parts && typeof raw.parts === 'object' ? raw.parts : undefined;
    const wantsCookies = !parts || parts.cookies !== false;

    const def = browserImport.browserDef(browser);
    if (!def) return { ok: false, error: 'BROWSER_NOT_FOUND' };
    analytics.track('browser_import', { browser });

    // Las cookies obligan a cerrar el navegador; pedimos permiso una vez. Si el
    // usuario no quiere cerrarlo, seguimos sin cookies (historial/marcadores/
    // contraseñas se leen con el navegador abierto).
    let importCookies = wantsCookies;
    const host = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined;
    if (wantsCookies && (await browserImport.isBrowserRunning(def.processName))) {
      const { response } = await showAppMessageBox(host, {
        type: 'question',
        title: 'inplaize',
        message: `Hay que cerrar ${def.name} un momento`,
        detail:
          `Para traer las cookies necesitamos leer la sesión de ${def.name}, y eso solo se puede con `
          + `${def.name} cerrado. Lo cerramos y lo reabrimos con tus pestañas apenas termine.`,
        buttons: [`Cerrar ${def.name} y continuar`, 'Continuar sin cookies', 'Cancelar'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) return { ok: false, error: 'CANCELLED' };
      if (response === 1) importCookies = false;
    }

    // Una sola vez para todos los perfiles. Cada perfil levanta su propio
    // navegador headless (también se llama chrome.exe): reabrirlo entre
    // perfiles obliga a cerrarlo de nuevo y la app parece trabada.
    let reopenBrowser = false;
    if (importCookies && (await browserImport.isBrowserRunning(def.processName))) {
      if (!(await browserImport.closeBrowserForImport(def.processName))) {
        return { ok: false, error: 'BROWSER_CLOSE_FAILED' };
      }
      reopenBrowser = true;
    }

    const totals = {
      cookies: 0,
      history: 0,
      bookmarks: 0,
      passwords: 0,
      passwordsSkipped: 0,
      passwordsVaultAvailable: true,
    };
    let lastError = '';
    let anyDone = false;
    try {
      for (let i = 0; i < directories.length; i += 1) {
        let summary = null;
        try {
          summary = await profileImport.importFullProfile({
            browser,
            directory: directories[i],
            autoClose: true,
            relaunch: false,
            parts: parts ? { ...parts, cookies: importCookies } : { cookies: importCookies },
          });
        } catch (err) {
          lastError = (err && err.message) || 'IMPORT_FAILED';
          continue;
        }
        anyDone = true;
        if (summary.closedBrowser) reopenBrowser = true;
        totals.partition = summary.partition;
        totals.cookies += summary.cookies || 0;
        totals.history += summary.history || 0;
        totals.bookmarks += summary.bookmarks || 0;
        totals.passwords += summary.passwords || 0;
        totals.passwordsSkipped += summary.passwordsSkipped || 0;
        if (summary.cookiesError) totals.cookiesError = summary.cookiesError;
        if (summary.passwordsVaultAvailable === false) totals.passwordsVaultAvailable = false;
      }
    } finally {
      if (reopenBrowser) browserImport.relaunchBrowser(browser);
    }

    if (!anyDone) return { ok: false, error: lastError || 'IMPORT_FAILED' };
    try {
      require('./browse-profiles').refreshAccounts();
    } catch {
      /* noop */
    }
    return { ok: true, ...totals };
  });

  ipcMain.handle('history-suggest', (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    try {
      return historyStore.suggest(String(raw.query || ''), Number(raw.limit) || 8);
    } catch {
      return [];
    }
  });

  ipcMain.handle('history-record', (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    try {
      historyStore.record(String(raw.url || ''), String(raw.title || ''));
    } catch {
      /* noop */
    }
    return true;
  });

  ipcMain.handle('history-list', (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    try {
      return historyStore.search(String(raw.query || ''), Number(raw.limit) || 300, Number(raw.offset) || 0);
    } catch {
      return [];
    }
  });

  ipcMain.handle('history-remove', (_event, url) => {
    try {
      return historyStore.remove(Array.isArray(url) ? url.map((u) => String(u || '')) : String(url || ''));
    } catch {
      return false;
    }
  });

  ipcMain.handle('history-clear', () => {
    try {
      historyStore.clear();
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('bookmarks-list', () => {
    try {
      return bookmarksStore.list();
    } catch {
      return [];
    }
  });

  ipcMain.handle('bookmarks-add', (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    try {
      return bookmarksStore.add({ url: String(raw.url || ''), title: String(raw.title || '') });
    } catch {
      return null;
    }
  });

  ipcMain.handle('bookmarks-remove', (_event, id) => {
    try {
      return bookmarksStore.remove(String(id || ''));
    } catch {
      return false;
    }
  });

  ipcMain.handle('bookmarks-has', (_event, url) => {
    try {
      return bookmarksStore.has(String(url || ''));
    } catch {
      return false;
    }
  });

  ipcMain.handle('passwords-for-host', (_event, url) => {
    try {
      return passwordsStore.forHost(String(url || ''));
    } catch {
      return [];
    }
  });

  ipcMain.handle('passwords-save', (_event, payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    try {
      return passwordsStore.upsert({
        origin: String(raw.origin || raw.url || ''),
        username: String(raw.username || ''),
        password: String(raw.password || ''),
      });
    } catch {
      return null;
    }
  });

  ipcMain.handle('passwords-list', () => {
    try {
      return { available: passwordsStore.available(), items: passwordsStore.listForDisplay() };
    } catch {
      return { available: false, items: [] };
    }
  });

  ipcMain.handle('passwords-remove', (_event, id) => {
    try {
      return passwordsStore.remove(String(id || ''));
    } catch {
      return false;
    }
  });

  return { raiseAppFromGlobalHotkey };

}



module.exports = { registerIpcHandlers };


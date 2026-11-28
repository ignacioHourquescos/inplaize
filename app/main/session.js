'use strict';

const path = require('path');
const { readJson, writeJson } = require('./store');
const {
  GUEST_ID,
  createId,
  sanitizeNotes,
  sanitizeName,
  sanitizeShortcut,
  hueFromSeed,
  hostOf,
  emptyBlock,
} = require('../shared/model');

const MAX_PROFILES = 12;
const MAX_SHORTCUTS = 24;
const MAX_TABS = 20;

const state = {
  mode: 'home',
  barOpen: false,
  editing: false,
  activeProfileId: GUEST_ID,
  focusedShortcutId: null,
  profiles: [{ id: GUEST_ID, name: 'Sin sesión', kind: 'guest' }],
  shortcuts: [],
  openShortcutIds: [],
  tabs: {},
  notes: { blocks: [emptyBlock()] },
};

let dir = '';
let notify = () => {};
let persistTimer = null;
let emitting = false;

function setNotifier(fn) {
  notify = typeof fn === 'function' ? fn : () => {};
}

function files() {
  return {
    notes: path.join(dir, 'mvp-notes.json'),
    profiles: path.join(dir, 'mvp-profiles.json'),
    shortcuts: path.join(dir, 'mvp-shortcuts.json'),
    tabs: path.join(dir, 'mvp-tabs.json'),
  };
}

function bag(profileId) {
  if (!state.tabs[profileId]) state.tabs[profileId] = { activeId: null, items: [] };
  return state.tabs[profileId];
}

function activeBag() {
  return bag(state.activeProfileId);
}

function activeTab() {
  const current = activeBag();
  return current.items.find((tab) => tab.id === current.activeId) || null;
}

function schedulePersist() {
  if (!dir) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 200);
}

function persist() {
  if (!dir) return;
  const f = files();
  writeJson(f.notes, state.notes);
  writeJson(
    f.profiles,
    state.profiles.filter((profile) => profile.kind !== 'guest').map((profile) => ({
      id: profile.id,
      name: profile.name,
    })),
  );
  writeJson(f.shortcuts, state.shortcuts);
  const tabs = {};
  for (const profile of state.profiles) {
    if (profile.kind === 'guest') continue;
    const current = state.tabs[profile.id];
    if (!current) continue;
    tabs[profile.id] = {
      activeId: current.activeId,
      items: current.items.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })),
    };
  }
  writeJson(f.tabs, tabs);
}

function touch() {
  schedulePersist();
  if (emitting) return;
  emitting = true;
  try {
    notify();
  } finally {
    emitting = false;
  }
}

function init(userData) {
  dir = userData;
  const f = files();
  state.notes = sanitizeNotes(readJson(f.notes, null));

  const savedProfiles = readJson(f.profiles, []);
  state.profiles = [{ id: GUEST_ID, name: 'Sin sesión', kind: 'guest' }];
  if (Array.isArray(savedProfiles)) {
    for (const profile of savedProfiles) {
      if (!profile || profile.id === GUEST_ID || state.profiles.length >= MAX_PROFILES) continue;
      const id = typeof profile.id === 'string' ? profile.id.trim().slice(0, 80) : '';
      if (!id || state.profiles.some((item) => item.id === id)) continue;
      state.profiles.push({
        id,
        name: sanitizeName(profile.name, 'Perfil'),
        kind: 'named',
      });
    }
  }

  const savedShortcuts = readJson(f.shortcuts, []);
  state.shortcuts = [];
  if (Array.isArray(savedShortcuts)) {
    for (const raw of savedShortcuts) {
      if (state.shortcuts.length >= MAX_SHORTCUTS) break;
      const shortcut = sanitizeShortcut(raw);
      if (!shortcut || state.shortcuts.some((item) => item.id === shortcut.id)) continue;
      state.shortcuts.push(shortcut);
    }
  }

  const savedTabs = readJson(f.tabs, {});
  state.tabs = {};
  if (savedTabs && typeof savedTabs === 'object') {
    for (const profile of state.profiles) {
      if (profile.kind === 'guest') continue;
      const raw = savedTabs[profile.id];
      if (!raw || !Array.isArray(raw.items)) continue;
      const items = [];
      for (const tab of raw.items) {
        if (!tab || items.length >= MAX_TABS) continue;
        const url = typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url) ? tab.url : '';
        const id = typeof tab.id === 'string' && tab.id.trim() ? tab.id.trim().slice(0, 80) : createId('t');
        items.push({
          id,
          url,
          title: sanitizeName(tab.title, url ? hostOf(url) : 'Nueva pestaña') || 'Nueva pestaña',
        });
      }
      state.tabs[profile.id] = {
        activeId: items.some((tab) => tab.id === raw.activeId) ? raw.activeId : (items[0] && items[0].id) || null,
        items,
      };
    }
  }
}

function makeTab(url) {
  const safe = typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
  return {
    id: createId('t'),
    url: safe,
    title: safe ? hostOf(safe) || 'Pestaña' : 'Nueva pestaña',
  };
}

function ensureTab(profileId) {
  const current = bag(profileId);
  if (!current.items.length) {
    const tab = makeTab('');
    current.items.push(tab);
    current.activeId = tab.id;
  }
  if (!current.items.some((tab) => tab.id === current.activeId)) {
    current.activeId = current.items[0].id;
  }
  return current;
}

function goHome() {
  state.mode = 'home';
  state.barOpen = false;
  state.editing = false;
  touch();
}

function beginBrowse(profileId) {
  if (!state.profiles.some((profile) => profile.id === profileId)) return false;
  state.activeProfileId = profileId;
  state.mode = 'browse';
  state.barOpen = true;
  state.editing = false;
  ensureTab(profileId);
  touch();
  return true;
}

function toggleBar() {
  if (state.barOpen) {
    state.barOpen = false;
    touch();
    return;
  }
  state.mode = 'browse';
  state.barOpen = true;
  ensureTab(state.activeProfileId);
  touch();
}

function setEditing(on) {
  state.editing = on === true;
  touch();
}

function selectProfile(id) {
  return beginBrowse(id);
}

function addProfile(name) {
  const label = sanitizeName(name, '');
  if (!label) return { ok: false, error: 'Poné un nombre para el perfil.' };
  if (state.profiles.length >= MAX_PROFILES) return { ok: false, error: 'Ya hay demasiados perfiles.' };
  const profile = { id: createId('p'), name: label, kind: 'named' };
  state.profiles.push(profile);
  state.editing = false;
  beginBrowse(profile.id);
  return { ok: true };
}

function removeProfile(id) {
  if (id === GUEST_ID) return { tabIds: [] };
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile) return { tabIds: [] };
  const tabIds = (state.tabs[id] && state.tabs[id].items.map((tab) => tab.id)) || [];
  state.profiles = state.profiles.filter((item) => item.id !== id);
  delete state.tabs[id];
  if (state.activeProfileId === id) {
    state.activeProfileId = GUEST_ID;
    if (state.mode === 'browse') ensureTab(GUEST_ID);
  }
  touch();
  return { tabIds };
}

function addShortcut(raw) {
  if (state.shortcuts.length >= MAX_SHORTCUTS) {
    return { ok: false, error: 'Ya hay demasiados accesos.' };
  }
  const shortcut = sanitizeShortcut(raw);
  if (!shortcut) return { ok: false, error: 'Escribí un enlace o algo para buscar.' };
  state.shortcuts.push(shortcut);
  state.editing = false;
  touch();
  return { ok: true, shortcut };
}

function removeShortcut(id) {
  state.shortcuts = state.shortcuts.filter((shortcut) => shortcut.id !== id);
  state.openShortcutIds = state.openShortcutIds.filter((shortcutId) => shortcutId !== id);
  if (state.focusedShortcutId === id) state.focusedShortcutId = null;
  touch();
}

function reorderShortcuts(ids) {
  if (!Array.isArray(ids)) return;
  const map = new Map(state.shortcuts.map((shortcut) => [shortcut.id, shortcut]));
  const next = [];
  for (const id of ids) {
    const shortcut = map.get(id);
    if (!shortcut) continue;
    next.push(shortcut);
    map.delete(id);
  }
  for (const shortcut of map.values()) next.push(shortcut);
  state.shortcuts = next;
  touch();
}

function noteShortcutOpen(id, open) {
  const has = state.openShortcutIds.includes(id);
  if (open && !has) state.openShortcutIds.push(id);
  if (!open && has) state.openShortcutIds = state.openShortcutIds.filter((shortcutId) => shortcutId !== id);
  if (!open && state.focusedShortcutId === id) state.focusedShortcutId = null;
  touch();
}

function setFocusedShortcut(id) {
  state.focusedShortcutId = id || null;
  touch();
}

function saveNotes(raw) {
  state.notes = sanitizeNotes(raw);
  touch();
  return state.notes;
}

function newTab(url) {
  state.mode = 'browse';
  state.barOpen = true;
  const current = ensureTab(state.activeProfileId);
  if (current.items.length >= MAX_TABS) return null;
  const tab = makeTab(url);
  const index = current.items.findIndex((item) => item.id === current.activeId);
  current.items.splice(index + 1, 0, tab);
  current.activeId = tab.id;
  touch();
  return tab;
}

function closeTab(tabId) {
  const current = activeBag();
  const index = current.items.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  current.items.splice(index, 1);
  if (!current.items.length) {
    const tab = makeTab('');
    current.items.push(tab);
    current.activeId = tab.id;
  } else if (!current.items.some((tab) => tab.id === current.activeId)) {
    current.activeId = current.items[Math.max(0, index - 1)].id;
  }
  touch();
}

function selectTab(tabId) {
  const current = activeBag();
  if (!current.items.some((tab) => tab.id === tabId)) return;
  current.activeId = tabId;
  state.mode = 'browse';
  state.barOpen = true;
  touch();
}

function patchTab(profileId, tabId, patch) {
  const current = state.tabs[profileId];
  if (!current) return;
  const tab = current.items.find((item) => item.id === tabId);
  if (!tab) return;
  if (typeof patch.url === 'string') tab.url = /^https?:\/\//i.test(patch.url) ? patch.url : '';
  if (typeof patch.title === 'string' && patch.title.trim()) {
    tab.title = sanitizeName(patch.title, tab.title);
  }
  touch();
}

function sproutOf(shortcutFocused) {
  if (state.barOpen && shortcutFocused && state.focusedShortcutId) {
    return { kind: 'shortcut', id: state.focusedShortcutId, shape: 'sprout' };
  }
  if (state.barOpen && state.mode === 'browse') {
    return { kind: 'profile', id: state.activeProfileId, shape: 'sprout' };
  }
  if (state.focusedShortcutId && state.openShortcutIds.includes(state.focusedShortcutId)) {
    return { kind: 'shortcut', id: state.focusedShortcutId, shape: 'ring' };
  }
  return null;
}

function snapshot(extra) {
  const current = state.mode === 'browse' ? activeBag() : activeBag();
  const tab = activeTab();
  return {
    mode: state.mode,
    barOpen: state.barOpen,
    editing: state.editing,
    activeProfileId: state.activeProfileId,
    openShortcutIds: state.openShortcutIds.slice(),
    sprout: sproutOf(extra && extra.shortcutFocused),
    profiles: state.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      hue: hueFromSeed(profile.id),
    })),
    shortcuts: state.shortcuts.map((shortcut) => ({
      id: shortcut.id,
      name: shortcut.name,
      url: shortcut.url,
      host: hostOf(shortcut.url),
    })),
    tabs: (current.items || []).map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
    })),
    activeTabId: current.activeId,
    nav: {
      canGoBack: false,
      canGoForward: false,
      address: tab && tab.url ? tab.url : '',
    },
    notes: state.notes,
  };
}

module.exports = {
  init,
  setNotifier,
  persist,
  snapshot,
  goHome,
  toggleBar,
  setEditing,
  selectProfile,
  addProfile,
  removeProfile,
  addShortcut,
  removeShortcut,
  reorderShortcuts,
  noteShortcutOpen,
  setFocusedShortcut,
  saveNotes,
  newTab,
  closeTab,
  selectTab,
  patchTab,
  activeTab,
  state,
};

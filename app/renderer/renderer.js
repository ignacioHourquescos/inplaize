'use strict';

const notesEl = document.getElementById('notes');
const profilesEl = document.getElementById('profiles');
const shortcutsEl = document.getElementById('shortcuts');
const tabsEl = document.getElementById('tabs');
const barEl = document.getElementById('bar');
const addressEl = document.getElementById('address');
const menuEl = document.getElementById('menu');
const sheetEl = document.getElementById('sheet');
const slashEl = document.getElementById('slash');

let current = null;
let notesStamp = '';
let saveTimer = null;
let sheetKind = '';
let slashBlock = null;

const GUEST_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<circle cx="12" cy="9" r="3.2" stroke="currentColor" stroke-width="1.8"/>' +
  '<path d="M6.2 18.2c1.2-2.4 3.2-3.6 5.8-3.6s4.6 1.2 5.8 3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '</svg>';

function localId() {
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function favicon(host) {
  if (!host) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

function closePopovers() {
  menuEl.hidden = true;
  document.getElementById('menu-btn').setAttribute('aria-expanded', 'false');
  slashEl.hidden = true;
  slashBlock = null;
}

function apply(state) {
  current = state;
  document.documentElement.dataset.mode = state.mode;
  document.documentElement.dataset.bar = state.barOpen ? 'open' : 'closed';
  barEl.hidden = !state.barOpen;
  document.getElementById('chevron').setAttribute('aria-expanded', state.barOpen ? 'true' : 'false');
  document.getElementById('edit-btn').setAttribute('aria-pressed', state.editing ? 'true' : 'false');
  renderProfiles(state);
  renderShortcuts(state);
  renderTabs(state);
  const back = document.getElementById('back');
  const forward = document.getElementById('forward');
  back.disabled = !state.nav.canGoBack;
  forward.disabled = !state.nav.canGoForward;
  if (document.activeElement !== addressEl) addressEl.value = state.nav.address || '';
  const stamp = JSON.stringify(state.notes);
  if (stamp !== notesStamp && !notesEl.contains(document.activeElement)) {
    notesStamp = stamp;
    renderNotes(state.notes);
  }
}

function sproutClass(state, kind, id) {
  if (!state.sprout || state.sprout.kind !== kind || state.sprout.id !== id) return '';
  return state.sprout.shape === 'sprout' ? 'is-sprout' : 'is-ring';
}

function renderProfiles(state) {
  profilesEl.replaceChildren();
  for (const profile of state.profiles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip ${sproutClass(state, 'profile', profile.id)}`.trim();
    button.title = profile.name;
    button.setAttribute('aria-label', profile.name);
    const avatar = document.createElement('span');
    avatar.className = profile.kind === 'guest' ? 'avatar guest' : 'avatar';
    avatar.style.setProperty('--hue', String(profile.hue));
    if (profile.kind === 'guest') avatar.innerHTML = GUEST_ICON;
    else avatar.textContent = profile.name.trim().charAt(0).toUpperCase() || '?';
    button.append(avatar);
    button.addEventListener('click', () => mvp.selectProfile(profile.id));
    if (state.editing && profile.kind !== 'guest') {
      button.append(removeButton(() => mvp.removeProfile(profile.id)));
    }
    profilesEl.append(button);
  }
  if (state.editing) profilesEl.append(addButton('Nuevo perfil', () => openSheet('profile')));
}

function renderShortcuts(state) {
  shortcutsEl.replaceChildren();
  for (const shortcut of state.shortcuts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip ${sproutClass(state, 'shortcut', shortcut.id)}`.trim();
    button.title = shortcut.name;
    button.draggable = state.editing;
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = shortcut.name.trim().charAt(0).toUpperCase() || '?';
    glyph.append(letter);
    if (shortcut.host) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = favicon(shortcut.host);
      img.addEventListener('error', () => img.remove());
      glyph.append(img);
    }
    button.append(glyph);
    if (state.openShortcutIds.includes(shortcut.id) && !button.classList.contains('is-sprout')) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      button.append(dot);
    }
    button.addEventListener('click', () => mvp.openShortcut(shortcut.id));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (state.openShortcutIds.includes(shortcut.id)) mvp.closeShortcut(shortcut.id);
    });
    button.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', shortcut.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    button.addEventListener('dragover', (event) => {
      if (!current || !current.editing) return;
      event.preventDefault();
    });
    button.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = event.dataTransfer.getData('text/plain');
      if (!current || from === shortcut.id) return;
      const ids = current.shortcuts.map((item) => item.id);
      const origin = ids.indexOf(from);
      const target = ids.indexOf(shortcut.id);
      if (origin < 0 || target < 0) return;
      ids.splice(origin, 1);
      ids.splice(target, 0, from);
      mvp.reorderShortcuts(ids);
    });
    if (state.editing) button.append(removeButton(() => mvp.removeShortcut(shortcut.id)));
    shortcutsEl.append(button);
  }
  if (state.editing) shortcutsEl.append(addButton('Nuevo acceso', () => openSheet('shortcut')));
}

function renderTabs(state) {
  tabsEl.replaceChildren();
  for (const tab of state.tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = tab.id === state.activeTabId ? 'tab is-active' : 'tab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', tab.id === state.activeTabId ? 'true' : 'false');
    const label = document.createElement('span');
    label.textContent = tab.title || 'Nueva pestaña';
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Cerrar pestaña';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      mvp.closeTab(tab.id);
    });
    button.append(label, close);
    button.addEventListener('click', () => mvp.selectTab(tab.id));
    tabsEl.append(button);
  }
}

function addButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'add';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.textContent = '+';
  button.addEventListener('click', onClick);
  return button;
}

function removeButton(onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'x';
  button.textContent = '×';
  button.title = 'Quitar';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function renderNotes(notes) {
  notesEl.replaceChildren();
  const blocks = notes && Array.isArray(notes.blocks) ? notes.blocks : [];
  for (const block of blocks) notesEl.append(buildBlock(block));
  if (!notesEl.firstChild) notesEl.append(buildBlock({ id: localId(), type: 'text', text: '', done: false }));
}

function buildBlock(block) {
  const row = document.createElement('div');
  row.className = block.done ? 'block is-done' : 'block';
  row.dataset.id = block.id;
  row.dataset.type = block.type || 'text';
  if (row.dataset.type === 'todo') {
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'check';
    check.textContent = block.done ? '✓' : '';
    check.addEventListener('click', () => {
      row.classList.toggle('is-done');
      check.textContent = row.classList.contains('is-done') ? '✓' : '';
      scheduleSave();
    });
    row.append(check);
  } else if (row.dataset.type === 'bullet') {
    const mark = document.createElement('span');
    mark.className = 'bullet-mark';
    row.append(mark);
  }
  const text = document.createElement('div');
  text.className = 'text';
  text.contentEditable = 'true';
  text.spellcheck = false;
  text.textContent = block.text || '';
  if ((block.type || 'text') === 'text') text.dataset.placeholder = 'Escribí, o / para el tipo';
  text.addEventListener('input', () => onNoteInput(row, text));
  text.addEventListener('keydown', (event) => onNoteKey(event, row, text));
  row.append(text);
  return row;
}

function onNoteInput(row, text) {
  const value = text.textContent || '';
  if (value === '/') openSlash(row);
  else closeSlash();
  scheduleSave();
}

function onNoteKey(event, row, text) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    closeSlash();
    const value = text.textContent || '';
    const offset = caretOffset(text);
    text.textContent = value.slice(0, offset);
    const next = buildBlock({
      id: localId(),
      type: row.dataset.type,
      text: value.slice(offset),
      done: false,
    });
    row.after(next);
    focusBlock(next, 0);
    scheduleSave();
    return;
  }
  if (event.key === 'Backspace' && caretOffset(text) === 0 && !(text.textContent || '').length) {
    const previous = row.previousElementSibling;
    if (!previous) return;
    event.preventDefault();
    row.remove();
    focusBlock(previous, -1);
    scheduleSave();
  }
  if (event.key === 'Escape') closeSlash();
}

function caretOffset(el) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) {
    return (el.textContent || '').length;
  }
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
  return range.toString().length;
}

function focusBlock(row, offset) {
  const text = row.querySelector('.text');
  if (!text) return;
  text.focus();
  const node = text.firstChild;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  if (!node) {
    range.selectNodeContents(text);
    range.collapse(true);
  } else {
    const at = offset < 0 ? node.textContent.length : Math.min(offset, node.textContent.length);
    range.setStart(node, at);
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function readNotes() {
  return {
    blocks: [...notesEl.querySelectorAll('.block')].map((row) => ({
      id: row.dataset.id,
      type: row.dataset.type,
      text: (row.querySelector('.text') && row.querySelector('.text').textContent) || '',
      done: row.classList.contains('is-done'),
    })),
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const notes = readNotes();
    notesStamp = JSON.stringify(notes);
    mvp.saveNotes(notes);
  }, 250);
}

function openSlash(row) {
  slashBlock = row;
  slashEl.replaceChildren();
  for (const [type, label] of [['text', 'Texto'], ['todo', 'Tarea'], ['bullet', 'Viñeta']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => chooseType(type));
    slashEl.append(button);
  }
  const rect = row.getBoundingClientRect();
  slashEl.style.left = `${Math.max(12, rect.left)}px`;
  slashEl.style.top = `${rect.bottom + 4}px`;
  slashEl.hidden = false;
}

function closeSlash() {
  slashEl.hidden = true;
  slashBlock = null;
}

function chooseType(type) {
  const row = slashBlock;
  closeSlash();
  if (!row || !row.isConnected) return;
  const text = row.querySelector('.text');
  const value = text && text.textContent === '/' ? '' : (text && text.textContent) || '';
  const done = row.classList.contains('is-done');
  const next = buildBlock({ id: row.dataset.id, type, text: value, done: type === 'todo' && done });
  row.replaceWith(next);
  focusBlock(next, -1);
  scheduleSave();
}

function openSheet(kind) {
  sheetKind = kind;
  closePopovers();
  document.getElementById('sheet-title').textContent = kind === 'profile' ? 'Nuevo perfil' : 'Nuevo acceso';
  document.getElementById('sheet-url-label').hidden = kind === 'profile';
  document.getElementById('sheet-name').value = '';
  document.getElementById('sheet-url').value = '';
  const error = document.getElementById('sheet-error');
  error.hidden = true;
  error.textContent = '';
  sheetEl.hidden = false;
  document.getElementById('sheet-name').focus();
}

function closeSheet() {
  sheetEl.hidden = true;
  sheetKind = '';
}

document.getElementById('home-btn').addEventListener('click', () => mvp.home());
document.getElementById('chevron').addEventListener('click', () => mvp.toggleBar());
document.getElementById('edit-btn').addEventListener('click', () => {
  mvp.setEditing(!(current && current.editing));
});
document.getElementById('menu-btn').addEventListener('click', () => {
  menuEl.hidden = !menuEl.hidden;
  document.getElementById('menu-btn').setAttribute('aria-expanded', menuEl.hidden ? 'false' : 'true');
});
document.getElementById('menu-quit').addEventListener('click', () => mvp.quit());
document.getElementById('back').addEventListener('click', () => mvp.back());
document.getElementById('forward').addEventListener('click', () => mvp.forward());
document.getElementById('reload').addEventListener('click', () => mvp.reload());
document.getElementById('new-tab').addEventListener('click', () => mvp.newTab());
document.getElementById('win-min').addEventListener('click', () => mvp.window('minimize'));
document.getElementById('win-max').addEventListener('click', () => mvp.window('maximize'));
document.getElementById('win-close').addEventListener('click', () => mvp.window('close'));

document.getElementById('omnibox').addEventListener('submit', (event) => {
  event.preventDefault();
  mvp.navigate(addressEl.value);
  addressEl.blur();
});

document.getElementById('sheet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.getElementById('sheet-name').value;
  const error = document.getElementById('sheet-error');
  const result = sheetKind === 'profile'
    ? await mvp.addProfile(name)
    : await mvp.addShortcut({ name, url: document.getElementById('sheet-url').value });
  if (result && result.ok === false) {
    error.hidden = false;
    error.textContent = result.error || 'No se pudo agregar.';
    return;
  }
  closeSheet();
});

document.getElementById('sheet-cancel').addEventListener('click', closeSheet);
sheetEl.addEventListener('click', (event) => {
  if (event.target === sheetEl) closeSheet();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSheet();
    closePopovers();
    if (current && current.editing) mvp.setEditing(false);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    if (!current || current.mode !== 'browse' || !current.barOpen) mvp.toggleBar();
    addressEl.focus();
    addressEl.select();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') {
    event.preventDefault();
    mvp.newTab();
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!menuEl.hidden && !menuEl.contains(event.target) && event.target !== document.getElementById('menu-btn')) {
    menuEl.hidden = true;
  }
  if (!slashEl.hidden && !slashEl.contains(event.target)) closeSlash();
});

mvp.onState(apply);
mvp.getState().then(apply);

'use strict';

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const emptyEl = $('empty');
const searchEl = $('search');
const neverSection = $('never-section');
const neverList = $('never-list');
const editor = $('editor');
const editorTitle = $('editor-title');
const siteField = $('site-field');
const siteInput = $('editor-site');
const userInput = $('editor-username');
const passInput = $('editor-password');
const editorError = $('editor-error');

const MASK = '••••••••••';

/** @type {{ credentials: Array<{ id: string, origin: string, username: string }>, neverSave: string[], settings: { offerToSave: boolean, autofill: boolean }, canEncrypt: boolean } | null} */
let data = null;
/** @type {string | null} id que se está editando; '' es uno nuevo */
let editingId = null;
/** Claves a la vista: id → texto. */
const revealed = new Map();

function hostOf(origin) {
  try {
    return new URL(origin).host.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

function button(label, onClick, extraClass = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${extraClass}`.trim();
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function siteBadge(origin) {
  const badge = document.createElement('span');
  badge.className = 'site-badge';
  badge.textContent = hostOf(origin).charAt(0) || '?';
  return badge;
}

function renderCredentials() {
  const query = searchEl.value.trim().toLowerCase();
  const items = data.credentials.filter(
    (c) => !query || c.origin.toLowerCase().includes(query) || c.username.toLowerCase().includes(query)
  );
  listEl.replaceChildren();
  for (const c of items) {
    const row = document.createElement('li');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'row-main';
    const site = document.createElement('span');
    site.className = 'row-site';
    site.textContent = hostOf(c.origin);
    site.title = c.origin;
    const user = document.createElement('span');
    user.className = 'row-user';
    user.textContent = c.username || 'Sin usuario';
    main.append(site, user);

    const secret = document.createElement('span');
    secret.className = 'row-secret';
    secret.textContent = revealed.has(c.id) ? revealed.get(c.id) : MASK;

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(
      button(revealed.has(c.id) ? 'Ocultar' : 'Ver', async () => {
        if (revealed.has(c.id)) revealed.delete(c.id);
        else revealed.set(c.id, await window.passwords.reveal(c.id));
        renderCredentials();
      }),
      button('Copiar', () => window.passwords.copyPassword(c.id)),
      button('Editar', () => openEditor(c)),
      button(
        'Borrar',
        async () => {
          if (!confirm(`¿Borrar la contraseña de ${c.username || 'este usuario'} en ${hostOf(c.origin)}?`)) return;
          revealed.delete(c.id);
          await window.passwords.remove(c.id);
        },
        'danger'
      )
    );

    row.append(siteBadge(c.origin), main, secret, actions);
    listEl.append(row);
  }
  emptyEl.hidden = items.length > 0;
  emptyEl.textContent = data.credentials.length
    ? 'Ninguna contraseña coincide con la búsqueda.'
    : 'Todavía no hay contraseñas guardadas.';
}

function renderNeverSave() {
  neverList.replaceChildren();
  for (const origin of data.neverSave) {
    const row = document.createElement('li');
    row.className = 'row';
    const main = document.createElement('div');
    main.className = 'row-main';
    const site = document.createElement('span');
    site.className = 'row-site';
    site.textContent = hostOf(origin);
    site.title = origin;
    main.append(site);
    row.append(siteBadge(origin), main, button('Quitar', () => window.passwords.removeNeverSave(origin)));
    neverList.append(row);
  }
  neverSection.hidden = data.neverSave.length === 0;
}

function render() {
  if (!data) return;
  $('offer-to-save').checked = !!data.settings.offerToSave;
  $('autofill').checked = !!data.settings.autofill;
  $('encrypt-warning').hidden = data.canEncrypt;
  $('add-btn').disabled = !data.canEncrypt;
  renderCredentials();
  renderNeverSave();
}

async function refresh() {
  data = await window.passwords.get();
  render();
}

/** @param {{ id: string, origin: string, username: string } | null} cred */
function openEditor(cred) {
  editingId = cred ? cred.id : '';
  editorTitle.textContent = cred ? `Editar · ${hostOf(cred.origin)}` : 'Agregar contraseña';
  siteField.hidden = !!cred;
  siteInput.value = '';
  userInput.value = cred ? cred.username : '';
  passInput.value = '';
  passInput.placeholder = cred ? 'Dejala vacía para no cambiarla' : '';
  editorError.hidden = true;
  editor.hidden = false;
  (cred ? userInput : siteInput).focus();
}

function closeEditor() {
  editingId = null;
  editor.hidden = true;
}

editor.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (editingId === null) return;
  const result = await window.passwords.save({
    id: editingId || undefined,
    site: siteInput.value,
    username: userInput.value,
    password: passInput.value,
  });
  if (result && result.ok) {
    if (editingId) revealed.delete(editingId);
    closeEditor();
    return;
  }
  editorError.textContent = (result && result.error) || 'No se pudo guardar';
  editorError.hidden = false;
});

$('editor-cancel').addEventListener('click', closeEditor);
$('add-btn').addEventListener('click', () => openEditor(null));
searchEl.addEventListener('input', renderCredentials);
$('offer-to-save').addEventListener('change', (ev) =>
  window.passwords.setSettings({ offerToSave: ev.target.checked })
);
$('autofill').addEventListener('change', (ev) => window.passwords.setSettings({ autofill: ev.target.checked }));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !editor.hidden) closeEditor();
});

window.passwords.onChanged(() => refresh());
refresh();

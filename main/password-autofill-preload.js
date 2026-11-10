'use strict';

/**
 * Preload de las pestañas de la navegación suelta: avisa al main cuando se envía
 * un login (para ofrecer guardarlo) y completa el que haya guardado para el sitio.
 */

const { ipcRenderer } = require('electron');

const USER_SELECTOR = [
  'input[autocomplete~="username"]',
  'input[autocomplete~="email"]',
  'input[type="email"]',
  'input[type="text"]',
  'input[type="tel"]',
  'input:not([type])',
].join(',');
const LAST_USER_KEY = '__inplaizeLastLoginUser';
const FILL_WATCH_MS = 30 * 1000;

function isWebPage() {
  return location.protocol === 'https:' || location.protocol === 'http:';
}

/** @param {Element} el */
function isVisible(el) {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** @param {ParentNode} scope */
function passwordFields(scope) {
  return [...scope.querySelectorAll('input[type="password"]')].filter(isVisible);
}

/** @param {HTMLInputElement} el */
function looksLikeUsername(el) {
  const hint = `${el.name} ${el.id} ${el.autocomplete} ${el.type}`.toLowerCase();
  return /user|mail|login|identifier|account|cuenta|usuario/.test(hint);
}

/**
 * El campo de usuario de un formulario: el texto visible más cercano antes de la clave.
 * @param {HTMLInputElement} pw
 * @param {{ withValue?: boolean }} [opts]
 */
function usernameFieldFor(pw, opts = {}) {
  const scope = pw.form || document;
  const inputs = [...scope.querySelectorAll('input')];
  for (let i = inputs.indexOf(pw) - 1; i >= 0; i -= 1) {
    const el = inputs[i];
    if (!el.matches(USER_SELECTOR) || !isVisible(el)) continue;
    if (opts.withValue && !el.value.trim()) continue;
    return el;
  }
  return null;
}

/** @param {HTMLInputElement} el @param {string} value */
function setFieldValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function rememberedUser() {
  try {
    return sessionStorage.getItem(LAST_USER_KEY) || '';
  } catch {
    return '';
  }
}

let lastSent = '';
let lastSentAt = 0;

/** @param {HTMLInputElement} pw */
function capture(pw) {
  const password = pw.value;
  if (!password) return;
  const userEl = usernameFieldFor(pw, { withValue: true });
  const username = ((userEl && userEl.value) || rememberedUser()).trim();
  const key = `${username}\n${password}`;
  if (key === lastSent && Date.now() - lastSentAt < 3000) return;
  lastSent = key;
  lastSentAt = Date.now();
  ipcRenderer.send('password-captured', { username, password });
}

/** @param {ParentNode} scope */
function captureIn(scope) {
  const pw = passwordFields(scope).find((el) => el.value);
  if (pw) capture(pw);
}

function watchLogins() {
  // Logins en dos pasos (primero el mail, después la clave): el usuario queda del paso anterior.
  document.addEventListener(
    'change',
    (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLInputElement) || !el.matches(USER_SELECTOR) || !looksLikeUsername(el)) return;
      const value = el.value.trim();
      if (!value) return;
      try {
        sessionStorage.setItem(LAST_USER_KEY, value);
      } catch {
        /* noop */
      }
    },
    true
  );

  document.addEventListener(
    'submit',
    (ev) => {
      if (ev.target instanceof HTMLFormElement) captureIn(ev.target);
    },
    true
  );

  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Enter') return;
      const el = ev.target;
      if (!(el instanceof HTMLInputElement)) return;
      if (el.type === 'password') capture(el);
      else if (el.form) captureIn(el.form);
    },
    true
  );

  // Muchos sitios no envían el formulario: el botón de "Iniciar sesión" lo hace por JS.
  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target instanceof Element ? ev.target : null;
      const btn = target && target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
      if (!btn) return;
      captureIn(btn.closest('form') || document);
    },
    true
  );
}

/** @type {Array<{ id: string, username: string, password: string }> | null} */
let credentials = null;
let filled = false;

async function loadCredentials() {
  if (credentials) return credentials;
  try {
    const list = await ipcRenderer.invoke('password-fill-request');
    credentials = Array.isArray(list) ? list : [];
  } catch {
    credentials = [];
  }
  return credentials;
}

async function tryFill() {
  if (filled) return;
  const pw = passwordFields(document).find((el) => !el.value);
  const userOnly = pw
    ? null
    : [...document.querySelectorAll(USER_SELECTOR)].find(
        (el) => isVisible(el) && !el.value && looksLikeUsername(el)
      );
  if (!pw && !userOnly) return;
  const list = await loadCredentials();
  if (!list.length || filled) return;
  const cred = list[0];
  if (pw) {
    const userEl = usernameFieldFor(pw);
    if (userEl && !userEl.value && cred.username) setFieldValue(userEl, cred.username);
    setFieldValue(pw, cred.password);
    filled = true;
    ipcRenderer.send('password-filled', cred.id);
  } else if (userOnly && cred.username) {
    setFieldValue(userOnly, cred.username);
  }
}

function watchForms() {
  let timer = null;
  const schedule = () => {
    if (timer || filled) return;
    timer = setTimeout(() => {
      timer = null;
      tryFill().catch(() => {});
    }, 300);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), FILL_WATCH_MS);
  schedule();
}

if (isWebPage()) {
  window.addEventListener('DOMContentLoaded', () => {
    watchLogins();
    watchForms();
  });
}

'use strict';

const PALETTE = [
  ['#eef2ff', '#4338ca'],
  ['#fce7f3', '#be185d'],
  ['#ecfdf5', '#047857'],
  ['#fff7ed', '#c2410c'],
  ['#f5f3ff', '#6d28d9'],
  ['#eff6ff', '#1d4ed8'],
];

function colorsFor(label) {
  let hash = 0;
  const text = String(label || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

function initialOf(label) {
  const text = String(label || '').trim();
  if (!text) return '?';
  return Array.from(text)[0].toUpperCase();
}

const card = document.getElementById('card');
const messageEl = document.getElementById('message');
const detailEl = document.getElementById('detail');
const choicesEl = document.getElementById('choices');
const rememberWrap = document.getElementById('remember-wrap');
const rememberInput = document.getElementById('remember');
const rememberLabel = document.getElementById('remember-label');
const cancelBtn = document.getElementById('cancel');
const closeBtn = document.getElementById('close');

function dismiss() {
  window.choicePrompt.choose(null, false);
}

function reportSize() {
  const width = Math.ceil(card.offsetWidth + 80);
  const height = Math.ceil(card.offsetHeight + 80);
  window.choicePrompt.resize(width, height);
}

window.choicePrompt.onData((data) => {
  const payload = data && typeof data === 'object' ? data : {};
  messageEl.textContent = payload.message || '';
  detailEl.textContent = payload.detail || '';
  detailEl.hidden = !payload.detail;
  choicesEl.replaceChildren();

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice.id !== 'string') continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = initialOf(choice.label);
    const [bg, fg] = colorsFor(choice.label);
    avatar.style.background = bg;
    avatar.style.color = fg;

    const text = document.createElement('span');
    text.className = 'choice-text';
    const label = document.createElement('span');
    label.className = 'choice-label';
    label.textContent = choice.label || 'Usuario';
    text.append(label);
    if (typeof choice.hint === 'string' && choice.hint.trim()) {
      const hint = document.createElement('span');
      hint.className = 'choice-hint';
      hint.textContent = choice.hint.trim();
      text.append(hint);
    }

    button.append(avatar, text);
    button.addEventListener('click', () => {
      window.choicePrompt.choose(choice.id, !!rememberInput.checked);
    });
    choicesEl.append(button);
  }

  cancelBtn.textContent = payload.cancelLabel || 'Cancelar';
  if (payload.rememberLabel) {
    rememberWrap.hidden = false;
    rememberLabel.textContent = payload.rememberLabel;
  } else {
    rememberWrap.hidden = true;
    rememberInput.checked = false;
  }

  requestAnimationFrame(reportSize);
});

cancelBtn.addEventListener('click', dismiss);
closeBtn.addEventListener('click', dismiss);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismiss();
});

window.choicePrompt.ready();

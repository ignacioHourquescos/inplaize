const form = document.getElementById('form');
const input = document.getElementById('input');
const errorEl = document.getElementById('error');

function looksLikeUrl(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2000 || /\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?([/?#].*)?$/i.test(t)) return true;
  return /^[a-z0-9.-]+\.[a-z]{2,}([/?#].*)?$/i.test(t);
}

function showError(message) {
  input.classList.add('is-invalid');
  errorEl.textContent = message || 'No se pudo abrir';
  errorEl.hidden = false;
  input.focus();
}

function clearError() {
  input.classList.remove('is-invalid');
  errorEl.textContent = '';
  errorEl.hidden = true;
}

input.focus();

if (navigator.clipboard && navigator.clipboard.readText) {
  navigator.clipboard.readText().then((text) => {
    const t = String(text || '').trim();
    if (!input.value && looksLikeUrl(t)) {
      input.value = t;
      input.select();
    }
  }).catch(() => {});
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) {
    input.focus();
    return;
  }
  clearError();
  try {
    const res = await window.urlPrompt.submit(value);
    if (!res || res.ok === false) showError((res && res.error) || 'No se pudo abrir');
  } catch {
    showError('No se pudo abrir');
  }
});

input.addEventListener('input', () => {
  if (input.classList.contains('is-invalid')) clearError();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.urlPrompt.cancel();
  }
});

/**
 * La franja de perfiles tiene que verse igual que la de un acceso:
 * inplaize y Descargas con contorno, y el toggle como línea con chevron.
 * El estilo en línea gana a cualquier hoja que vuelva a pintar la pastilla violeta.
 */
(function lockStripChrome() {
  const HOME = '#dock-home-btn, #dock-downloads-btn, #shell-home-btn, #shell-downloads-btn';

  function token(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function paint() {
    const text = token('--ud-chrome-text', '#e8e8ef');
    const bg = token('--ud-chrome-strip-bg', '#121216');
    const muted = token('--ud-chrome-icon-muted', '#c8c8d4');
    const divider = token('--ud-chrome-divider', '#3f3f48');

    document.querySelectorAll(HOME).forEach((btn) => {
      btn.style.setProperty('background', 'transparent', 'important');
      btn.style.setProperty('background-image', 'none', 'important');
      btn.style.setProperty('box-shadow', 'none', 'important');
      const mark = btn.querySelector('.dock-home-logo-mark');
      if (!mark) return;
      mark.style.setProperty('width', '26px', 'important');
      mark.style.setProperty('height', '26px', 'important');
      mark.style.setProperty('border-radius', '8px', 'important');
      mark.style.setProperty('background', bg, 'important');
      mark.style.setProperty('background-image', 'none', 'important');
      mark.style.setProperty('color', text, 'important');
      mark.style.setProperty('border', '1.5px solid ' + text, 'important');
      mark.style.setProperty('box-shadow', 'none', 'important');
    });

    const toggle = document.getElementById('strip-search');
    if (!toggle) return;
    toggle.style.setProperty('flex', '0 0 26px', 'important');
    toggle.style.setProperty('width', '26px', 'important');
    toggle.style.setProperty('min-width', '26px', 'important');
    toggle.style.setProperty('max-width', '26px', 'important');
    toggle.style.setProperty('height', 'auto', 'important');
    toggle.style.setProperty('align-self', 'stretch', 'important');
    toggle.style.setProperty('border-radius', '0', 'important');
    toggle.style.setProperty('background', 'transparent', 'important');
    toggle.style.setProperty('background-image', 'none', 'important');
    toggle.style.setProperty('border', 'none', 'important');
    toggle.style.setProperty('box-shadow', 'none', 'important');
    toggle.style.setProperty('clip-path', 'none', 'important');

    const line = toggle.querySelector('.strip-search-line');
    if (line) {
      line.style.setProperty('display', 'block', 'important');
      line.style.setProperty('background', divider, 'important');
    }

    const mark = toggle.querySelector('.strip-search-mark');
    if (!mark) return;
    const open = toggle.getAttribute('aria-expanded') === 'true';
    const hot = toggle.matches(':hover');
    mark.style.setProperty('width', '22px', 'important');
    mark.style.setProperty('height', '18px', 'important');
    mark.style.setProperty('min-width', '22px', 'important');
    mark.style.setProperty('min-height', '18px', 'important');
    mark.style.setProperty('border-radius', '6px', 'important');
    mark.style.setProperty('background', bg, 'important');
    mark.style.setProperty('background-image', 'none', 'important');
    mark.style.setProperty('color', open || hot ? text : muted, 'important');
    mark.style.setProperty('box-shadow', 'none', 'important');
  }

  function boot() {
    paint();
    const root = document.getElementById('sidebar-chrome') || document.querySelector('.shell-top') || document.body;
    const observer = new MutationObserver(() => paint());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui-theme', 'data-canvas-theme', 'data-bar-sprout', 'data-loose-nav'],
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-expanded'],
    });
    document.documentElement.addEventListener('pointerover', (ev) => {
      if (ev.target.closest && ev.target.closest('#strip-search')) paint();
    }, true);
    document.documentElement.addEventListener('pointerout', (ev) => {
      if (ev.target.closest && ev.target.closest('#strip-search')) paint();
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

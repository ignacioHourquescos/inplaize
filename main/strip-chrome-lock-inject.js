'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let cachedCss = '';

function lockCss() {
  if (cachedCss) return cachedCss;
  try {
    const root = app.getAppPath();
    cachedCss = fs.readFileSync(path.join(root, 'strip-chrome-lock.css'), 'utf8');
  } catch {
    cachedCss = '';
  }
  return cachedCss;
}

/**
 * Pinta la franja correcta aunque el renderer tenga CSS viejo en caché.
 * @param {Electron.WebContents | null | undefined} webContents
 */
function injectStripChromeLock(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  const css = lockCss();
  if (!css) return;
  const paintJs = `
(() => {
  const HOME = '#dock-home-btn, #dock-downloads-btn, #shell-home-btn, #shell-downloads-btn';
  const token = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };
  const paint = () => {
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
    mark.style.setProperty('width', '22px', 'important');
    mark.style.setProperty('height', '18px', 'important');
    mark.style.setProperty('min-width', '22px', 'important');
    mark.style.setProperty('min-height', '18px', 'important');
    mark.style.setProperty('border-radius', '6px', 'important');
    mark.style.setProperty('background', bg, 'important');
    mark.style.setProperty('background-image', 'none', 'important');
    mark.style.setProperty('color', open ? text : muted, 'important');
    mark.style.setProperty('box-shadow', 'none', 'important');
  };
  paint();
  if (!window.__stripChromeLockInjected) {
    window.__stripChromeLockInjected = true;
    const root = document.getElementById('sidebar-chrome') || document.querySelector('.shell-top') || document.body;
    const obs = new MutationObserver(() => paint());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-theme', 'data-canvas-theme', 'data-bar-sprout', 'data-loose-nav'] });
    if (root) obs.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-expanded'] });
  }
})();
`;
  Promise.resolve()
    .then(() => webContents.insertCSS(css))
    .then(() => webContents.executeJavaScript(paintJs, true))
    .catch(() => {});
}

/**
 * @param {Electron.WebContents | null | undefined} webContents
 */
function attachStripChromeLock(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  const run = () => injectStripChromeLock(webContents);
  webContents.on('did-finish-load', run);
  if (!webContents.isLoading()) run();
}

module.exports = { injectStripChromeLock, attachStripChromeLock };

/**
 * Reparte el ancho cuando las pestañas no entran.
 * Todas quedan del mismo ancho y la suma entra en la fila.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UsualDeskTabStripFit = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PREFERRED = 220;
  const MIN = 64;

  /**
   * @param {number} count
   * @param {number} available
   * @param {number} [preferred]
   * @param {number} [minWidth]
   * @returns {number[]}
   */
  function tabStripWidths(count, available, preferred) {
    const n = count | 0;
    if (n <= 0) return [];
    const pref = Math.max(1, preferred == null ? PREFERRED : preferred);
    const room = Math.max(n, Math.floor(Number.isFinite(available) ? available : n * pref));
    if (room >= n * pref) return Array(n).fill(pref);
    const each = Math.max(1, Math.floor(room / n));
    return new Array(n).fill(each);
  }

  /** Parte la dirección: el esquema casi no se ve, el dominio va en negrita y el resto más fino. */
  function splitAddress(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    const match = value.match(/^(https?:\/\/)([^/]*)(.*)$/i);
    if (!match) return { scheme: '', host: value, rest: '' };
    return { scheme: match[1], host: match[2], rest: match[3] };
  }

  function paintAddressFace(el, raw) {
    if (!el) return;
    const parts = splitAddress(raw);
    el.replaceChildren();
    if (!parts || (!parts.host && !parts.rest)) {
      el.classList.add('is-empty');
      return;
    }
    el.classList.remove('is-empty');
    if (parts.scheme) {
      const scheme = document.createElement('span');
      scheme.className = 'omnibox-scheme';
      scheme.textContent = parts.scheme;
      el.appendChild(scheme);
    }
    const host = document.createElement('span');
    host.className = 'omnibox-host';
    host.textContent = parts.host;
    el.appendChild(host);
    if (parts.rest) {
      const rest = document.createElement('span');
      rest.className = 'omnibox-rest';
      rest.textContent = parts.rest;
      el.appendChild(rest);
    }
  }

  /**
   * @param {HTMLElement | null} strip
   * @param {string} tabSelector
   */
  function fitTabStrip(strip, tabSelector) {
    if (!strip || !strip.parentElement) return;
    const cluster = strip.parentElement;
    if (cluster.clientWidth < 8) return;

    const tabs = [...strip.querySelectorAll(tabSelector)];
    const fixed = [];
    const flow = [];
    for (const el of tabs) {
      if (el.classList.contains('is-pinned') || el.classList.contains('is-composing')) fixed.push(el);
      else flow.push(el);
    }
    for (const el of flow) {
      el.style.flex = '';
      el.style.width = '';
    }
    for (const el of fixed) {
      el.style.width = '';
      el.style.flex = el.classList.contains('is-composing') ? '0 0 320px' : '0 0 auto';
    }

    const stripStyle = getComputedStyle(strip);
    const gap = parseFloat(stripStyle.columnGap || stripStyle.gap) || 0;
    const clusterStyle = getComputedStyle(cluster);
    const clusterGap = parseFloat(clusterStyle.columnGap || clusterStyle.gap) || 0;
    const kids = [...cluster.children];
    let taken = 0;
    for (const kid of kids) {
      if (kid !== strip) taken += kid.offsetWidth;
    }
    if (kids.length > 1) taken += clusterGap * (kids.length - 1);

    const pad = (parseFloat(stripStyle.paddingLeft) || 0) + (parseFloat(stripStyle.paddingRight) || 0);
    const fixedW = fixed.reduce((sum, el) => sum + el.offsetWidth, 0);
    const gaps = Math.max(0, tabs.length - 1) * gap;
    const available = cluster.clientWidth - taken - pad - fixedW - gaps;
    const widths = tabStripWidths(flow.length, available);
    flow.forEach((el, i) => {
      const w = widths[i];
      el.style.flex = `0 0 ${w}px`;
      el.style.width = `${w}px`;
    });
  }

  /** @param {HTMLElement | null} strip */
  function watchTabStrip(strip, tabSelector) {
    if (!strip || !strip.parentElement || strip.__tabFitWatch) return;
    strip.__tabFitWatch = true;
    const cluster = strip.parentElement;
    const run = () => fitTabStrip(strip, tabSelector);
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(run);
      observer.observe(cluster);
    } else {
      window.addEventListener('resize', run);
    }
  }

  /** URL ya no es columna lateral: leading = contenido; no sincronizar anchos. */
  function alignStripLeading() {
    if (typeof document === 'undefined') return;
    document.documentElement.style.removeProperty('--ud-strip-lead-w');
  }

  /** @deprecated La dirección es fila completa; no hay split. */
  function bindUrlColumnSplit() {
    /* no-op */
  }

  return { fitTabStrip, tabStripWidths, watchTabStrip, bindUrlColumnSplit, alignStripLeading, paintAddressFace, PREFERRED, MIN };
});

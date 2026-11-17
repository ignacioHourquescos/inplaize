'use strict';

/**
 * Dibujos de las tarjetas de tema en Configuración.
 *
 * Cada dibujo es el contenido de un SVG de 120×64. Los colores `var(--th-*)`,
 * `var(--key-line)` y `var(--secondary)` salen del tema de la tarjeta:
 * themes.css los define en `.theme-preview[data-ui-theme]`.
 *
 * Los `id` de degradados, filtros y máscaras llevan el nombre del tema porque
 * todos los SVG conviven en el mismo documento.
 */
(function () {
  const VIEW_W = 120;
  const VIEW_H = 64;

  const n = (v) => Math.round(v * 10) / 10;

  function background(fill) {
    return `<rect width="${VIEW_W}" height="${VIEW_H}" style="fill:${fill}"/>`;
  }

  /** @param {Array<[number, number, number, number?]>} points x, y, radio y opacidad */
  function dots(points, fill) {
    return points
      .map(([x, y, r, o]) => `<circle cx="${x}" cy="${y}" r="${r}" style="fill:${fill}" opacity="${o == null ? 1 : o}"/>`)
      .join('');
  }

  /* ---------------- Oscuro: eclipse ---------------- */

  function darkArt() {
    return (
      '<defs><radialGradient id="ta-dark-corona">' +
      '<stop offset="0.4" style="stop-color:var(--key-line)" stop-opacity="0.95"/>' +
      '<stop offset="0.62" style="stop-color:var(--th-accent)" stop-opacity="0.6"/>' +
      '<stop offset="1" style="stop-color:var(--th-accent)" stop-opacity="0"/>' +
      '</radialGradient></defs>' +
      background('var(--th-canvas)') +
      '<circle cx="60" cy="32" r="31" fill="url(#ta-dark-corona)"/>' +
      '<circle cx="60" cy="32" r="13" style="fill:var(--th-canvas)"/>' +
      '<circle cx="60" cy="32" r="13.3" fill="none" stroke="#fff" stroke-opacity="0.75" stroke-width="0.8"/>' +
      '<circle cx="69.6" cy="22.6" r="4" fill="#fff" opacity="0.3"/>' +
      '<circle cx="69.6" cy="22.6" r="2" fill="#fff"/>' +
      dots(
        [
          [14, 12, 1.1], [26, 44, 0.8, 0.8], [18, 28, 0.6, 0.7], [36, 54, 0.6, 0.6],
          [100, 14, 0.8, 0.8], [108, 40, 1.1], [94, 52, 0.7, 0.7], [112, 26, 0.6, 0.6],
        ],
        'var(--secondary)',
      )
    );
  }

  /* ---------------- Medianoche: luna y ciudad ---------------- */

  function midnightArt() {
    const windows = [
      [24.5, 41], [28, 41], [24.5, 46], [28, 51],
      [60.5, 43], [64, 48],
      [76.5, 39], [80, 39], [76.5, 44], [80, 50],
      [108.5, 45], [111.5, 50], [10, 47], [44.5, 46],
    ];
    return (
      '<defs>' +
      '<linearGradient id="ta-midnight-sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--th-canvas)"/>' +
      '<stop offset="1" style="stop-color:var(--th-hover)"/>' +
      '</linearGradient>' +
      `<mask id="ta-midnight-moon"><rect width="${VIEW_W}" height="${VIEW_H}" fill="#fff"/>` +
      '<circle cx="91" cy="16.5" r="9.5" fill="#000"/></mask>' +
      '</defs>' +
      `<rect width="${VIEW_W}" height="${VIEW_H}" fill="url(#ta-midnight-sky)"/>` +
      dots(
        [
          [14, 10, 1], [30, 20, 0.7, 0.8], [44, 8, 0.9], [58, 17, 0.7, 0.7], [66, 28, 0.6, 0.6],
          [106, 9, 0.8, 0.9], [110, 30, 0.7, 0.7], [20, 31, 0.6, 0.6], [72, 7, 0.6, 0.8],
        ],
        'var(--th-text)',
      ) +
      '<circle cx="86" cy="20" r="17" style="fill:var(--key-line)" opacity="0.12"/>' +
      '<circle cx="86" cy="20" r="11" fill="#fef3c7" mask="url(#ta-midnight-moon)"/>' +
      '<path fill="#050914" d="M0 64V50H8V44H16V52H22V38H32V48H38V42H42V34H44V42H50V50H58V40H68V46H74V36H84V50H90V44' +
      'H100V52H106V42H114V48H120V64Z"/>' +
      windows
        .map(([x, y], i) => {
          const fill = i % 4 === 3 ? 'var(--key-line)' : 'var(--secondary)';
          return `<rect x="${x}" y="${y}" width="1.6" height="1.8" style="fill:${fill}"/>`;
        })
        .join('')
    );
  }

  /* ---------------- Neón: cartel de tubos ---------------- */

  function neonArt() {
    const tubes = (frame, letters, width) =>
      `<g fill="none" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">` +
      `<rect x="22" y="13" width="76" height="38" rx="9" style="stroke:${frame}"/>` +
      `<g style="stroke:${letters}">` +
      '<path d="M32.5 41V23L42.5 41V23"/>' +
      '<path d="M57.5 23H47.5V41H57.5M47.5 32H55"/>' +
      '<rect x="62.5" y="23" width="10" height="18" rx="5"/>' +
      '<path d="M77.5 41V23L87.5 41V23"/>' +
      '</g></g>';
    return (
      '<defs>' +
      '<pattern id="ta-neon-brick" width="16" height="10" patternUnits="userSpaceOnUse">' +
      '<path d="M0 0.3H16M0 5.3H16M4 0.3V5.3M12 5.3V10.3" fill="none" stroke-width="0.5"' +
      ' style="stroke:var(--th-line)"/></pattern>' +
      `<filter id="ta-neon-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${VIEW_W}" height="${VIEW_H}">` +
      '<feGaussianBlur stdDeviation="2.4"/></filter>' +
      '<radialGradient id="ta-neon-wash">' +
      '<stop offset="0" style="stop-color:var(--key-line)" stop-opacity="0.3"/>' +
      '<stop offset="1" style="stop-color:var(--key-line)" stop-opacity="0"/>' +
      '</radialGradient>' +
      '</defs>' +
      background('var(--th-canvas)') +
      `<rect width="${VIEW_W}" height="${VIEW_H}" fill="url(#ta-neon-brick)" opacity="0.55"/>` +
      '<ellipse cx="60" cy="32" rx="56" ry="32" fill="url(#ta-neon-wash)"/>' +
      '<path d="M40 0V13M80 0V13" fill="none" stroke-width="0.8" style="stroke:var(--th-muted)" opacity="0.6"/>' +
      `<g filter="url(#ta-neon-glow)">${tubes('var(--key-line)', '#67e8f9', 3.2)}</g>` +
      tubes('var(--key-line)', '#67e8f9', 1.9) +
      `<g opacity="0.85">${tubes('#fff', '#fff', 0.55)}</g>`
    );
  }

  /* ---------------- Bosque: pinos y luciérnagas ---------------- */

  /** Pino de tres pisos con la punta en `base - h`. */
  function pine(x, base, h, w) {
    const top = base - h;
    const y1 = top + h * 0.38;
    const y2 = top + h * 0.68;
    return (
      `M${n(x)} ${n(top)}L${n(x + w * 0.3)} ${n(y1)}H${n(x + w * 0.14)}L${n(x + w * 0.42)} ${n(y2)}H${n(x + w * 0.2)}` +
      `L${n(x + w * 0.5)} ${n(base)}H${n(x - w * 0.5)}L${n(x - w * 0.2)} ${n(y2)}H${n(x - w * 0.42)}` +
      `L${n(x - w * 0.14)} ${n(y1)}H${n(x - w * 0.3)}Z`
    );
  }

  /** @param {Array<[number, number, number]>} trees x, alto y ancho */
  function pineRow(trees, base) {
    return trees.map(([x, h, w]) => pine(x, base, h, w)).join('');
  }

  function forestArt() {
    const fireflies = [[18, 12], [45, 19], [62, 8], [90, 14], [52, 36], [112, 24], [9, 32]];
    return (
      '<defs><linearGradient id="ta-forest-sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--th-canvas)"/>' +
      '<stop offset="1" style="stop-color:var(--th-line)"/>' +
      '</linearGradient></defs>' +
      `<rect width="${VIEW_W}" height="${VIEW_H}" fill="url(#ta-forest-sky)"/>` +
      `<path d="${pineRow([[6, 30, 16], [22, 34, 18], [40, 28, 16], [57, 33, 18], [75, 29, 16], [92, 34, 18], [110, 30, 17]], 66)}"` +
      ' style="fill:var(--th-accent)" opacity="0.5"/>' +
      `<path d="${pineRow([[14, 40, 22], [36, 36, 20], [62, 42, 22], [86, 37, 20], [106, 41, 22]], 68)}"` +
      ' style="fill:var(--th-hover)"/>' +
      `<path d="${pineRow([[0, 48, 26], [28, 44, 24], [74, 50, 26], [100, 45, 24], [122, 48, 26]], 70)}" fill="#06100b"/>` +
      fireflies
        .map(
          ([x, y]) =>
            `<circle cx="${x}" cy="${y}" r="3.2" style="fill:var(--secondary)" opacity="0.22"/>` +
            `<circle cx="${x}" cy="${y}" r="1.1" style="fill:var(--secondary)"/>`,
        )
        .join('')
    );
  }

  /* ---------------- Atardecer: sol sobre el agua ---------------- */

  function sunsetArt() {
    const horizon = 40;
    const reflections = [[42.5, 28], [46.5, 20], [50.5, 14], [54.5, 9], [58.5, 5]];
    return (
      '<defs>' +
      '<linearGradient id="ta-sunset-sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--th-field)"/>' +
      '<stop offset="0.55" style="stop-color:var(--th-accent)"/>' +
      '<stop offset="0.88" style="stop-color:var(--key-line)"/>' +
      '<stop offset="1" stop-color="#fdba74"/>' +
      '</linearGradient>' +
      '<linearGradient id="ta-sunset-sea" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--th-accent-2)"/>' +
      '<stop offset="1" style="stop-color:var(--th-canvas)"/>' +
      '</linearGradient>' +
      '<radialGradient id="ta-sunset-halo">' +
      '<stop offset="0.5" stop-color="#fff7c2" stop-opacity="0.55"/>' +
      '<stop offset="1" stop-color="#fff7c2" stop-opacity="0"/>' +
      '</radialGradient>' +
      '</defs>' +
      `<rect width="${VIEW_W}" height="${horizon}" fill="url(#ta-sunset-sky)"/>` +
      `<circle cx="60" cy="${horizon}" r="24" fill="url(#ta-sunset-halo)"/>` +
      `<circle cx="60" cy="${horizon}" r="12" style="fill:var(--secondary)"/>` +
      '<path d="M24 14q2.5-2.5 5 0q2.5-2.5 5 0M38 21q2-2 4 0q2-2 4 0" fill="none" stroke-width="0.9"' +
      ' stroke-linecap="round" style="stroke:var(--th-canvas)" opacity="0.8"/>' +
      `<rect y="${horizon}" width="${VIEW_W}" height="${VIEW_H - horizon}" fill="url(#ta-sunset-sea)"/>` +
      reflections
        .map(
          ([y, w], i) =>
            `<rect x="${n(60 - w / 2)}" y="${y}" width="${w}" height="1.8" rx="0.9" style="fill:var(--secondary)"` +
            ` opacity="${n(0.95 - i * 0.14)}"/>`,
        )
        .join('')
    );
  }

  /* ---------------- Claro: sol con rayos ---------------- */

  function lightArt() {
    let rays = '';
    for (let i = 0; i < 8; i += 1) {
      const a = (i * Math.PI) / 4;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      rays += `M${n(60 + cos * 15)} ${n(32 + sin * 15)}L${n(60 + cos * 21)} ${n(32 + sin * 21)}`;
    }
    return (
      '<defs><linearGradient id="ta-light-sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--th-canvas)"/>' +
      '<stop offset="1" style="stop-color:var(--th-raise)"/>' +
      '</linearGradient></defs>' +
      `<rect width="${VIEW_W}" height="${VIEW_H}" fill="url(#ta-light-sky)"/>` +
      '<circle cx="60" cy="32" r="27" fill="#fde68a" opacity="0.35"/>' +
      `<path d="${rays}" fill="none" stroke="#f59e0b" stroke-width="2.4" stroke-linecap="round"/>` +
      '<circle cx="60" cy="32" r="10.5" fill="#fbbf24"/>' +
      '<circle cx="57" cy="29" r="4" fill="#fde68a" opacity="0.7"/>'
    );
  }

  /* ---------------- Arena: dunas ---------------- */

  function sandArt() {
    return (
      background('var(--th-canvas)') +
      '<circle cx="90" cy="18" r="14" fill="#f5b54a" opacity="0.22"/>' +
      '<circle cx="90" cy="18" r="7.5" fill="#f0a23b"/>' +
      '<path d="M0 44Q30 30 60 40T120 33V64H0Z" style="fill:var(--th-field)"/>' +
      '<path d="M0 53Q28 40 58 48Q90 56 120 42V64H0Z" style="fill:var(--th-line)"/>' +
      '<path d="M0 61Q40 46 76 56Q100 62 120 54V64H0Z" fill="#c9a569"/>' +
      '<path d="M8 57Q40 47 72 55.5M82 51.5Q100 51 114 45.5" fill="none" stroke-width="0.8" stroke-linecap="round"' +
      ' style="stroke:var(--th-accent)" opacity="0.4"/>'
    );
  }

  /* ---------------- Menta: ramita ---------------- */

  function leaf(x, y, angle, len, wid, fill) {
    return (
      `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(angle)})">` +
      `<path d="M0 0Q${n(len * 0.45)} ${n(-wid)} ${n(len)} 0Q${n(len * 0.45)} ${n(wid)} 0 0Z" style="fill:${fill}"/>` +
      `<path d="M${n(len * 0.14)} 0H${n(len * 0.8)}" fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="0.5"/>` +
      '</g>'
    );
  }

  function mintArt() {
    const p0 = [36, 58];
    const p1 = [54, 42];
    const p2 = [79, 13];
    const at = (t) => [0, 1].map((k) => (1 - t) * (1 - t) * p0[k] + 2 * t * (1 - t) * p1[k] + t * t * p2[k]);
    const heading = (t) => {
      const dx = (1 - t) * (p1[0] - p0[0]) + t * (p2[0] - p1[0]);
      const dy = (1 - t) * (p1[1] - p0[1]) + t * (p2[1] - p1[1]);
      return (Math.atan2(dy, dx) * 180) / Math.PI;
    };
    let leaves = '';
    for (const [t, len, wid] of [[0.18, 19, 6.5], [0.44, 17, 6], [0.68, 13.5, 5], [0.88, 10, 4]]) {
      const [x, y] = at(t);
      const a = heading(t);
      leaves += leaf(x, y, a - 52, len, wid, 'var(--th-accent)') + leaf(x, y, a + 52, len, wid, '#34d399');
    }
    leaves += leaf(p2[0], p2[1], heading(1), 9, 3.6, 'var(--th-accent)');
    return (
      background('var(--th-canvas)') +
      '<circle cx="60" cy="33" r="25" style="fill:var(--th-field)" opacity="0.7"/>' +
      `<path d="M${p0[0]} ${p0[1]}Q${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]}" fill="none" stroke-width="1.5"` +
      ' stroke-linecap="round" style="stroke:var(--th-accent-2)"/>' +
      leaves
    );
  }

  /* ---------------- Lavanda: espigas ---------------- */

  const LAVENDER_BUDS = ['var(--th-accent)', '#a78bfa', 'var(--key-line)'];

  /** Tallo desde abajo hasta (`x1`, `top`) con flores en la mitad de arriba. */
  function lavenderSprig(x0, x1, top, buds) {
    const base = 66;
    const dx = x1 - x0;
    const dy = top - base;
    const len = Math.hypot(dx, dy);
    const tilt = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    const px = -dy / len;
    const py = dx / len;
    let out =
      `<path d="M${x0} ${base}L${x1} ${top}" fill="none" stroke="#6f9a72" stroke-width="1.1" stroke-linecap="round"/>`;
    const bud = (cx, cy, r, turn, fill) =>
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(r * 0.8)}" ry="${n(r * 1.2)}"` +
      ` transform="rotate(${n(tilt + turn)} ${n(cx)} ${n(cy)})" style="fill:${fill}"/>`;
    for (let i = buds - 1; i >= 0; i -= 1) {
      const k = i / (buds - 1);
      const cx = x1 - dx * k * 0.5;
      const cy = top - dy * k * 0.5;
      const r = 1.5 + k * 1.1;
      if (i === 0) {
        out += bud(cx, cy, r, 0, LAVENDER_BUDS[0]);
        continue;
      }
      const off = r * 0.85;
      out +=
        bud(cx + px * off, cy + py * off, r, 28, LAVENDER_BUDS[i % 3]) +
        bud(cx - px * off, cy - py * off, r, -28, LAVENDER_BUDS[(i + 1) % 3]);
    }
    return out;
  }

  function lavenderArt() {
    return (
      background('var(--th-canvas)') +
      '<circle cx="60" cy="40" r="30" style="fill:var(--th-strip)"/>' +
      lavenderSprig(42, 25, 27, 5) +
      lavenderSprig(78, 95, 27, 5) +
      lavenderSprig(50, 42, 16, 6) +
      lavenderSprig(70, 78, 16, 6) +
      lavenderSprig(60, 60, 9, 7)
    );
  }

  /* ---------------- Cielo: nubes y globo ---------------- */

  function cloud(x, y, scale) {
    const shape =
      '<rect x="0" y="8" width="34" height="9" rx="4.5"/><circle cx="9" cy="9" r="6.5"/>' +
      '<circle cx="18" cy="6" r="8"/><circle cx="27" cy="10" r="5.5"/>';
    return (
      `<g transform="translate(${x} ${y}) scale(${scale})">` +
      `<g transform="translate(0 1.6)" style="fill:var(--th-line)" opacity="0.7">${shape}</g>` +
      `<g fill="#fff">${shape}</g></g>`
    );
  }

  function skyArt() {
    return (
      '<defs><linearGradient id="ta-sky-sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--th-line)"/>' +
      '<stop offset="1" style="stop-color:var(--th-field)"/>' +
      '</linearGradient></defs>' +
      `<rect width="${VIEW_W}" height="${VIEW_H}" fill="url(#ta-sky-sky)"/>` +
      cloud(12, 7, 0.55) +
      cloud(92, 14, 0.6) +
      '<path d="M66.5 39.5L69.5 45M77.5 39.5L74.5 45" fill="none" stroke-width="0.6" style="stroke:var(--th-muted)"/>' +
      '<path d="M72 7C84 7 88 17 88 21.5C88 29.5 79 35.5 76 39.5H68C65 35.5 56 29.5 56 21.5C56 17 60 7 72 7Z"' +
      ' style="fill:var(--th-accent)"/>' +
      '<path d="M72 7C77 11 78 19 78 22.5C78 30.5 75 36.5 74 39.5H70C69 36.5 66 30.5 66 22.5C66 19 67 11 72 7Z" fill="#fbbf24"/>' +
      '<rect x="69" y="45" width="6" height="4.6" rx="1" fill="#92400e"/>' +
      cloud(8, 38, 1.05) +
      cloud(86, 46, 0.8)
    );
  }

  /** @type {Record<string, string>} */
  const ART = {
    dark: darkArt(),
    midnight: midnightArt(),
    neon: neonArt(),
    forest: forestArt(),
    sunset: sunsetArt(),
    light: lightArt(),
    sand: sandArt(),
    mint: mintArt(),
    lavender: lavenderArt(),
    sky: skyArt(),
  };

  /**
   * @param {string} themeId id de un tema de canvas-theme.js
   * @returns {string} el SVG del dibujo, o '' si el tema no tiene uno
   */
  function svgFor(themeId) {
    const art = Object.prototype.hasOwnProperty.call(ART, themeId) ? ART[themeId] : '';
    if (!art) return '';
    return (
      `<svg class="theme-art" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid slice"` +
      ` aria-hidden="true" focusable="false">${art}</svg>`
    );
  }

  window.InplaizeThemeArt = { svgFor };
})();

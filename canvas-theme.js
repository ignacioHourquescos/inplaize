'use strict';

/**
 * Tema de la aplicación y color de acento.
 *
 * El tema guardado es uno de THEMES. En el documento quedan:
 *   data-ui-theme      tema aplicado; lo lee themes.css
 *   data-canvas-theme  'light' en los temas claros, ausente en los oscuros
 *   data-color-theme   acento elegido a mano; ausente si se usa el del tema
 */
(function () {
  const THEME_KEY = 'inplaize.canvasTheme';
  const COLOR_KEY = 'inplaize.colorTheme';
  const DEFAULT_THEME = 'dark';
  const AUTO_COLOR = 'auto';

  const THEMES = [
    { id: 'light', label: 'Claro', group: 'light' },
    { id: 'sand', label: 'Arena', group: 'light' },
    { id: 'mint', label: 'Menta', group: 'light' },
    { id: 'lavender', label: 'Lavanda', group: 'light' },
    { id: 'sky', label: 'Cielo', group: 'light' },
    { id: 'dark', label: 'Oscuro', group: 'dark' },
    { id: 'midnight', label: 'Medianoche', group: 'dark' },
    { id: 'neon', label: 'Neón', group: 'dark' },
    { id: 'forest', label: 'Bosque', group: 'dark' },
    { id: 'sunset', label: 'Atardecer', group: 'dark' },
  ];

  const GROUPS = [
    { id: 'light', label: 'Claros' },
    { id: 'dark', label: 'Oscuros' },
  ];

  const COLORS = [
    { id: AUTO_COLOR, label: 'Del tema', swatch: '' },
    { id: 'indigo', label: 'Índigo', swatch: '#4f46e5' },
    { id: 'violet', label: 'Violeta', swatch: '#7c3aed' },
    { id: 'blue', label: 'Azul', swatch: '#2563eb' },
    { id: 'teal', label: 'Verde azulado', swatch: '#0f766e' },
    { id: 'amber', label: 'Ámbar', swatch: '#b45309' },
    { id: 'rose', label: 'Rosa', swatch: '#be123c' },
  ];

  const themeById = new Map(THEMES.map((t) => [t.id, t]));
  const colorIds = new Set(COLORS.map((c) => c.id));

  function readTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (themeById.has(v)) return v;
    } catch {
      /* sin almacenamiento: tema por defecto */
    }
    return DEFAULT_THEME;
  }

  function readColor() {
    try {
      const v = localStorage.getItem(COLOR_KEY);
      if (colorIds.has(v)) return v;
    } catch {
      /* sin almacenamiento: acento del tema */
    }
    return AUTO_COLOR;
  }

  function apply(theme, color) {
    const root = document.documentElement;
    root.setAttribute('data-ui-theme', theme);

    if (themeById.get(theme).group === 'light') root.setAttribute('data-canvas-theme', 'light');
    else root.removeAttribute('data-canvas-theme');

    if (colorIds.has(color) && color !== AUTO_COLOR) root.setAttribute('data-color-theme', color);
    else root.removeAttribute('data-color-theme');
  }

  function persist(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* el tema sigue en esta sesión */
    }
  }

  /** Elegir un tema vuelve al acento propio de ese tema. */
  function setTheme(theme) {
    const next = themeById.has(theme) ? theme : DEFAULT_THEME;
    persist(THEME_KEY, next);
    persist(COLOR_KEY, AUTO_COLOR);
    apply(next, AUTO_COLOR);
  }

  function setColor(color) {
    const next = colorIds.has(color) ? color : AUTO_COLOR;
    persist(COLOR_KEY, next);
    apply(readTheme(), next);
  }

  function applyStored() {
    apply(readTheme(), readColor());
  }

  window.addEventListener('storage', (e) => {
    if (e.key == null || e.key === THEME_KEY || e.key === COLOR_KEY) applyStored();
  });

  window.InplaizeCanvasTheme = {
    themes: THEMES,
    groups: GROUPS,
    colors: COLORS,
    get: readTheme,
    getColor: readColor,
    isLight() {
      return themeById.get(readTheme()).group === 'light';
    },
    set: setTheme,
    setColor,
    applyStored,
  };

  applyStored();
})();

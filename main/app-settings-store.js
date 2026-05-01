'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  dockPosition: 'left',
  /** 'normal' = filas con nombre; 'minimal' = solo iconos en la lista */
  sidebarDensity: 'normal',
  /** false = toasts nativos de Windows/Chromium; true = tarjetas en el panel */
  inAppWebNotifications: false,
  /**
   * Siempre ventana propia por acceso web (Alt+Tab / barra de tareas como varias ventanas).
   * Valores legacy "shell" en disco se migran a "separate" al cargar.
   */
  webHostMode: 'separate',
};

const ALLOWED_DOCK = new Set(['left', 'center', 'right']);
const ALLOWED_SIDEBAR_DENSITY = new Set(['normal', 'minimal']);
const ALLOWED_WEB_HOST = new Set(['separate']);

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'app-settings.json');
}

function normalize(raw) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!ALLOWED_DOCK.has(merged.dockPosition)) {
    merged.dockPosition = DEFAULTS.dockPosition;
  }
  if (!ALLOWED_SIDEBAR_DENSITY.has(merged.sidebarDensity)) {
    merged.sidebarDensity = DEFAULTS.sidebarDensity;
  }
  if (typeof merged.inAppWebNotifications !== 'boolean') {
    merged.inAppWebNotifications = DEFAULTS.inAppWebNotifications;
  }
  if (merged.webHostMode === 'shell') {
    merged.webHostMode = 'separate';
  }
  if (!ALLOWED_WEB_HOST.has(merged.webHostMode)) {
    merged.webHostMode = DEFAULTS.webHostMode;
  }
  return merged;
}

function loadAppSettings() {
  try {
    const p = settingsFilePath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const next = normalize(raw);
      if (raw && typeof raw === 'object' && raw.webHostMode === 'shell') {
        try {
          fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8');
        } catch {
          /* noop */
        }
      }
      return next;
    }
  } catch {
    /* fall through */
  }
  return normalize({});
}

/**
 * @param {Partial<{ dockPosition: string, sidebarDensity: string, inAppWebNotifications: boolean, webHostMode: string }>} partial
 * @returns {ReturnType<loadAppSettings>}
 */
function saveAppSettings(partial) {
  const next = normalize({ ...loadAppSettings(), ...partial });
  fs.writeFileSync(settingsFilePath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

module.exports = {
  loadAppSettings,
  saveAppSettings,
  normalize,
  ALLOWED_DOCK,
  ALLOWED_SIDEBAR_DENSITY,
  ALLOWED_WEB_HOST,
};

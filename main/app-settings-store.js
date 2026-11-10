'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DEFAULT_HOTKEY, normalizeDockHotkey } = require('./hotkey-accelerator');

const DEFAULTS = {
  /** 'normal' = filas con nombre; 'minimal' = solo iconos en la lista */
  sidebarDensity: 'normal',
  /** false = toasts nativos de Windows/Chromium; true = tarjetas en el panel */
  inAppWebNotifications: false,
  /**
   * Onboarding de primera vez: cuando es false y la lista de shortcuts está
   * vacía, el renderer dispara el wizard que guía al usuario a crear su
   * primera ventana y a probar el atajo.
   */
  onboardingCompleted: false,
  /** Tres teclas del atajo global, en el orden que eligió el usuario. */
  dockHotkey: DEFAULT_HOTKEY.slice(),
  /**
   * Veces que abrió y volvió a cerrar las ventanas con el atajo, ya con la app
   * en uso. A las 10, un popup explica cómo apagar una ventana y cómo dejarla
   * en foco. Sale la próxima vez que el atajo las trae al frente.
   */
  hotkeyToggleCount: 0,
  /** Hay una apertura con el atajo esperando el cierre que completa el ciclo. */
  hotkeyCoachAwaitingHide: false,
  /** El popup de gestos ya se mostró (o el usuario lo cerró). */
  gestureCoachShown: false,
  /**
   * Minutos sin usar una ventana web antes de descargar su página para liberar memoria
   * (vuelve a cargarse al enfocarla). 0 = nunca.
   */
  webIdleHibernateMinutes: 15,
  /** Estadísticas de uso anónimas (Aptabase). El usuario puede apagarlas en Configuración. */
  analyticsEnabled: true,
  /** Último día (YYYY-MM-DD) en que se mandó la foto diaria de uso. */
  analyticsInventoryDay: '',
  /** UUID aleatorio de esta instalación: cuenta usuarios reales sin datos personales. */
  analyticsInstallId: '',
};

const ALLOWED_SIDEBAR_DENSITY = new Set(['normal', 'minimal']);

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'app-settings.json');
}

function normalize(raw) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!ALLOWED_SIDEBAR_DENSITY.has(merged.sidebarDensity)) {
    merged.sidebarDensity = DEFAULTS.sidebarDensity;
  }
  if (typeof merged.inAppWebNotifications !== 'boolean') {
    merged.inAppWebNotifications = DEFAULTS.inAppWebNotifications;
  }
  delete merged.webHostMode;
  delete merged.dockPosition;
  if (typeof merged.onboardingCompleted !== 'boolean') {
    merged.onboardingCompleted = DEFAULTS.onboardingCompleted;
  }
  const toggleCount = Number(merged.hotkeyToggleCount);
  merged.hotkeyToggleCount = Number.isFinite(toggleCount) && toggleCount > 0
    ? Math.min(100000, Math.floor(toggleCount))
    : 0;
  if (typeof merged.hotkeyCoachAwaitingHide !== 'boolean') {
    merged.hotkeyCoachAwaitingHide = DEFAULTS.hotkeyCoachAwaitingHide;
  }
  if (typeof merged.gestureCoachShown !== 'boolean') {
    merged.gestureCoachShown = DEFAULTS.gestureCoachShown;
  }
  const idleMinutes = Number(merged.webIdleHibernateMinutes);
  merged.webIdleHibernateMinutes = Number.isFinite(idleMinutes) && idleMinutes > 0
    ? Math.min(24 * 60, Math.floor(idleMinutes))
    : 0;
  if (merged.webIdleHibernateMinutes > 0 && merged.webIdleHibernateMinutes < 5) {
    merged.webIdleHibernateMinutes = 5;
  }
  if (typeof merged.analyticsEnabled !== 'boolean') {
    merged.analyticsEnabled = DEFAULTS.analyticsEnabled;
  }
  if (typeof merged.analyticsInventoryDay !== 'string') {
    merged.analyticsInventoryDay = DEFAULTS.analyticsInventoryDay;
  }
  if (typeof merged.analyticsInstallId !== 'string') {
    merged.analyticsInstallId = DEFAULTS.analyticsInstallId;
  }
  merged.dockHotkey = normalizeDockHotkey(merged.dockHotkey);
  return merged;
}

function loadAppSettings() {
  try {
    const p = settingsFilePath();
    if (fs.existsSync(p)) {
      return normalize(JSON.parse(fs.readFileSync(p, 'utf-8')));
    }
  } catch {
    /* fall through */
  }
  return normalize({});
}

/**
 * @param {Partial<{ sidebarDensity: string, inAppWebNotifications: boolean }>} partial
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
  ALLOWED_SIDEBAR_DENSITY,
};

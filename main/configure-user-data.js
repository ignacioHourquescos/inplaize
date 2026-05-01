'use strict';

/**
 * Debe cargarse antes que cualquier módulo que use app.getPath('userData').
 * Fija una carpeta estable ("UsualDesk") y migra datos desde carpetas anteriores si hace falta.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CANONICAL_DIR = 'UsualDesk';
const LEGACY_DIRS = ['Dock Station', 'dock-station'];

function applyUserDataPath() {
  const appData = app.getPath('appData');
  const newUserData = path.join(appData, CANONICAL_DIR);

  try {
    if (!fs.existsSync(newUserData)) {
      for (const legacy of LEGACY_DIRS) {
        const legacyPath = path.join(appData, legacy);
        if (fs.existsSync(legacyPath)) {
          fs.renameSync(legacyPath, newUserData);
          break;
        }
      }
    }
  } catch (err) {
    console.error('[UsualDesk] Migración de datos antiguos falló:', err.message);
  }

  app.setPath('userData', newUserData);
}

applyUserDataPath();

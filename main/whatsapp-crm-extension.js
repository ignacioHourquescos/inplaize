'use strict';

const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');
const { sanitizeSessionId } = require('./session-partition');
const { log } = require('./logger');

/**
 * Solo el acceso "wpp mostrador". Renova Ventas y Wpp personal no cargan el CRM.
 * La extensión vive en la sesión (`persist:wpp-mostrador`), así que el content
 * script entra en web.whatsapp.com de esa cuenta y en ninguna otra.
 */
const CRM_WHATSAPP_SESSION_ID = 'wpp-mostrador';
const EXTENSION_NAME = 'Renova CRM para WhatsApp';

const loadedPartitions = new Set();
let missingLogged = false;

function isWhatsAppWeb(url) {
  try {
    return new URL(url).hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

function extensionDistPath() {
  if (process.env.RENOVA_CRM_WPP_DIST) return path.resolve(process.env.RENOVA_CRM_WPP_DIST);
  return path.resolve(__dirname, '..', '..', '..', 'renova', 'renova-crm-wpp', 'dist');
}

/**
 * Electron no registra el service worker en módulos (`import` + `"type": "module"`).
 * Se copia el build y se empaqueta el background en un solo script clásico.
 * @param {string} dist
 * @returns {string}
 */
function stageExtension(dist) {
  const stageRoot = path.join(app.getPath('userData'), 'crm-extension');
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.cpSync(dist, stageRoot, { recursive: true });

  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (err) {
    log(`[crm] no está esbuild (${err && err.message ? err.message : err}); se carga el build tal cual`);
    return dist;
  }

  esbuild.buildSync({
    entryPoints: [path.join(dist, 'service-worker-loader.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: path.join(stageRoot, 'background.bundle.js'),
    legalComments: 'none',
  });

  const manifestPath = path.join(stageRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.background = { service_worker: 'background.bundle.js' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return stageRoot;
}

/**
 * Carga la extensión descomprimida en la sesión de este acceso.
 * @param {{ sessionId?: string, url?: string }} shortcut
 * @param {string} partition
 * @returns {Promise<boolean>} true si se cargó ahora (la página ya abierta hay que recargarla)
 */
async function ensureCrmExtension(shortcut, partition) {
  if (!shortcut || sanitizeSessionId(shortcut.sessionId) !== CRM_WHATSAPP_SESSION_ID) return false;
  if (!isWhatsAppWeb(shortcut.url)) return false;
  if (!partition || !partition.startsWith('persist:')) return false;
  if (loadedPartitions.has(partition)) return false;

  const dist = extensionDistPath();
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
    if (!missingLogged) {
      missingLogged = true;
      log(`[crm] wpp mostrador sin extensión: no está ${dist}. Corré npm run build en renova-crm-wpp.`);
    }
    return false;
  }

  let loadPath = dist;
  try {
    loadPath = stageExtension(dist);
  } catch (err) {
    log(`[crm] no se pudo preparar la extensión, se intenta el build tal cual: ${err && err.message ? err.message : err}`);
    loadPath = dist;
  }

  try {
    const extensions = session.fromPartition(partition).extensions;
    const already = extensions.getAllExtensions().some((ext) => ext.name === EXTENSION_NAME);
    if (!already) {
      const ext = await extensions.loadExtension(loadPath);
      log(`[crm] extensión "${ext.name}" cargada solo en ${partition}`);
    }
    loadedPartitions.add(partition);
    return !already;
  } catch (err) {
    log(`[crm] no se pudo cargar la extensión en ${partition}: ${err && err.message ? err.message : err}`);
    return false;
  }
}

module.exports = {
  ensureCrmExtension,
  CRM_WHATSAPP_SESSION_ID,
};

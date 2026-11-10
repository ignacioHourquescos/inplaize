'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { app, net } = require('electron');
const { loadAppSettings, saveAppSettings } = require('./app-settings-store');
const { log } = require('./logger');

const APTABASE_APP_KEY = 'A-US-3352898721';
const APTABASE_URL = 'https://us.aptabase.com/api/v0/events';

/** Aptabase acepta hasta 25 eventos por pedido. */
const BATCH_SIZE = 25;
const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE = 500;
/** Igual que el SDK oficial: una hora sin eventos abre una sesión nueva. */
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Nombres de evento permitidos desde el renderer: así una página web o un bug
 * no pueden mandar cualquier cosa (ni contenido del usuario) a Aptabase.
 */
const RENDERER_EVENTS = new Set([
  'onboarding_started',
]);

let enabled = true;
let installId = '';
let ready = false;
let sending = false;
let retryAfter = 0;
let failures = 0;
/** @type {object[]} */
let queue = [];
let systemProps = null;
let userAgent = 'inplaize';
let sessionId = newSessionId();
let lastEventAt = Date.now();
const startedAt = Date.now();

function newSessionId() {
  const secs = Math.floor(Date.now() / 1000).toString();
  const rand = Math.floor(Math.random() * 1e8).toString().padStart(8, '0');
  return secs + rand;
}

function queueFilePath() {
  return path.join(app.getPath('userData'), 'analytics-queue.json');
}

function persistQueue() {
  try {
    if (queue.length) fs.writeFileSync(queueFilePath(), JSON.stringify(queue), 'utf-8');
    else if (fs.existsSync(queueFilePath())) fs.unlinkSync(queueFilePath());
  } catch {
    /* sin disco: los eventos quedan en memoria */
  }
}

function loadPersistedQueue() {
  try {
    const raw = JSON.parse(fs.readFileSync(queueFilePath(), 'utf-8'));
    return Array.isArray(raw) ? raw.slice(-MAX_QUEUE) : [];
  } catch {
    return [];
  }
}

function ensureInstallId(settings) {
  if (settings.analyticsInstallId) return settings.analyticsInstallId;
  const id = randomUUID();
  try {
    saveAppSettings({ analyticsInstallId: id });
  } catch {
    /* sin disco: el id vale solo para esta ejecución */
  }
  return id;
}

function initAnalytics() {
  try {
    const settings = loadAppSettings();
    enabled = settings.analyticsEnabled !== false;
    installId = ensureInstallId(settings);
  } catch {
    enabled = true;
    installId = randomUUID();
  }
  queue = loadPersistedQueue().concat(queue);
  app.whenReady().then(() => {
    systemProps = {
      isDebug: !app.isPackaged,
      locale: app.getLocale(),
      osName: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
      osVersion: os.release(),
      engineName: 'Chromium',
      engineVersion: process.versions.chrome,
      appVersion: app.getVersion(),
      sdkVersion: 'inplaize-analytics@1',
    };
    const version = String(systemProps.appVersion || '').replace(/[^\w.+-]/g, '') || '0';
    userAgent = `inplaize/${version} (${systemProps.osName})`;
    ready = true;
    const timer = setInterval(flush, FLUSH_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    flush();
  });
  app.on('before-quit', () => {
    track('app_closed', { minutes: Math.round((Date.now() - startedAt) / 60000) });
    persistQueue();
  });
}

function setAnalyticsEnabled(on) {
  enabled = on !== false;
}

/**
 * Solo nombres de evento y propiedades genéricas: nunca URLs completas, títulos,
 * texto de notas ni datos de cuentas.
 * @param {string} name
 * @param {Record<string, string | number | boolean>} [props]
 */
function track(name, props) {
  if (!enabled || !name) return;
  const now = Date.now();
  if (now - lastEventAt > SESSION_TIMEOUT_MS) sessionId = newSessionId();
  lastEventAt = now;
  queue.push({
    timestamp: new Date(now).toISOString(),
    sessionId,
    eventName: name,
    props: { ...(props && typeof props === 'object' ? props : {}), install_id: installId },
  });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  persistQueue();
}

async function flush() {
  if (!ready || sending || !queue.length || Date.now() < retryAfter) return;
  sending = true;
  const batch = queue.slice(0, BATCH_SIZE);
  try {
    const res = await net.fetch(APTABASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'App-Key': APTABASE_APP_KEY,
        // Aptabase cuenta usuarios con IP + User-Agent: uno fijo evita duplicados.
        'User-Agent': userAgent,
      },
      body: JSON.stringify(batch.map((e) => ({ ...e, systemProps }))),
      credentials: 'omit',
    });
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
      if (!res.ok) log(`Analytics: Aptabase rechazó ${batch.length} eventos (HTTP ${res.status})`);
      queue = queue.slice(batch.length);
      failures = 0;
      persistQueue();
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    failures += 1;
    retryAfter = Date.now() + Math.min(5 * 60 * 1000, 5000 * 2 ** failures);
    if (failures === 1 || failures % 10 === 0) {
      log(`Analytics: no se pudo enviar (${err?.message || err}); ${queue.length} eventos pendientes`);
    }
  } finally {
    sending = false;
  }
  if (queue.length && !failures) flush();
}

function trackFromRenderer(name, props) {
  if (!RENDERER_EVENTS.has(name)) return;
  const clean = {};
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
      else if (typeof v === 'string' && v.length <= 40) clean[k] = v;
    }
  }
  track(name, clean);
}

module.exports = {
  initAnalytics,
  setAnalyticsEnabled,
  track,
  trackFromRenderer,
};

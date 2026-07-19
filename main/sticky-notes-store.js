'use strict';

/**
 * Persistencia local de las notas adhesivas ("sticky pads") que viven en la
 * pantalla de inicio del dock. El archivo se guarda en `userData/sticky-notes.json`
 * para no contaminar `shortcuts.json` (formato y migraciones distintas).
 *
 * Estructura en disco:
 *   { version: 1, notes: Array<StickyNote>, crumpled: Array<CrumpledNote> }
 *
 * Cada `notes[i]` representa una nota viva (visible y editable):
 *   { id, text, color, x, y, rotation, w, h, updatedAt }
 *
 * Cada `crumpled[i]` representa una nota apretada que cayó al fondo:
 *   { id, text, color, leftPct, rotation, fellAt }
 *
 * El renderer es la fuente de verdad mientras la ventana está abierta; al
 * cerrarse o actualizarse llama `save-sticky-notes` y aquí simplemente
 * persistimos lo que llegó (con un saneamiento defensivo, por si la versión
 * vieja de la app guardó algo raro).
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FILE_VERSION = 1;
const MAX_NOTES = 200;
const MAX_CRUMPLED = 60;

function stickyNotesFilePath() {
  return path.join(app.getPath('userData'), 'sticky-notes.json');
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function sanitizeText(value, maxLen) {
  if (value == null) return '';
  const str = String(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

function sanitizeNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (!id) return null;
  return {
    id,
    text: sanitizeText(raw.text, 4000),
    color: 'amarillo',
    x: clampNumber(raw.x, -2000, 4000, 40),
    y: clampNumber(raw.y, -2000, 4000, 40),
    w: clampNumber(raw.w, 140, 600, 210),
    h: clampNumber(raw.h, 120, 600, 210),
    rotation: clampNumber(raw.rotation, -25, 25, 0),
    z: clampNumber(raw.z, 0, Number.MAX_SAFE_INTEGER, 1),
    updatedAt: clampNumber(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
}

function sanitizeCrumpled(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (!id) return null;
  return {
    id,
    text: sanitizeText(raw.text, 4000),
    color: 'amarillo',
    xPx: clampNumber(raw.xPx, -2000, 6000, 100),
    bottomPx: clampNumber(raw.bottomPx, 0, 400, 10),
    rotation: clampNumber(raw.rotation, -180, 180, 0),
    z: clampNumber(raw.z, 0, Number.MAX_SAFE_INTEGER, 1),
    fellAt: clampNumber(raw.fellAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
}

function emptyPayload() {
  return { version: FILE_VERSION, notes: [], crumpled: [] };
}

function loadStickyNotes() {
  try {
    const p = stickyNotesFilePath();
    if (!fs.existsSync(p)) return emptyPayload();
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return emptyPayload();
    const notes = Array.isArray(raw.notes)
      ? raw.notes.map(sanitizeNote).filter(Boolean).slice(0, MAX_NOTES)
      : [];
    const crumpled = Array.isArray(raw.crumpled)
      ? raw.crumpled.map(sanitizeCrumpled).filter(Boolean).slice(-MAX_CRUMPLED)
      : [];
    return { version: FILE_VERSION, notes, crumpled };
  } catch {
    return emptyPayload();
  }
}

function saveStickyNotes(payload) {
  const safe = {
    version: FILE_VERSION,
    notes: Array.isArray(payload?.notes)
      ? payload.notes.map(sanitizeNote).filter(Boolean).slice(0, MAX_NOTES)
      : [],
    crumpled: Array.isArray(payload?.crumpled)
      ? payload.crumpled.map(sanitizeCrumpled).filter(Boolean).slice(-MAX_CRUMPLED)
      : [],
  };
  try {
    fs.writeFileSync(stickyNotesFilePath(), JSON.stringify(safe, null, 2), 'utf-8');
  } catch {
    /* sin permisos de escritura: mantenemos el estado en memoria del renderer */
  }
  return safe;
}

function broadcastStickyNotesChanged(senderWebContents) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue;
    if (senderWebContents && w.webContents === senderWebContents) continue;
    try {
      w.webContents.send('sticky-notes-changed');
    } catch {
      /* noop */
    }
  }
}

module.exports = {
  loadStickyNotes,
  saveStickyNotes,
  broadcastStickyNotesChanged,
};

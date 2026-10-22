'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * @returns {number | null}
 */
function readBuildNumber() {
  const roots = [];
  try {
    roots.push(app.getAppPath());
  } catch {
    /* noop */
  }
  roots.push(path.join(__dirname, '..'));

  for (const root of roots) {
    const p = path.join(root, 'build-info.json');
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const n = Number.parseInt(String(j.build), 10);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch {
      /* noop */
    }
  }
  return null;
}

function getAppVersionPayload() {
  const version = app.getVersion();
  const build = readBuildNumber();
  const display = build != null ? `${version} (${build})` : version;
  return { version, build, display };
}

/**
 * @param {unknown} entry
 * @returns {{ version: string, date: string, notes: string[] } | null}
 */
function normalizeVersionHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const version = String(entry.version || '').trim();
  if (!version) return null;
  const date = typeof entry.date === 'string' ? entry.date.trim() : '';
  const rawNotes = Array.isArray(entry.notes)
    ? entry.notes
    : typeof entry.notes === 'string'
      ? [entry.notes]
      : [];
  const notes = rawNotes.map((note) => String(note).trim()).filter(Boolean);
  return { version, date, notes };
}

/** Historial publicado en version-history.json (más reciente primero). */
function readVersionHistory() {
  const roots = [];
  try {
    roots.push(app.getAppPath());
  } catch {
    /* noop */
  }
  roots.push(path.join(__dirname, '..'));

  for (const root of roots) {
    const p = path.join(root, 'version-history.json');
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!Array.isArray(j)) continue;
      return j.map(normalizeVersionHistoryEntry).filter(Boolean);
    } catch {
      /* noop */
    }
  }
  return [];
}

module.exports = { getAppVersionPayload, readBuildNumber, readVersionHistory };

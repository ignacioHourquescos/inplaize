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

module.exports = { getAppVersionPayload, readBuildNumber };

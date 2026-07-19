'use strict';

/**
 * Incrementa build-info.json antes de electron-builder.
 * El número queda embebido en el instalador para mostrar "1.3.0 (44)" etc.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const buildPath = path.join(root, 'build-info.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const version = pkg.version || '0.0.0';

let data = { build: 0 };
try {
  if (fs.existsSync(buildPath)) {
    data = JSON.parse(fs.readFileSync(buildPath, 'utf-8'));
  }
} catch {
  data = { build: 0 };
}

const prev = Number.parseInt(String(data.build), 10);
const next = Number.isFinite(prev) && prev >= 0 ? prev + 1 : 1;

const out = {
  build: next,
  versionAtBuild: version,
};

fs.writeFileSync(buildPath, `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
// eslint-disable-next-line no-console
console.log(`[bump-build] ${version} → build ${next} (written ${path.relative(root, buildPath)})`);

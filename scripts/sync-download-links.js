'use strict';

/**
 * Apunta los botones de descarga de la landing a la versión de package.json.
 * Corre en el build de Vercel y antes de empaquetar, así el link nunca queda
 * atrasado respecto de la release publicada.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const landing = path.join(root, 'landing');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = pkg.version || '0.0.0';
const repo = 'https://github.com/ignacioHourquescos/inplaize';
const target = `${repo}/releases/download/v${version}/inplaize.Setup.${version}.exe`;
const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const linkRe = new RegExp(`${escaped}/releases/download/v[\\d.]+/inplaize\\.Setup\\.[\\d.]+\\.exe`, 'g');

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.isFile() && entry.name.endsWith('.html') ? [full] : [];
  });
}

let updated = 0;
htmlFiles(landing).forEach((file) => {
  const html = fs.readFileSync(file, 'utf-8');
  const next = html.replace(linkRe, target);
  if (next === html) return;
  fs.writeFileSync(file, next, 'utf-8');
  updated += 1;
  // eslint-disable-next-line no-console
  console.log(`[sync-download-links] ${path.relative(root, file)}`);
});

// eslint-disable-next-line no-console
console.log(`[sync-download-links] v${version} · ${updated} archivo(s) actualizado(s)`);

'use strict';

/**
 * Genera los iconos de la app (assets/icon.png + assets/icon.ico) a partir
 * del logo de inplaize definido como SVG (misma marca que .dock-home-logo-mark
 * en styles.css: gradiente violeta, cuadrado blanco interior y punto violeta).
 *
 * Uso: node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// Escala 26px (CSS) → 256px: cuadrado 26→256 (r=8→79), interior 11→108 (r=4→39), punto 4→39.
const LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a78bfa"/>
      <stop offset="1" stop-color="#6d28d9"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="56" fill="url(#bg)"/>
  <rect x="74" y="74" width="108" height="108" rx="30" fill="rgba(255,255,255,0.95)"/>
  <circle cx="128" cy="128" r="20" fill="#8b5cf6"/>
</svg>
`;

async function main() {
  const svgBuffer = Buffer.from(LOGO_SVG);

  // 512px: mínimo que exige electron-builder para derivar el .icns de macOS.
  const pngMain = path.join(ASSETS_DIR, 'icon.png');
  await sharp(svgBuffer).resize(512, 512).png().toFile(pngMain);
  console.log(`OK ${pngMain}`);

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    sizes.map((size) => sharp(svgBuffer).resize(size, size).png().toBuffer()),
  );

  const ico = await pngToIco(pngBuffers);
  const icoPath = path.join(ASSETS_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`OK ${icoPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

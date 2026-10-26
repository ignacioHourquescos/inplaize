'use strict';

/**
 * Copia el editor de documentos a la vista de prueba del sitio.
 * Vercel publica solo `landing/`, así que el botón queda en
 * /probar-documento/ de la vista previa de la rama.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'landing', 'probar-documento', 'vendor');
const files = [
  'document-modal.js',
  'document-modal.css',
  'document-markdown.js',
  'document-editor.bundle.js',
  'ui-tooltip.js',
];

fs.mkdirSync(dest, { recursive: true });
files.forEach((file) => {
  fs.copyFileSync(path.join(root, file), path.join(dest, file));
});

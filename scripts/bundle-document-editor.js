'use strict';

const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

esbuild.build({
  absWorkingDir: root,
  entryPoints: ['editor/document-editor.js'],
  outfile: 'document-editor.bundle.js',
  bundle: true,
  format: 'iife',
  globalName: 'InplaizeDocs',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
}).then(() => {
  console.log('document-editor.bundle.js');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

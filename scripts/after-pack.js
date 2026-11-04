'use strict';

/**
 * Con signAndEditExecutable=false electron-builder no toca el .exe y queda el ícono de Electron,
 * que es el que Windows muestra en la barra de tareas. Lo incrustamos acá con rcedit.
 */

const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { rcedit } = await import('rcedit');
  const { productFilename } = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${productFilename}.exe`);
  const root = path.join(__dirname, '..');
  await rcedit(exe, {
    icon: path.join(root, 'assets', 'icon.ico'),
    'version-string': {
      ProductName: productFilename,
      FileDescription: productFilename,
    },
  });
  // eslint-disable-next-line no-console
  console.log(`[after-pack] ícono incrustado en ${path.relative(root, exe)}`);
};

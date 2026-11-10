'use strict';

/**
 * Con signAndEditExecutable=false electron-builder no toca el .exe y queda el ícono de Electron,
 * que es el que Windows muestra en la barra de tareas. Lo incrustamos acá con rcedit.
 */

const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (process.env.INPLAIZE_SIGNING === '1') {
    // Firmando, electron-builder ya incrusta ícono y metadatos antes de firmar.
    // Tocar el .exe acá invalidaría la firma y SmartScreen volvería a quejarse.
    // eslint-disable-next-line no-console
    console.log('[after-pack] build firmada: se omite rcedit para no invalidar la firma');
    return;
  }
  const { rcedit } = await import('rcedit');
  const { productFilename, version } = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${productFilename}.exe`);
  const root = path.join(__dirname, '..');
  await rcedit(exe, {
    icon: path.join(root, 'assets', 'icon.ico'),
    // Sin esto el .exe queda con la versión de Electron. SignPath exige que el
    // nombre y la versión de producto sean los del proyecto en cada build.
    'product-version': version,
    'file-version': version,
    'version-string': {
      ProductName: productFilename,
      FileDescription: productFilename,
      CompanyName: context.packager.appInfo.companyName || productFilename,
      LegalCopyright: `© ${new Date().getFullYear()} ${context.packager.appInfo.companyName || productFilename}`,
    },
  });
  // eslint-disable-next-line no-console
  console.log(`[after-pack] ícono incrustado en ${path.relative(root, exe)}`);
};

'use strict';

/**
 * En desarrollo la app corre sobre node_modules/electron/dist/electron.exe y Windows pinta
 * el ícono de ESE ejecutable en la barra de tareas. Le incrustamos el de inplaize.
 */

const fs = require('fs');
const path = require('path');

async function main() {
  if (process.platform !== 'win32') return;
  const root = path.join(__dirname, '..');
  const ico = path.join(root, 'assets', 'icon.ico');
  let exe;
  try {
    exe = require('electron');
  } catch {
    return;
  }
  if (typeof exe !== 'string' || !fs.existsSync(exe) || !fs.existsSync(ico)) return;

  const stamp = path.join(path.dirname(exe), '.inplaize-icon');
  const icoTime = String(fs.statSync(ico).mtimeMs);
  const exeTime = String(fs.statSync(exe).mtimeMs);
  try {
    const [prevIco, prevExe] = fs.readFileSync(stamp, 'utf8').split('\n');
    if (prevIco === icoTime && prevExe === exeTime) return;
  } catch {
    /* primera vez */
  }

  const { rcedit } = await import('rcedit');
  try {
    await rcedit(exe, {
      icon: ico,
      'version-string': { ProductName: 'inplaize', FileDescription: 'inplaize' },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[brand-dev-electron] no se pudo editar electron.exe (¿está abierto?): ${err?.message || err}`);
    return;
  }
  fs.writeFileSync(stamp, `${icoTime}\n${fs.statSync(exe).mtimeMs}`);
  // eslint-disable-next-line no-console
  console.log('[brand-dev-electron] ícono de inplaize incrustado en electron.exe');
}

main();

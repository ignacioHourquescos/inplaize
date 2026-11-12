'use strict';

/**
 * Cerrar un .exe en Windows sin congelar el proceso que llama.
 *
 * `taskkill /T` sin `/F` manda WM_CLOSE y después espera a los procesos hijos
 * que no tienen ventana (renderers, GPU). Esa espera no tiene tope: si se
 * llama con execFileSync, el hilo de la app no vuelve y la ventana queda
 * "No responde". Acá el cierre es asíncrono y cada paso tiene límite.
 */

const { execFile } = require('child_process');

/** @param {string} imageName */
function sanitizeImage(imageName) {
  const name = String(imageName || '');
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : '';
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ stdout: string, timedOut: boolean }>}
 */
function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout) => {
        resolve({
          stdout: String(stdout || ''),
          timedOut: !!(err && (err.killed || err.signal)),
        });
      },
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} imageName
 * @returns {Promise<boolean>} true también si no pudimos mirar: mejor no
 *   asumir que está cerrado y lanzar otra instancia contra el perfil tomado.
 */
async function isImageRunning(imageName) {
  const safe = sanitizeImage(imageName);
  if (!safe || process.platform !== 'win32') return false;
  const { stdout, timedOut } = await run(
    'tasklist',
    ['/FI', `IMAGENAME eq ${safe}`, '/FO', 'CSV', '/NH'],
    8000,
  );
  if (timedOut) return true;
  return stdout.toLowerCase().includes(`"${safe.toLowerCase()}"`);
}

/**
 * Espera a que no quede ningún proceso con esa imagen. Al desaparecer deja
 * un margen para que suelte el lock del perfil, y vuelve a mirar: Chrome
 * a veces se reinicia solo (modo en segundo plano) en ese intervalo.
 * @param {string} imageName
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitImageExit(imageName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isImageRunning(imageName))) {
      await sleep(800);
      if (!(await isImageRunning(imageName))) return true;
    } else {
      await sleep(250);
    }
  }
  return false;
}

/**
 * Cierre normal y, si sigue vivo, forzado. Sin `/T` en el cierre normal.
 * @param {string} imageName
 * @returns {Promise<boolean>}
 */
async function closeImage(imageName) {
  const safe = sanitizeImage(imageName);
  if (!safe || process.platform !== 'win32') return false;
  if (!(await isImageRunning(safe))) return true;

  await run('taskkill', ['/IM', safe], 5000);
  if (await waitImageExit(safe, 8000)) return true;

  await run('taskkill', ['/F', '/IM', safe], 5000);
  if (await waitImageExit(safe, 4000)) return true;
  // Chrome (sobre todo con el arranque en segundo plano) puede volver a
  // aparecer en el margen en que soltamos el perfil. Un force más.
  await run('taskkill', ['/F', '/IM', safe], 5000);
  return waitImageExit(safe, 4000);
}

/** @param {number} pid Mata ese proceso y los que haya arrancado. */
async function killPidTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || process.platform !== 'win32') return;
  await run('taskkill', ['/PID', String(n), '/T', '/F'], 8000);
}

module.exports = {
  isImageRunning,
  waitImageExit,
  closeImage,
  killPidTree,
};

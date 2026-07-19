'use strict';

/**
 * Preload de la ventana oculta que genera miniaturas. Expone un puente mínimo
 * y seguro: recibir trabajos, leer los bytes del archivo objetivo y devolver el
 * PNG resultante. La página en sí no tiene acceso a Node (contextIsolation on).
 */

const fs = require('fs');
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thumbAPI', {
  /** Suscribe el callback a los trabajos enviados por el proceso principal. */
  onJob(callback) {
    ipcRenderer.on('thumb-job', (_event, job) => callback(job));
  },
  /** Devuelve el resultado (PNG dataURL o error) al proceso principal. */
  sendResult(result) {
    ipcRenderer.send('thumb-result', result);
  },
  /**
   * Lee un archivo local y devuelve sus bytes como ArrayBuffer para procesarlos
   * en la página (pdf.js / SheetJS). Devuelve null si falla.
   * @param {string} filePath
   * @returns {ArrayBuffer|null}
   */
  readFile(filePath) {
    try {
      const buf = fs.readFileSync(filePath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      return null;
    }
  },
});

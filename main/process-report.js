'use strict';

const { app, webContents } = require('electron');
const { log } = require('./logger');

const FIRST_REPORT_MS = 2 * 60 * 1000;
const REPORT_EVERY_MS = 30 * 60 * 1000;

function describeContents(wc) {
  let url = '';
  try {
    url = wc.getURL();
  } catch {
    url = '';
  }
  if (url.startsWith('file:')) url = url.split(/[\\/]/).pop() || url;
  else if (url.length > 80) url = `${url.slice(0, 80)}…`;
  return `${wc.getType()}:${url || '(vacío)'}`;
}

/** Una línea por proceso: tipo, memoria privada, CPU y qué páginas viven en él. */
function logProcessReport() {
  /** @type {Map<number, string[]>} */
  const pages = new Map();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    const pid = wc.getOSProcessId();
    if (!pages.has(pid)) pages.set(pid, []);
    pages.get(pid).push(describeContents(wc));
  }
  const metrics = app.getAppMetrics();
  let totalKb = 0;
  const lines = metrics
    .map((m) => {
      const privateKb = (m.memory && (m.memory.privateBytes || m.memory.workingSetSize)) || 0;
      totalKb += privateKb;
      return {
        privateKb,
        text: `  ${m.type.padEnd(12)} pid=${m.pid} ${Math.round(privateKb / 1024)}MB cpu=${m.cpu.percentCPUUsage.toFixed(1)}% ${(pages.get(m.pid) || []).join(' | ')}`,
      };
    })
    .sort((a, b) => b.privateKb - a.privateKb)
    .map((l) => l.text);
  log(`Procesos: ${metrics.length}, ${Math.round(totalKb / 1024)}MB en total\n${lines.join('\n')}`);
}

function startProcessReports() {
  // La CPU de getAppMetrics se mide desde la llamada anterior.
  app.getAppMetrics();
  const first = setTimeout(logProcessReport, FIRST_REPORT_MS);
  const every = setInterval(logProcessReport, REPORT_EVERY_MS);
  if (typeof first.unref === 'function') first.unref();
  if (typeof every.unref === 'function') every.unref();
}

module.exports = { startProcessReports, logProcessReport };

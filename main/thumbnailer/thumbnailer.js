'use strict';

/**
 * Lógica de la ventana oculta que rasteriza documentos a una miniatura PNG.
 * Corre como página de navegador (sin Node); usa pdf.js y SheetJS cargados como
 * globales UMD y el puente `thumbAPI` del preload para leer archivos y devolver
 * el resultado.
 */

(function () {
  const OUT = 240; // lado mayor de la miniatura en px (se escala en el tile)

  const pdfjsLib = window['pdfjsLib'];
  if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.js',
      location.href,
    ).href;
  }

  function fail(jobId, error) {
    window.thumbAPI.sendResult({ jobId, error: String(error || 'THUMB_FAILED') });
  }

  function done(jobId, canvas) {
    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (err) {
      return fail(jobId, err);
    }
    window.thumbAPI.sendResult({ jobId, dataUrl });
  }

  /** Rasteriza la primera página de un PDF. */
  async function renderPdf(jobId, buffer) {
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: false,
      isEvalSupported: false,
    });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = OUT / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    done(jobId, canvas);
  }

  /** Dibuja una vista tipo planilla a partir de una matriz de filas. */
  function renderSheetGrid(jobId, rows) {
    const MAX_ROWS = 9;
    const MAX_COLS = 5;
    const data = rows.slice(0, MAX_ROWS).map((r) => (Array.isArray(r) ? r.slice(0, MAX_COLS) : []));
    const cols = data.reduce((m, r) => Math.max(m, r.length), 1);

    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUT, OUT);

    const headerH = 30;
    const rowH = (OUT - headerH) / Math.max(1, MAX_ROWS - 1);
    const colW = OUT / cols;

    ctx.fillStyle = '#1f7a44';
    ctx.fillRect(0, 0, OUT, headerH);

    ctx.strokeStyle = '#d9dee5';
    ctx.lineWidth = 1;
    for (let c = 1; c < cols; c += 1) {
      ctx.beginPath();
      ctx.moveTo(Math.round(c * colW) + 0.5, 0);
      ctx.lineTo(Math.round(c * colW) + 0.5, OUT);
      ctx.stroke();
    }
    for (let r = 1; r < MAX_ROWS; r += 1) {
      const y = headerH + (r - 1) * rowH;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(OUT, Math.round(y) + 0.5);
      ctx.stroke();
    }

    ctx.textBaseline = 'middle';
    ctx.font = '11px "Segoe UI", Arial, sans-serif';
    for (let r = 0; r < data.length; r += 1) {
      const isHeader = r === 0;
      const y = isHeader ? headerH / 2 : headerH + (r - 1) * rowH + rowH / 2;
      ctx.fillStyle = isHeader ? '#ffffff' : '#2b2f36';
      if (isHeader) ctx.font = 'bold 11px "Segoe UI", Arial, sans-serif';
      else ctx.font = '11px "Segoe UI", Arial, sans-serif';
      const cells = data[r];
      for (let c = 0; c < cols; c += 1) {
        const raw = cells[c];
        if (raw === undefined || raw === null || raw === '') continue;
        let text = String(raw);
        const maxW = colW - 8;
        while (text.length && ctx.measureText(text).width > maxW) {
          text = text.slice(0, -1);
        }
        ctx.fillText(text, c * colW + 4, y);
      }
    }

    done(jobId, canvas);
  }

  async function renderSheet(jobId, buffer, kind) {
    const XLSX = window['XLSX'];
    let wb;
    if (kind === 'csv') {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
      wb = XLSX.read(text, { type: 'string' });
    } else {
      wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    }
    const first = wb.SheetNames[0];
    const sheet = wb.Sheets[first];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    renderSheetGrid(jobId, rows);
  }

  window.thumbAPI.onJob(async (job) => {
    const { jobId, filePath, kind } = job || {};
    try {
      const buffer = window.thumbAPI.readFile(filePath);
      if (!buffer) return fail(jobId, 'READ_FAILED');
      if (kind === 'pdf') {
        await renderPdf(jobId, buffer);
      } else if (kind === 'xlsx' || kind === 'xls' || kind === 'csv') {
        await renderSheet(jobId, buffer, kind);
      } else {
        fail(jobId, 'UNSUPPORTED');
      }
    } catch (err) {
      fail(jobId, (err && err.message) || err);
    }
  });
})();

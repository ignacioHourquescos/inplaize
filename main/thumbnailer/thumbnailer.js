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

  const MAX_ROWS = 9;
  const MAX_COLS = 5;
  // Fallback neutro (cuando SheetJS CE no expone estilos): sin verde forzado.
  const FALLBACK_HEADER_BG = '#f2f4f7'; // gris muy claro, solo para distinguir
  const FALLBACK_TEXT = '#2b2f36'; // gris oscuro

  /**
   * Convierte un color ARGB/RGB de SheetJS ("FF1F7A44", "1F7A44", "#abc") a
   * "#rrggbb". Descarta el canal alfa (2 primeros chars si vienen 8). Devuelve
   * null si no es un color RGB válido (p. ej. colores por theme sin rgb).
   */
  function argbToHex(argb) {
    if (typeof argb !== 'string') return null;
    let s = argb.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]+$/.test(s)) return null;
    if (s.length === 8) s = s.slice(2); // "AARRGGBB" → descartar alpha
    if (s.length === 3) {
      s = s
        .split('')
        .map((ch) => ch + ch)
        .join('');
    }
    if (s.length !== 6) return null;
    return `#${s.toLowerCase()}`;
  }

  /** Color de relleno real de la celda, o null si no hay/es por theme. */
  function cellFill(cell) {
    const fill = cell && cell.s && cell.s.fill;
    if (!fill) return null;
    if (fill.patternType === 'none') return null;
    const fg = fill.fgColor || fill.bgColor;
    if (!fg || !fg.rgb) return null; // {theme, tint} sin rgb → ignorar
    return argbToHex(fg.rgb);
  }

  /** Color y negrita reales de la fuente de la celda. */
  function cellFont(cell) {
    const font = cell && cell.s && cell.s.font;
    const color = font && font.color && font.color.rgb ? argbToHex(font.color.rgb) : null;
    const bold = !!(font && font.bold);
    return { color, bold };
  }

  /** Elige texto blanco o gris oscuro según la luminancia del fondo. */
  function idealTextOn(hex) {
    const s = String(hex).replace('#', '');
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.55 ? '#ffffff' : FALLBACK_TEXT;
  }

  /**
   * Lee las celdas de la hoja por referencia (para conservar `cell.s`) y arma
   * una matriz recortada a MAX_ROWS x MAX_COLS de objetos
   * `{ text, bg, color, bold }`. `hasStyles` indica si el archivo trajo algún
   * estilo real (fill/font) — SheetJS CE suele no exponerlos.
   */
  function buildStyledGrid(XLSX, sheet) {
    const rows = [];
    let hasStyles = false;
    const ref = sheet && sheet['!ref'];
    if (!ref) return { rows, hasStyles };

    const range = XLSX.utils.decode_range(ref);
    const colEnd = Math.min(range.e.c, range.s.c + MAX_COLS - 1);

    for (let r = range.s.r; r <= range.e.r && rows.length < MAX_ROWS; r += 1) {
      const rowCells = [];
      let any = false;
      for (let c = range.s.c; c <= colEnd; c += 1) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        let text = '';
        if (cell) text = cell.w != null ? cell.w : cell.v != null ? String(cell.v) : '';
        const bg = cell ? cellFill(cell) : null;
        const { color, bold } = cell ? cellFont(cell) : { color: null, bold: false };
        if (bg || color || bold) hasStyles = true;
        if (text !== '' || bg || color || bold) any = true;
        rowCells.push({ text, bg, color, bold });
      }
      if (any) rows.push(rowCells); // salta filas totalmente vacías (como blankrows:false)
    }
    return { rows, hasStyles };
  }

  /**
   * Dibuja una vista tipo planilla. `rows` es una matriz de celdas
   * `{ text, bg, color, bold }`. Con estilos reales pinta el fill/font del
   * archivo; sin estilos usa un look neutro (blanco + encabezado gris claro).
   */
  function renderSheetGrid(jobId, rows, hasStyles) {
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 1);

    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUT, OUT);

    const headerH = 30;
    const rowH = (OUT - headerH) / Math.max(1, MAX_ROWS - 1);
    const colW = OUT / cols;
    const rowRect = (r) => (r === 0 ? { y: 0, h: headerH } : { y: headerH + (r - 1) * rowH, h: rowH });

    // 1) Fondos: fill real por celda; si no hay estilos, encabezado gris claro.
    for (let r = 0; r < rows.length; r += 1) {
      const { y, h } = rowRect(r);
      const cells = rows[r];
      for (let c = 0; c < cols; c += 1) {
        const cell = cells[c];
        let bg = cell && cell.bg;
        if (!bg && !hasStyles && r === 0) bg = FALLBACK_HEADER_BG;
        if (bg) {
          ctx.fillStyle = bg;
          ctx.fillRect(c * colW, y, colW, h);
        }
      }
    }

    // 2) Líneas de grilla suaves.
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

    // 3) Texto: color/negrita reales, con recorte por ancho de columna.
    ctx.textBaseline = 'middle';
    for (let r = 0; r < rows.length; r += 1) {
      const { y, h } = rowRect(r);
      const cy = y + h / 2;
      const cells = rows[r];
      for (let c = 0; c < cols; c += 1) {
        const cell = cells[c];
        if (!cell) continue;
        const raw = cell.text;
        if (raw === undefined || raw === null || raw === '') continue;

        let color = cell.color;
        if (!color) {
          if (cell.bg) color = idealTextOn(cell.bg);
          else if (!hasStyles && r === 0) color = FALLBACK_TEXT;
          else color = FALLBACK_TEXT;
        }
        const bold = cell.bold || (!hasStyles && r === 0);

        ctx.fillStyle = color;
        ctx.font = `${bold ? 'bold ' : ''}11px "Segoe UI", Arial, sans-serif`;

        let text = String(raw);
        const maxW = colW - 8;
        while (text.length && ctx.measureText(text).width > maxW) {
          text = text.slice(0, -1);
        }
        ctx.fillText(text, c * colW + 4, cy);
      }
    }

    done(jobId, canvas);
  }

  async function renderSheet(jobId, buffer, kind) {
    const XLSX = window['XLSX'];
    let wb;
    if (kind === 'csv') {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
      wb = XLSX.read(text, { type: 'string', cellStyles: true });
    } else {
      wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellStyles: true });
    }
    const first = wb.SheetNames[0];
    const sheet = wb.Sheets[first];
    const { rows, hasStyles } = buildStyledGrid(XLSX, sheet);
    renderSheetGrid(jobId, rows, hasStyles);
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

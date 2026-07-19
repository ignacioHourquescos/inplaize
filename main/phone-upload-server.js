'use strict';

/**
 * Recibir archivos desde el teléfono por Wi-Fi (PWA).
 *
 * Un servidor HTTP mínimo que corre dentro del main de Electron, escuchando
 * en la LAN:
 *
 *  - `GET /?token=...`            → página móvil (PWA): un toque en cualquier
 *    parte abre el selector y sube con progreso.
 *  - `GET /manifest.webmanifest`  → manifest dinámico (incluye el token en las
 *    URLs) con `share_target`: instalada como app, inplaize aparece en el menú
 *    Compartir de Android.
 *  - `POST /share-target?token=…` → recibe los archivos compartidos desde el
 *    menú Compartir (multipart, parseado con busboy).
 *  - `POST /upload?token=…&name=…`→ subida directa desde la página (body crudo).
 *  - `GET /install?token=…`       → instrucciones para instalar la PWA.
 *  - `GET /icon-192.png|512`      → íconos del manifest (sin token: no son
 *    sensibles y simplifica el fetch del navegador).
 *
 * Todo lo recibido se guarda en la carpeta Descargas del sistema y se registra
 * en el historial del dock con progreso (sourceName "Teléfono").
 *
 * HTTPS: Chrome solo instala PWAs desde orígenes seguros. El servidor usa un
 * certificado autofirmado (ver phone-upload-tls.js) con la IP LAN actual en el
 * SAN. La primera vez en el celular hay que aceptar la advertencia de
 * seguridad; después el prompt "Instalar app" y el menú Compartir funcionan.
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const downloads = require('./downloads-manager');
const { loadOrCreateTlsCredentials } = require('./phone-upload-tls');
const { log } = require('./logger');

const PREFERRED_PORT = 47777;
/** Tope de tamaño por archivo (4 GB): evita llenar el disco por accidente. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

let server = null;
let actualPort = 0;
let token = '';

function configFilePath() {
  return path.join(app.getPath('userData'), 'phone-upload.json');
}

/** Token aleatorio persistido: el QR escaneado ayer sigue valiendo hoy. */
function loadOrCreateToken() {
  const p = configFilePath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (raw && typeof raw.token === 'string' && raw.token.length >= 16) return raw.token;
  } catch {
    /* primera vez o archivo corrupto */
  }
  const fresh = crypto.randomBytes(16).toString('hex');
  try {
    fs.writeFileSync(p, JSON.stringify({ token: fresh }, null, 2), 'utf-8');
  } catch {
    /* sin persistencia: token válido solo por esta sesión */
  }
  return fresh;
}

/** IPv4 de LAN de la máquina (la primera no interna). */
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

function isTokenValid(reqUrl) {
  try {
    const url = new URL(reqUrl, 'http://x');
    return token && url.searchParams.get('token') === token;
  } catch {
    return false;
  }
}

/** Nombre de archivo seguro: sin rutas ni caracteres inválidos en Windows. */
function sanitizeFilename(raw) {
  const base = path.basename(String(raw || '').trim());
  const clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return clean && clean !== '.' && clean !== '..' ? clean : `archivo_${Date.now()}`;
}

/* ---------------------------------------------------------------------------
 * Ingesta: guarda un stream como archivo en Descargas con progreso en el dock.
 * ------------------------------------------------------------------------- */

/**
 * @param {{ filename: string, totalBytes?: number, sourceName?: string }} meta
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<{ ok: boolean, savePath?: string, tooLarge?: boolean }>}
 */
function ingestStream(meta, stream) {
  return new Promise((resolve) => {
    let downloadsDir;
    try {
      downloadsDir = app.getPath('downloads');
    } catch {
      downloadsDir = app.getPath('temp');
    }
    const finalPath = downloads.uniqueDestPath(downloadsDir, sanitizeFilename(meta.filename));
    // Extensión temporal (que el watcher ignora); se renombra al terminar.
    const tempPath = `${finalPath}.uploading`;

    const recId = downloads.addExternalDownload({
      filename: path.basename(finalPath),
      savePath: finalPath,
      sourceName: meta.sourceName || 'Teléfono',
      totalBytes: Number(meta.totalBytes) || 0,
      state: 'progressing',
    });

    const out = fs.createWriteStream(tempPath);
    let received = 0;
    let lastNotify = 0;
    let failed = false;
    let tooLarge = false;

    const fail = () => {
      if (failed) return;
      failed = true;
      try {
        out.destroy();
      } catch {
        /* noop */
      }
      fs.unlink(tempPath, () => {});
      downloads.finishExternalDownload(recId, { ok: false });
      resolve({ ok: false, tooLarge });
    };

    stream.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        stream.unpipe(out);
        if (typeof stream.destroy === 'function') stream.destroy();
        fail();
        return;
      }
      const now = Date.now();
      if (now - lastNotify > 250) {
        lastNotify = now;
        downloads.updateExternalDownload(recId, received);
      }
    });

    stream.pipe(out);
    stream.on('error', fail);
    out.on('error', fail);
    // busboy corta el stream del archivo si supera `limits.fileSize`.
    stream.on('limit', () => {
      tooLarge = true;
      fail();
    });

    out.on('finish', () => {
      if (failed) return;
      try {
        fs.renameSync(tempPath, finalPath);
        downloads.finishExternalDownload(recId, { ok: true, savePath: finalPath });
        resolve({ ok: true, savePath: finalPath });
      } catch {
        fail();
      }
    });
  });
}

/* ---------------------------------------------------------------------------
 * Manifest e íconos (PWA)
 * ------------------------------------------------------------------------- */

function manifestJson() {
  const q = `?token=${token}`;
  return JSON.stringify({
    name: 'inplaize — enviar a la PC',
    short_name: 'inplaize',
    id: '/inplaize-phone-upload',
    description: 'Enviá archivos del teléfono a la zona de descargas de inplaize.',
    start_url: `/${q}`,
    scope: '/',
    display: 'standalone',
    background_color: '#111114',
    theme_color: '#111114',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    share_target: {
      action: `/share-target${q}`,
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [
          {
            name: 'files',
            accept: ['image/*', 'video/*', 'audio/*', 'text/*', 'application/*'],
          },
        ],
      },
    },
  });
}

/** Sirve assets/icon.png (512) o assets/icon-192.png. */
function serveIcon(res, size) {
  const file = size === 192 ? 'icon-192.png' : 'icon.png';
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'assets', file));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    res.end(buf);
  } catch {
    res.writeHead(404).end();
  }
}

/** Service worker mínimo: requisito de Chrome para instalar la PWA. */
function serviceWorkerJs() {
  return `'use strict';
self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
`;
}

/* ---------------------------------------------------------------------------
 * Páginas
 * ------------------------------------------------------------------------- */

/** Página que ve el teléfono: menú de origen siempre visible abajo. */
function mobilePageHtml() {
  const q = `?token=${token}`;
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#111114" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="inplaize" />
<title>inplaize — Enviar archivos</title>
<link rel="manifest" href="/manifest.webmanifest${q}" />
<link rel="icon" href="/icon-192.png" />
<link rel="apple-touch-icon" href="/icon-192.png" />
<style>
  :root { color-scheme: dark; --sheet-bg: #2b2b33; --sheet-handle: #5a5a64; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #111114; color: #f5f5f7; min-height: 100vh; min-height: 100dvh;
    display: flex; flex-direction: column; padding: 20px 20px 0;
    -webkit-tap-highlight-color: transparent;
  }
  .top { flex: 0 0 auto; text-align: center; padding-top: 8px; }
  h1 { font-size: 18px; font-weight: 600; letter-spacing: 0.02em; }
  h1 span { color: #8f8f96; font-weight: 500; }
  .hint { margin-top: 8px; font-size: 13px; color: #8f8f96; line-height: 1.45; }
  #status {
    flex: 1 1 auto; min-height: 0; margin-top: 20px;
    display: flex; flex-direction: column; gap: 8px; overflow-y: auto;
    padding-bottom: 12px;
  }
  .item { background: #1a1a1f; border-radius: 12px; padding: 10px 14px; font-size: 13px;
          display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .st { flex: 0 0 auto; color: #8f8f96; font-variant-numeric: tabular-nums; }
  .item.ok .st { color: #5dd97c; }
  .item.err .st { color: #ff6b6b; }
  input[type="file"] { display: none; }
  /* Hoja inferior: imita el menú nativo de Android, siempre visible. */
  .picker-sheet {
    flex: 0 0 auto; margin: 0 -20px; padding: 10px 20px calc(16px + env(safe-area-inset-bottom));
    background: var(--sheet-bg); border-radius: 20px 20px 0 0;
    box-shadow: 0 -8px 32px rgba(0,0,0,0.45);
  }
  .picker-handle {
    width: 36px; height: 4px; border-radius: 99px; background: var(--sheet-handle);
    margin: 0 auto 14px; opacity: 0.7;
  }
  .picker-title { font-size: 13px; color: #a8a8b0; text-align: center; margin-bottom: 14px; }
  .picker-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 6px;
  }
  .picker-opt {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    border: none; background: transparent; color: #f5f5f7; font-family: inherit;
    cursor: pointer; padding: 4px 2px; -webkit-tap-highlight-color: transparent;
  }
  .picker-opt:active .picker-icon { background: #3d3d48; transform: scale(0.96); }
  .picker-icon {
    width: 56px; height: 56px; border-radius: 50%; background: #3a3a44;
    display: flex; align-items: center; justify-content: center;
    transition: transform 0.12s ease, background 0.12s ease;
  }
  .picker-icon svg { width: 26px; height: 26px; }
  .picker-label { font-size: 11.5px; line-height: 1.2; text-align: center; color: #d8d8de; }
  #a2hs {
    flex: 0 0 auto; margin-bottom: 16px;
    background: linear-gradient(135deg, #2a2a38 0%, #1f1f28 100%);
    border: 1px solid #4a4a58; border-radius: 16px;
    padding: 16px 16px 14px; display: none; flex-direction: column; gap: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.35);
  }
  #a2hs.show { display: flex; }
  #a2hs strong { font-size: 16px; line-height: 1.3; }
  #a2hs p { font-size: 13.5px; line-height: 1.55; color: #c9c9d1; }
  #a2hs p b { color: #f5f5f7; }
  #a2hs-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  #a2hs-install {
    border: none; border-radius: 10px; padding: 10px 18px;
    background: #7c7cf0; color: #fff; font-size: 14px; font-weight: 600;
    font-family: inherit; cursor: pointer;
  }
  #a2hs-guide {
    border: none; border-radius: 10px; padding: 10px 14px;
    background: transparent; color: #9d9df5; font-size: 13px; font-weight: 600;
    font-family: inherit; cursor: pointer; text-decoration: underline;
  }
  #a2hs-skip {
    border: none; border-radius: 10px; padding: 10px 14px;
    background: rgba(255,255,255,0.06); color: #a8a8b0; font-size: 13px;
    font-family: inherit; cursor: pointer;
  }
</style>
</head>
<body>
  <div id="a2hs">
    <strong>Instalá inplaize en tu celular</strong>
    <p id="a2hs-steps"></p>
    <div id="a2hs-actions">
      <button id="a2hs-install" type="button">Instalar app</button>
      <button id="a2hs-guide" type="button">Ver guía</button>
      <button id="a2hs-skip" type="button">Ahora no</button>
    </div>
  </div>

  <div class="top">
    <h1>inplaize <span>· enviar a la PC</span></h1>
    <p class="hint">Elegí de dónde enviar. El archivo aparece al instante en Descargas.</p>
  </div>
  <div id="status"></div>

  <div class="picker-sheet" aria-label="Elegir origen del archivo">
    <div class="picker-handle" aria-hidden="true"></div>
    <p class="picker-title">Enviar desde</p>
    <div class="picker-grid">
      <button type="button" class="picker-opt" data-for="cam-photo" aria-label="Sacar foto">
        <span class="picker-icon">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.8"/>
            <circle cx="12" cy="13" r="4" stroke="currentColor" stroke-width="1.8"/>
          </svg>
        </span>
        <span class="picker-label">Cámara</span>
      </button>
      <button type="button" class="picker-opt" data-for="cam-video" aria-label="Grabar video">
        <span class="picker-icon">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="6" width="13" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/>
            <path d="M16 10l5-3v10l-5-3v-4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="picker-label">Video</span>
      </button>
      <button type="button" class="picker-opt" data-for="gallery" aria-label="Fotos y videos">
        <span class="picker-icon">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/>
            <circle cx="9" cy="10" r="1.5" fill="currentColor"/>
            <path d="M3 15l5-5 4 4 3-3 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="picker-label">Fotos y videos</span>
      </button>
      <button type="button" class="picker-opt" data-for="files" aria-label="Archivos">
        <span class="picker-icon">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 4h7l3 3v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.8"/>
            <path d="M15 4v4h4" stroke="currentColor" stroke-width="1.8"/>
          </svg>
        </span>
        <span class="picker-label">Archivos</span>
      </button>
    </div>
  </div>

  <input id="cam-photo" type="file" accept="image/*" capture="environment" />
  <input id="cam-video" type="file" accept="video/*" capture="environment" />
  <input id="gallery" type="file" accept="image/*,video/*" multiple />
  <input id="files" type="file" multiple />

<script>
  const status = document.getElementById('status');
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const inputs = {
    'cam-photo': document.getElementById('cam-photo'),
    'cam-video': document.getElementById('cam-video'),
    gallery: document.getElementById('gallery'),
    files: document.getElementById('files'),
  };

  function row(name) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = '<span class="name"></span><span class="st">0%</span>';
    el.querySelector('.name').textContent = name;
    status.prepend(el);
    return el;
  }

  const sharedCount = Number(params.get('shared') || 0);
  if (sharedCount > 0) {
    const el = row(sharedCount === 1 ? 'Archivo compartido' : sharedCount + ' archivos compartidos');
    el.classList.add('ok');
    el.querySelector('.st').textContent = 'Enviado';
  }

  async function uploadOne(file) {
    const el = row(file.name);
    const st = el.querySelector('.st');
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const q = new URLSearchParams({ token, name: file.name, size: String(file.size) });
        xhr.open('POST', '/upload?' + q.toString());
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) st.textContent = Math.round((e.loaded / e.total) * 100) + '%';
        };
        xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error('HTTP ' + xhr.status)));
        xhr.onerror = () => reject(new Error('red'));
        xhr.send(file);
      });
      el.classList.add('ok');
      st.textContent = 'Enviado';
    } catch {
      el.classList.add('err');
      st.textContent = 'Error';
    }
  }

  function bindInput(input) {
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      for (const f of files) await uploadOne(f);
    });
  }
  Object.values(inputs).forEach(bindInput);

  function openInput(id) {
    const input = inputs[id];
    if (!input) return;
    try {
      if (input.showPicker) input.showPicker();
      else input.click();
    } catch {
      input.click();
    }
  }

  document.querySelectorAll('.picker-opt').forEach((btn) => {
    btn.addEventListener('click', () => openInput(btn.dataset.for));
  });

  (function initA2hs() {
    const banner = document.getElementById('a2hs');
    const steps = document.getElementById('a2hs-steps');
    const installBtn = document.getElementById('a2hs-install');
    const guideBtn = document.getElementById('a2hs-guide');
    const skipBtn = document.getElementById('a2hs-skip');
    const SESSION_KEY = 'inplaize-a2hs-dismissed';
    const installed =
      window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (installed || sessionStorage.getItem(SESSION_KEY)) return;

    const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const guideUrl = '/install' + location.search;

    function setSteps(html) {
      steps.innerHTML = html;
    }

    function hideBanner() {
      sessionStorage.setItem(SESSION_KEY, '1');
      banner.classList.remove('show');
    }

    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      setSteps(
        'Queda en tu pantalla de inicio y aparece en el menú <b>Compartir</b> de Android. ' +
        'Así podés mandar fotos y archivos a la PC con un toque.',
      );
      installBtn.textContent = 'Instalar app';
      banner.classList.add('show');
    });

    installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice.catch(() => null);
        deferredPrompt = null;
        if (choice && choice.outcome === 'accepted') {
          hideBanner();
          return;
        }
      }
      if (isIos) {
        setSteps('Tocá el botón <b>Compartir</b> de Safari y elegí <b>Añadir a pantalla de inicio</b>.');
      } else {
        window.location.href = guideUrl;
      }
    });

    guideBtn.addEventListener('click', () => {
      window.location.href = guideUrl;
    });

    skipBtn.addEventListener('click', hideBanner);

    setSteps(
      isIos
        ? 'Para no escanear el QR cada vez, agregá inplaize a tu pantalla de inicio: ' +
          '<b>Compartir → Añadir a pantalla de inicio</b>.'
        : 'Instalá inplaize como app para acceder más rápido y usar el menú <b>Compartir → inplaize</b> ' +
          'desde la galería, WhatsApp y otras apps.',
    );
    if (!deferredPrompt) installBtn.textContent = isIos ? 'Cómo instalar' : 'Instalar app';
    banner.classList.add('show');
  })();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
</script>
</body>
</html>`;
}

/** Instrucciones para la primera visita (certificado autofirmado). */
function installPageHtml() {
  const q = `?token=${token}`;
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#111114" />
<title>inplaize — Instalar como app</title>
<link rel="manifest" href="/manifest.webmanifest${q}" />
<link rel="icon" href="/icon-192.png" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #111114; color: #f5f5f7; min-height: 100vh; padding: 28px 22px 48px;
    display: flex; flex-direction: column; gap: 18px; max-width: 560px; margin: 0 auto;
  }
  h1 { font-size: 20px; font-weight: 600; }
  p, li { font-size: 14.5px; line-height: 1.6; color: #c9c9d1; }
  b { color: #f5f5f7; }
  ol { padding-left: 22px; display: flex; flex-direction: column; gap: 12px; }
  .back { color: #9d9df5; font-size: 14px; text-decoration: none; }
  .note { font-size: 13px; color: #8f8f96; }
  .cta {
    display: flex; flex-direction: column; gap: 10px; margin-top: 4px;
  }
  .btn-primary {
    border: none; border-radius: 12px; padding: 14px 18px;
    background: #7c7cf0; color: #fff; font-size: 15px; font-weight: 600;
    font-family: inherit; cursor: pointer; text-align: center; text-decoration: none;
  }
  .btn-secondary {
    border: none; border-radius: 12px; padding: 12px 18px;
    background: rgba(255,255,255,0.06); color: #c9c9d1; font-size: 14px;
    font-family: inherit; cursor: pointer; text-align: center; text-decoration: none;
  }
</style>
</head>
<body>
  <h1>Instalá inplaize en tu celular</h1>
  <p>
    Instalada como app, inplaize queda en tu pantalla de inicio y aparece en el menú
    <b>Compartir</b> de Android: desde la galería es <b>Compartir → inplaize</b> y el
    archivo llega solo a la PC.
  </p>
  <ol>
    <li>
      Si Chrome avisa que la conexión no es privada, tocá <b>Avanzado</b> y
      <b>Continuar</b> (es tu propia PC en la red de casa, certificado autofirmado).
    </li>
    <li id="step-install">
      Tocá <b>Instalar app</b> abajo, o en Chrome menú <b>⋮</b> → <b>Instalar app</b> /
      <b>Añadir a pantalla de inicio</b>.
    </li>
    <li>Una vez instalada, abrila desde el ícono en tu pantalla de inicio.</li>
  </ol>
  <p class="note">
    Si cambiás de Wi-Fi (casa/trabajo), escaneá el QR de nuevo: la dirección IP
    cambia y puede pedirte aceptar el certificado otra vez.
  </p>
  <div class="cta">
    <button id="install-now" class="btn-primary" type="button">Instalar app</button>
    <a class="btn-secondary" href="/${q}">Continuar sin instalar</a>
  </div>
<script>
  (function () {
    const btn = document.getElementById('install-now');
    const step = document.getElementById('step-install');
    const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isIos) {
      step.innerHTML =
        'Tocá <b>Compartir</b> en Safari y elegí <b>Añadir a pantalla de inicio</b>.';
      btn.textContent = 'Entendido';
    }
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
    });
    btn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice.catch(() => {});
        deferredPrompt = null;
        return;
      }
      if (isIos) {
        step.innerHTML =
          'Abrí el menú <b>Compartir</b> (cuadrado con flecha) y elegí <b>Añadir a pantalla de inicio</b>.';
      } else {
        step.innerHTML =
          'En Chrome, tocá el menú <b>⋮</b> arriba a la derecha y buscá <b>Instalar app</b> o ' +
          '<b>Añadir a pantalla de inicio</b>.';
      }
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  })();
</script>
</body>
</html>`;
}

/* ---------------------------------------------------------------------------
 * Handlers HTTP
 * ------------------------------------------------------------------------- */

/** Subida directa desde la página: body crudo con nombre y tamaño en la query. */
async function handleUpload(req, res) {
  const url = new URL(req.url, 'http://x');
  const filename = url.searchParams.get('name');
  const declaredSize =
    Number(url.searchParams.get('size')) || Number(req.headers['content-length']) || 0;

  if (declaredSize > MAX_UPLOAD_BYTES) {
    res.writeHead(413).end('too large');
    return;
  }

  const result = await ingestStream({ filename, totalBytes: declaredSize }, req);
  if (result.ok) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(result.tooLarge ? 413 : 500).end('error');
  }
}

/** Archivos llegados por el menú Compartir de Android (multipart). */
function handleShareTarget(req, res) {
  let Busboy;
  try {
    Busboy = require('busboy');
  } catch {
    res.writeHead(500).end('busboy missing');
    return;
  }

  let bb;
  try {
    bb = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 30 },
    });
  } catch {
    res.writeHead(400).end('bad multipart');
    return;
  }

  /** @type {Promise<{ok:boolean}>[]} */
  const ingests = [];

  bb.on('file', (_field, fileStream, info) => {
    const filename = info && info.filename ? info.filename : `compartido_${Date.now()}`;
    ingests.push(ingestStream({ filename }, fileStream));
  });
  // Texto/URLs compartidos sin archivo: se ignoran (esto es para archivos).
  bb.on('field', () => {});

  bb.on('close', async () => {
    const results = await Promise.all(ingests);
    const okCount = results.filter((r) => r.ok).length;
    if (res.headersSent) return;
    // 303: el POST del share target termina como GET de la página normal.
    res.writeHead(303, { Location: `/?token=${token}&shared=${okCount}` });
    res.end();
  });
  bb.on('error', () => {
    if (!res.headersSent) res.writeHead(400).end('multipart error');
  });

  req.pipe(bb);
}

/* ---------------------------------------------------------------------------
 * Servidor
 * ------------------------------------------------------------------------- */

/**
 * Arranca el servidor (idempotente). Intenta el puerto preferido y si está
 * ocupado deja que el SO elija uno libre.
 * @returns {Promise<void>}
 */
async function startPhoneUploadServer() {
  if (server) return;
  token = loadOrCreateToken();

  const lanIp = getLanIp();
  const tls = await loadOrCreateTlsCredentials(lanIp);

  server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const pathname = new URL(req.url, 'https://x').pathname;

    // Recursos públicos del manifest (imágenes, service worker).
    if (req.method === 'GET' && pathname === '/icon-192.png') return serveIcon(res, 192);
    if (req.method === 'GET' && pathname === '/icon-512.png') return serveIcon(res, 512);
    if (req.method === 'GET' && pathname === '/sw.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(serviceWorkerJs());
      return;
    }

    if (!isTokenValid(req.url)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('inplaize: token inválido. Volvé a escanear el QR desde la PC.');
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(mobilePageHtml());
      return;
    }
    if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(manifestJson());
      return;
    }
    if (req.method === 'GET' && pathname === '/install') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(installPageHtml());
      return;
    }
    if (req.method === 'POST' && pathname === '/upload') {
      handleUpload(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/share-target') {
      handleShareTarget(req, res);
      return;
    }
    res.writeHead(404).end('not found');
  });

  return new Promise((resolve) => {
    const onListening = () => {
      actualPort = server.address().port;
      const scheme = 'https';
      log(
        `Servidor PWA de subida desde el teléfono (${scheme}) escuchando en puerto ${actualPort}` +
          (lanIp ? ` (LAN ${lanIp})` : ''),
      );
      resolve();
    };
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        server.listen(0, '0.0.0.0', onListening);
      } else {
        log(`Servidor de subida: no se pudo iniciar (${err?.message || err})`);
        server = null;
        resolve();
      }
    });
    server.listen(PREFERRED_PORT, '0.0.0.0', onListening);
  });
}

/**
 * Info para el popover del panel de descargas: URL actual (la IP puede cambiar
 * de red a red, por eso se calcula en cada llamada) y QR como data URL.
 * @returns {Promise<{ ok: boolean, url?: string, qrDataUrl?: string, error?: string }>}
 */
async function getConnectInfo() {
  if (!server) return { ok: false, error: 'SERVER_DOWN' };
  const ip = getLanIp();
  if (!ip) return { ok: false, error: 'NO_LAN' };
  const url = `https://${ip}:${actualPort}/?token=${token}`;
  try {
    const QRCode = require('qrcode');
    const qrDataUrl = await QRCode.toDataURL(url, {
      margin: 1,
      width: 240,
      color: { dark: '#FFFFFFFF', light: '#00000000' },
    });
    return { ok: true, url, qrDataUrl };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  startPhoneUploadServer,
  getConnectInfo,
};

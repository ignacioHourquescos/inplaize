'use strict';

/**
 * Preview del onboarding en el navegador.
 * http://127.0.0.1:4173/onboarding
 * http://127.0.0.1:4173/installer/   la ventana del instalador, con la descarga simulada
 * Sirve los archivos del repo para que el CSS, el JS y los íconos sean los mismos.
 *
 * El botón Descargar de la landing, en esta vista previa, no sale a GitHub: baja
 * dist/inplaize.Setup.X.exe, el instalador chico. Así se puede probar sin llevarse
 * el instalador completo que hoy está publicado con ese mismo nombre.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LANDING = path.join(ROOT, 'landing');
const PORT = Number(process.env.PORT) || 4173;
const HOST = '127.0.0.1';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
const SETUP_NAME = `inplaize.Setup.${VERSION}.exe`;
const FULL_NAME = `inplaize.Full.Setup.${VERSION}.exe`;
const SETUP_FILE = path.join(ROOT, 'dist', SETUP_NAME);
const FULL_FILE = path.join(ROOT, 'dist', FULL_NAME);
const LOCAL_SETUP_HREF = `/download/${SETUP_NAME}`;
const LOCAL_FULL_HREF = `/download/${FULL_NAME}`;
const RELEASE_SETUP_RE =
  /https:\/\/github\.com\/ignacioHourquescos\/inplaize\/releases\/download\/v[\d.]+\/inplaize\.Setup\.[\d.]+\.exe/g;

function rewriteLocalDownload(html) {
  return html.replace(RELEASE_SETUP_RE, LOCAL_SETUP_HREF);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function previewHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'onboarding-preview.html'), 'utf8');
  const stamp = Date.now();
  return html
    .replace('href="onboarding.css"', `href="onboarding.css?t=${stamp}"`)
    .replace('src="onboarding.js"', `src="onboarding.js?t=${stamp}"`);
}

function sendFile(res, filePath) {
  if (path.basename(filePath) === 'onboarding-preview.html') {
    const html = previewHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = TYPES[ext];
  if (!type) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (ext === '.html') {
    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500);
        res.end(err.code === 'ENOENT' ? 'Not found' : 'Error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
      });
      res.end(rewriteLocalDownload(html));
    });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/** Hasta cuándo el preview tiene prestado el atajo (la app no debe abrirse). */
let hotkeyYieldUntil = 0;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/hotkey-yield') {
    if (req.method === 'POST') {
      readBody(req).then((raw) => {
        let on = false;
        try {
          on = JSON.parse(raw || '{}').on === true;
        } catch {
          on = false;
        }
        hotkeyYieldUntil = on ? Date.now() + 2200 : 0;
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      });
      return;
    }
    const hold = Date.now() < hotkeyYieldUntil;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ hold }));
    return;
  }
  const downloadFile =
    pathname === LOCAL_SETUP_HREF ? SETUP_FILE : pathname === LOCAL_FULL_HREF ? FULL_FILE : null;
  if (downloadFile) {
    const downloadName = path.basename(downloadFile);
    if (!fs.existsSync(downloadFile)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        downloadFile === SETUP_FILE
          ? 'No está el instalador chico. Corré npm run build:installer.'
          : 'No está el instalador completo. Corré node scripts/build-win.js.',
      );
      return;
    }
    const stat = fs.statSync(downloadFile);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(downloadFile).pipe(res);
    return;
  }
  if (pathname === '/onboarding' || pathname === '/onboarding/') {
    sendFile(res, path.join(ROOT, 'onboarding-preview.html'));
    return;
  }
  // /manual → /manual/ para que los links relativos de la landing funcionen.
  if (pathname === '/manual' || pathname === '/landing/manual' || pathname === '/landing') {
    res.writeHead(302, { Location: pathname.replace(/^\/landing/, '') + '/' || '/' });
    res.end();
    return;
  }
  if (pathname === '/installer') {
    res.writeHead(302, { Location: '/installer/' });
    res.end();
    return;
  }
  // La ventana del instalador (installer/ui). Usa el CSS, el JS y los íconos del
  // onboarding; en el .exe van todos en una misma carpeta, y acá se arma igual.
  const installerRel = pathname.startsWith('/installer/') ? pathname.slice('/installer/'.length) || 'index.html' : null;
  const rel = installerRel == null ? pathname.replace(/^\/+/, '') : installerRel;
  if (rel.split(/[/\\]/).some((part) => part === '..' || part.startsWith('.'))) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (installerRel != null) {
    const own = path.join(ROOT, 'installer', 'ui', installerRel);
    sendFile(res, fs.existsSync(own) ? own : path.join(ROOT, installerRel));
    return;
  }
  // Una carpeta sirve su index.html (/ → landing, /manual/ → landing/manual).
  const withIndex = (p) => (pathname.endsWith('/') ? path.join(p, 'index.html') : p);
  // /landing/... sigue funcionando como alias.
  const landingRel = rel.replace(/^landing\/?/, '');
  const candidates = [
    withIndex(path.resolve(LANDING, landingRel)),
    withIndex(path.resolve(ROOT, rel)),
  ].filter((p) => p.startsWith(LANDING + path.sep) || p.startsWith(ROOT + path.sep));
  const found = candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  sendFile(res, found);
});

// Si el puerto está ocupado (casi siempre, otra vista previa que quedó abierta)
// se prueba con los siguientes en vez de morir con un error.
const LAST_PORT = PORT + 10;
let port = PORT;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < LAST_PORT) {
    console.log(`El puerto ${port} está ocupado; pruebo con el ${port + 1}.`);
    port += 1;
    server.listen(port, HOST);
    return;
  }
  console.error(
    err.code === 'EADDRINUSE'
      ? `No hay ningún puerto libre entre ${PORT} y ${LAST_PORT}.`
      : `No se pudo abrir la vista previa: ${err.message}`,
  );
  process.exit(1);
});

server.on('listening', () => {
  console.log(`Landing:    http://${HOST}:${port}/`);
  console.log(`Manual:     http://${HOST}:${port}/manual/`);
  console.log(`Onboarding: http://${HOST}:${port}/onboarding`);
  console.log(`Atajo:      http://${HOST}:${port}/onboarding?step=hotkey`);
  console.log(`Instalador: http://${HOST}:${port}/installer/`);
  console.log(`Descarga:   http://${HOST}:${port}${LOCAL_SETUP_HREF}`);
});

server.listen(port, HOST);

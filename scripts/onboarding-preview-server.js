'use strict';

/**
 * Preview del onboarding en el navegador.
 * http://127.0.0.1:4173/onboarding
 * Sirve los archivos del repo para que el CSS, el JS y los íconos sean los mismos.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LANDING = path.join(ROOT, 'landing');
const PORT = Number(process.env.PORT) || 4173;
const HOST = '127.0.0.1';

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
  const rel = pathname.replace(/^\/+/, '');
  if (rel.split(/[/\\]/).some((part) => part === '..' || part.startsWith('.'))) {
    res.writeHead(404);
    res.end('Not found');
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

server.listen(PORT, HOST, () => {
  console.log(`Landing:    http://${HOST}:${PORT}/`);
  console.log(`Manual:     http://${HOST}:${PORT}/manual/`);
  console.log(`Onboarding: http://${HOST}:${PORT}/onboarding`);
  console.log(`Atajo:      http://${HOST}:${PORT}/onboarding?step=hotkey`);
  console.log(`Computadora: http://${HOST}:${PORT}/onboarding?step=hotkey&stage=desk`);
});

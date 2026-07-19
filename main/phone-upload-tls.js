'use strict';

/**
 * Certificado TLS autofirmado para el servidor PWA de subida desde el teléfono.
 * Chrome solo instala PWAs desde orígenes seguros (HTTPS). Como inplaize corre
 * en la LAN con una IP que cambia, generamos un cert con SAN para la IP actual
 * y lo regeneramos cuando la red cambia.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const selfsigned = require('selfsigned');

function tlsDir() {
  return path.join(app.getPath('userData'), 'phone-upload-tls');
}

/**
 * @param {string | null} lanIp
 * @returns {Promise<{ key: string | Buffer, cert: string | Buffer }>}
 */
async function loadOrCreateTlsCredentials(lanIp) {
  const dir = tlsDir();
  const metaPath = path.join(dir, 'meta.json');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  let storedIp = null;
  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      storedIp = meta && meta.ip != null ? String(meta.ip) : null;
    }
  } catch {
    /* regenerar */
  }

  const ip = lanIp || '127.0.0.1';
  if (storedIp === ip && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: 'inplaize.local' },
    { type: 7, ip: '127.0.0.1' },
  ];
  if (ip && ip !== '127.0.0.1') {
    altNames.push({ type: 7, ip });
  }

  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + 825 * 24 * 60 * 60 * 1000);

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'inplaize' }], {
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'basicConstraints',
        cA: true,
      },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true,
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
      },
      {
        name: 'subjectAltName',
        altNames,
      },
    ],
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(metaPath, JSON.stringify({ ip, createdAt: Date.now() }, null, 2));

  return { key: pems.private, cert: pems.cert };
}

module.exports = { loadOrCreateTlsCredentials };

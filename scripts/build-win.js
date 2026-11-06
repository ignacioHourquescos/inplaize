'use strict';

/**
 * Build del instalador de Windows.
 *
 * SmartScreen muestra "Windows protegió tu PC / Más información → Ejecutar de
 * todas formas" cuando el .exe no está firmado: no es un bug de la app, es
 * Windows avisando que no puede verificar quién la publica. La única forma de
 * que deje de aparecer es firmar el instalador con un certificado de firma de
 * código (OV o EV) a nombre del publisher.
 *
 * Este script compila firmado si encuentra un certificado configurado, y sin
 * firmar si no hay ninguno (ahí el aviso sigue apareciendo). Formas de darle
 * un certificado, por variables de entorno:
 *
 *   CSC_LINK + CSC_KEY_PASSWORD   ruta (o base64) de un .pfx y su contraseña
 *   WIN_CERT_SUBJECT              CN del certificado ya instalado en Windows
 *   WIN_CERT_SHA1                 huella del certificado instalado en Windows
 *
 * Ejemplo:
 *   $env:CSC_LINK = "C:\certs\inplaize.pfx"
 *   $env:CSC_KEY_PASSWORD = "..."
 *   npm run build:win
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

const certFile = process.env.CSC_LINK || process.env.WIN_CSC_LINK || '';
const certSubject = process.env.WIN_CERT_SUBJECT || '';
const certSha1 = process.env.WIN_CERT_SHA1 || '';
const signing = !!(certFile || certSubject || certSha1);

const args = ['--win'];
const env = { ...process.env };

if (signing) {
  // Con firma, electron-builder edita y firma el .exe él mismo; después de eso
  // nadie más puede tocarlo o la firma deja de validar (ver scripts/after-pack.js).
  args.push('--config.win.signAndEditExecutable=true');
  if (certSubject) args.push(`--config.win.signtoolOptions.certificateSubjectName=${certSubject}`);
  if (certSha1) args.push(`--config.win.signtoolOptions.certificateSha1=${certSha1}`);
  env.INPLAIZE_SIGNING = '1';
  delete env.CSC_IDENTITY_AUTO_DISCOVERY;
} else {
  // Sin certificado no tiene sentido que electron-builder salga a buscar uno:
  // falla la build en vez de compilar sin firmar.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

// eslint-disable-next-line no-console
console.log(
  signing
    ? '[build:win] compilando CON firma de código'
    : '[build:win] compilando SIN firmar — Windows va a mostrar el aviso de SmartScreen al instalar',
);

// Se invoca el cli.js con node en vez del .cmd de node_modules/.bin: con shell
// la ruta del proyecto (que tiene un espacio) se parte en dos y la build muere.
const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const res = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, stdio: 'inherit' });
process.exit(res.status == null ? 1 : res.status);

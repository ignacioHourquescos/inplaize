'use strict';

/**
 * Build del instalador chico: el .exe que se baja de la web.
 *
 * Pesa alrededor de 1 MB, así que la descarga del navegador es instantánea. Al
 * abrirlo muestra una ventana y recién ahí baja el instalador completo
 * (inplaize.Full.Setup.X.exe, el que arma electron-builder) del mismo release,
 * mientras muestra cómo funciona inplaize. El código está en installer/.
 *
 * Quedan dos archivos por versión en dist/:
 *   inplaize.Setup.X.exe        el chico; es el que enlaza la landing
 *   inplaize.Full.Setup.X.exe   el completo; lo baja el chico, y sirve suelto para instalar sin internet
 *
 * Se compila con el csc.exe de .NET Framework que viene con Windows, para no
 * depender de ningún SDK. Lo único que se baja es el paquete de WebView2 (las
 * DLL que hacen de puente con el navegador del sistema), con la versión y el
 * hash fijos acá abajo.
 *
 *   INPLAIZE_SETUP_URL   otra dirección para el instalador completo. Sirve
 *                        para probar contra un release que ya está publicado.
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = pkg.version || '0.0.0';
const productName = (pkg.build && pkg.build.productName) || pkg.name;
const repo = 'https://github.com/ignacioHourquescos/inplaize';

const fullName = `inplaize.Full.Setup.${version}.exe`;
const webName = `inplaize.Setup.${version}.exe`;
const setupUrl = process.env.INPLAIZE_SETUP_URL || `${repo}/releases/download/v${version}/${fullName}`;

const WEBVIEW2 = {
  version: '1.0.4314.35',
  sha512:
    '70e6a256a3f7066407327c46a59cc034cdb6b545e0c9cae2b322478c818dcc868cb26f225e3ecac7e71e620f916d8c09b734f4d3da9f7054e872f54b63e7a433',
  // Lo que se usa del paquete → cómo queda en la caché.
  files: {
    'lib/net462/Microsoft.Web.WebView2.Core.dll': 'Microsoft.Web.WebView2.Core.dll',
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll': 'Microsoft.Web.WebView2.WinForms.dll',
    'runtimes/win-x64/native/WebView2Loader.dll': 'x64/WebView2Loader.dll',
    'runtimes/win-x86/native/WebView2Loader.dll': 'x86/WebView2Loader.dll',
    'runtimes/win-arm64/native/WebView2Loader.dll': 'arm64/WebView2Loader.dll',
    'LICENSE.txt': 'LICENSE.txt',
  },
};

const cacheDir = path.join(root, 'node_modules', '.cache', 'inplaize-installer');
const sdkDir = path.join(cacheDir, `webview2-${WEBVIEW2.version}`);

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[build:installer] ${message}`);
}

function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map((dir) =>
    path.join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe'),
  );
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`No está csc.exe de .NET Framework 4 (se buscó en ${candidates.join(' y ')}).`);
  return found;
}

/** Saca de un .zip (un .nupkg lo es) los archivos pedidos. */
function unzip(buffer, wanted) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('El paquete de WebView2 no es un zip válido.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('El paquete de WebView2 está dañado.');
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (wanted.includes(name)) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      out.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function ensureWebView2Sdk() {
  const targets = Object.values(WEBVIEW2.files).map((file) => path.join(sdkDir, file));
  if (targets.every((file) => fs.existsSync(file))) return;

  const url =
    `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2.version}/` +
    `microsoft.web.webview2.${WEBVIEW2.version}.nupkg`;
  log(`bajando el paquete de WebView2 ${WEBVIEW2.version}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo bajar ${url} (${response.status}).`);
  const nupkg = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash('sha512').update(nupkg).digest('hex');
  if (hash !== WEBVIEW2.sha512) {
    throw new Error(`El paquete de WebView2 no coincide con el hash esperado (llegó ${hash}).`);
  }

  const entries = unzip(nupkg, Object.keys(WEBVIEW2.files));
  Object.entries(WEBVIEW2.files).forEach(([entry, file]) => {
    const data = entries.get(entry);
    if (!data) throw new Error(`El paquete de WebView2 no trae ${entry}.`);
    const target = path.join(sdkDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  });
}

/**
 * Lo que va embebido en el .exe: [archivo, nombre adentro].
 * La interfaz usa el CSS, el JS y los íconos del onboarding tal cual están en
 * la app, así que un cambio en el tour se ve también en el instalador.
 */
function resources() {
  const list = [
    [path.join(sdkDir, 'Microsoft.Web.WebView2.Core.dll'), 'Microsoft.Web.WebView2.Core.dll'],
    [path.join(sdkDir, 'Microsoft.Web.WebView2.WinForms.dll'), 'Microsoft.Web.WebView2.WinForms.dll'],
    // La licencia de WebView2 pide que su aviso acompañe a lo que se distribuye.
    [path.join(sdkDir, 'LICENSE.txt'), 'licenses/WebView2.txt'],
  ];
  ['x64', 'x86', 'arm64'].forEach((arch) => {
    list.push([path.join(sdkDir, arch, 'WebView2Loader.dll'), `loader/${arch}/WebView2Loader.dll`]);
  });

  const uiDir = path.join(root, 'installer', 'ui');
  fs.readdirSync(uiDir).forEach((file) => list.push([path.join(uiDir, file), `ui/${file}`]));
  ['onboarding.css', 'onboarding.js'].forEach((file) => list.push([path.join(root, file), `ui/${file}`]));
  list.push([path.join(root, 'assets', 'win-hill.svg'), 'ui/assets/win-hill.svg']);
  const iconsDir = path.join(root, 'assets', 'icons');
  fs.readdirSync(iconsDir)
    .filter((file) => file.endsWith('.png'))
    .forEach((file) => list.push([path.join(iconsDir, file), `ui/assets/icons/${file}`]));
  return list;
}

function csString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Datos de esta versión, y los metadatos del .exe (SignPath exige nombre y versión de producto). */
function writeBuildInfo(file) {
  const numbers = version.split(/[.+-]/).map((part) => parseInt(part, 10) || 0);
  const fileVersion = [0, 1, 2, 3].map((i) => numbers[i] || 0).join('.');
  const author = typeof pkg.author === 'string' ? pkg.author : (pkg.author && pkg.author.name) || productName;
  const fullPath = path.join(root, 'dist', fullName);
  const sizeHint = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
  const fileName = decodeURIComponent(new URL(setupUrl).pathname.split('/').pop());

  const source = `// Generado por scripts/build-installer.js. No se edita a mano.
using System.Reflection;

[assembly: AssemblyTitle(${csString(productName)})]
[assembly: AssemblyDescription(${csString(`Instalador de ${productName}`)})]
[assembly: AssemblyProduct(${csString(productName)})]
[assembly: AssemblyCompany(${csString(author)})]
[assembly: AssemblyCopyright(${csString(`© ${new Date().getFullYear()} ${author}`)})]
[assembly: AssemblyVersion(${csString(fileVersion)})]
[assembly: AssemblyFileVersion(${csString(fileVersion)})]
[assembly: AssemblyInformationalVersion(${csString(version)})]

namespace Inplaize.Setup
{
    static class BuildInfo
    {
        public const string Version = ${csString(version)};
        /// <summary>El instalador completo de esta misma versión.</summary>
        public const string SetupUrl = ${csString(setupUrl)};
        public const string SetupFileName = ${csString(fileName)};
        /// <summary>Lo que pesa, para avisarlo antes de bajar. 0 si no se sabe.</summary>
        public const long SetupSizeHint = ${sizeHint};
        /// <summary>El proceso de la app, para saber cuándo ya abrió.</summary>
        public const string AppProcessName = ${csString(productName)};
    }
}
`;
  fs.writeFileSync(file, `\ufeff${source}`, 'utf-8');
}

async function main() {
  if (process.platform !== 'win32') {
    log('solo se arma en Windows; se omite');
    return;
  }

  const csc = findCsc();
  await ensureWebView2Sdk();

  fs.mkdirSync(cacheDir, { recursive: true });
  const buildInfo = path.join(cacheDir, 'BuildInfo.cs');
  writeBuildInfo(buildInfo);

  const outFile = path.join(root, 'dist', webName);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // Las opciones van en un archivo: la ruta del proyecto tiene un espacio y por línea de comandos se parte.
  const quote = (file) => `"${file}"`;
  const options = [
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/debug-',
    '/codepage:65001',
    `/out:${quote(outFile)}`,
    `/win32icon:${quote(path.join(root, 'assets', 'icon.ico'))}`,
    `/win32manifest:${quote(path.join(root, 'installer', 'app.manifest'))}`,
    `/reference:${quote(path.join(sdkDir, 'Microsoft.Web.WebView2.Core.dll'))}`,
    `/reference:${quote(path.join(sdkDir, 'Microsoft.Web.WebView2.WinForms.dll'))}`,
    ...resources().map(([file, name]) => `/resource:${quote(file)},${name}`),
    quote(path.join(root, 'installer', 'Installer.cs')),
    quote(buildInfo),
  ];
  const responseFile = path.join(cacheDir, 'csc.rsp');
  fs.writeFileSync(responseFile, `\ufeff${options.join('\r\n')}\r\n`, 'utf-8');

  const res = spawnSync(csc, ['/nologo', `@${responseFile}`], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`csc.exe terminó con código ${res.status}.`);

  const kb = Math.round(fs.statSync(outFile).size / 1024);
  log(`${path.relative(root, outFile)} · ${kb} KB · baja ${setupUrl}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[build:installer] ${err.message}`);
  process.exit(1);
});

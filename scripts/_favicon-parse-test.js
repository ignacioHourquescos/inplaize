'use strict';

const { parseLinkIcons, parseBaseHref, buildCandidateList, normalizePageUrl, imageDataUrl } = require('../main/web-favicon');

const html = [
  '<head>',
  '<base href="https://cdn.example.com/app/">',
  '<link rel="apple-touch-icon" sizes="180x180" href="/apple.png">',
  '<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">',
  '<link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">',
  '<link rel="mask-icon" href="/mask.svg">',
  '</head>',
].join('');

const links = parseLinkIcons(html, parseBaseHref(html, 'https://example.com/page'));
const list = buildCandidateList(links, 'https://example.com');
if (!list[0].endsWith('/favicon.ico')) {
  throw new Error('ico first ' + list.join(' | '));
}
if (!list.some((u) => u.endsWith('/app/favicon-32.png'))) {
  throw new Error('png base ' + list.join(' | '));
}
const maskIdx = list.findIndex((u) => u.includes('mask'));
const pngIdx = list.findIndex((u) => u.includes('favicon-32'));
if (maskIdx !== -1 && maskIdx < pngIdx) {
  throw new Error('mask before png ' + list.join(' | '));
}
if (normalizePageUrl('notaurl')) throw new Error('reject word');
const gh = normalizePageUrl('github.com');
if (!gh || gh.href !== 'https://github.com/') throw new Error('norm ' + (gh && gh.href));
if (normalizePageUrl('file:///c:/x')) throw new Error('file');
const png = Buffer.from('89504e470d0a1a0a', 'hex');
if (!imageDataUrl(png, 'image/png', 'https://x/a.png').startsWith('data:image/png;base64,')) {
  throw new Error('png');
}
if (imageDataUrl(Buffer.from('<html>nope</html>'), 'image/x-icon', 'https://x/favicon.ico')) {
  throw new Error('html as ico');
}
const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
if (!imageDataUrl(ico, 'application/octet-stream', 'https://x/favicon.ico').startsWith('data:image/x-icon;base64,')) {
  throw new Error('ico sniff');
}
console.log(list.join('\n'));
console.log('parser ok');

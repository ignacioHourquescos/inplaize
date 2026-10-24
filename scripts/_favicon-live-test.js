'use strict';

const path = require('path');
const { app } = require('electron');

const root = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const { resolveWebFavicon } = require(path.join(root, 'main', 'web-favicon'));
  const targets = ['https://github.com', 'https://es.wikipedia.org'];
  let failed = false;
  for (const target of targets) {
    const dataUrl = await resolveWebFavicon(target);
    const ok = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/');
    console.log(target, ok ? dataUrl.slice(0, 48) : 'MISS', ok ? dataUrl.length : 0);
    if (!ok) failed = true;
  }
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});

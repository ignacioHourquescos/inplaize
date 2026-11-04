'use strict';

const path = require('path');
const { Menu, dialog, clipboard, shell } = require('electron');

/** Mismos escalones que Chrome. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

const NEW_TAB_URL = 'https://www.google.com/';
const GEMINI_URL = 'https://gemini.google.com/app';
const LENS_UPLOAD_URL = 'https://lens.google.com/v3/upload?hl=es';
const TRANSLATE_TARGET_LANG = 'es';
const HISTORY_MENU_MAX = 15;

/**
 * @typedef {{
 *   host: Electron.BrowserWindow | null,
 *   activeWebContents: () => Electron.WebContents | null,
 *   openTab: (url: string, opts?: { loadOptions?: Electron.LoadURLOptions }) => Promise<unknown>,
 *   sendToChrome: (command: string, payload?: unknown) => void,
 *   newTab?: () => void,
 *   allowFullScreen?: boolean,
 * }} PageMenuContext
 */

function isAlive(wc) {
  return !!wc && !wc.isDestroyed();
}

/** @param {PageMenuContext} ctx */
function openNewTab(ctx) {
  if (typeof ctx.newTab === 'function') ctx.newTab();
  else ctx.openTab(NEW_TAB_URL).catch(() => {});
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function zoomPercent(wc) {
  return Math.round((isAlive(wc) ? wc.getZoomFactor() : 1) * 100);
}

/** @param {Electron.WebContents} wc @param {1 | -1 | 0} dir */
function stepZoom(wc, dir) {
  if (!isAlive(wc)) return;
  if (dir === 0) {
    wc.setZoomFactor(1);
    return;
  }
  const cur = wc.getZoomFactor();
  const next =
    dir > 0
      ? ZOOM_STEPS.find((z) => z > cur + 0.001)
      : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001);
  if (next) wc.setZoomFactor(next);
}

/** @param {PageMenuContext} ctx */
function toggleFullScreen(ctx) {
  const { host } = ctx;
  if (!ctx.allowFullScreen || !host || host.isDestroyed()) return;
  const next = !host.isFullScreen();
  if (next) host.setFullScreenable(true);
  host.setFullScreen(next);
}

/** @param {Electron.WebContents} wc */
function printPage(wc) {
  if (!isAlive(wc)) return;
  wc.print({}, () => {});
}

/** @param {Electron.WebContents} wc */
function translatePage(wc) {
  if (!isAlive(wc)) return;
  const url = wc.getURL();
  if (!isWebUrl(url)) return;
  const target =
    'https://translate.google.com/translate?sl=auto' +
    `&tl=${TRANSLATE_TARGET_LANG}&hl=${TRANSLATE_TARGET_LANG}&u=${encodeURIComponent(url)}`;
  wc.loadURL(target).catch(() => {});
}

/**
 * Captura lo visible de la pestaña y la sube a Lens como formulario multipart,
 * igual que el botón de Chrome.
 * @param {PageMenuContext} ctx
 */
async function searchWithLens(ctx) {
  const wc = ctx.activeWebContents();
  if (!isAlive(wc)) return;
  const image = await wc.capturePage();
  const png = image.toPNG();
  const boundary = `----inplaizeLens${Date.now().toString(16)}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="encoded_image"; filename="captura.png"\r\n' +
        'Content-Type: image/png\r\n\r\n'
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  await ctx.openTab(LENS_UPLOAD_URL, {
    loadOptions: {
      postData: [{ type: 'rawData', bytes: body }],
      extraHeaders: `Content-Type: multipart/form-data; boundary=${boundary}`,
    },
  });
}

/** @param {Electron.BrowserWindow | null} host */
function dialogParent(host) {
  return host && !host.isDestroyed() ? [host] : [];
}

/** @param {Electron.BrowserWindow | null} host @param {Electron.WebContents} wc */
async function savePageAs(host, wc) {
  if (!isAlive(wc)) return;
  const title = (wc.getTitle() || 'pagina').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'pagina';
  const { canceled, filePath } = await dialog.showSaveDialog(...dialogParent(host), {
    title: 'Guardar página como',
    defaultPath: `${title}.html`,
    filters: [{ name: 'Página web completa', extensions: ['html', 'htm'] }],
  });
  if (canceled || !filePath) return;
  const ext = path.extname(filePath) ? '' : '.html';
  await wc.savePage(filePath + ext, 'HTMLComplete');
}

/** @param {Electron.BrowserWindow | null} host @param {Electron.WebContents} wc */
async function clearBrowsingData(host, wc) {
  if (!isAlive(wc)) return;
  const { response } = await dialog.showMessageBox(...dialogParent(host), {
    type: 'question',
    title: 'Eliminar datos de navegación',
    message: 'Eliminar datos de navegación de este acceso',
    detail:
      'Borrar todo cierra la sesión en este sitio y en los demás que usen la misma sesión.',
    buttons: ['Cancelar', 'Solo caché', 'Caché, cookies e historial'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (response === 0) return;
  const ses = wc.session;
  await ses.clearCache();
  if (response === 2) {
    await ses.clearStorageData();
    try {
      wc.navigationHistory.clear();
    } catch {
      /* el historial se limpia en la próxima navegación */
    }
  }
  wc.reload();
}

/** @param {Electron.WebContents} wc */
function historyMenuItems(wc) {
  const nav = wc.navigationHistory;
  const entries = nav.getAllEntries();
  const current = nav.getActiveIndex();
  const items = [];
  for (let i = entries.length - 1; i >= 0 && items.length < HISTORY_MENU_MAX; i -= 1) {
    const e = entries[i];
    const label = (e.title || e.url || '').slice(0, 80);
    items.push({
      label: label.replace(/&/g, '&&'),
      type: 'checkbox',
      checked: i === current,
      click: () => {
        if (isAlive(wc)) nav.goToIndex(i);
      },
    });
  }
  return items.length ? items : [{ label: 'Sin historial', enabled: false }];
}

/**
 * @param {PageMenuContext} ctx
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function buildTemplate(ctx) {
  const { host } = ctx;
  const wc = ctx.activeWebContents();
  const hasPage = isAlive(wc);
  const webPage = hasPage && isWebUrl(wc.getURL());
  const label = (accelerator) => ({ accelerator, registerAccelerator: false });
  const fullScreenItems = ctx.allowFullScreen
    ? [
        {
          label: 'Pantalla completa',
          type: /** @type {const} */ ('checkbox'),
          checked: !!host && !host.isDestroyed() && host.isFullScreen(),
          ...label('F11'),
          click: () => toggleFullScreen(ctx),
        },
      ]
    : [];

  return [
    {
      label: 'Nueva pestaña',
      ...label('Ctrl+T'),
      click: () => openNewTab(ctx),
    },
    { type: 'separator' },
    { label: 'Historial', enabled: hasPage, submenu: hasPage ? historyMenuItems(wc) : [] },
    {
      label: 'Descargas',
      ...label('Ctrl+J'),
      click: () => ctx.sendToChrome('downloads'),
    },
    { type: 'separator' },
    {
      label: `Zoom: ${zoomPercent(wc)} %`,
      enabled: hasPage,
      submenu: [
        { label: 'Acercar', ...label('Ctrl+Plus'), click: () => stepZoom(wc, 1) },
        { label: 'Alejar', ...label('Ctrl+-'), click: () => stepZoom(wc, -1) },
        { label: 'Restablecer (100 %)', ...label('Ctrl+0'), click: () => stepZoom(wc, 0) },
      ],
    },
    ...fullScreenItems,
    { type: 'separator' },
    { label: 'Imprimir…', enabled: hasPage, ...label('Ctrl+P'), click: () => printPage(wc) },
    {
      label: 'Abrir Gemini',
      click: () => ctx.openTab(GEMINI_URL).catch(() => {}),
    },
    {
      label: 'Buscar en esta pestaña con Google Lens',
      enabled: hasPage,
      click: () => searchWithLens(ctx).catch(() => {}),
    },
    { label: 'Traducir…', enabled: webPage, click: () => translatePage(wc) },
    {
      label: 'Buscar en la página…',
      enabled: hasPage,
      ...label('Ctrl+F'),
      click: () => ctx.sendToChrome('find-open'),
    },
    {
      label: 'Enviar, guardar y compartir',
      enabled: hasPage,
      submenu: [
        {
          label: 'Copiar enlace',
          enabled: webPage,
          click: () => clipboard.writeText(wc.getURL()),
        },
        {
          label: 'Guardar página como…',
          ...label('Ctrl+S'),
          click: () => savePageAs(host, wc).catch(() => {}),
        },
        {
          label: 'Abrir en el navegador del sistema',
          enabled: webPage,
          click: () => shell.openExternal(wc.getURL()).catch(() => {}),
        },
      ],
    },
    {
      label: 'Más herramientas',
      enabled: hasPage,
      submenu: [
        {
          label: 'Eliminar datos de navegación…',
          ...label('Ctrl+Shift+Delete'),
          click: () => clearBrowsingData(host, wc).catch(() => {}),
        },
        {
          label: 'Herramientas para desarrolladores',
          ...label('Ctrl+Shift+I'),
          click: () => wc.openDevTools({ mode: 'detach' }),
        },
      ],
    },
  ];
}

/**
 * @param {PageMenuContext} ctx
 * @param {{ x?: number, y?: number }} [at] coordenadas en la página de la franja
 */
function popupPageMenu(ctx, at = {}) {
  if (!ctx.host || ctx.host.isDestroyed()) return;
  const menu = Menu.buildFromTemplate(buildTemplate(ctx));
  const opts = { window: ctx.host };
  if (Number.isFinite(at.x) && Number.isFinite(at.y)) {
    opts.x = Math.round(at.x);
    opts.y = Math.round(at.y);
  }
  menu.popup(opts);
}

/**
 * Atajos tipo Chrome dentro de la página (zoom, buscar, imprimir…).
 * @param {Electron.WebContents} wc
 * @param {PageMenuContext} ctx
 */
function attachPageShortcuts(wc, ctx) {
  if (!isAlive(wc)) return;

  wc.on('zoom-changed', (_e, direction) => {
    stepZoom(wc, direction === 'in' ? 1 : -1);
  });

  wc.on('found-in-page', (_e, result) => {
    if (ctx.activeWebContents() !== wc) return;
    ctx.sendToChrome('find-result', {
      active: result.activeMatchOrdinal || 0,
      total: result.matches || 0,
    });
  });

  wc.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    const key = String(input.key || '');
    const ctrl = input.control || input.meta;
    const { host } = ctx;

    if (key === 'F11' && !ctrl && !input.alt && ctx.allowFullScreen) {
      event.preventDefault();
      toggleFullScreen(ctx);
      return;
    }
    if (key === 'Escape' && !ctrl && host && !host.isDestroyed() && host.isFullScreen()) {
      event.preventDefault();
      host.setFullScreen(false);
      return;
    }
    if (!ctrl || input.alt) return;

    const lower = key.toLowerCase();
    let handled = true;
    if (input.shift) {
      if (lower === 'i') wc.openDevTools({ mode: 'detach' });
      else if (key === 'Delete') clearBrowsingData(host, wc).catch(() => {});
      else handled = false;
    } else if (key === '+' || key === '=' || key === 'Add') stepZoom(wc, 1);
    else if (key === '-' || key === 'Subtract') stepZoom(wc, -1);
    else if (key === '0') stepZoom(wc, 0);
    else if (lower === 'f') ctx.sendToChrome('find-open');
    else if (lower === 'p') printPage(wc);
    else if (lower === 's') savePageAs(host, wc).catch(() => {});
    else if (lower === 't') openNewTab(ctx);
    else if (lower === 'j') ctx.sendToChrome('downloads');
    else handled = false;
    if (handled) event.preventDefault();
  });
}

/**
 * @param {Electron.WebContents | null} wc
 * @param {{ text?: string, forward?: boolean, newSearch?: boolean } | null} arg
 */
function findInPage(wc, arg) {
  if (!isAlive(wc)) return false;
  const text = arg && typeof arg.text === 'string' ? arg.text : '';
  if (!text) {
    wc.stopFindInPage('clearSelection');
    return false;
  }
  wc.findInPage(text, { forward: arg.forward !== false, findNext: arg.newSearch === true });
  return true;
}

/** @param {Electron.WebContents | null} wc */
function stopFindInPage(wc) {
  if (!isAlive(wc)) return false;
  wc.stopFindInPage('clearSelection');
  return true;
}

module.exports = {
  popupPageMenu,
  attachPageShortcuts,
  findInPage,
  stopFindInPage,
};

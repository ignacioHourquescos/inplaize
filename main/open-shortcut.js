'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { shell, BrowserWindow, session, app } = require('electron');
const { isProcessRunning, focusWindowByProcess } = require('./process-utils');
const { partitionFromSessionId } = require('./session-partition');
const { webMapKey } = require('./web-map-key');
const { loadAppSettings } = require('./app-settings-store');
const {
  broadcastShortcutTitleBadge,
  broadcastOpenWebWindowKeys,
} = require('./dock-window-bridge');
const { forceWindowForeground } = require('./window-focus');

/**
 * Ruta absoluta a un icono en disco para `BrowserWindow.setIcon` (PNG/ICO…), o null.
 * @param {import('./shortcuts-store').Shortcut | Record<string, unknown>} shortcut
 * @returns {string | null}
 */
function resolveShortcutIconPathForWindow(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return null;
  const icon = typeof shortcut.icon === 'string' ? shortcut.icon.trim() : '';
  if (!icon || /^https?:\/\//i.test(icon) || icon.startsWith('data:')) return null;
  let root;
  try {
    root = app.getAppPath();
  } catch {
    root = path.join(__dirname, '..');
  }
  const normalized = icon.replace(/\\/g, '/');
  const abs = path.isAbsolute(icon) ? icon : path.join(root, normalized.replace(/^\//, ''));
  try {
    if (fs.existsSync(abs) && /\.(png|ico|jpe?g|gif|webp)$/i.test(abs)) return abs;
  } catch {
    return null;
  }
  return null;
}

/** Solo depuración: volcado en toasts nativos + archivo (ver buildWebNotificationPatchScript). */
const DEBUG_DUMP_WEB_NOTIFICATION_IN_TOAST = false;

/**
 * @param {boolean} custom true = notificación amigable en el panel, sin toast de Windows
 * @param {boolean} debug volcado técnico en toasts nativos (si custom es false)
 */
function buildWebNotificationPatchScript(custom, debug) {
  const C = custom ? 'true' : 'false';
  const D = debug ? 'true' : 'false';
  return `(function(){
try{
  var Native=window.Notification;
  if(!Native||typeof Native!=='function')return;
  if(!window.__usualDeskNativeNotification)window.__usualDeskNativeNotification=Native;
  var VER=5;
  if(window.__usualDeskNotifyPatch&&window.__usualDeskNotifyVer===VER)return;
  if(window.__usualDeskNotifyPatch){
    try{window.Notification=window.__usualDeskNativeNotification;}catch(e){}
    delete window.__usualDeskNotifyPatch;
    delete window.__usualDeskNotifyVer;
  }
  window.__usualDeskNotifyPatch=true;
  window.__usualDeskNotifyVer=VER;
  var N=Native;
  var CUSTOM=${C};
  var DEBUG=${D};
  function onNativeClick(){
    try{
      if(typeof window.__usualDeskOnNotificationClick==='function')window.__usualDeskOnNotificationClick();
    }catch(e){}
  }
  function ser(title,opts){
    opts=opts||{};
    var lines=['title: '+String(title)];
    var done=Object.create(null);
    function add(k,v){
      if(v===undefined)return;
      done[k]=1;
      try{
        if(k==='actions'&&Array.isArray(v)){
          v=v.map(function(a){return{action:a.action,title:a.title,icon:a.icon};});
        }
        lines.push(k+': '+(typeof v==='object'?JSON.stringify(v):String(v)));
      }catch(e){lines.push(k+': [...]');}
    }
    var std=['body','icon','badge','image','tag','silent','requireInteraction','timestamp','dir','lang','renotify','vibrate'];
    for(var si=0;si<std.length;si++){
      var sk=std[si];
      if(Object.prototype.hasOwnProperty.call(opts,sk))add(sk,opts[sk]);
    }
    if(Object.prototype.hasOwnProperty.call(opts,'data'))add('data',opts.data);
    for(var p in opts){
      if(done[p])continue;
      try{add(p,opts[p]);}catch(e){}
    }
    return lines.join('\\n');
  }
  function splitDump(full){
    var maxC=420;
    var maxParts=32;
    var parts=[];
    var i=0;
    while(i<full.length&&parts.length<maxParts){
      var end=Math.min(i+maxC,full.length);
      if(end<full.length){
        var br=full.lastIndexOf('\\n',end);
        var sp=full.lastIndexOf(' ',end);
        if(br>i+30)end=br+1;
        else if(sp>i+40)end=sp+1;
      }
      parts.push(full.slice(i,end));
      i=end;
    }
    if(i<full.length&&parts.length){
      parts[parts.length-1]+='\\n… (+'+(full.length-i)+' chars → last-web-notification-dump.txt)';
    }
    return parts;
  }
  function makeInAppMock(title,opts){
    opts=opts||{};
    var listeners={};
    function addL(t,fn){
      if(!listeners[t])listeners[t]=[];
      listeners[t].push(fn);
    }
    function fire(t){
      var arr=listeners[t]||[];
      for(var i=0;i<arr.length;i++){
        try{arr[i].call(mock,{preventDefault:function(){}});}catch(e){}
      }
      if(t==='click'&&typeof mock.onclick==='function'){
        try{mock.onclick();}catch(e){}
      }
    }
    var id='udn-'+Date.now()+'-'+Math.floor(Math.random()*1e9);
    var mock={
      onclick:null,
      title:String(title),
      body:opts.body!=null?String(opts.body):'',
      tag:opts.tag!=null?String(opts.tag):'',
      icon:opts.icon||'',
      data:opts.data,
      addEventListener:function(t,fn){addL(t,fn);},
      removeEventListener:function(t,fn){
        var a=listeners[t];
        if(!a)return;
        var j=a.indexOf(fn);
        if(j>=0)a.splice(j,1);
      },
      close:function(){
        try{
          if(typeof window.__usualDeskDismissInAppNotification==='function')
            window.__usualDeskDismissInAppNotification(id);
        }catch(e){}
      },
      dispatchEvent:function(ev){
        if(ev&&ev.type==='click')fire('click');
        return true;
      }
    };
    try{
      if(typeof window.__usualDeskEmitInAppNotification==='function'){
        window.__usualDeskEmitInAppNotification(id,{
          title:mock.title,
          body:mock.body,
          icon:mock.icon,
          image:opts.image||'',
          tag:mock.tag,
          data:opts.data,
          silent:!!opts.silent,
          requireInteraction:!!opts.requireInteraction
        });
      }
    }catch(e){}
    return mock;
  }
  function W(title,opts){
    opts=opts||{};
    if(CUSTOM)return makeInAppMock(title,opts);
    if(!DEBUG){
      var n=new N(title,opts);
      n.addEventListener('click',onNativeClick);
      return n;
    }
    var full='[Volcado íntegro: last-web-notification-dump.txt]\\n\\n'+ser(title,opts);
    try{
      if(typeof window.__usualDeskSaveNotificationDump==='function'){
        window.__usualDeskSaveNotificationDump(full);
      }
    }catch(e1){}
    var parts=splitDump(full);
    if(parts.length===0)parts=['(vacío)'];
    var tagBase='udbg'+Date.now()+'-';
    var first=null;
    function optsForChunk(bodyPart,idx,total){
      var o={body:bodyPart,tag:tagBase+idx,requireInteraction:idx===total-1};
      if(opts.silent===true)o.silent=true;
      if(opts.icon)o.icon=opts.icon;
      if(opts.image)o.image=opts.image;
      if(opts.badge)o.badge=opts.badge;
      return o;
    }
    function makeOne(idx){
      var total=parts.length;
      var t=String(title)+(total>1?' ('+(idx+1)+'/'+total+')':'');
      var nn=new N(t,optsForChunk(parts[idx],idx,total));
      nn.addEventListener('click',onNativeClick);
      if(idx===0)first=nn;
    }
    for(var jj=0;jj<parts.length;jj++){
      if(jj===0)makeOne(0);
      else{(function(ix){setTimeout(function(){makeOne(ix);},ix*220);})(jj);}
    }
    return first;
  }
  W.permission=N.permission;
  W.requestPermission=N.requestPermission.bind(N);
  window.Notification=W;
}catch(e){}
})();`;
}

function runWebNotificationInject(webContents) {
  const custom = false;
  const script = buildWebNotificationPatchScript(custom, DEBUG_DUMP_WEB_NOTIFICATION_IN_TOAST);
  return webContents.executeJavaScript(script).catch(() => {});
}

/**
 * @param {Electron.WebContents} webContents
 */
function attachWebNotificationClickFocus(webContents) {
  if (webContents.__usualDeskNotifyInjectBound) {
    runWebNotificationInject(webContents);
    return;
  }
  webContents.__usualDeskNotifyInjectBound = true;
  const run = () => runWebNotificationInject(webContents);
  webContents.on('dom-ready', run);
  webContents.on('did-finish-load', run);
}

function refreshWebNotificationPatches() {
  for (const win of webWindowsByUrlKey.values()) {
    if (win.isDestroyed()) continue;
    const wc = getHostedWebContents(win) || win.webContents;
    runWebNotificationInject(wc);
  }
  if (loadAppSettings().webHostMode === 'shell') {
    try {
      require('./web-shell').forEachTabWebContents((wc) => {
        if (!wc.isDestroyed()) runWebNotificationInject(wc);
      });
    } catch {
      /* noop */
    }
  }
}

/**
 * Primera aparición de (número) en el título; usado por Gmail, WhatsApp Web, etc.
 * @param {string} title
 * @returns {number | null}
 */
function parseParenCount(title) {
  const m = String(title).match(/\((\d+)\)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/**
 * @param {Electron.BrowserWindow} win
 * @param {string} shortcutId
 */
function pushTitleBadgeFromWindow(win, shortcutId) {
  if (win.isDestroyed()) return;
  const wc = getHostedWebContents(win);
  let title = '';
  try {
    title = wc && !wc.isDestroyed() ? wc.getTitle() : win.getTitle();
  } catch {
    title = '';
  }
  broadcastShortcutTitleBadge(shortcutId, parseParenCount(title));
}

/**
 * @param {Electron.WebContents} webContents
 * @param {string} shortcutId
 */
function attachWebContentsTitleBadge(webContents, shortcutId) {
  if (webContents.__usualDeskTitleBadgeAttached) return;
  webContents.__usualDeskTitleBadgeAttached = true;

  webContents.on('page-title-updated', (_event, title) => {
    broadcastShortcutTitleBadge(shortcutId, parseParenCount(title));
  });

  webContents.once('did-finish-load', () => {
    if (webContents.isDestroyed()) return;
    try {
      broadcastShortcutTitleBadge(shortcutId, parseParenCount(webContents.getTitle()));
    } catch {
      broadcastShortcutTitleBadge(shortcutId, null);
    }
  });
}

/**
 * Escucha cambios de título de la ventana web y actualiza el badge en el dock.
 * @param {Electron.BrowserWindow} win
 * @param {string} shortcutId
 */
function attachWebWindowTitleBadge(win, shortcutId) {
  const wc = getHostedWebContents(win) || win.webContents;
  attachWebContentsTitleBadge(wc, shortcutId);
}

/**
 * Web embebido en la ventana shell (BrowserView).
 * @param {Electron.WebContents} webContents
 * @param {{ id?: string, name?: string, url?: string }} shortcut
 * @param {string} mapKey
 */
function attachWebShortcutEmbeddedWebContents(webContents, shortcut, mapKey) {
  webContents.__usualDeskWebMapKey = mapKey;
  attachWebNotificationClickFocus(webContents);
  webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (!url || /^chrome[-:]/i.test(url) || url.startsWith('about:blank')) {
      return { action: 'deny' };
    }
    const background =
      disposition === 'background-tab' ||
      disposition === 'save-to-disk' ||
      disposition === 'other';
    setImmediate(() => {
      try {
        require('./loose-nav-window')
          .openTabFromUrl(url, { background })
          .catch(() => {
            try {
              shell.openExternal(url);
            } catch {
              /* noop */
            }
          });
      } catch {
        try {
          shell.openExternal(url);
        } catch {
          /* noop */
        }
      }
    });
    return { action: 'deny' };
  });
  attachWebContentsTitleBadge(webContents, shortcut.id);
}

/**
 * WhatsApp Web rechaza el UA por defecto de Electron. Usamos la misma versión
 * de Chromium que el binario para que coincida con las capacidades reales.
 */
function chromeLikeUserAgent() {
  const chrome = process.versions.chrome;
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function isWhatsAppWeb(url) {
  try {
    return new URL(url).hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

/** @type {Map<string, Electron.BrowserWindow>} */
const webWindowsByUrlKey = new Map();

/** Última ventana web enfocada (Ctrl+Alt+D la trae al frente sin abrir el panel del dock). */
/** @type {string | null} */
let lastFocusedWebMapKey = null;

function setLastFocusedWebMapKey(mapKey) {
  if (!mapKey || typeof mapKey !== 'string') return;
  lastFocusedWebMapKey = mapKey;
}

/**
 * @param {Electron.BrowserWindow} win
 * @param {string} mapKey
 */
function wireWebWindowFocusTracking(win, mapKey) {
  if (!win || win.isDestroyed() || win.__usualDeskFocusTrackingWire) return;
  win.__usualDeskFocusTrackingWire = true;
  const bump = () => setLastFocusedWebMapKey(mapKey);
  win.on('focus', bump);
  try {
    win.webContents.on('focus', bump);
  } catch {
    /* noop */
  }
  function wireHosted() {
    const h = getHostedWebContents(win);
    if (h && !h.isDestroyed() && !h.__usualDeskLastFocusBump) {
      h.__usualDeskLastFocusBump = true;
      h.on('focus', bump);
    }
  }
  wireHosted();
  win.on('show', wireHosted);
}

/**
 * Atajo global: enfoca la última ventana web de inplaze (o cualquiera abierta como respaldo).
 * @returns {boolean}
 */
function focusLastWebWindowFromHotkey() {
  const tryKey = (k) => {
    if (!k || typeof k !== 'string') return false;
    if (!webWindowsByUrlKey.has(k)) return false;
    return focusWebWindowByMapKey(k);
  };
  if (tryKey(lastFocusedWebMapKey)) return true;
  const keys = [...webWindowsByUrlKey.keys()];
  for (let i = keys.length - 1; i >= 0; i--) {
    if (tryKey(keys[i])) return true;
  }
  return false;
}

/**
 * ¿Alguna ventana web (o su contenido hospedado) tiene foco ahora mismo?
 * @returns {boolean}
 */
function anyWebWindowFocused() {
  for (const win of webWindowsByUrlKey.values()) {
    if (!win || win.isDestroyed()) continue;
    try {
      if (win.isFocused()) return true;
    } catch {
      /* noop */
    }
    const wc = getHostedWebContents(win) || win.webContents;
    try {
      if (wc && !wc.isDestroyed() && wc.isFocused()) return true;
    } catch {
      /* noop */
    }
  }
  return false;
}

/**
 * Minimiza todas las ventanas web abiertas (simula minimizar la aplicación entera).
 * @returns {boolean} true si minimizó al menos una
 */
function minimizeAllWebWindows() {
  let any = false;
  for (const win of webWindowsByUrlKey.values()) {
    if (!win || win.isDestroyed()) continue;
    try {
      if (!win.isMinimized()) {
        win.minimize();
        any = true;
      }
    } catch {
      /* noop */
    }
  }
  return any;
}

/**
 * Contenido web real cuando la ventana usa marco + BrowserView (franja de iconos).
 * @param {Electron.BrowserWindow} win
 * @returns {Electron.WebContents | null}
 */
function getHostedWebContents(win) {
  if (!win || win.isDestroyed()) return null;
  const h = win.__usualDeskHostedWebContents;
  if (h && !h.isDestroyed()) return h;
  return null;
}

/** Particiones en las que ya instalamos comprobación de permiso `notifications`. */
const webPartitionsWithNotificationHandlers = new Set();

/**
 * Deniega permisos de notificación del navegador cuando el acceso tiene notificaciones apagadas.
 * @param {string} partition
 */
function installWebNotificationPermissionHandlers(partition) {
  if (webPartitionsWithNotificationHandlers.has(partition)) return;
  webPartitionsWithNotificationHandlers.add(partition);
  const ses = session.fromPartition(partition);

  function notificationsMutedForContents(webContents) {
    if (!webContents || webContents.isDestroyed()) return false;
    if (webContents.__usualDeskNotificationsMuted === true) return true;
    const win = BrowserWindow.fromWebContents(webContents);
    if (!win || win.isDestroyed()) return false;
    return win.__usualDeskNotificationsMuted === true;
  }

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'notifications' && notificationsMutedForContents(webContents)) {
      callback(false);
      return;
    }
    callback(true);
  });
}

function syncOpenWebKeysToDock() {
  broadcastOpenWebWindowKeys([...webWindowsByUrlKey.keys()]);
  try {
    require('./detached-web-frame').broadcastChromeToAllDetachedHosts();
  } catch {
    /* noop */
  }
}

/**
 * Registra la ventana web antes de terminar de cargar (para la franja de iconos y el dock).
 * @param {string} mapKey
 * @param {Electron.BrowserWindow} win
 */
function setWebWindowForMapKey(mapKey, win) {
  webWindowsByUrlKey.set(mapKey, win);
  syncOpenWebKeysToDock();
}

/**
 * @param {string} mapKey
 */
function deleteWebWindowForMapKey(mapKey) {
  webWindowsByUrlKey.delete(mapKey);
  if (lastFocusedWebMapKey === mapKey) {
    lastFocusedWebMapKey = null;
    const remaining = [...webWindowsByUrlKey.keys()];
    if (remaining.length) lastFocusedWebMapKey = remaining[remaining.length - 1];
  }
  syncOpenWebKeysToDock();
}

function getOpenWebWindowKeys() {
  if (loadAppSettings().webHostMode === 'shell') {
    try {
      return require('./web-shell').getOpenMapKeys();
    } catch {
      return [];
    }
  }
  return [...webWindowsByUrlKey.keys()];
}

/**
 * Silencia o activa audio de la ventana web abierta para este acceso (si existe).
 * @param {{ type?: string, sessionId?: string, url?: string }} shortcut
 * @param {boolean} muted
 */
function setWebShortcutAudioMuted(shortcut, muted) {
  if (!shortcut || shortcut.type !== 'web') return;
  const mapKey = webMapKey(shortcut);
  if (loadAppSettings().webHostMode === 'shell') {
    try {
      require('./web-shell').setTabAudioMuted(mapKey, !!muted);
    } catch {
      /* noop */
    }
    return;
  }
  const win = webWindowsByUrlKey.get(mapKey);
  if (win && !win.isDestroyed()) {
    const wc = getHostedWebContents(win) || win.webContents;
    wc.setAudioMuted(!!muted);
  }
}

/**
 * Actualiza el flag en la ventana abierta (los handlers de permiso lo leen al pedir/comprobar notificaciones).
 * @param {{ type?: string, sessionId?: string, url?: string }} shortcut
 * @param {boolean} muted true = notificaciones del sitio desactivadas
 */
function setWebShortcutNotificationsMuted(shortcut, muted) {
  if (!shortcut || shortcut.type !== 'web') return;
  const mapKey = webMapKey(shortcut);
  if (loadAppSettings().webHostMode === 'shell') {
    try {
      require('./web-shell').setTabNotificationsMuted(mapKey, !!muted);
    } catch {
      /* noop */
    }
    return;
  }
  const win = webWindowsByUrlKey.get(mapKey);
  if (win && !win.isDestroyed()) {
    win.__usualDeskNotificationsMuted = !!muted;
  }
}

/**
 * Misma URL (sin hash, sin barra final) → reutiliza la ventana y la enfoca.
 */
async function openWebShortcut(shortcut) {
  if (loadAppSettings().webHostMode === 'shell') {
    await require('./web-shell').openOrFocusTab(shortcut);
    return;
  }

  const partition = partitionFromSessionId(shortcut.sessionId);
  const mapKey = webMapKey(shortcut);
  const focusOverride = (() => {
    try {
      return require('./focus-mode').getRuntimeOverride(mapKey);
    } catch {
      return null;
    }
  })();
  const desiredNotificationsMuted = focusOverride
    ? focusOverride.notificationsMuted
    : shortcut.notificationsMuted === true;
  const desiredAudioMuted = focusOverride
    ? focusOverride.audioMuted
    : !!shortcut.audioMuted;
  let win = webWindowsByUrlKey.get(mapKey);
  if (win && !win.isDestroyed()) {
    installWebNotificationPermissionHandlers(partition);
    win.__usualDeskWebMapKey = mapKey;
    win.__usualDeskShortcutLabel = shortcut.name || 'Web';
    if (win.isMinimized()) win.restore();
    if (win.isFullScreen()) win.setFullScreen(false);
    if (!win.isMaximized()) win.maximize();
    win.focus();
    win.__usualDeskNotificationsMuted = desiredNotificationsMuted;
    const hosted = getHostedWebContents(win);
    if (hosted) hosted.setAudioMuted(desiredAudioMuted);
    else win.webContents.setAudioMuted(desiredAudioMuted);
    pushTitleBadgeFromWindow(win, shortcut.id);
    wireWebWindowFocusTracking(win, mapKey);
    setLastFocusedWebMapKey(mapKey);
    syncOpenWebKeysToDock();
    return;
  }

  installWebNotificationPermissionHandlers(partition);

  if (isWhatsAppWeb(shortcut.url)) {
    session.fromPartition(partition).setUserAgent(chromeLikeUserAgent());
  }

  win = await require('./detached-web-frame').createDetachedWebHostWindow(shortcut, mapKey, partition);

  win.__usualDeskNotificationsMuted = desiredNotificationsMuted;
  win.__usualDeskWebMapKey = mapKey;
  win.__usualDeskShortcutLabel = shortcut.name || 'Web';
  try {
    const hosted = getHostedWebContents(win);
    if (hosted) hosted.setAudioMuted(desiredAudioMuted);
    else win.webContents.setAudioMuted(desiredAudioMuted);
  } catch {
    /* noop */
  }

  win.on('closed', () => {
    deleteWebWindowForMapKey(mapKey);
    broadcastShortcutTitleBadge(shortcut.id, null);
  });

  wireWebWindowFocusTracking(win, mapKey);
  setLastFocusedWebMapKey(mapKey);
}

async function openShortcut(shortcut) {
  if (shortcut.type === 'app') {
    const targetPath = shortcut.url;
    if (path.extname(targetPath).toLowerCase() === '.lnk') {
      await shell.openPath(targetPath);
      return;
    }

    const exeName = path.basename(targetPath);
    const processName = path.parse(exeName).name;

    const running = await isProcessRunning(exeName);
    if (running) {
      focusWindowByProcess(processName);
      return;
    }

    const appDir = path.dirname(targetPath);
    try {
      spawn(targetPath, [], { detached: true, stdio: 'ignore', cwd: appDir }).unref();
    } catch {
      await shell.openPath(targetPath);
    }
    return;
  }

  if (shortcut.type === 'loose') {
    await require('./loose-nav-window').enterLooseNavMode();
    return;
  }

  await openWebShortcut(shortcut);
}

/**
 * @param {string} mapKey
 * @returns {boolean}
 */
function focusWebWindowByMapKey(mapKey) {
  if (!mapKey || typeof mapKey !== 'string') return false;
  if (loadAppSettings().webHostMode === 'shell') {
    try {
      return require('./web-shell').focusTabByMapKey(mapKey);
    } catch {
      return false;
    }
  }
  const win = webWindowsByUrlKey.get(mapKey);
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (win.isFullScreen()) win.setFullScreen(false);
  if (!win.isMaximized()) win.maximize();
  forceWindowForeground(win);
  const hosted = getHostedWebContents(win);
  if (hosted && !hosted.isDestroyed()) {
    try {
      hosted.focus();
    } catch {
      /* noop */
    }
  }
  setLastFocusedWebMapKey(mapKey);
  return true;
}

/**
 * Cierra la ventana web asociada a una clave (p. ej. mantener pulsado en la franja).
 * @param {string} mapKey
 */
function closeWebWindowByMapKey(mapKey) {
  if (!mapKey || typeof mapKey !== 'string') return;
  const win = webWindowsByUrlKey.get(mapKey);
  if (win && !win.isDestroyed()) win.close();
}

/**
 * @param {Electron.WebContents} webContents
 * @param {{ title?: string, body?: string, tag?: string, data?: unknown }} [notification]
 * @returns {Promise<boolean>}
 */
async function tryOpenWebNotificationTarget(webContents, notification) {
  if (!webContents || webContents.isDestroyed()) return false;
  if (!notification || typeof notification !== 'object') return false;

  const n = notification;
  const title = typeof n.title === 'string' ? n.title.trim() : '';
  const data = n.data && typeof n.data === 'object' ? n.data : null;
  const directUrl =
    (data && typeof data.url === 'string' && data.url) ||
    (data && typeof data.href === 'string' && data.href) ||
    (data && typeof data.link === 'string' && data.link) ||
    '';

  if (directUrl) {
    try {
      await webContents.loadURL(directUrl);
      return true;
    } catch {
      /* fallback below */
    }
  }

  let currentUrl = '';
  try {
    currentUrl = webContents.getURL();
  } catch {
    return false;
  }

  let host = '';
  try {
    host = new URL(currentUrl).hostname;
  } catch {
    return false;
  }

  if (host !== 'web.whatsapp.com' || !title) return false;

  const titleJson = JSON.stringify(title);
  const script = `(function(){
  return (async function(){
    const target = ${titleJson};
    const norm = function(s){
      return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase();
    };
    const nt = norm(target);
    if (!nt) return false;

    const sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

    function rowFromEl(el){
      if (!el) return null;
      return (
        el.closest('[data-testid="cell-frame-container"]') ||
        el.closest('[role="listitem"]') ||
        el.closest('[role="row"]') ||
        el.closest('div[tabindex="0"]') ||
        el.closest('div[tabindex="-1"]')
      );
    }

    function scoreLabel(a, b){
      if (a === b) return 3;
      if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 2;
      return 0;
    }

    function findBestRow(){
      var best = null;
      var bestScore = 0;

      var cells = Array.prototype.slice.call(document.querySelectorAll('[data-testid="cell-frame-container"]'));
      for (var i = 0; i < cells.length; i++){
        var cell = cells[i];
        var titleSpan = cell.querySelector('[data-testid="cell-frame-title"] span[title]') ||
          cell.querySelector('[data-testid="cell-frame-title"] span') ||
          cell.querySelector('span[title]');
        var raw = titleSpan ? (titleSpan.getAttribute('title') || titleSpan.textContent || '') : '';
        var t = norm(raw);
        var sc = scoreLabel(t, nt);
        if (sc > bestScore){
          bestScore = sc;
          best = cell;
        }
      }

      if (bestScore >= 2) return best;

      var spans = Array.prototype.slice.call(document.querySelectorAll('span[title], span[dir="auto"]'));
      for (var j = 0; j < spans.length; j++){
        var el = spans[j];
        var lab = norm(el.getAttribute('title') || el.textContent || '');
        var sc2 = scoreLabel(lab, nt);
        if (sc2 > bestScore){
          var rowEl = rowFromEl(el);
          if (rowEl){
            bestScore = sc2;
            best = rowEl;
          }
        }
      }

      return bestScore >= 2 ? best : null;
    }

    function trySearchBox(){
      var box = document.querySelector('#side div[contenteditable="true"]') ||
        document.querySelector('[data-testid="chat-list-search"] div[contenteditable="true"]') ||
        document.querySelector('div[role="textbox"][contenteditable="true"]');
      if (!box) return false;
      box.focus();
      try {
        document.execCommand('selectAll', false, null);
      } catch (e1) {}
      try {
        document.execCommand('insertText', false, target);
      } catch (e2) {}
      return true;
    }

    for (var attempt = 0; attempt < 6; attempt++){
      var row = findBestRow();
      if (row){
        row.click();
        return true;
      }
      await sleep(100 + attempt * 80);
    }

    if (trySearchBox()){
      await sleep(280);
      for (var k = 0; k < 5; k++){
        var row2 = findBestRow();
        if (row2){
          row2.click();
          return true;
        }
        await sleep(120);
      }
    }

    return false;
  })();
})();`;
  try {
    const ok = await webContents.executeJavaScript(script, true);
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * @param {string} mapKey
 * @param {{ title?: string, body?: string, tag?: string, data?: unknown }} [notification]
 * @returns {Promise<boolean>}
 */
async function focusWebWindowFromNotification(mapKey, notification) {
  const focused = focusWebWindowByMapKey(mapKey);
  if (!focused) return false;
  let wc = null;
  if (loadAppSettings().webHostMode === 'shell') {
    try {
      wc = require('./web-shell').getWebContentsForMapKey(mapKey);
    } catch {
      wc = null;
    }
  } else {
    const win = webWindowsByUrlKey.get(mapKey);
    if (win && !win.isDestroyed()) wc = getHostedWebContents(win) || win.webContents;
  }
  if (!wc || wc.isDestroyed()) return false;
  await new Promise((r) => setTimeout(r, 150));
  await tryOpenWebNotificationTarget(wc, notification);
  return true;
}

function closeAllDetachedWebWindows() {
  for (const win of [...webWindowsByUrlKey.values()]) {
    if (win && !win.isDestroyed()) win.close();
  }
  webWindowsByUrlKey.clear();
  lastFocusedWebMapKey = null;
  broadcastOpenWebWindowKeys([]);
}

module.exports = {
  openShortcut,
  getOpenWebWindowKeys,
  setWebShortcutAudioMuted,
  setWebShortcutNotificationsMuted,
  focusWebWindowByMapKey,
  focusWebWindowFromNotification,
  refreshWebNotificationPatches,
  installWebNotificationPermissionHandlers,
  attachWebShortcutEmbeddedWebContents,
  closeAllDetachedWebWindows,
  closeWebWindowByMapKey,
  setWebWindowForMapKey,
  deleteWebWindowForMapKey,
  focusLastWebWindowFromHotkey,
  anyWebWindowFocused,
  minimizeAllWebWindows,
};

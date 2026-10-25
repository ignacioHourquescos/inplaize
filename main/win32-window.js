'use strict';

/**
 * Llamadas a user32/kernel32 para reparentar una ventana ajena.
 * Solo Windows x64. Los HWND se manejan como bigint.
 */

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const RECT = koffi.struct('RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32',
});

const POINT = koffi.struct('POINT', {
  x: 'int32',
  y: 'int32',
});

const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(intptr hwnd, intptr lParam)');

const EnumWindows = user32.func('int __stdcall EnumWindows(EnumWindowsProc *cb, intptr lParam)');
const IsWindow = user32.func('int __stdcall IsWindow(intptr hwnd)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr hwnd)');
const IsIconic = user32.func('int __stdcall IsIconic(intptr hwnd)');
const IsZoomed = user32.func('int __stdcall IsZoomed(intptr hwnd)');
const GetParent = user32.func('intptr __stdcall GetParent(intptr hwnd)');
const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16_t *buf, int max)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)',
);
const GetWindowRect = user32.func('int __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)');
const GetClientRect = user32.func('int __stdcall GetClientRect(intptr hwnd, _Out_ RECT *rect)');
const ClientToScreen = user32.func('int __stdcall ClientToScreen(intptr hwnd, _Inout_ POINT *pt)');
const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)');
const SetWindowLongPtrW = user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)');
const SetParent = user32.func('intptr __stdcall SetParent(intptr child, intptr parent)');
const SetWindowPos = user32.func(
  'int __stdcall SetWindowPos(intptr hwnd, intptr insertAfter, int x, int y, int cx, int cy, uint32 flags)',
);
const ShowWindow = user32.func('int __stdcall ShowWindow(intptr hwnd, int cmd)');
const MoveWindow = user32.func('int __stdcall MoveWindow(intptr hwnd, int x, int y, int w, int h, int repaint)');
const PostMessageW = user32.func('int __stdcall PostMessageW(intptr hwnd, uint32 msg, uintptr wParam, intptr lParam)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *pt)');
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
const OpenProcess = kernel32.func('intptr __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(intptr handle)');
const QueryFullProcessImageNameW = kernel32.func(
  'int __stdcall QueryFullProcessImageNameW(intptr process, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32 *size)',
);

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const GW_OWNER = 4;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const WS_EX_APPWINDOW = 0x00040000n;
const WS_EX_TOOLWINDOW = 0x00000080n;
const WS_CHILD = 0x40000000n;
const WS_POPUP = 0x80000000n;
const WS_CAPTION = 0x00c00000n;
const WS_THICKFRAME = 0x00040000n;
const WS_VISIBLE = 0x10000000n;
const WS_CLIPSIBLINGS = 0x04000000n;
const WS_CLIPCHILDREN = 0x02000000n;
const WS_SYSMENU = 0x00080000n;
const WS_MINIMIZEBOX = 0x00020000n;
const WS_MAXIMIZEBOX = 0x00010000n;
const WS_MAXIMIZE = 0x01000000n;
const SW_HIDE = 0;
const CHILD_STYLE_STRIP =
  WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_MAXIMIZE;
/** Electron recrea el HWND si lo pasamos a WS_CHILD. Se queda top-level, sin marco. */
const OWNED_STYLE_STRIP =
  WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_MAXIMIZE | WS_CHILD;

const SW_SHOW = 5;
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;

const WM_CLOSE = 0x0010;

/**
 * @param {unknown} value
 * @returns {bigint}
 */
function asHwnd(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value);
  if (Buffer.isBuffer(value)) {
    if (value.length >= 8) return value.readBigUInt64LE(0);
    if (value.length >= 4) return BigInt(value.readUInt32LE(0));
  }
  return 0n;
}

/**
 * @param {unknown} value
 * @returns {bigint}
 */
function asUint32(value) {
  const n = typeof value === 'bigint' ? value : BigInt(value || 0);
  return n & 0xffffffffn;
}

/**
 * @param {Buffer} buf
 * @param {number} chars
 */
function utf16(buf, chars) {
  if (!chars || chars < 0) return '';
  return buf.toString('utf16le', 0, chars * 2);
}

/**
 * @param {bigint} hwnd
 */
function readWide(hwnd, fn) {
  const buf = Buffer.alloc(512);
  const n = fn(hwnd, buf, 256);
  return utf16(buf, n);
}

/**
 * @param {bigint} hwnd
 */
function isAlive(hwnd) {
  try {
    return !!hwnd && !!IsWindow(hwnd);
  } catch {
    return false;
  }
}

/**
 * @param {bigint} hwnd
 * @returns {number}
 */
function windowPid(hwnd) {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return pid[0] >>> 0;
}

/** @type {Map<number, string>} */
const imageCache = new Map();

/**
 * @param {number} pid
 * @returns {string}
 */
function processImage(pid) {
  if (!pid) return '';
  const cached = imageCache.get(pid);
  if (cached != null) return cached;
  const handle = asHwnd(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (!handle) {
    imageCache.set(pid, '');
    return '';
  }
  try {
    const buf = Buffer.alloc(1024);
    const size = [512];
    const ok = QueryFullProcessImageNameW(handle, 0, buf, size);
    const image = ok ? utf16(buf, size[0]) : '';
    imageCache.set(pid, image);
    return image;
  } finally {
    CloseHandle(handle);
  }
}

/**
 * @param {bigint} hwnd
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
function windowRect(hwnd) {
  const rect = {};
  if (!GetWindowRect(hwnd, rect)) return null;
  return rect;
}

/**
 * @param {bigint} hwnd
 * @returns {{ width: number, height: number }}
 */
function clientSize(hwnd) {
  const rect = {};
  if (!GetClientRect(hwnd, rect)) return { width: 0, height: 0 };
  return { width: rect.right - rect.left, height: rect.bottom - rect.top };
}

/**
 * Rect del hijo en coordenadas del cliente del padre.
 * @param {bigint} parent
 * @param {bigint} child
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function childRect(parent, child) {
  const origin = { x: 0, y: 0 };
  if (!ClientToScreen(parent, origin)) return null;
  const rect = windowRect(child);
  if (!rect) return null;
  return {
    x: rect.left - origin.x,
    y: rect.top - origin.y,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  };
}

/**
 * @returns {Array<{ hwnd: bigint, pid: number, title: string, className: string, image: string, width: number, height: number, owner: bigint }>}
 */
function listTopLevelWindows() {
  /** @type {Array<{ hwnd: bigint, pid: number, title: string, className: string, image: string, width: number, height: number, owner: bigint }>} */
  const rows = [];
  EnumWindows((raw) => {
    try {
      const hwnd = asHwnd(raw);
      if (!hwnd || !IsWindowVisible(hwnd)) return 1;
      const title = readWide(hwnd, GetWindowTextW);
      if (!title) return 1;
      const rect = windowRect(hwnd);
      if (!rect) return 1;
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      if (width < 80 || height < 60) return 1;
      const pid = windowPid(hwnd);
      rows.push({
        hwnd,
        pid,
        title,
        className: readWide(hwnd, GetClassNameW),
        image: processImage(pid),
        width,
        height,
        owner: asHwnd(GetWindow(hwnd, GW_OWNER)),
      });
    } catch {
      /* una ventana que muere a mitad de la enumeración no importa */
    }
    return 1;
  }, 0);
  return rows;
}

/**
 * @param {bigint} hwnd
 * @returns {{ style: bigint, exStyle: bigint, zoomed: boolean, rect: { left: number, top: number, right: number, bottom: number } | null }}
 */
function captureWindowChrome(hwnd) {
  return {
    style: asUint32(GetWindowLongPtrW(hwnd, GWL_STYLE)),
    exStyle: asUint32(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
    zoomed: !!IsZoomed(hwnd),
    rect: windowRect(hwnd),
  };
}

/**
 * Mete la ventana ajena como hija. Así no tiene botón propio en la barra.
 * @param {bigint} guest
 * @param {bigint} parent
 * @param {{ style: bigint, exStyle: bigint }} saved
 * @returns {bigint}
 */
function attachChild(guest, parent, saved) {
  if (IsIconic(guest) || IsZoomed(guest)) ShowWindow(guest, SW_RESTORE);
  ShowWindow(guest, SW_HIDE);
  const ex = (saved.exStyle & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
  SetWindowLongPtrW(guest, GWL_EXSTYLE, ex);
  const style = (saved.style & ~CHILD_STYLE_STRIP) | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
  SetWindowLongPtrW(guest, GWL_STYLE, style);
  SetWindowPos(guest, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
  const parentStyle = asUint32(GetWindowLongPtrW(parent, GWL_STYLE));
  if ((parentStyle & WS_CLIPCHILDREN) === 0n) {
    SetWindowLongPtrW(parent, GWL_STYLE, parentStyle | WS_CLIPCHILDREN | WS_CLIPSIBLINGS);
  }
  SetParent(guest, parent);
  ShowWindow(guest, SW_SHOW);
  return asHwnd(GetParent(guest));
}

/**
 * @param {bigint} guest
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 */
/**
 * Electron recrea el HWND si lo hacemos WS_CHILD. Queda owned por el marco:
 * encima de esa ventana, sin botón en la barra, y la franja de inplaize sigue visible.
 * @param {bigint} guest
 * @param {bigint} owner
 * @param {{ style: bigint, exStyle: bigint }} saved
 * @returns {bigint}
 */
function attachOwned(guest, owner, saved) {
  if (IsIconic(guest) || IsZoomed(guest)) ShowWindow(guest, SW_RESTORE);
  ShowWindow(guest, SW_HIDE);
  const parent = asHwnd(GetParent(guest));
  if (parent) SetParent(guest, 0);
  const ex = (saved.exStyle & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
  SetWindowLongPtrW(guest, GWL_EXSTYLE, ex);
  const style = (saved.style & ~OWNED_STYLE_STRIP) | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
  SetWindowLongPtrW(guest, GWL_STYLE, style);
  SetWindowLongPtrW(guest, GWLP_HWNDPARENT, owner);
  SetWindowPos(guest, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
  return asHwnd(GetWindow(guest, GW_OWNER));
}

/**
 * @param {bigint} guest
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {boolean} [activate]
 */
function moveChild(guest, x, y, width, height, activate) {
  SetWindowPos(
    guest,
    0,
    x,
    y,
    Math.max(1, width),
    Math.max(1, height),
    SWP_SHOWWINDOW | (activate ? 0 : SWP_NOACTIVATE),
  );
}

/**
 * Quita el botón de la barra de tareas de una ventana top-level.
 * @param {bigint} hwnd
 * @returns {boolean} true si cambió el estilo
 */
function hideFromTaskbar(hwnd) {
  if (!hwnd) return false;
  const ex = asUint32(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const next = (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
  if (next === ex) return false;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
  SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
  return true;
}

/**
 * Devuelve la ventana al escritorio con el marco que tenía.
 * @param {bigint} guest
 * @param {{ style: bigint, exStyle: bigint, zoomed: boolean, rect: { left: number, top: number, right: number, bottom: number } | null }} saved
 */
function restoreTopLevel(guest, saved) {
  if (!isAlive(guest) || !saved) return;
  SetWindowLongPtrW(guest, GWLP_HWNDPARENT, 0);
  SetParent(guest, 0);
  SetWindowLongPtrW(guest, GWL_STYLE, saved.style);
  SetWindowLongPtrW(guest, GWL_EXSTYLE, saved.exStyle);
  SetWindowPos(guest, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
  if (saved.zoomed) {
    ShowWindow(guest, SW_MAXIMIZE);
    return;
  }
  const rect = saved.rect;
  if (rect && rect.right > rect.left && rect.bottom > rect.top) {
    SetWindowPos(
      guest,
      0,
      rect.left,
      rect.top,
      rect.right - rect.left,
      rect.bottom - rect.top,
      SWP_SHOWWINDOW | SWP_FRAMECHANGED,
    );
  }
  ShowWindow(guest, SW_SHOW);
}

/**
 * @param {bigint} guest
 */
function requestClose(guest) {
  if (!isAlive(guest)) return;
  PostMessageW(guest, WM_CLOSE, 0, 0);
}

/**
 * @param {bigint} hwnd
 * @returns {bigint}
 */
function getParent(hwnd) {
  return asHwnd(GetParent(hwnd));
}

/**
 * @param {bigint} hwnd
 * @returns {bigint}
 */
function getOwner(hwnd) {
  return asHwnd(GetWindow(hwnd, GW_OWNER));
}

/**
 * @param {bigint} hwnd
 * @returns {string}
 */
function windowClass(hwnd) {
  return readWide(hwnd, GetClassNameW);
}

/**
 * Origen del cliente en coordenadas de pantalla.
 * @param {bigint} hwnd
 * @returns {{ x: number, y: number }}
 */
function clientOrigin(hwnd) {
  const pt = { x: 0, y: 0 };
  if (!hwnd || !ClientToScreen(hwnd, pt)) return { x: 0, y: 0 };
  return { x: pt.x || 0, y: pt.y || 0 };
}

/**
 * @param {bigint} hwnd
 * @param {boolean} visible
 */
function showWindow(hwnd, visible) {
  if (!hwnd) return;
  ShowWindow(hwnd, visible ? SW_SHOW : SW_HIDE);
}

/**
 * Una ventana maximizada tapa la barra. La devolvemos a tamaño normal
 * para poder colocarla debajo.
 * @param {bigint} hwnd
 */
function unmaximize(hwnd) {
  if (!hwnd) return;
  if (IsIconic(hwnd) || IsZoomed(hwnd)) ShowWindow(hwnd, SW_RESTORE);
}

/** Animación del cursor en curso: una nueva reemplaza a la anterior. */
let cursorGlide = null;

/**
 * Desliza el cursor real hasta un punto, en píxeles físicos de pantalla.
 * Si el usuario agarra el mouse a mitad de camino, se suelta y no pelea.
 * @param {number} x
 * @param {number} y
 * @param {number} [durationMs]
 */
function glideCursorTo(x, y, durationMs) {
  if (cursorGlide) {
    clearInterval(cursorGlide);
    cursorGlide = null;
  }
  const from = {};
  if (!GetCursorPos(from)) return;
  const toX = Math.round(x);
  const toY = Math.round(y);
  const total = Math.max(60, Math.min(2000, Number(durationMs) || 600));
  const startedAt = Date.now();
  let last = { x: from.x, y: from.y };
  cursorGlide = setInterval(() => {
    const now = {};
    if (!GetCursorPos(now) || Math.abs(now.x - last.x) > 24 || Math.abs(now.y - last.y) > 24) {
      clearInterval(cursorGlide);
      cursorGlide = null;
      return;
    }
    const t = Math.min(1, (Date.now() - startedAt) / total);
    const e = 1 - Math.pow(1 - t, 3);
    last = {
      x: Math.round(from.x + (toX - from.x) * e),
      y: Math.round(from.y + (toY - from.y) * e),
    };
    SetCursorPos(last.x, last.y);
    if (t >= 1) {
      clearInterval(cursorGlide);
      cursorGlide = null;
    }
  }, 8);
}

/**
 * @param {Electron.BrowserWindow} win
 * @returns {bigint}
 */
function hwndFromBrowserWindow(win) {
  return asHwnd(win.getNativeWindowHandle());
}

module.exports = {
  asHwnd,
  isAlive,
  windowPid,
  processImage,
  windowRect,
  clientSize,
  childRect,
  listTopLevelWindows,
  captureWindowChrome,
  attachChild,
  attachOwned,
  moveChild,
  hideFromTaskbar,
  getOwner,
  windowClass,
  clientOrigin,
  showWindow,
  unmaximize,
  restoreTopLevel,
  requestClose,
  getParent,
  glideCursorTo,
  hwndFromBrowserWindow,
};

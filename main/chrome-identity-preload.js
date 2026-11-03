'use strict';

const { contextBridge } = require('electron');

const full = String((process.versions && process.versions.chrome) || '141.0.0.0');
const major = full.split('.')[0];

try {
  contextBridge.executeInMainWorld({
    func: (majorVersion, fullVersion) => {
      try {
        const c = window.chrome || {};
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: c });
        }
        if (!c.app) {
          c.app = {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            getDetails: () => null,
            getIsInstalled: () => false,
            runningState: () => 'cannot_run',
          };
        }
        if (!c.csi) {
          c.csi = () => {
            const t = performance.timing;
            return { onloadT: t.loadEventEnd, startE: t.navigationStart, pageT: performance.now(), tran: 15 };
          };
        }
        if (!c.loadTimes) {
          c.loadTimes = () => {
            const t = performance.timing;
            return {
              requestTime: t.navigationStart / 1000,
              startLoadTime: t.navigationStart / 1000,
              commitLoadTime: t.responseStart / 1000,
              finishDocumentLoadTime: t.domContentLoadedEventEnd / 1000,
              finishLoadTime: t.loadEventEnd / 1000,
              firstPaintTime: t.responseEnd / 1000,
              firstPaintAfterLoadTime: 0,
              navigationType: 'Other',
              wasFetchedViaSpdy: true,
              wasNpnNegotiated: true,
              npnNegotiatedProtocol: 'h2',
              wasAlternateProtocolAvailable: false,
              connectionInfo: 'h2',
            };
          };
        }
      } catch {
        /* noop */
      }
      try {
        const uad = navigator.userAgentData;
        if (!uad) return;
        const proto = Object.getPrototypeOf(uad);
        const brands = () => [
          { brand: 'Google Chrome', version: majorVersion },
          { brand: 'Chromium', version: majorVersion },
          { brand: 'Not_A Brand', version: '24' },
        ];
        const fullList = () => [
          { brand: 'Google Chrome', version: fullVersion },
          { brand: 'Chromium', version: fullVersion },
          { brand: 'Not_A Brand', version: '24.0.0.0' },
        ];
        Object.defineProperty(proto, 'brands', { configurable: true, get: brands });

        const origHigh = proto.getHighEntropyValues;
        if (typeof origHigh === 'function') {
          Object.defineProperty(proto, 'getHighEntropyValues', {
            configurable: true,
            writable: true,
            value: function getHighEntropyValues(hints) {
              return origHigh.call(this, hints).then((values) => {
                const out = { ...values, brands: brands() };
                if (Array.isArray(hints) && hints.includes('fullVersionList')) {
                  out.fullVersionList = fullList();
                }
                return out;
              });
            },
          });
        }

        const origToJSON = proto.toJSON;
        if (typeof origToJSON === 'function') {
          Object.defineProperty(proto, 'toJSON', {
            configurable: true,
            writable: true,
            value: function toJSON() {
              return { ...origToJSON.call(this), brands: brands() };
            },
          });
        }
      } catch {
        /* la página sigue funcionando con la identidad de Chromium */
      }
    },
    args: [major, full],
  });
} catch {
  /* noop */
}

/**
 * Google detecta igual que no es Chrome y muestra "Elige Chrome". Se oculta el
 * cartel y se pulsa "No usar Chrome" para que Google recuerde el rechazo.
 */
function dismissChromePromo() {
  if (!/(^|\.)google\.[a-z.]+$/i.test(location.hostname)) return;
  const SHEET = 'g-bottom-sheet[aria-labelledby="promo_label_id"]';
  const style = document.createElement('style');
  style.textContent = `${SHEET} { display: none !important; }`;
  const addStyle = () => (document.head || document.documentElement).appendChild(style);

  let done = false;
  const tryDismiss = () => {
    if (done) return;
    const sheet = document.querySelector(SHEET);
    if (!sheet || !/Chrome/i.test(sheet.textContent || '')) return;
    const decline = [...sheet.querySelectorAll('[role="button"], button')].find((b) =>
      /no usar chrome|no,? gracias|no thanks|don.t switch|not now|ahora no/i.test(b.textContent || '')
    );
    if (!decline) return;
    done = true;
    decline.click();
  };

  const start = () => {
    addStyle();
    tryDismiss();
    const observer = new MutationObserver(tryDismiss);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 20000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

try {
  dismissChromePromo();
} catch {
  /* noop */
}

'use strict';

/**
 * Tooltip custom en DOM — reemplaza los tooltips nativos del SO (`title=""`).
 *
 * Motivo: las ventanas de UsualDesk son `frame: false + transparent + alwaysOnTop`
 * y en varios casos con `setIgnoreMouseEvents` + mouse forwarding. Los tooltips
 * nativos de Chromium en Windows son controles ToolTip de Win32 que en estas
 * ventanas se pintan por encima de todas las aplicaciones y no se ocultan
 * al pasar el puntero a otra app, quedando "pegados" en pantalla.
 *
 * Este módulo muestra/oculta un único <div> dentro de la propia página, así
 * garantizamos que desaparece con mouseleave, blur, visibilitychange, etc.
 *
 * Uso:
 *   <script src="ui-tooltip.js"></script>
 *   // En HTML: data-tooltip="texto"  (opcionalmente data-tooltip-placement="right|left|top|bottom")
 *   // En JS : el.setAttribute('data-tooltip', 'texto')  ó  UDTooltip.set(el, 'texto')
 *
 * El módulo se auto-inicializa en `DOMContentLoaded`.
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.UDTooltip && window.UDTooltip.__initialized) return;

  var SHOW_DELAY_MS = 450;
  var HIDE_DELAY_MS = 80;
  var EDGE_MARGIN = 8;

  var tipEl = null;
  var currentTarget = null;
  var showTimer = null;
  var hideTimer = null;
  var styleInjected = false;

  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var css =
      '.ud-tooltip{' +
        'position:fixed;' +
        'z-index:2147483647;' +
        'pointer-events:none;' +
        'max-width:320px;' +
        'padding:6px 10px;' +
        'border-radius:6px;' +
        'background:rgba(24,24,27,0.96);' +
        'color:#f4f4f5;' +
        'font:500 12px/1.35 "Miranda Sans","Segoe UI",system-ui,sans-serif;' +
        'letter-spacing:.1px;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.05);' +
        'opacity:0;' +
        'transform:translateY(2px);' +
        'transition:opacity .12s ease-out,transform .12s ease-out;' +
        'white-space:pre-wrap;' +
        'word-break:break-word;' +
      '}' +
      '.ud-tooltip.is-visible{opacity:1;transform:translateY(0);}';
    try {
      var style = document.createElement('style');
      style.setAttribute('data-ud-tooltip', 'true');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {
      /* noop */
    }
  }

  function ensureTipEl() {
    if (tipEl && document.body && tipEl.parentNode === document.body) return tipEl;
    if (!document.body) return null;
    injectStyle();
    tipEl = document.createElement('div');
    tipEl.className = 'ud-tooltip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function getTooltipText(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.hasAttribute('data-tooltip-disabled')) return '';
    var text = el.getAttribute('data-tooltip');
    if (text == null) return '';
    text = String(text);
    return text.trim() ? text : '';
  }

  function findTarget(node) {
    while (node && node.nodeType === 1) {
      if (node.hasAttribute && node.hasAttribute('data-tooltip')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function clearTimers() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function place(el) {
    var tip = ensureTipEl();
    if (!tip || !el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;

    var preferred = (el.getAttribute('data-tooltip-placement') || '').toLowerCase();
    var order;
    if (preferred === 'right') order = ['right', 'left', 'bottom', 'top'];
    else if (preferred === 'left') order = ['left', 'right', 'bottom', 'top'];
    else if (preferred === 'top') order = ['top', 'bottom', 'right', 'left'];
    else if (preferred === 'bottom') order = ['bottom', 'top', 'right', 'left'];
    else order = ['bottom', 'top', 'right', 'left'];

    function candidate(side) {
      var x = 0;
      var y = 0;
      if (side === 'right') {
        x = r.right + EDGE_MARGIN;
        y = r.top + r.height / 2 - th / 2;
      } else if (side === 'left') {
        x = r.left - EDGE_MARGIN - tw;
        y = r.top + r.height / 2 - th / 2;
      } else if (side === 'top') {
        x = r.left + r.width / 2 - tw / 2;
        y = r.top - EDGE_MARGIN - th;
      } else {
        x = r.left + r.width / 2 - tw / 2;
        y = r.bottom + EDGE_MARGIN;
      }
      var fits =
        x >= EDGE_MARGIN &&
        y >= EDGE_MARGIN &&
        x + tw <= vw - EDGE_MARGIN &&
        y + th <= vh - EDGE_MARGIN;
      return { x: x, y: y, fits: fits };
    }

    var pick = null;
    for (var i = 0; i < order.length; i++) {
      var c = candidate(order[i]);
      if (c.fits) {
        pick = c;
        break;
      }
      if (!pick) pick = c;
    }

    var finalX = Math.max(EDGE_MARGIN, Math.min(pick.x, vw - tw - EDGE_MARGIN));
    var finalY = Math.max(EDGE_MARGIN, Math.min(pick.y, vh - th - EDGE_MARGIN));
    tip.style.left = finalX + 'px';
    tip.style.top = finalY + 'px';
  }

  function showFor(el) {
    var text = getTooltipText(el);
    if (!text) return;
    var tip = ensureTipEl();
    if (!tip) return;
    tip.textContent = text;
    tip.setAttribute('aria-hidden', 'false');
    // Primera pasada para medir con el texto ya aplicado.
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.classList.add('is-visible');
    place(el);
    // Reajuste tras el reflow (por si las dimensiones cambiaron).
    place(el);
  }

  function hideNow() {
    clearTimers();
    currentTarget = null;
    if (!tipEl) return;
    tipEl.classList.remove('is-visible');
    tipEl.setAttribute('aria-hidden', 'true');
  }

  function scheduleShow(el) {
    clearTimers();
    currentTarget = el;
    showTimer = setTimeout(function () {
      showTimer = null;
      if (currentTarget !== el) return;
      showFor(el);
    }, SHOW_DELAY_MS);
  }

  function scheduleHide() {
    if (hideTimer) return;
    hideTimer = setTimeout(function () {
      hideTimer = null;
      hideNow();
    }, HIDE_DELAY_MS);
  }

  function onPointerOver(e) {
    var el = findTarget(e.target);
    if (!el) return;
    if (el === currentTarget) return;
    scheduleShow(el);
  }

  function onPointerOut(e) {
    if (!currentTarget) return;
    var related = e.relatedTarget;
    if (related && currentTarget.contains && currentTarget.contains(related)) return;
    // Si el puntero sigue sobre el mismo target (pasa a un hijo sin data-tooltip), no ocultamos.
    var newTarget = findTarget(related);
    if (newTarget === currentTarget) return;
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
      currentTarget = null;
      return;
    }
    scheduleHide();
  }

  function onPointerDown() {
    hideNow();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' || e.keyCode === 27) hideNow();
  }

  function onWindowBlur() {
    hideNow();
  }

  function onVisibility() {
    if (document.visibilityState !== 'visible') hideNow();
  }

  function onScrollOrResize() {
    if (!currentTarget || !tipEl || !tipEl.classList.contains('is-visible')) {
      hideNow();
      return;
    }
    place(currentTarget);
  }

  function init() {
    injectStyle();
    ensureTipEl();
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('click', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('pagehide', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize, true);
  }

  /** @type {{ set: Function, hide: Function, __initialized: boolean }} */
  var api = {
    __initialized: true,
    set: function (el, text) {
      if (!el || el.nodeType !== 1) return;
      if (text == null || String(text).trim() === '') {
        el.removeAttribute('data-tooltip');
      } else {
        el.setAttribute('data-tooltip', String(text));
      }
      if (el === currentTarget && tipEl && tipEl.classList.contains('is-visible')) {
        var t = getTooltipText(el);
        if (!t) hideNow();
        else {
          tipEl.textContent = t;
          place(el);
        }
      }
    },
    hide: hideNow,
  };
  window.UDTooltip = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

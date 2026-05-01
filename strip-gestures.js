/**
 * Gestos compartidos sobre iconos de la franja (strip) de accesos:
 *   - Click corto con el botón IZQUIERDO → activación normal (lo dispara
 *     el `click` del propio botón; este módulo solo detecta long-press).
 *   - Mantener pulsado con el botón IZQUIERDO (CLOSE_HOLD_MS) dispara
 *     `onClose`, usado para cerrar la pestaña/ventana. Sin efectos en el
 *     borde del icono: la única señal visual es una píldora flotante
 *     "× Cerrar" que aparece debajo del icono.
 *   - Click con el botón DERECHO (sin hold) dispara `onFocus`, usado para
 *     añadir esa ventana al Modo Foco. Funciona también sobre iconos de
 *     ventanas cerradas.
 *
 * Todos los handlers son opcionales: pasa `null`/`undefined` para desactivar
 * el gesto correspondiente en ese icono. Si no se pasa `onFocus`, el botón
 * derecho no intercepta el menú contextual nativo.
 *
 * Compatibilidad: se aceptan los alias `onCloseDrag` → `onClose` y
 * `onLongPressFocus` → `onFocus`.
 */
(function () {
  const CLOSE_HOLD_MS = 450;
  const HOLD_MOVE_CANCEL_PX = 12;
  const SUPPRESS_CLICK_MS = 900;

  function bindIconStripGestures(btn, opts) {
    if (!btn) return () => {};
    const o = opts || {};
    const onClose =
      typeof o.onClose === 'function'
        ? o.onClose
        : typeof o.onCloseDrag === 'function'
        ? o.onCloseDrag
        : null;
    const onFocus =
      typeof o.onFocus === 'function'
        ? o.onFocus
        : typeof o.onLongPressFocus === 'function'
        ? o.onLongPressFocus
        : null;
    const suppressNextActivation =
      typeof o.suppressNextActivation === 'function' ? o.suppressNextActivation : null;

    let startX = 0;
    let startY = 0;
    let activePointerId = null;
    let committed = false;
    let movedPastCancel = false;

    let closeLabelEl = null;
    let pressRaf = 0;
    let pressStartTs = 0;

    /* -------------------- "Cerrar" pill (long-press izquierdo) -------------------- */

    function ensureCloseLabel() {
      if (!onClose) return null;
      if (closeLabelEl && closeLabelEl.isConnected) return closeLabelEl;
      closeLabelEl = document.createElement('span');
      closeLabelEl.className = 'strip-drag-close-pill';
      closeLabelEl.setAttribute('aria-hidden', 'true');
      const icon = document.createElement('span');
      icon.className = 'strip-drag-close-icon';
      icon.textContent = '\u00D7';
      const text = document.createElement('span');
      text.className = 'strip-drag-close-text';
      text.textContent = 'Cerrar';
      closeLabelEl.appendChild(icon);
      closeLabelEl.appendChild(text);
      document.body.appendChild(closeLabelEl);
      positionCloseLabel();
      return closeLabelEl;
    }

    function positionCloseLabel() {
      if (!closeLabelEl) return;
      const r = btn.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.bottom + 8;
      closeLabelEl.style.left = `${x}px`;
      closeLabelEl.style.top = `${y}px`;
    }

    function removeCloseLabel() {
      if (closeLabelEl) {
        try {
          closeLabelEl.remove();
        } catch {
          /* noop */
        }
        closeLabelEl = null;
      }
    }

    function stopPressAnimation() {
      if (pressRaf) {
        cancelAnimationFrame(pressRaf);
        pressRaf = 0;
      }
    }

    function fullCleanup() {
      stopPressAnimation();
      removeCloseLabel();
    }

    /* -------------------- Hold driver (sólo para cerrar con izquierdo) -------------------- */

    function startCloseHold(e) {
      ensureCloseLabel();
      pressStartTs = performance.now();
      const tick = (now) => {
        pressRaf = 0;
        if (committed || activePointerId == null) return;
        const p = Math.min(1, (now - pressStartTs) / CLOSE_HOLD_MS);
        if (closeLabelEl) closeLabelEl.style.setProperty('--press-progress', String(p));
        if (p >= 1) {
          committed = true;
          if (suppressNextActivation) suppressNextActivation();
          releaseCapture(e);
          try {
            if (typeof onClose === 'function') onClose();
          } catch {
            /* noop */
          }
          if (closeLabelEl) closeLabelEl.classList.add('is-committing');
          setTimeout(fullCleanup, 160);
          return;
        }
        pressRaf = requestAnimationFrame(tick);
      };
      pressRaf = requestAnimationFrame(tick);
    }

    /* -------------------- Pointer plumbing -------------------- */

    function releaseCapture(e) {
      if (activePointerId == null) return;
      try {
        if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      activePointerId = null;
    }

    function onPointerDown(e) {
      if (e.button !== 0 || !onClose) return;
      startX = e.clientX;
      startY = e.clientY;
      committed = false;
      movedPastCancel = false;
      fullCleanup();
      try {
        btn.setPointerCapture(e.pointerId);
        activePointerId = e.pointerId;
      } catch {
        activePointerId = null;
      }
      startCloseHold(e);
    }

    function onPointerMove(e) {
      if (activePointerId == null || committed) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dist = Math.hypot(dx, dy);
      if (dist > HOLD_MOVE_CANCEL_PX) {
        movedPastCancel = true;
        fullCleanup();
      } else if (closeLabelEl) {
        // La píldora sigue al icono si éste se reubica (scroll/resize tardío).
        positionCloseLabel();
      }
    }

    function onPointerEnd(e) {
      // Sólo suprimimos el siguiente click si el usuario arrastró fuera del
      // icono (gesto cancelado) o si el long-press llegó a comprometerse —el
      // commit ya llamó a `suppressNextActivation` desde el tick, así que aquí
      // no hace falta repetirlo. Un click corto NO debe suprimirse: tiene que
      // llegar al `click` listener para activar/cerrar/apagar foco.
      const wasMovedAbort = movedPastCancel && !committed;
      fullCleanup();
      if (wasMovedAbort && suppressNextActivation) {
        suppressNextActivation();
      }
      releaseCapture(e);
    }

    function onContextMenu(e) {
      // Bloqueamos el menú contextual del OS/Electron y disparamos el gesto
      // de foco en un click simple de botón derecho. Sólo si hay callback
      // cableado; de lo contrario no robamos comportamiento al icono.
      if (!onFocus) return;
      try {
        e.preventDefault();
      } catch {
        /* noop */
      }
      if (suppressNextActivation) suppressNextActivation();
      try {
        onFocus();
      } catch {
        /* noop */
      }
    }

    btn.addEventListener('pointerdown', onPointerDown);
    btn.addEventListener('pointermove', onPointerMove);
    btn.addEventListener('pointerup', onPointerEnd);
    btn.addEventListener('pointercancel', onPointerEnd);
    btn.addEventListener('contextmenu', onContextMenu);

    return function dispose() {
      btn.removeEventListener('pointerdown', onPointerDown);
      btn.removeEventListener('pointermove', onPointerMove);
      btn.removeEventListener('pointerup', onPointerEnd);
      btn.removeEventListener('pointercancel', onPointerEnd);
      btn.removeEventListener('contextmenu', onContextMenu);
      fullCleanup();
    };
  }

  window.UsualDeskStripGestures = {
    bindIconStripGestures,
    SUPPRESS_CLICK_MS,
    CLOSE_HOLD_MS,
  };
})();

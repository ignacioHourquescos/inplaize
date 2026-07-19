'use strict';

/**
 * Sticky notes clásicas en la pantalla de inicio del dock.
 *
 * Flujo:
 *   - Hacer clic en un área vacía del home crea una nota amarilla en esa
 *     posición. Si todavía no se escribió nada queda enfocada lista para
 *     tipiar.
 *   - Cada nota es un cuadrado amarillo con la esquina inferior derecha
 *     levemente "levantada" (efecto de papel doblado). Sin gradientes en el
 *     cuerpo. Tipografía Inter pero con peso medio (no tan "negra" como el
 *     logo de inplaize).
 *   - Mantener pulsada la nota (fuera del área de texto) hace que vibre
 *     durante 1.5 s y luego se aplaste en su lugar. Acto seguido el papel
 *     hecho un bollo cae en línea recta (mismo eje X) hasta el piso. Puede
 *     caer arriba de otros bollos: simplemente los nuevos van por encima.
 *   - Hacer clic en un bollo lo "abre" y vuelve a aparecer como nota.
 *   - Persistencia en `userData/sticky-notes.json` con debounce 300 ms.
 */

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.UsualDeskStickyNotes && window.UsualDeskStickyNotes.__initialized) return;

  /** ms para que un click sostenido sobre la nota dispare la vibración. */
  const LONG_PRESS_MS = 280;
  /** ms que vibra la nota antes de transformarse en bollo. */
  const VIBRATE_MS = 500;
  /** ms hasta que se confirma el guardado en disco después de mutar el estado. */
  const SAVE_DEBOUNCE_MS = 300;
  /** ms que dura la animación "aplastar la nota en su lugar" antes de caer. */
  const CRUMPLE_MORPH_MS = 400;
  /** ms que dura la caída en línea recta del bollo hasta el piso. */
  const FALL_DURATION_MS = 650;
  /** Tamaño visual de un bollo (cuadrado contenedor). */
  const BALL_SIZE_PX = 68;
  /** Margen vertical entre la base del piso y la base del bollo más bajo. */
  const BALL_BOTTOM_MARGIN_PX = 8;
  /** Distancia horizontal por la que dos bollos se consideran "en la misma
   * columna" y, por tanto, se apilan en vez de quedar uno al lado del otro. */
  const STACK_X_RANGE_PX = BALL_SIZE_PX * 0.85;
  /** Pixeles que cada bollo añade al alto de la pila (un poco menor que el
   * tamaño del bollo: aparentan estar pisándose con un solape natural). */
  const STACK_STEP_PX = Math.round(BALL_SIZE_PX * 0.55);
  const DEFAULT_NOTE_W = 210;
  const DEFAULT_NOTE_H = 210;

  /** @type {{ notes: Array<any>, crumpled: Array<any> }} */
  const state = {
    notes: [],
    crumpled: [],
  };

  let panelEl = null;
  let layerEl = null;
  let saveTimer = null;
  let homeVisibleProvider = () => true;
  /** Cache de elementos DOM por id para no reconstruir todo en cada render. */
  const noteDomById = new Map();
  const crumpledDomById = new Map();
  /** Contador para z-index incremental: las notas/bollos creados después se ven encima. */
  let zCounter = 1;

  function getApi() {
    return (typeof window !== 'undefined' && window.usualDesk) || null;
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function clamp(n, min, max) {
    if (!Number.isFinite(n)) return min;
    return Math.min(Math.max(n, min), max);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const api = getApi();
      if (!api || typeof api.saveStickyNotes !== 'function') return;
      api
        .saveStickyNotes({
          notes: state.notes,
          crumpled: state.crumpled,
        })
        .catch(() => {
          /* sin permisos: mantenemos memoria en vivo */
        });
    }, SAVE_DEBOUNCE_MS);
  }

  function isHomeVisibleNow() {
    try {
      return homeVisibleProvider() === true;
    } catch {
      return false;
    }
  }

  /**
   * Calcula el `bottomPx` al que debería aterrizar un nuevo bollo cuya
   * coordenada horizontal sea `xPx`. Si en esa columna ya hay otros bollos,
   * el nuevo se apoya encima del más alto (la pila crece de abajo hacia
   * arriba). Si la columna está vacía, queda en el piso.
   */
  function computeStackedBottom(xPx, excludeId) {
    let bottom = BALL_BOTTOM_MARGIN_PX;
    for (const c of state.crumpled) {
      if (excludeId && c.id === excludeId) continue;
      if (Math.abs(c.xPx - xPx) < STACK_X_RANGE_PX) {
        const candidate = c.bottomPx + STACK_STEP_PX;
        if (candidate > bottom) bottom = candidate;
      }
    }
    return bottom;
  }

  /**
   * Después de quitar un bollo (al restaurarlo) re-apilamos los que quedaron
   * en su columna para que no queden "flotando" en el aire. Los bollos
   * superiores caen suavemente a su nueva posición gracias a la transición
   * CSS sobre `bottom` aplicada por la clase `.is-resting`.
   */
  function restackColumn(xPx) {
    const inColumn = state.crumpled
      .filter((c) => Math.abs(c.xPx - xPx) < STACK_X_RANGE_PX)
      .sort((a, b) => (a.fellAt || 0) - (b.fellAt || 0));
    let currentBottom = BALL_BOTTOM_MARGIN_PX;
    for (const c of inColumn) {
      if (c.bottomPx !== currentBottom) {
        c.bottomPx = currentBottom;
        const dom = crumpledDomById.get(c.id);
        if (dom) dom.style.bottom = `${currentBottom}px`;
      }
      currentBottom += STACK_STEP_PX;
    }
  }

  function bringNoteToFront(id) {
    const idx = state.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    state.notes[idx].z = ++zCounter;
    const dom = noteDomById.get(id);
    if (dom) dom.style.zIndex = String(state.notes[idx].z);
  }

  function createNoteData(opts) {
    const layerW = layerEl ? layerEl.clientWidth : 480;
    const layerH = layerEl ? layerEl.clientHeight : 480;
    const rawX = opts && Number.isFinite(opts.x) ? opts.x : 40;
    const rawY = opts && Number.isFinite(opts.y) ? opts.y : 40;
    const x = clamp(rawX, 6, Math.max(6, layerW - DEFAULT_NOTE_W - 6));
    const y = clamp(rawY, 6, Math.max(6, layerH - DEFAULT_NOTE_H - 6));
    return {
      id: makeId('note'),
      text: opts && typeof opts.text === 'string' ? opts.text : '',
      color: 'amarillo',
      x,
      y,
      w: DEFAULT_NOTE_W,
      h: DEFAULT_NOTE_H,
      rotation: 0,
      z: ++zCounter,
      updatedAt: Date.now(),
    };
  }

  function buildNoteElement(note) {
    const el = document.createElement('div');
    el.className = 'sticky-note';
    el.dataset.stickyId = note.id;
    el.setAttribute('data-mouse-hit', '');
    el.style.left = `${note.x}px`;
    el.style.top = `${note.y}px`;
    el.style.width = `${note.w}px`;
    el.style.height = `${note.h}px`;
    el.style.zIndex = String(note.z || ++zCounter);

    el.innerHTML = `
      <button type="button" class="sticky-note-close" data-role="delete" aria-label="Eliminar nota" title="Eliminar">
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>
      <div class="sticky-note-text" contenteditable="true" spellcheck="false" data-role="text" data-placeholder="Escribí…"></div>
      <span class="sticky-note-curl" aria-hidden="true"></span>
    `;

    const textEl = el.querySelector('[data-role="text"]');
    if (textEl) {
      textEl.textContent = note.text || '';
      textEl.addEventListener('input', () => {
        const data = state.notes.find((n) => n.id === note.id);
        if (!data) return;
        data.text = textEl.textContent || '';
        data.updatedAt = Date.now();
        scheduleSave();
      });
      textEl.addEventListener('focus', () => {
        el.classList.add('is-editing');
        bringNoteToFront(note.id);
      });
      textEl.addEventListener('blur', () => {
        el.classList.remove('is-editing');
      });
      textEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          textEl.blur();
        }
      });
      textEl.addEventListener('paste', (ev) => {
        if (!ev.clipboardData) return;
        ev.preventDefault();
        const plain = ev.clipboardData.getData('text/plain') || '';
        document.execCommand('insertText', false, plain);
      });
    }

    const deleteBtn = el.querySelector('[data-role="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        deleteNote(note.id);
      });
      deleteBtn.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
      });
    }

    attachDragAndCrumple(el, note.id);
    return el;
  }

  function deleteNote(id) {
    const idx = state.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const dom = noteDomById.get(id);
    if (dom) {
      dom.classList.add('is-removing');
      setTimeout(() => {
        if (dom.parentNode) dom.parentNode.removeChild(dom);
      }, 220);
    }
    noteDomById.delete(id);
    state.notes.splice(idx, 1);
    scheduleSave();
  }

  function attachDragAndCrumple(el, id) {
    /** @type {null | {
     *   pointerId: number,
     *   mode: 'idle'|'drag'|'press'|'vibrating'|'crumpling',
     *   startX: number, startY: number,
     *   baseX: number, baseY: number,
     *   pressTimer: any,
     *   vibrateTimer: any,
     *   target: HTMLElement | null,
     * }} */
    let session = null;

    const onPointerDown = (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target instanceof Element ? ev.target : null;
      if (target && target.closest('[data-role="text"]')) return;
      if (target && target.closest('[data-role="delete"]')) return;

      const data = state.notes.find((n) => n.id === id);
      if (!data) return;
      bringNoteToFront(id);

      session = {
        pointerId: ev.pointerId,
        mode: 'press',
        startX: ev.clientX,
        startY: ev.clientY,
        baseX: data.x,
        baseY: data.y,
        pressTimer: null,
        vibrateTimer: null,
        target,
      };

      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }

      // Después de un breve "press" (sin movimiento) arranca la vibración.
      // Le damos a la vibración la duración VIBRATE_MS antes del bollo.
      session.pressTimer = setTimeout(() => {
        if (!session || session.mode === 'drag') return;
        session.mode = 'vibrating';
        el.classList.add('is-vibrating');
        session.vibrateTimer = setTimeout(() => {
          if (!session || session.mode !== 'vibrating') return;
          session.mode = 'crumpling';
          el.classList.remove('is-vibrating');
          try {
            el.releasePointerCapture(session.pointerId);
          } catch {
            /* noop */
          }
          performCrumpleAndFall(id);
          session = null;
        }, VIBRATE_MS);
      }, LONG_PRESS_MS);

      ev.preventDefault();
    };

    const onPointerMove = (ev) => {
      if (!session || session.pointerId !== ev.pointerId) return;
      if (session.mode === 'vibrating' || session.mode === 'crumpling') return;
      const dx = ev.clientX - session.startX;
      const dy = ev.clientY - session.startY;
      if (session.mode === 'press') {
        if (Math.abs(dx) + Math.abs(dy) > 6) {
          session.mode = 'drag';
          if (session.pressTimer) {
            clearTimeout(session.pressTimer);
            session.pressTimer = null;
          }
          el.classList.add('is-dragging');
        }
      }
      if (session.mode === 'drag') {
        const data = state.notes.find((n) => n.id === id);
        if (!data || !layerEl) return;
        const maxX = Math.max(0, layerEl.clientWidth - data.w);
        const maxY = Math.max(0, layerEl.clientHeight - data.h);
        const nx = clamp(session.baseX + dx, 0, maxX);
        const ny = clamp(session.baseY + dy, 0, maxY);
        data.x = nx;
        data.y = ny;
        el.style.left = `${nx}px`;
        el.style.top = `${ny}px`;
      }
    };

    const onPointerUp = (ev) => {
      if (!session || session.pointerId !== ev.pointerId) return;
      if (session.mode === 'vibrating' || session.mode === 'crumpling') return;
      const wasDragging = session.mode === 'drag';
      const wasPress = session.mode === 'press';
      const start = { x: session.startX, y: session.startY };
      if (session.pressTimer) {
        clearTimeout(session.pressTimer);
        session.pressTimer = null;
      }
      if (session.vibrateTimer) {
        clearTimeout(session.vibrateTimer);
        session.vibrateTimer = null;
      }
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      el.classList.remove('is-dragging');
      el.classList.remove('is-vibrating');
      session = null;
      if (wasDragging) {
        const data = state.notes.find((n) => n.id === id);
        if (data) {
          data.updatedAt = Date.now();
          scheduleSave();
        }
      } else if (wasPress) {
        const moved = Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y);
        if (moved < 6) {
          const textEl = el.querySelector('[data-role="text"]');
          if (textEl) {
            textEl.focus();
            placeCaretAtEnd(textEl);
          }
        }
      }
    };

    const onPointerCancel = (ev) => {
      if (!session || session.pointerId !== ev.pointerId) return;
      if (session.mode === 'vibrating' || session.mode === 'crumpling') return;
      if (session.pressTimer) clearTimeout(session.pressTimer);
      if (session.vibrateTimer) clearTimeout(session.vibrateTimer);
      el.classList.remove('is-dragging');
      el.classList.remove('is-vibrating');
      session = null;
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
  }

  function placeCaretAtEnd(node) {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* noop */
    }
  }

  /**
   * Animación completa: aplastar la nota en su sitio y luego dejar caer un
   * bollo en línea recta hasta el piso. El bollo termina como elemento
   * persistente en `state.crumpled` y en el DOM.
   */
  function performCrumpleAndFall(noteId) {
    const idx = state.notes.findIndex((n) => n.id === noteId);
    if (idx < 0) return;
    const data = state.notes[idx];
    const dom = noteDomById.get(noteId);
    if (!dom || !layerEl) {
      state.notes.splice(idx, 1);
      scheduleSave();
      return;
    }

    // Fase 1: la nota se aplasta en su lugar (sin moverse del eje X/Y).
    dom.classList.add('is-crumpling');
    dom.style.pointerEvents = 'none';

    setTimeout(() => {
      // Fase 2: la nota desaparece y nace un bollo en la misma posición,
      // que cae en línea recta hasta el piso.
      const noteRect = dom.getBoundingClientRect();
      const layerRect = layerEl.getBoundingClientRect();
      const ballCenterX =
        noteRect.left - layerRect.left + noteRect.width / 2;
      const ballStartCenterY =
        noteRect.top - layerRect.top + noteRect.height / 2;

      // Eliminamos la nota del DOM y del estado.
      if (dom.parentNode) dom.parentNode.removeChild(dom);
      noteDomById.delete(noteId);
      state.notes.splice(state.notes.findIndex((n) => n.id === noteId), 1);

      // El nuevo bollo se apoya sobre los que ya están en su misma columna.
      const stackedBottom = computeStackedBottom(ballCenterX);
      const floorCenterY = layerEl.clientHeight - stackedBottom - BALL_SIZE_PX / 2;

      const initialRotation = Math.round(Math.random() * 30 - 15);
      const finalRotation = initialRotation + Math.round(Math.random() * 40 - 20);

      const crumpled = {
        id: makeId('crumpled'),
        text: data.text,
        color: 'amarillo',
        xPx: ballCenterX,
        bottomPx: stackedBottom,
        rotation: finalRotation,
        z: ++zCounter,
        fellAt: Date.now(),
      };
      state.crumpled.push(crumpled);

      const ballEl = buildCrumpledElement(crumpled);
      layerEl.appendChild(ballEl);
      crumpledDomById.set(crumpled.id, ballEl);

      // Posición inicial: centro del bollo en el centro de la ex-nota.
      // Durante la caída usamos transform: translate(-50%, -50%) para que
      // `top` represente directamente el CENTRO vertical del bollo. Al
      // aterrizar pasamos a anclar con bottom + translate(-50%, 0): los
      // pixeles netos coinciden (mismo borde inferior) y no hay salto.
      ballEl.classList.add('is-falling');
      ballEl.style.left = `${ballCenterX}px`;
      ballEl.style.top = `${ballStartCenterY}px`;
      ballEl.style.bottom = 'auto';
      ballEl.style.transform =
        `translate(-50%, -50%) rotate(${initialRotation}deg)`;

      // Forzamos reflow antes de pedir la transición a la posición final.
      // eslint-disable-next-line no-unused-expressions
      ballEl.offsetHeight;
      ballEl.style.transition =
        `top ${FALL_DURATION_MS}ms cubic-bezier(0.45, 0.05, 0.65, 1), ` +
        `transform ${FALL_DURATION_MS}ms cubic-bezier(0.45, 0.05, 0.65, 1)`;
      ballEl.style.top = `${floorCenterY}px`;
      ballEl.style.transform =
        `translate(-50%, -50%) rotate(${finalRotation}deg)`;

      setTimeout(() => {
        // Cambio de anclaje sin transición para que no se vea: la rotación
        // se mantiene en `finalRotation` (sin saltos), y bottom+translateY(0)
        // arroja exactamente la misma posición vertical que top+translateY(-50%).
        ballEl.style.transition = 'none';
        ballEl.style.left = `${crumpled.xPx}px`;
        ballEl.style.top = 'auto';
        ballEl.style.bottom = `${crumpled.bottomPx}px`;
        ballEl.style.transform = `translate(-50%, 0) rotate(${finalRotation}deg)`;
        ballEl.style.setProperty('--crumple-rot', `${finalRotation}deg`);
        // eslint-disable-next-line no-unused-expressions
        ballEl.offsetHeight;
        ballEl.style.transition = '';
        ballEl.classList.remove('is-falling');
        ballEl.classList.add('is-resting');
        ballEl.classList.add('just-landed');
        setTimeout(() => ballEl.classList.remove('just-landed'), 260);
        scheduleSave();
      }, FALL_DURATION_MS + 20);
    }, CRUMPLE_MORPH_MS);
  }

  function buildCrumpledElement(c) {
    const ball = document.createElement('button');
    ball.type = 'button';
    ball.className = 'sticky-crumpled-ball';
    ball.dataset.crumpledId = c.id;
    ball.setAttribute(
      'aria-label',
      `Abrir nota apretada${c.text ? ': ' + c.text.slice(0, 80) : ''}`,
    );
    ball.setAttribute('title', c.text ? `Abrir: ${c.text.slice(0, 140)}` : 'Abrir nota');
    ball.style.left = `${c.xPx}px`;
    ball.style.bottom = `${c.bottomPx}px`;
    ball.style.zIndex = String(c.z || ++zCounter);
    ball.style.setProperty('--crumple-rot', `${c.rotation}deg`);
    ball.style.transform = `translate(-50%, 0) rotate(${c.rotation}deg)`;
    // El SVG dentro genera el aspecto de papel arrugado con sus dobleces.
    ball.innerHTML = crumpledPaperSvg();
    ball.addEventListener('click', (ev) => {
      ev.stopPropagation();
      restoreCrumpled(c.id);
    });
    return ball;
  }

  /**
   * SVG estilizado de un papel arrugado: contorno irregular, líneas internas
   * sutiles que sugieren los pliegues y polígonos con tonos más oscuros donde
   * el papel "cae" en sombra. Mucho más papel-ish que un círculo con gradiente.
   */
  function crumpledPaperSvg() {
    return `
<svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true" class="sticky-crumpled-svg">
  <defs>
    <radialGradient id="cp-light" cx="32%" cy="28%" r="60%">
      <stop offset="0%" stop-color="#fff6c4"/>
      <stop offset="55%" stop-color="#ffe680"/>
      <stop offset="100%" stop-color="#e8c64a"/>
    </radialGradient>
  </defs>
  <!-- Sombra que el bollo proyecta en el piso (más oscura abajo) -->
  <ellipse cx="50" cy="93" rx="34" ry="5" fill="rgba(0,0,0,0.45)"/>
  <!-- Cuerpo principal con contorno irregular -->
  <path
    d="M 18 32 L 28 14 L 47 8 L 63 12 L 80 22 L 90 38 L 94 56 L 86 76 L 70 88 L 50 92 L 30 88 L 12 74 L 6 56 L 8 42 Z"
    fill="url(#cp-light)"
    stroke="rgba(120,90,10,0.35)"
    stroke-width="0.8"
    stroke-linejoin="round"
  />
  <!-- Facetas (polígonos más oscuros = sombras de pliegues) -->
  <path d="M 18 32 L 35 30 L 28 14 Z"            fill="rgba(0,0,0,0.10)"/>
  <path d="M 90 38 L 78 44 L 80 22 Z"            fill="rgba(0,0,0,0.10)"/>
  <path d="M 94 56 L 78 60 L 86 76 Z"            fill="rgba(0,0,0,0.14)"/>
  <path d="M 12 74 L 30 70 L 30 88 Z"            fill="rgba(0,0,0,0.15)"/>
  <path d="M 50 92 L 60 78 L 70 88 Z"            fill="rgba(0,0,0,0.16)"/>
  <path d="M 35 30 L 50 22 L 47 8 Z"             fill="rgba(255,255,255,0.18)"/>
  <path d="M 50 22 L 63 12 L 65 28 Z"            fill="rgba(255,255,255,0.12)"/>
  <path d="M 30 70 L 50 60 L 55 80 L 35 78 Z"    fill="rgba(0,0,0,0.07)"/>
  <path d="M 50 60 L 65 50 L 78 60 L 65 70 Z"    fill="rgba(0,0,0,0.10)"/>
  <path d="M 35 30 L 50 38 L 50 22 Z"            fill="rgba(255,255,255,0.10)"/>
  <!-- Pliegues como trazos -->
  <g stroke="rgba(120,90,10,0.45)" stroke-width="0.7" fill="none" stroke-linecap="round">
    <path d="M 22 36 Q 35 42 50 38 T 80 42"/>
    <path d="M 18 60 Q 32 52 50 60 T 86 60"/>
    <path d="M 28 78 Q 42 70 56 78 T 80 74"/>
    <path d="M 40 18 L 48 32"/>
    <path d="M 66 18 L 60 36"/>
    <path d="M 78 30 L 70 48"/>
    <path d="M 25 50 L 32 64"/>
    <path d="M 70 56 L 76 72"/>
  </g>
  <!-- Brillos -->
  <g fill="rgba(255,255,255,0.55)">
    <ellipse cx="38" cy="26" rx="6" ry="2.5" transform="rotate(-18 38 26)"/>
    <ellipse cx="62" cy="48" rx="4" ry="1.6" transform="rotate(20 62 48)"/>
  </g>
</svg>`;
  }

  function restoreCrumpled(id) {
    const idx = state.crumpled.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const data = state.crumpled[idx];
    state.crumpled.splice(idx, 1);
    const dom = crumpledDomById.get(id);
    if (dom) {
      dom.classList.add('is-restoring');
      setTimeout(() => {
        if (dom.parentNode) dom.parentNode.removeChild(dom);
      }, 320);
    }
    crumpledDomById.delete(id);

    // Después de quitar el bollo, los que estaban encima en la misma columna
    // caen suavemente para llenar el hueco.
    restackColumn(data.xPx);

    // La nota vuelve cerca de donde estaba el bollo en X y arriba del piso.
    const layerW = layerEl ? layerEl.clientWidth : 480;
    const layerH = layerEl ? layerEl.clientHeight : 480;
    const x = clamp(data.xPx - DEFAULT_NOTE_W / 2, 12, Math.max(12, layerW - DEFAULT_NOTE_W - 12));
    const y = clamp(layerH * 0.35, 12, Math.max(12, layerH - DEFAULT_NOTE_H - 100));
    const note = createNoteData({ text: data.text, x, y });
    state.notes.push(note);
    const noteEl = buildNoteElement(note);
    layerEl.appendChild(noteEl);
    noteDomById.set(note.id, noteEl);
    noteEl.classList.add('is-restoring');
    setTimeout(() => noteEl.classList.remove('is-restoring'), 380);
    bringNoteToFront(note.id);
    scheduleSave();
  }

  function renderAll() {
    if (!layerEl) return;
    while (layerEl.firstChild) layerEl.removeChild(layerEl.firstChild);
    noteDomById.clear();
    crumpledDomById.clear();
    // Notas primero, bollos al final (van en el piso).
    for (const n of state.notes) {
      if (!n.z) n.z = ++zCounter;
      const el = buildNoteElement(n);
      layerEl.appendChild(el);
      noteDomById.set(n.id, el);
    }
    for (const c of state.crumpled) {
      if (!c.z) c.z = ++zCounter;
      const el = buildCrumpledElement(c);
      // Estos bollos ya están en el piso desde el inicio: habilitamos las
      // transiciones suaves de hover.
      el.classList.add('is-resting');
      layerEl.appendChild(el);
      crumpledDomById.set(c.id, el);
    }
  }

  function spawnNoteAtClient(clientX, clientY, opts) {
    if (!layerEl) return null;
    const layerRect = layerEl.getBoundingClientRect();
    // Centramos la nota en el punto del clic (sentir natural).
    const localX = clientX - layerRect.left - DEFAULT_NOTE_W / 2;
    const localY = clientY - layerRect.top - 32; // un poco arriba del clic
    const note = createNoteData({ x: localX, y: localY, text: opts?.text || '' });
    state.notes.push(note);
    const el = buildNoteElement(note);
    layerEl.appendChild(el);
    noteDomById.set(note.id, el);
    el.classList.add('is-appearing');
    setTimeout(() => el.classList.remove('is-appearing'), 320);
    if (opts?.focus !== false) {
      const textEl = el.querySelector('[data-role="text"]');
      if (textEl) {
        textEl.focus();
        placeCaretAtEnd(textEl);
      }
    }
    scheduleSave();
    return note;
  }

  function spawnNoteAtCenter() {
    if (!layerEl) return null;
    const rect = layerEl.getBoundingClientRect();
    return spawnNoteAtClient(rect.left + rect.width / 2, rect.top + rect.height * 0.35);
  }

  /**
   * Manejador de clic en el panel del home: si el clic ocurre sobre un área
   * "vacía" (no sobre los botones, la marca con foco, ni una nota o bollo
   * existentes), creamos una nueva nota en esa posición.
   */
  function handlePanelClick(ev) {
    if (ev.button != null && ev.button !== 0) return;
    if (!isHomeVisibleNow()) return;
    if (!layerEl) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    // Áreas que NO deben crear notas:
    if (target.closest('.sticky-note')) return;
    if (target.closest('.sticky-crumpled-ball')) return;
    if (target.closest('.dock-home-action-cell')) return;
    if (target.closest('.dock-home-quit-link')) return;
    if (target.closest('#dock-home-menu') || target.closest('#dock-home-menu-backdrop')) return;
    if (target.closest('button')) return;
    if (target.closest('a')) return;
    // Si el clic no fue dentro del panel del home (p. ej. sobre algo del chrome), salir.
    if (panelEl && !panelEl.contains(target)) return;

    spawnNoteAtClient(ev.clientX, ev.clientY);
  }

  async function loadFromDisk() {
    const api = getApi();
    if (!api || typeof api.getStickyNotes !== 'function') {
      state.notes = [];
      state.crumpled = [];
      renderAll();
      return;
    }
    try {
      const payload = await api.getStickyNotes();
      state.notes = Array.isArray(payload?.notes) ? payload.notes : [];
      state.crumpled = Array.isArray(payload?.crumpled) ? payload.crumpled : [];
      // Asegurar z-index incremental coherente con el orden de carga.
      for (const n of state.notes) n.z = ++zCounter;
      for (const c of state.crumpled) c.z = ++zCounter;
      // Re-apilamos por si el archivo trae bottomPx incoherentes (p. ej. notas
      // de versiones viejas donde todos los bollos estaban en el piso).
      const seenColumns = new Set();
      for (const c of state.crumpled) {
        const key = Math.round(c.xPx / STACK_X_RANGE_PX);
        if (seenColumns.has(key)) continue;
        seenColumns.add(key);
        restackColumn(c.xPx);
      }
    } catch {
      state.notes = [];
      state.crumpled = [];
    }
    renderAll();
  }

  function mount(opts) {
    const host = opts && opts.host instanceof HTMLElement ? opts.host : null;
    if (!host) return;
    if (host.querySelector(':scope > .sticky-notes-layer')) return;
    panelEl = host;

    if (typeof opts?.isHomeVisible === 'function') {
      homeVisibleProvider = opts.isHomeVisible;
    }

    layerEl = document.createElement('div');
    layerEl.id = 'sticky-notes-layer';
    layerEl.className = 'sticky-notes-layer';
    layerEl.setAttribute('aria-label', 'Notas de la pantalla de inicio');
    host.appendChild(layerEl);

    panelEl.addEventListener('click', handlePanelClick);

    loadFromDisk();

    const api = getApi();
    if (api && typeof api.onStickyNotesChanged === 'function') {
      api.onStickyNotesChanged(() => {
        loadFromDisk();
      });
    }
  }

  function spawnEmptyNote() {
    spawnNoteAtCenter();
  }

  window.UsualDeskStickyNotes = {
    __initialized: true,
    mount,
    spawnEmptyNote,
  };
})();

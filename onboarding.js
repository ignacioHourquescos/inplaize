'use strict';

/**
 * Onboarding de primera vez para inplaize.
 *
 * Estructura: una capa visual (overlay oscuro) + un anillo pulsante sobre el
 * elemento "objetivo" + un bocadillo flotante con el copy y los botones.
 * El overlay es solo visual (`pointer-events: none`); el target queda
 * interactuable normalmente. El bocadillo captura sus propios clics.
 *
 * Pasos:
 *   0  Bienvenida (modal centrado, sin spotlight).
 *   1  Atajo Ctrl+Alt+D — modal centrado con un teclado dibujado mostrando
 *      las tres teclas. Sin spotlight: la idea es que el usuario pruebe el
 *      atajo (que justamente colapsa el panel) antes de pulsar "Siguiente".
 *   2  "+" para crear la primera ventana (#add-btn). Avance automático
 *      cuando shortcuts pasa de 0 a >=1. Sin botón "Siguiente": queremos
 *      que el usuario realmente agregue una ventana (sugerimos Chrome).
 *   3  Click izquierdo mantenido = cerrar/apagar esa ventana (sobre el card
 *      recién creado). Último paso del tour.
 *
 * Persistencia: solo se reactiva si en disco `onboardingCompleted === false`
 * Y la lista de shortcuts está vacía (para no molestar a usuarios que ya
 * tenían la app configurada y vienen de una versión previa).
 *
 * API pública (`window.UsualDeskOnboarding`):
 *   start({ skipWelcome, preview })
 *     → arranca el flujo desde el paso 0 (o 1 si skipWelcome).
 *     → con `preview: true` se asume que el usuario ya tiene shortcuts: se
 *        deshabilita el auto-avance, se fuerzan botones "Siguiente" en todos
 *        los pasos y NO se persiste `onboardingCompleted` (deja el estado
 *        en disco como estaba, p. ej. para repetir el tour cuantas veces
 *        haga falta desde Configuración).
 *   advance(reason)         → pasa al siguiente paso si el `reason` coincide.
 *   skip()                  → marca completado y cierra todo.
 *   isActive()              → true mientras está mostrándose.
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.UsualDeskOnboarding && window.UsualDeskOnboarding.__initialized) return;

  /** Estado en runtime */
  const state = {
    active: false,
    preview: false,
    step: -1,
    layerEl: null,
    spotlightEl: null,
    bubbleEl: null,
    targetEl: null,
    repositionRaf: 0,
    repositionListener: null,
    modalObserver: null,
    suppressedByModal: false,
    /**
     * Paso "hotkey": el usuario tiene que pulsar Ctrl+Alt+D una vez antes de
     * poder avanzar. Se detecta vía cambios de `sidebar-state` (que el main
     * envía al togglar el dock con el atajo). `hotkeyAttemptedNext` se
     * activa si el usuario intenta avanzar sin haberlo probado, y muestra
     * el aviso pidiéndoselo amablemente.
     */
    hotkeyPressed: false,
    hotkeyAttemptedNext: false,
    sidebarStateListenerArmed: false,
  };

  const STEPS = [
    {
      id: 'welcome',
      kind: 'modal',
      title: '¿Listo para dejar de perderte en el caos de ventanas?',
      body: '',
      primaryLabel: 'Comenzar',
      secondaryLabel: 'Omitir',
    },
    {
      id: 'hotkey',
      kind: 'modal',
      title: 'Tu shortcut que va a ser tu mejor amigo',
      body: 'Apretalo para mostrar u ocultar la aplicación. Probalo ahora antes de continuar.',
      keyboardKeys: ['Ctrl', 'Alt', 'D'],
      primaryLabel: 'Siguiente',
      secondaryLabel: 'Omitir',
    },
    {
      id: 'add-first',
      kind: 'spotlight',
      targetSelector: '#add-btn',
      placement: 'bottom',
      title: 'Agregá tu primera ventana',
      body: 'Pulsá el "+" arriba a la derecha. Por ejemplo: Chrome.',
      primaryLabel: 'Siguiente',
      // En real onboarding "Siguiente" abre el modal de añadir; en preview
      // simplemente avanza al paso 3 sin tocar la lista del usuario.
      primaryAction: 'open-add-shortcut',
      secondaryLabel: 'Omitir',
      autoAdvanceOn: 'shortcuts-non-empty',
    },
    {
      id: 'left-hold',
      kind: 'spotlight',
      targetSelector: '[data-onboarding-target="first-shortcut"]',
      placement: 'bottom',
      title: 'Cerrar sin tocar el resto',
      body:
        'Click corto abre la ventana. Si mantenés apretado el click izquierdo aparece la pildora "× Cerrar" y apagás solo esa ventana.',
      primaryLabel: 'Terminar',
      secondaryLabel: null,
    },
  ];

  function isActive() {
    return state.active;
  }

  /** ---------------- DOM helpers ---------------- */

  function ensureLayer() {
    if (state.layerEl && state.layerEl.isConnected) return state.layerEl;
    const layer = document.createElement('div');
    layer.id = 'onboarding-layer';
    layer.className = 'onboarding-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('data-mouse-hit', '');

    const dim = document.createElement('div');
    dim.className = 'onboarding-dim';

    const spotlight = document.createElement('div');
    spotlight.className = 'onboarding-spotlight';
    spotlight.setAttribute('aria-hidden', 'true');
    state.spotlightEl = spotlight;

    layer.appendChild(dim);
    layer.appendChild(spotlight);
    document.body.appendChild(layer);
    state.layerEl = layer;
    return layer;
  }

  function ensureBubble() {
    if (state.bubbleEl && state.bubbleEl.isConnected) return state.bubbleEl;
    const bubble = document.createElement('section');
    bubble.className = 'onboarding-bubble';
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-modal', 'false');
    bubble.setAttribute('data-mouse-hit', '');
    document.body.appendChild(bubble);
    state.bubbleEl = bubble;
    return bubble;
  }

  function clearTargetMark() {
    if (state.targetEl) {
      state.targetEl.classList.remove('is-onboarding-target');
      state.targetEl = null;
    }
  }

  function teardown() {
    state.active = false;
    state.preview = false;
    state.step = -1;
    state.suppressedByModal = false;
    state.hotkeyPressed = false;
    state.hotkeyAttemptedNext = false;
    document.documentElement.classList.remove('onboarding-active');
    if (state.repositionListener) {
      window.removeEventListener('resize', state.repositionListener);
      window.removeEventListener('scroll', state.repositionListener, true);
      state.repositionListener = null;
    }
    if (state.repositionRaf) {
      cancelAnimationFrame(state.repositionRaf);
      state.repositionRaf = 0;
    }
    if (state.modalObserver) {
      state.modalObserver.disconnect();
      state.modalObserver = null;
    }
    clearTargetMark();
    if (state.layerEl) {
      try {
        state.layerEl.remove();
      } catch {
        /* noop */
      }
      state.layerEl = null;
      state.spotlightEl = null;
    }
    if (state.bubbleEl) {
      try {
        state.bubbleEl.remove();
      } catch {
        /* noop */
      }
      state.bubbleEl = null;
    }
  }

  /**
   * El formulario "Añadir acceso directo" se renderiza en `#modal-overlay`
   * (lateral/centro) o en `#dock-inline-editor` (topbar). Mientras alguno
   * esté visible, escondemos la capa para no tapar el formulario y dejar
   * que el usuario se concentre en cargar la URL.
   */
  function isShortcutFormOpen() {
    const modal = document.getElementById('modal-overlay');
    if (modal && !modal.classList.contains('hidden')) return true;
    const inline = document.getElementById('dock-inline-editor');
    if (inline && !inline.classList.contains('hidden')) return true;
    return false;
  }

  function applyModalSuppression() {
    if (!state.active) return;
    const open = isShortcutFormOpen();
    if (open === state.suppressedByModal) return;
    state.suppressedByModal = open;
    if (state.layerEl) {
      state.layerEl.style.display = open ? 'none' : '';
    }
    if (state.bubbleEl) {
      state.bubbleEl.style.display = open ? 'none' : '';
    }
    if (!open) {
      // Al volver, el target puede haber cambiado de tamaño/posición.
      scheduleReflow();
    }
  }

  function startModalObserver() {
    if (state.modalObserver) return;
    const modal = document.getElementById('modal-overlay');
    const inline = document.getElementById('dock-inline-editor');
    const obs = new MutationObserver(() => applyModalSuppression());
    if (modal) obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
    if (inline) obs.observe(inline, { attributes: true, attributeFilter: ['class'] });
    state.modalObserver = obs;
  }

  async function persistCompleted() {
    // En modo preview no tocamos disco: el flag `onboardingCompleted` queda
    // como estaba y el usuario puede volver a ejecutar el tour cuando quiera.
    if (state.preview) return;
    try {
      if (window.usualDesk && typeof window.usualDesk.setAppSettings === 'function') {
        await window.usualDesk.setAppSettings({ onboardingCompleted: true });
      }
    } catch {
      /* persistencia no crítica */
    }
  }

  async function collapseDockSidebarIfPossible() {
    try {
      if (window.usualDesk && typeof window.usualDesk.collapseSidebar === 'function') {
        await window.usualDesk.collapseSidebar();
      }
    } catch {
      /* sin colapsar: el usuario puede hacerlo con click fuera o Ctrl+Alt+D */
    }
  }

  /** ---------------- Posicionamiento ---------------- */

  function positionSpotlight(rect) {
    if (!state.spotlightEl) return;
    const padding = 6;
    const x = rect.left - padding;
    const y = rect.top - padding;
    const w = rect.width + padding * 2;
    const h = rect.height + padding * 2;
    const s = state.spotlightEl.style;
    s.left = `${x}px`;
    s.top = `${y}px`;
    s.width = `${w}px`;
    s.height = `${h}px`;
    s.opacity = '1';
  }

  function hideSpotlight() {
    if (!state.spotlightEl) return;
    state.spotlightEl.style.opacity = '0';
  }

  function positionBubbleCentered() {
    if (!state.bubbleEl) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = state.bubbleEl.offsetWidth || 360;
    const bh = state.bubbleEl.offsetHeight || 200;
    state.bubbleEl.dataset.placement = 'center';
    state.bubbleEl.style.left = `${Math.max(12, (vw - bw) / 2)}px`;
    state.bubbleEl.style.top = `${Math.max(12, (vh - bh) / 2)}px`;
  }

  function reflowCurrentStep() {
    if (!state.active) return;
    const step = STEPS[state.step];
    if (!step) return;
    // El bocadillo siempre va centrado en pantalla, así el usuario tiene un
    // único lugar de referencia para leer y avanzar. El spotlight (cuando
    // existe) sigue dibujándose sobre el target real para indicar dónde
    // tiene que mirar/tocar.
    positionBubbleCentered();
    if (step.kind === 'modal') {
      hideSpotlight();
      return;
    }
    const target = state.targetEl;
    if (!target || !target.isConnected) {
      hideSpotlight();
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideSpotlight();
      return;
    }
    positionSpotlight(rect);
  }

  function scheduleReflow() {
    if (state.repositionRaf) return;
    state.repositionRaf = requestAnimationFrame(() => {
      state.repositionRaf = 0;
      reflowCurrentStep();
    });
  }

  /** ---------------- Render del paso ---------------- */

  function renderBubble(step) {
    const bubble = ensureBubble();
    bubble.dataset.stepId = step.id;
    bubble.dataset.kind = step.kind;
    const stepIndex = STEPS.indexOf(step);
    const stepCount = STEPS.length - 1; // sin contar la bienvenida (índice 0)
    // El paso 0 (welcome) no muestra contador; el resto sí, incluso modals.
    const counterText = stepIndex >= 1 ? `${stepIndex} de ${stepCount}` : '';

    // En modo preview los pasos auto-avanzados (p. ej. "Agregá tu primera
    // ventana") deben tener un botón "Siguiente" porque el usuario ya tiene
    // shortcuts y no vamos a forzarlo a crear uno nuevo solo para ver el tour.
    const isLast = stepIndex === STEPS.length - 1;
    const primaryLabel = step.primaryLabel
      ? step.primaryLabel
      : (state.preview ? (isLast ? 'Terminar' : 'Siguiente') : null);
    const secondaryLabel = step.secondaryLabel
      ? step.secondaryLabel
      : (state.preview && !isLast ? 'Cerrar' : null);

    const primary = primaryLabel
      ? `<button type="button" class="onboarding-btn-primary" data-onboarding-action="next">${escapeHtml(primaryLabel)}</button>`
      : '';
    const secondary = secondaryLabel
      ? `<button type="button" class="onboarding-btn-secondary" data-onboarding-action="skip">${escapeHtml(secondaryLabel)}</button>`
      : '';
    const counter = counterText
      ? `<span class="onboarding-counter">${escapeHtml(counterText)}</span>`
      : '';
    const body = step.body
      ? `<p class="onboarding-bubble-body">${escapeHtml(step.body)}</p>`
      : '';
    const keyboard = Array.isArray(step.keyboardKeys) && step.keyboardKeys.length
      ? renderKeyboardSvg(step.keyboardKeys)
      : '';
    // Aviso para el paso "hotkey" si el usuario intenta avanzar sin haber
    // probado Ctrl+Alt+D al menos una vez.
    const showHotkeyWarning =
      step.id === 'hotkey' && state.hotkeyAttemptedNext && !state.hotkeyPressed;
    const warning = showHotkeyWarning
      ? '<div class="onboarding-bubble-warning" role="alert">'
        + 'Para seguir, probá apretando el shortcut <strong>Ctrl + Alt + D</strong>. '
        + 'Vas a ver cómo la app se oculta y vuelve a aparecer.'
        + '</div>'
      : '';

    bubble.innerHTML = `
      <header class="onboarding-bubble-header">
        ${counter}
        <h3 class="onboarding-bubble-title">${escapeHtml(step.title)}</h3>
      </header>
      ${body}
      ${keyboard}
      ${warning}
      <footer class="onboarding-bubble-footer">
        ${secondary}
        ${primary}
      </footer>
    `;

    bubble.querySelectorAll('[data-onboarding-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const action = btn.getAttribute('data-onboarding-action');
        if (action === 'next') goNext();
        else if (action === 'skip') skip();
      });
    });
  }

  /**
   * Dibuja un teclado decorativo con las teclas dadas. La última tecla se
   * resalta en violeta porque es la "letra" del atajo y la que el usuario
   * tiene que recordar. Entre tecla y tecla pintamos un "+" tenue.
   * @param {string[]} keys
   */
  function renderKeyboardSvg(keys) {
    const k = keys.slice();
    const KEY_HEIGHT = 56;
    const KEY_PAD_X = 14;
    const PLUS_WIDTH = 22;
    const FONT_PER_CHAR = 9.5;
    const sizes = k.map((label) => Math.max(54, label.length * FONT_PER_CHAR + KEY_PAD_X * 2));
    let totalWidth = 0;
    sizes.forEach((w, i) => {
      totalWidth += w;
      if (i < sizes.length - 1) totalWidth += PLUS_WIDTH;
    });
    const padding = 12;
    const totalH = KEY_HEIGHT + padding * 2;
    const totalW = totalWidth + padding * 2;
    let cursor = padding;
    const parts = [];
    k.forEach((label, i) => {
      const w = sizes[i];
      const isAccent = i === k.length - 1;
      const fill = isAccent ? 'rgba(167, 139, 250, 0.22)' : 'rgba(255, 255, 255, 0.05)';
      const stroke = isAccent ? 'rgba(167, 139, 250, 0.95)' : 'rgba(255, 255, 255, 0.2)';
      const strokeW = isAccent ? 2 : 1.4;
      const textColor = isAccent ? '#ffffff' : 'rgba(245, 246, 248, 0.92)';
      parts.push(
        `<rect x="${cursor}" y="${padding}" width="${w}" height="${KEY_HEIGHT}" rx="9" ry="9" ` +
          `fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" />`,
      );
      // Pequeña sombra inferior para sensación de keycap
      parts.push(
        `<rect x="${cursor + 4}" y="${padding + KEY_HEIGHT - 6}" width="${w - 8}" height="3" rx="2" ` +
          `fill="rgba(0,0,0,0.35)" />`,
      );
      parts.push(
        `<text x="${cursor + w / 2}" y="${padding + KEY_HEIGHT / 2 + 5}" text-anchor="middle" ` +
          `font-family="Inter, 'Miranda Sans', system-ui, sans-serif" font-size="15" ` +
          `font-weight="${isAccent ? 700 : 600}" fill="${textColor}">${escapeHtml(label)}</text>`,
      );
      cursor += w;
      if (i < k.length - 1) {
        parts.push(
          `<text x="${cursor + PLUS_WIDTH / 2}" y="${padding + KEY_HEIGHT / 2 + 5}" text-anchor="middle" ` +
            `font-family="Inter, system-ui, sans-serif" font-size="14" ` +
            `fill="rgba(255,255,255,0.45)">+</text>`,
        );
        cursor += PLUS_WIDTH;
      }
    });

    return (
      `<div class="onboarding-keyboard-wrap" aria-hidden="true">` +
        `<svg class="onboarding-keyboard" viewBox="0 0 ${totalW} ${totalH}" ` +
          `width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">` +
          parts.join('') +
        `</svg>` +
      `</div>`
    );
  }

  function showStep(stepIndex) {
    const step = STEPS[stepIndex];
    if (!step) {
      finish();
      return;
    }
    state.step = stepIndex;
    ensureLayer();
    document.documentElement.classList.add('onboarding-active');

    clearTargetMark();
    let hasSpotlight = false;
    if (step.kind === 'spotlight' && step.targetSelector) {
      const target = document.querySelector(step.targetSelector);
      if (target) {
        target.classList.add('is-onboarding-target');
        state.targetEl = target;
        hasSpotlight = true;
      }
    }
    if (state.layerEl) {
      state.layerEl.classList.toggle('has-spotlight', hasSpotlight);
      // Etiquetamos la capa con el id del paso para que CSS pueda darle
      // tratamientos especiales (p. ej. el welcome con imagen de fondo).
      state.layerEl.dataset.stepId = step.id;
    }

    renderBubble(step);
    // Render inicial: dejamos que el navegador layoute y luego posicionamos.
    requestAnimationFrame(() => {
      reflowCurrentStep();
      // Doble RAF: algunos cambios de tamaño del bocadillo recién aparecen tras
      // el primer paint; reposicionamos otra vez para encuadrar bien la flecha.
      requestAnimationFrame(() => reflowCurrentStep());
    });
  }

  function goNext() {
    if (!state.active) return;
    const step = STEPS[state.step];

    // Paso "hotkey": exigimos que el usuario haya probado Ctrl+Alt+D al
    // menos una vez antes de seguir, también en modo preview (el preview
    // tiene que mostrar exactamente lo que ve un usuario nuevo). Si no se
    // probó, dejamos el wizard donde está y mostramos un aviso amable.
    if (step && step.id === 'hotkey' && !state.hotkeyPressed) {
      state.hotkeyAttemptedNext = true;
      renderBubble(step);
      return;
    }

    // Paso "add-first" en onboarding real: "Siguiente" significa abrir el
    // modal de añadir ventana (mismo gesto que pulsar el "+"). Cuando el
    // usuario guarde, el auto-avance via `shortcuts-non-empty` pasará al
    // paso siguiente. En preview avanzamos directo sin tocar nada.
    if (step && step.primaryAction === 'open-add-shortcut' && !state.preview) {
      const addBtn = document.getElementById('add-btn');
      if (addBtn) {
        try {
          addBtn.click();
        } catch {
          /* fallback: si por alguna razón no funciona, avanzamos */
          advanceToNextStep();
        }
        return;
      }
    }

    advanceToNextStep();
  }

  function advanceToNextStep() {
    const next = state.step + 1;
    if (next >= STEPS.length) {
      finish();
      return;
    }
    showStep(next);
  }

  /** ---------------- Avance automático por eventos externos ---------------- */

  function advance(reason) {
    if (!state.active) return;
    // En modo preview el usuario navega manualmente con "Siguiente": ignoramos
    // los avances automáticos disparados por shortcuts ya existentes.
    if (state.preview) return;
    const step = STEPS[state.step];
    if (!step) return;
    if (step.autoAdvanceOn && step.autoAdvanceOn === reason) {
      goNext();
    }
  }

  /** ---------------- Inicio / fin ---------------- */

  function start(opts) {
    if (state.active) return;
    const o = opts || {};
    state.active = true;
    state.preview = !!o.preview;
    const skipWelcome = !!o.skipWelcome;

    if (!state.repositionListener) {
      const listener = () => scheduleReflow();
      window.addEventListener('resize', listener);
      window.addEventListener('scroll', listener, true);
      state.repositionListener = listener;
    }

    armSidebarStateListener();
    startModalObserver();
    showStep(skipWelcome ? 1 : 0);
    applyModalSuppression();
  }

  /**
   * Cualquier cambio de `sidebar-state` durante el paso 1 cuenta como prueba
   * del atajo (porque en `webHostMode: separate` y sin ventanas web abiertas
   * Ctrl+Alt+D toggleea el dock). Se arma una sola vez porque el wrapper de
   * `onSidebarState` solo agrega listeners (no los reemplaza), y queremos
   * evitar duplicados si el usuario re-abre el preview varias veces.
   */
  function armSidebarStateListener() {
    if (state.sidebarStateListenerArmed) return;
    if (!window.usualDesk || typeof window.usualDesk.onSidebarState !== 'function') return;
    window.usualDesk.onSidebarState(() => {
      if (!state.active) return;
      const step = STEPS[state.step];
      if (!step || step.id !== 'hotkey') return;
      if (state.hotkeyPressed) return;
      state.hotkeyPressed = true;
      // Si el usuario ya había intentado avanzar y le dijimos que probara,
      // quitamos el aviso al volver a verlo desplegado.
      if (state.hotkeyAttemptedNext) {
        state.hotkeyAttemptedNext = false;
        renderBubble(step);
      }
    });
    state.sidebarStateListenerArmed = true;
  }

  async function finish() {
    await persistCompleted();
    teardown();
  }

  async function skip() {
    // Si saltó antes de crear su primera ventana, devolvemos el dock a la
    // franja: nadie quiere quedarse mirando un panel negro a pantalla
    // completa cuando lo único que quería era cerrar el tutorial.
    // En modo preview NO colapsamos: el usuario abrió el panel desde
    // Configuración y querrá seguir interactuando con él.
    const skippedBeforeFirstShortcut =
      !state.preview && state.step >= 0 && state.step <= 2;
    await persistCompleted();
    teardown();
    if (skippedBeforeFirstShortcut) {
      collapseDockSidebarIfPossible();
    }
  }

  /** ---------------- Util ---------------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.UsualDeskOnboarding = {
    __initialized: true,
    start,
    advance,
    skip,
    isActive,
  };
})();

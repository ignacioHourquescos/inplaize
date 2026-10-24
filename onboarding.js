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
 *   2  Menú (≡) arriba a la derecha → «Añadir acceso». Avance automático
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
    /** Paso "personalize": apps seleccionadas por el usuario */
    selectedApps: new Set(),
  };

  const STEPS = [
    {
      id: 'welcome',
      kind: 'modal',
      title: '👋 Bienvenido a inplaize',
      body: 'Tu escritorio organizado. Gmail, WhatsApp, Drive… cada cosa en su lugar, sin caos de pestañas. Configurá todo en menos de un minuto.',
      primaryLabel: 'Empezar',
      secondaryLabel: 'Omitir',
    },
    {
      id: 'personalize',
      kind: 'modal',
      title: '¿Qué apps usás más?',
      body: 'Elegí las que querés tener siempre a mano. Las agregamos automáticamente.',
      primaryLabel: 'Continuar',
      secondaryLabel: 'Saltear',
      apps: [
        { id: 'gmail', name: 'Gmail', icon: '📧', url: 'https://mail.google.com' },
        { id: 'whatsapp', name: 'WhatsApp', icon: '💬', url: 'https://web.whatsapp.com' },
        { id: 'drive', name: 'Drive', icon: '📁', url: 'https://drive.google.com' },
        { id: 'calendar', name: 'Calendar', icon: '📅', url: 'https://calendar.google.com' },
        { id: 'linkedin', name: 'LinkedIn', icon: '💼', url: 'https://linkedin.com' },
        { id: 'chatgpt', name: 'ChatGPT', icon: '🤖', url: 'https://chat.openai.com' },
        { id: 'youtube', name: 'YouTube', icon: '▶️', url: 'https://youtube.com' },
        { id: 'notion', name: 'Notion', icon: '📝', url: 'https://notion.so' },
      ],
    },
    {
      id: 'hotkey',
      kind: 'modal',
      title: '⌨️ Tu atajo mágico',
      body: 'Presionalo para mostrar u ocultar inplaize desde cualquier parte. Probalo ahora para continuar.',
      keyboardKeys: ['Ctrl', 'Alt', 'D'],
      primaryLabel: 'Siguiente',
      secondaryLabel: 'Omitir',
    },
    {
      id: 'add-first',
      kind: 'spotlight',
      targetSelector: '#dock-home-menu-btn',
      placement: 'bottom',
      title: '➕ Agregá más ventanas',
      body: 'Toca el menú (≡) y elegí «Añadir acceso». Podés agregar cualquier página web o programa.',
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
      title: '🎯 Cerrá una ventana específica',
      body:
        'Click corto la abre. Si mantenés el click izquierdo apretado, aparece "× Cerrar" y podés cerrar solo esa ventana.',
      primaryLabel: 'Siguiente',
      secondaryLabel: null,
    },
    {
      id: 'import-sessions',
      kind: 'modal',
      title: '🔐 Traé tus sesiones de Chrome',
      body:
        'Copiá las sesiones ya iniciadas en Chrome (Gmail, LinkedIn…) para no volver a loguearte. WhatsApp siempre pide vincular con el QR.',
      primaryLabel: 'Terminar',
      secondaryLabel: 'Saltear',
    },
  ];

  function isActive() {
    return state.active;
  }

  /** ---------------- Paso "import-sessions" ---------------- */

  /** Estado propio del paso de importación de sesiones desde Chrome. */
  const importState = {
    loading: false,
    loaded: false,
    /** @type {{ platformSupported: boolean, chromeFound: boolean, chromeRunning: boolean } | null} */
    status: null,
    profiles: [],
    selectedProfile: 'Default',
    /** Accesos web del usuario (excluye apps). */
    webShortcuts: [],
    /** @type {Set<string>} ids seleccionados para importar */
    selectedIds: new Set(),
    busy: false,
    /** @type {{ importedByShortcut: Array<{ name: string, imported: number }> } | null} */
    result: null,
    error: '',
  };

  function resetImportState() {
    importState.loading = false;
    importState.loaded = false;
    importState.status = null;
    importState.profiles = [];
    importState.selectedProfile = 'Default';
    importState.webShortcuts = [];
    importState.selectedIds = new Set();
    importState.busy = false;
    importState.result = null;
    importState.error = '';
  }

  function isWhatsAppShortcut(s) {
    try {
      return new URL(String(s.url || '')).hostname === 'web.whatsapp.com';
    } catch {
      return false;
    }
  }

  async function initImportStepData() {
    if (importState.loaded || importState.loading) return;
    importState.loading = true;
    renderImportArea();
    const api = window.usualDesk || {};
    let status = null;
    let profiles = [];
    let shortcuts = [];
    try {
      status = typeof api.getChromeImportStatus === 'function'
        ? await api.getChromeImportStatus()
        : null;
    } catch {
      status = null;
    }
    try {
      profiles = typeof api.listChromeProfiles === 'function'
        ? await api.listChromeProfiles()
        : [];
    } catch {
      profiles = [];
    }
    try {
      shortcuts = typeof api.getShortcuts === 'function' ? await api.getShortcuts() : [];
    } catch {
      shortcuts = [];
    }
    importState.loading = false;
    importState.loaded = true;
    importState.status = status;

    // Plataformas sin soporte de importación: el paso no aporta nada, cerramos.
    if (!status || status.platformSupported === false) {
      finish();
      return;
    }

    importState.profiles =
      Array.isArray(profiles) && profiles.length
        ? profiles
        : [{ directory: 'Default', name: 'Default', userName: '' }];
    importState.selectedProfile = importState.profiles[0].directory;
    importState.webShortcuts = (Array.isArray(shortcuts) ? shortcuts : []).filter(
      (s) => s && s.type === 'web' && s.url
    );
    importState.selectedIds = new Set(
      importState.webShortcuts.filter((s) => !isWhatsAppShortcut(s)).map((s) => String(s.id))
    );
    renderImportArea();
  }

  function importErrorText(code) {
    switch (code) {
      case 'CHROME_RUNNING':
        return 'Chrome está abierto. Cerralo completamente y volvé a intentar.';
      case 'CHROME_NOT_FOUND':
        return 'No encontramos Chrome en este equipo.';
      case 'NO_IMPORTABLE_SHORTCUTS':
        return 'No hay ventanas compatibles para importar.';
      default:
        return 'No se pudo importar. Podés iniciar sesión manualmente en cada ventana.';
    }
  }

  async function runImport() {
    if (importState.busy) return;
    const ids = [...importState.selectedIds];
    if (ids.length === 0) return;
    importState.busy = true;
    importState.error = '';
    importState.result = null;
    renderImportArea();
    let res = null;
    try {
      res = await window.usualDesk.importChromeSessionsForShortcuts(
        importState.selectedProfile,
        ids
      );
    } catch {
      res = null;
    }
    importState.busy = false;
    if (res && res.ok) {
      importState.result = res;
    } else {
      importState.error = importErrorText(res && res.error);
    }
    renderImportArea();
  }

  function renderImportArea() {
    const area = document.getElementById('onboarding-import-area');
    if (!area) return;

    if (importState.loading || !importState.loaded) {
      area.innerHTML = '<p class="onboarding-import-hint">Comprobando Google Chrome…</p>';
      scheduleReflow();
      return;
    }

    const status = importState.status || {};
    if (!status.chromeFound) {
      area.innerHTML =
        '<p class="onboarding-import-hint">No detectamos Google Chrome en este equipo. '
        + 'Podés iniciar sesión manualmente en cada ventana.</p>';
      scheduleReflow();
      return;
    }

    if (importState.webShortcuts.length === 0) {
      area.innerHTML =
        '<p class="onboarding-import-hint">Todavía no tenés ventanas web para importar. '
        + 'Podés hacerlo más adelante desde Configuración.</p>';
      scheduleReflow();
      return;
    }

    if (importState.result) {
      const lines = (importState.result.importedByShortcut || [])
        .map((r) => {
          const okTxt = r.imported > 0
            ? `${r.imported} cookies importadas`
            : 'sin cookies para este sitio en Chrome';
          return `<li><strong>${escapeHtml(r.name)}</strong>: ${escapeHtml(okTxt)}</li>`;
        })
        .join('');
      area.innerHTML =
        '<p class="onboarding-import-hint">Listo. Al abrir cada ventana deberías entrar ya logueado:</p>'
        + `<ul class="onboarding-import-summary">${lines}</ul>`;
      scheduleReflow();
      return;
    }

    const profileOptions = importState.profiles
      .map((p) => {
        const label = p.userName ? `${p.name} (${p.userName})` : p.name;
        const sel = p.directory === importState.selectedProfile ? ' selected' : '';
        return `<option value="${escapeHtml(p.directory)}"${sel}>${escapeHtml(label)}</option>`;
      })
      .join('');
    const profileRow = importState.profiles.length > 1
      ? '<label class="onboarding-import-row">Perfil de Chrome: '
        + `<select id="onboarding-import-profile">${profileOptions}</select></label>`
      : '';

    const items = importState.webShortcuts
      .map((s) => {
        const id = String(s.id);
        const name = escapeHtml(s.name || s.url || 'Ventana');
        const wa = isWhatsAppShortcut(s);
        if (wa) {
          return `<li class="onboarding-import-item is-disabled">`
            + `<input type="checkbox" disabled /> ${name} `
            + '<span class="onboarding-import-note">requiere QR del teléfono</span></li>';
        }
        const checked = importState.selectedIds.has(id) ? ' checked' : '';
        return `<li class="onboarding-import-item">`
          + `<label><input type="checkbox" data-import-shortcut="${escapeHtml(id)}"${checked} /> ${name}</label></li>`;
      })
      .join('');

    const warning = status.chromeRunning
      ? '<div class="onboarding-bubble-warning" role="alert">Chrome está abierto ahora: '
        + 'cerralo por completo antes de importar.</div>'
      : '';
    const error = importState.error
      ? `<div class="onboarding-bubble-warning" role="alert">${escapeHtml(importState.error)}</div>`
      : '';
    const btnLabel = importState.busy ? 'Importando… (puede tardar unos segundos)' : 'Importar sesiones';
    const btnDisabled = importState.busy || importState.selectedIds.size === 0 ? ' disabled' : '';

    area.innerHTML =
      profileRow
      + `<ul class="onboarding-import-list">${items}</ul>`
      + warning
      + error
      + `<button type="button" id="onboarding-import-btn" class="onboarding-btn-primary onboarding-import-btn"${btnDisabled}>${escapeHtml(btnLabel)}</button>`;

    const profileSel = area.querySelector('#onboarding-import-profile');
    if (profileSel) {
      profileSel.addEventListener('change', () => {
        importState.selectedProfile = profileSel.value;
      });
    }
    area.querySelectorAll('[data-import-shortcut]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-import-shortcut');
        if (cb.checked) importState.selectedIds.add(id);
        else importState.selectedIds.delete(id);
        const btn = area.querySelector('#onboarding-import-btn');
        if (btn) btn.disabled = importState.busy || importState.selectedIds.size === 0;
      });
    });
    const importBtn = area.querySelector('#onboarding-import-btn');
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        runImport();
      });
    }
    scheduleReflow();
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
    const counterText = stepIndex >= 1 ? `Paso ${stepIndex} de ${stepCount}` : '';
    
    // Barra de progreso (no se muestra en welcome)
    const progressPercent = stepIndex === 0 ? 0 : Math.round((stepIndex / stepCount) * 100);
    const progressBar = stepIndex >= 1 
      ? `<div class="onboarding-progress-bar"><div class="onboarding-progress-fill" style="width: ${progressPercent}%"></div></div>`
      : '';

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
    
    // Grid de apps para personalización
    const appGrid = step.id === 'personalize' && Array.isArray(step.apps)
      ? renderAppGrid(step.apps)
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
        ${progressBar}
        ${counter}
        <h3 class="onboarding-bubble-title">${escapeHtml(step.title)}</h3>
      </header>
      ${body}
      ${appGrid}
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

    // Event listeners para el grid de apps (paso personalize)
    bubble.querySelectorAll('.onboarding-app-option').forEach((option) => {
      option.addEventListener('click', () => {
        const appId = option.getAttribute('data-app-id');
        if (state.selectedApps.has(appId)) {
          state.selectedApps.delete(appId);
          option.classList.remove('is-selected');
        } else {
          state.selectedApps.add(appId);
          option.classList.add('is-selected');
        }
        // Actualizar el helper text con el contador
        const step = STEPS[state.step];
        if (step && step.id === 'personalize' && Array.isArray(step.apps)) {
          const count = state.selectedApps.size;
          const helper = bubble.querySelector('.onboarding-app-helper');
          if (helper) {
            helper.textContent = count === 0 
              ? 'Tocá las apps que querés agregar'
              : `${count} ${count === 1 ? 'app seleccionada' : 'apps seleccionadas'}`;
          }
        }
      });
    });

    if (step.id === 'import-sessions') {
      const footer = bubble.querySelector('.onboarding-bubble-footer');
      const area = document.createElement('div');
      area.className = 'onboarding-import-area';
      area.id = 'onboarding-import-area';
      if (footer) bubble.insertBefore(area, footer);
      else bubble.appendChild(area);
      renderImportArea();
      initImportStepData();
    }
  }

  /**
   * Renderiza la grilla de apps para el paso de personalización.
   * @param {Array} apps
   */
  function renderAppGrid(apps) {
    const items = apps
      .map((app) => {
        const selected = state.selectedApps.has(app.id) ? 'is-selected' : '';
        return `
          <div class="onboarding-app-option ${selected}" data-app-id="${escapeHtml(app.id)}">
            <div class="onboarding-app-icon">${escapeHtml(app.icon)}</div>
            <div class="onboarding-app-name">${escapeHtml(app.name)}</div>
          </div>
        `;
      })
      .join('');
    const count = state.selectedApps.size;
    const helperText = count === 0 
      ? '<p class="onboarding-app-helper">Tocá las apps que querés agregar</p>'
      : `<p class="onboarding-app-helper">${count} ${count === 1 ? 'app seleccionada' : 'apps seleccionadas'}</p>`;
    return `<div class="onboarding-app-grid">${items}</div>${helperText}`;
  }

  /**
   * Dibuja un teclado decorativo con las teclas dadas. La última tecla se
   * resalta en azul porque es la "letra" del atajo y la que el usuario
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
      const fill = isAccent ? 'rgba(26, 115, 232, 0.12)' : 'rgba(32, 33, 36, 0.04)';
      const stroke = isAccent ? '#1a73e8' : 'rgba(32, 33, 36, 0.2)';
      const strokeW = isAccent ? 2 : 1.4;
      const textColor = isAccent ? '#1a73e8' : '#202124';
      parts.push(
        `<rect x="${cursor}" y="${padding}" width="${w}" height="${KEY_HEIGHT}" rx="9" ry="9" ` +
          `fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" />`,
      );
      // Pequeña sombra inferior para sensación de keycap
      parts.push(
        `<rect x="${cursor + 4}" y="${padding + KEY_HEIGHT - 6}" width="${w - 8}" height="3" rx="2" ` +
          `fill="rgba(32, 33, 36, 0.1)" />`,
      );
      parts.push(
        `<text x="${cursor + w / 2}" y="${padding + KEY_HEIGHT / 2 + 5}" text-anchor="middle" ` +
          `font-family="'IBM Plex Sans', Inter, system-ui, sans-serif" font-size="15" ` +
          `font-weight="${isAccent ? 600 : 500}" fill="${textColor}">${escapeHtml(label)}</text>`,
      );
      cursor += w;
      if (i < k.length - 1) {
        parts.push(
          `<text x="${cursor + PLUS_WIDTH / 2}" y="${padding + KEY_HEIGHT / 2 + 5}" text-anchor="middle" ` +
            `font-family="'IBM Plex Sans', Inter, system-ui, sans-serif" font-size="14" ` +
            `fill="rgba(95, 99, 104, 0.6)">+</text>`,
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
    
    // Si estamos en el paso "add-first" y ya hay shortcuts (p.ej. del paso de personalización),
    // saltamos directo al siguiente paso
    if (step.id === 'add-first' && !state.preview) {
      const api = window.usualDesk || {};
      if (typeof api.getShortcuts === 'function') {
        try {
          const shortcuts = api.getShortcuts();
          if (Array.isArray(shortcuts) && shortcuts.length > 0) {
            // Ya hay shortcuts, saltamos este paso
            showStep(stepIndex + 1);
            return;
          }
        } catch {
          // Si falla, continuamos normalmente
        }
      }
    }
    
    state.step = stepIndex;
    ensureLayer();
    document.documentElement.classList.add('onboarding-active');

    clearTargetMark();
    let hasSpotlight = false;
    if (step.id === 'add-first') {
      const homeBtn = document.getElementById('dock-home-btn');
      if (homeBtn) {
        try {
          homeBtn.click();
        } catch {
          /* noop */
        }
      }
    }
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

    // Paso "personalize": crear shortcuts para las apps seleccionadas
    if (step && step.id === 'personalize' && state.selectedApps.size > 0 && !state.preview) {
      // Mostrar mensaje de éxito antes de avanzar
      showSuccessMessage(state.selectedApps.size);
      createShortcutsForSelectedApps(step.apps);
      // Pequeño delay para que el usuario vea el mensaje de éxito
      setTimeout(() => {
        advanceToNextStep();
      }, 800);
      return;
    }

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
    // modal de añadir ventana (mismo gesto que «Añadir acceso directo» en inicio).
    // Cuando el usuario guarde, el auto-avance via `shortcuts-non-empty` pasará al
    // paso siguiente. En preview avanzamos directo sin tocar nada.
    if (step && step.primaryAction === 'open-add-shortcut' && !state.preview) {
      if (window.__dockHomeMenu && typeof window.__dockHomeMenu.open === 'function') {
        window.__dockHomeMenu.open();
      }
      const homeAddBtn = document.getElementById('dock-home-add-btn');
      if (homeAddBtn) {
        try {
          homeAddBtn.click();
        } catch {
          /* fallback: si por alguna razón no funciona, avanzamos */
          advanceToNextStep();
        }
        return;
      }
    }

    advanceToNextStep();
  }

  function showSuccessMessage(count) {
    const bubble = state.bubbleEl;
    if (!bubble) return;
    const footer = bubble.querySelector('.onboarding-bubble-footer');
    if (!footer) return;
    const existing = bubble.querySelector('.onboarding-success-message');
    if (existing) existing.remove();
    const msg = document.createElement('div');
    msg.className = 'onboarding-success-message';
    msg.textContent = `¡Listo! ${count} ${count === 1 ? 'app agregada' : 'apps agregadas'}.`;
    bubble.insertBefore(msg, footer);
  }

  async function createShortcutsForSelectedApps(apps) {
    if (!window.usualDesk || typeof window.usualDesk.addShortcut !== 'function') return;
    const selectedAppsList = apps.filter((app) => state.selectedApps.has(app.id));
    for (const app of selectedAppsList) {
      try {
        await window.usualDesk.addShortcut({
          type: 'web',
          name: app.name,
          url: app.url,
          icon: '',
        });
      } catch (error) {
        console.error(`Error creating shortcut for ${app.name}:`, error);
      }
    }
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
    state.selectedApps.clear();
    resetImportState();
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

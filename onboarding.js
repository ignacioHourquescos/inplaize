'use strict';

/**
 * Onboarding de primera vez para inplaize.
 *
 * Estructura: una capa visual (overlay oscuro) + un anillo pulsante sobre el
 * elemento "objetivo" + un bocadillo flotante con el copy y los botones.
 * El overlay es solo visual (`pointer-events: none`); el target queda
 * interactuable normalmente. El bocadillo captura sus propios clics.
 *
 * Todo el tour vive en un modal del 80% del ancho y del alto. El fondo
 * queda visible alrededor; no hay spotlight sobre la interfaz.
 *
 * Los cuatro primeros pasos comparten una computadora (el monitor), que se arma
 * una sola vez y pasa de un paso al otro. Arriba va el monitor y abajo lo
 * propio de cada paso.
 *
 * Pasos:
 *   0  Bienvenida: el monitor muestra el logo. Arriba va la pregunta y,
 *      debajo del monitor, la frase de navegación.
 *   1  Personalizar: abajo, las apps. Al marcarlas se suman a la barra del
 *      monitor y, al seguir, se crean los accesos.
 *   2  Atajo, parte 1: el teclado encima de la computadora y, abajo, las
 *      teclas del atajo con una barra que se llena al apretarlas. Las teclas
 *      tienen borde azul y, al apretarlas, un disco gris translúcido. A la
 *      tercera apretada se sostiene un instante y el teclado se pliega.
 *   3  Atajo, parte 2: queda la computadora; apretarlo un par de veces más
 *      muestra cómo inplaize aparece y desaparece en la pantalla.
 *      Las dos partes son pasos distintos con el mismo id ('hotkey') y
 *      cada una cuenta en el indicador (4 pasos en total).
 *   4  Importar sesiones de Chrome.
 *
 * Cerrar una ventana (click izquierdo mantenido) y Modo Foco (click
 * derecho, silencia el resto) no van en este tour. Salen después, en un
 * popup, cuando el usuario ya abrió y volvió a cerrar las ventanas 10 veces
 * con el atajo.
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
 *        haga falta desde Internal).
 *   advance(reason)         → pasa al siguiente paso si el `reason` coincide.
 *   skip()                  → marca completado y cierra todo.
 *   isActive()              → true mientras está mostrándose.
 *   showGestureCoach()      → popup de apagar / foco, fuera del tour.
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
    /** La computadora de los tres primeros pasos. Se arma una vez y pasa de un paso al otro. */
    monitorEl: null,
    monitorTimer: 0,
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
    /** Teclas del atajo guardado. Se prenden solo mientras están apretadas. */
    hotkeyLit: new Set(),
    hotkeyKeys: ['Ctrl', 'Alt', 'D'],
    /** Modificadores que siguen apretados. Sirve para prender la letra que se come el atajo global. */
    hotkeyModsDown: { Ctrl: false, Alt: false, Shift: false, Win: false },
    lastHotkeyModifierUpAt: 0,
    hotkeyCapturing: false,
    hotkeyCapture: [],
    hotkeyError: '',
    /** 'keys': teclado y las teclas del atajo. 'desk': el teclado se pliega y la computadora muestra cómo aparece y desaparece. */
    hotkeyStage: 'keys',
    /** Veces que apretó el atajo en la primera parte. A las 3 pasa a la segunda. */
    hotkeyPressCount: 0,
    /** Espera a que se vea el tercer dedo antes de plegar el teclado. */
    hotkeyCountTimer: 0,
    /** Veces que apretó el atajo en la segunda parte. */
    hotkeyDeskPresses: 0,
    /** En la pantalla, si inplaize está visible. */
    hotkeyDockShown: true,
    /** Mientras el teclado se pliega hacia la segunda parte. */
    hotkeyFlipping: false,
    sidebarStateListenerArmed: false,
    hotkeyKeyListenerArmed: false,
    /** Paso "personalize": apps seleccionadas por el usuario */
    selectedApps: new Set(),
  };

  const STEPS = [
    {
      id: 'welcome',
      kind: 'modal',
      // Arriba va la marca de inplaize; este texto va debajo de la computadora.
      title: 'Navegá tus ventanas de manera ordenada.',
      body: '',
      primaryLabel: 'Empezar',
    },
    {
      id: 'personalize',
      kind: 'modal',
      title: 'Armá tu espacio',
      stepperLabel: 'Setup inicial',
      body: 'Elegí al menos dos apps que usás.',
      bodyUnderline: 'al menos dos apps',
      primaryLabel: 'Siguiente',
      apps: [
        { id: 'gmail', name: 'Gmail', icon: 'assets/icons/gmail.png', url: 'https://mail.google.com' },
        { id: 'whatsapp', name: 'WhatsApp', icon: 'assets/icons/whatsapp.png', url: 'https://web.whatsapp.com' },
        { id: 'drive', name: 'Drive', icon: 'assets/icons/dirve.png', url: 'https://drive.google.com' },
        { id: 'calendar', name: 'Calendar', icon: 'assets/icons/calendar.png', url: 'https://calendar.google.com' },
        { id: 'linkedin', name: 'LinkedIn', icon: 'assets/icons/linkedin.png', url: 'https://linkedin.com' },
        { id: 'chatgpt', name: 'ChatGPT', icon: 'assets/icons/gpt.png', url: 'https://chat.openai.com' },
        { id: 'youtube', name: 'YouTube', icon: 'assets/icons/youtube.png', url: 'https://youtube.com' },
        { id: 'notion', name: 'Notion', icon: 'assets/icons/notion.png', url: 'https://notion.so' },
      ],
    },
    {
      id: 'hotkey',
      /** Parte 1: el teclado y las tres apretadas. Es el paso 3 del indicador. */
      hotkeyStage: 'keys',
      kind: 'modal',
      title: 'Aprendiendo tu atajo mágico',
      stepperLabel: 'Atajo mágico',
      body: 'Apretá el atajo tres veces.',
      keyboardKeys: ['Ctrl', 'Alt', 'D'],
      primaryLabel: 'Siguiente',
    },
    {
      id: 'hotkey',
      /** Parte 2: la computadora donde inplaize aparece y desaparece. Es el paso 4 del indicador. */
      hotkeyStage: 'desk',
      kind: 'modal',
      title: 'Tu atajo mágico en acción 🌠',
      stepperLabel: 'Probar el atajo',
      body: 'Apretando tu atajo mágico, todo siempre estará en orden.',
      primaryLabel: 'Siguiente',
    },
    {
      id: 'import-sessions',
      kind: 'modal',
      title: 'Traé tus sesiones',
      stepperLabel: 'Configuración de sesión',
      body:
        'Copiá las sesiones ya iniciadas en Chrome (Gmail, LinkedIn…) para no volver a loguearte. WhatsApp siempre pide vincular con el QR.',
      primaryLabel: 'Terminar',
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
      showFarewell();
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

  function hostOf(url) {
    try {
      return new URL(String(url || '')).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  /** Ícono de la ficha: el del acceso o, si no tiene, el de la app que coincide por dirección. */
  function sessionIconFor(shortcut) {
    if (shortcut && shortcut.icon) return String(shortcut.icon);
    const host = hostOf(shortcut && shortcut.url);
    if (!host) return '';
    const personalize = STEPS.find((x) => x.id === 'personalize');
    const apps = personalize && Array.isArray(personalize.apps) ? personalize.apps : [];
    const match = apps.find((app) => hostOf(app.url) === host);
    return match ? match.icon : '';
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
        + 'Podés hacerlo más adelante desde Internal.</p>';
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

    const cards = importState.webShortcuts
      .map((s) => {
        const id = String(s.id);
        const name = String(s.name || s.url || 'Ventana');
        const icon = sessionIconFor(s);
        const iconHtml = icon ? appIconMarkup(icon) : escapeHtml(name.charAt(0).toUpperCase());
        const head = `<div class="onboarding-app-icon">${iconHtml}</div><div class="onboarding-app-name">${escapeHtml(name)}</div>`;
        if (isWhatsAppShortcut(s)) {
          return '<div class="onboarding-app-option onboarding-session-card is-disabled" aria-disabled="true">'
            + head + '<div class="onboarding-session-note">requiere QR</div></div>';
        }
        const on = importState.selectedIds.has(id);
        return `<div class="onboarding-app-option onboarding-session-card${on ? ' is-selected' : ''}" role="checkbox"`
          + ` tabindex="0" aria-checked="${on ? 'true' : 'false'}" data-import-shortcut="${escapeHtml(id)}">${head}</div>`;
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
      + `<div class="onboarding-session-grid">${cards}</div>`
      + warning
      + error
      + `<button type="button" id="onboarding-import-btn" class="onboarding-btn-primary onboarding-import-btn"${btnDisabled}>${escapeHtml(btnLabel)}</button>`;

    const profileSel = area.querySelector('#onboarding-import-profile');
    if (profileSel) {
      profileSel.addEventListener('change', () => {
        importState.selectedProfile = profileSel.value;
      });
    }
    area.querySelectorAll('[data-import-shortcut]').forEach((card) => {
      const toggle = () => {
        const id = card.getAttribute('data-import-shortcut');
        const on = !importState.selectedIds.has(id);
        if (on) importState.selectedIds.add(id);
        else importState.selectedIds.delete(id);
        card.classList.toggle('is-selected', on);
        card.setAttribute('aria-checked', on ? 'true' : 'false');
        const btn = area.querySelector('#onboarding-import-btn');
        if (btn) btn.disabled = importState.busy || importState.selectedIds.size === 0;
      };
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggle();
        }
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
    try {
      if (window.usualDesk && typeof window.usualDesk.setOnboardingActive === 'function') {
        window.usualDesk.setOnboardingActive(false);
      }
    } catch {
      /* noop */
    }
    setHotkeyTrial(false);
    state.active = false;
    state.preview = false;
    state.step = -1;
    state.suppressedByModal = false;
    state.hotkeyPressed = false;
    state.hotkeyAttemptedNext = false;
    state.hotkeyLit.clear();
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
    if (state.monitorTimer) {
      clearTimeout(state.monitorTimer);
      state.monitorTimer = 0;
    }
    state.monitorEl = null;
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
   * El formulario "Añadir acceso directo" se renderiza en `#modal-overlay`.
   * Mientras esté visible, escondemos la capa para no tapar el formulario y
   * dejar que el usuario se concentre en cargar la URL.
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

  /** ---------------- Monitor: la computadora de los tres primeros pasos ---------------- */

  /** Pasos que muestran el monitor. Es el mismo en los tres: se arma una vez y se mueve de lugar. */
  const MONITOR_STEPS = ['welcome', 'personalize', 'hotkey'];
  /** Barra del paso del atajo si no se eligió ninguna app (por ejemplo, al abrir ese paso suelto). */
  const FALLBACK_BAR = ['gmail.png', 'whatsapp.png', 'dirve.png'].map((file) => `assets/icons/${file}`);
  /** La app que muestra la computadora en la bienvenida: una sesión de WhatsApp. */
  const WELCOME_APP_ICON = 'assets/icons/whatsapp.png';
  /** Lo que tarda en irse un ícono de la barra al desmarcarlo. */
  const MONITOR_ICON_OUT_MS = 220;

  const WINDOW_CONTROLS = '<span class="wc-controls" aria-hidden="true"><i></i><i></i><i></i></span>';

  /** Las ventanas del landing, todas juntas y desordenadas. Se van una por una (ver `.wc` en el CSS). */
  function monitorChaosMarkup() {
    const win = (name, icon, title, url, x, y, r, z) => (
      `<article class="wc wc-${name}" style="--x:${x};--y:${y};--r:${r};--z:${z}">` +
        '<div class="wc-bar"><div class="wc-tab">' +
          `<img src="assets/icons/${icon}" alt="" /><span>${escapeHtml(title)}</span>` +
        '</div>' + WINDOW_CONTROLS + '</div>' +
        `<div class="wc-url">${escapeHtml(url)}</div>` +
        '<div class="wc-lines"><i></i><i></i><i></i><i></i></div>' +
      '</article>'
    );
    return (
      '<div class="onb-chaos">' +
        win('yt', 'youtube.png', 'Para ver después', 'youtube.com/watch', '0%', '4%', '-7deg', 1) +
        win('wa', 'whatsapp.png', 'El grupo', 'web.whatsapp.com', '2%', '38%', '-3deg', 3) +
        win('google', 'google.png', 'Buscar', 'google.com', '10%', '20%', '-5deg', 3) +
        win('gpt', 'gpt.png', 'Resumime esto', 'chatgpt.com', '60%', '0%', '6deg', 2) +
        win('drive', 'dirve.png', 'El doc', 'docs.google.com', '59%', '32%', '5deg', 5) +
        win('mail', 'gmail.png', 'Reunión de mañana', 'mail.google.com', '28%', '16%', '2deg', 4) +
        win('cal', 'calendar.png', 'Agenda', 'calendar.google.com', '48%', '8%', '8deg', 3) +
        '<article class="wc wc-note" style="--x:24%;--y:48%;--r:-2deg;--z:8">' +
          '<div class="wc-bar"><div class="wc-tab"><span class="wc-dot"></span><span>Anotar</span></div>' +
          WINDOW_CONTROLS + '</div>' +
          '<div class="wc-url">inplaize — inicio</div>' +
          '<div class="wc-note-body">' +
            '<span class="wc-avatar"></span>' +
            '<div class="wc-lines"><i></i><i></i></div>' +
          '</div>' +
          '<div class="wc-note-actions"><span>Cerrar</span><span class="is-go">Listo</span></div>' +
        '</article>' +
        '<div class="wc-sticky" style="--x:84%;--y:30%;--r:8deg;--z:6"></div>' +
      '</div>'
    );
  }

  /** La ventana que queda por defecto bajo la barra. */
  function deskWindowInner() {
    return (
      '<div class="wc-bar is-native"><div class="wc-title"><span class="wc-dot"></span><span>Anotar</span></div>' +
      WINDOW_CONTROLS + '</div>' +
      '<div class="wc-lines"><i></i><i></i><i></i><i></i></div>'
    );
  }

  /** Lo que queda cuando inplaize ordena: la barra arriba y una sola ventana debajo. */
  function monitorDeskMarkup() {
    return (
      '<div class="onboarding-desk">' +
        '<div class="onboarding-desk-window">' + deskWindowInner() + '</div>' +
      '</div>'
    );
  }

  /** ---------------- Previews de las apps (dibujos de alto nivel, sin detalle) ---------------- */

  /** Líneas grises que hacen de texto. */
  function pvLines(widths) {
    return '<span class="pv-lines">' + widths.map((w) => `<i style="width:${w}%"></i>`).join('') + '</span>';
  }

  function pvCalendar() {
    const days = [];
    for (let d = 5; d <= 31; d++) days.push(d);
    days.push(1);
    const events = { 7: ['b'], 9: ['g'], 13: ['r'], 14: ['b', 'y'], 20: ['y'], 22: ['b'], 24: ['g'], 27: ['r'] };
    const cells = days.map((d, i) => {
      const inMonth = i < 27;
      const today = inMonth && d === 24 ? ' is-today' : '';
      const evs = inMonth ? (events[d] || []) : [];
      return `<div class="pv-cal-cell${today}"><b>${d}</b>${evs.map((c) => `<span class="pv-ev is-${c}"></span>`).join('')}</div>`;
    }).join('');
    const dow = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((l) => `<span>${l}</span>`).join('');
    return (
      '<div class="pv pv-cal">' +
        '<div class="pv-cal-side">' +
          '<span class="pv-cal-new"><em>+</em>Crear</span>' +
          '<span class="pv-cal-mini"></span>' +
          pvLines([80, 60, 70]) +
        '</div>' +
        '<div class="pv-cal-main">' +
          '<div class="pv-cal-head"><span class="pv-cal-today">Hoy</span><b>octubre 2026</b></div>' +
          `<div class="pv-cal-dow">${dow}</div>` +
          `<div class="pv-cal-grid">${cells}</div>` +
        '</div>' +
      '</div>'
    );
  }

  function pvWhatsapp() {
    const chat = (active) => `<div class="pv-wa-chat${active ? ' is-active' : ''}"><span class="pv-ava"></span>${pvLines([58, 86])}</div>`;
    const bub = (dir, w) => `<span class="pv-bub is-${dir}" style="width:${w}%"><i style="width:90%"></i><i style="width:60%"></i></span>`;
    return (
      '<div class="pv pv-wa">' +
        '<div class="pv-wa-list">' +
          '<div class="pv-wa-top"><span class="pv-ava"></span></div>' +
          '<span class="pv-wa-search"></span>' +
          chat(false) + chat(true) + chat(false) + chat(false) +
        '</div>' +
        '<div class="pv-wa-pane">' +
          '<div class="pv-wa-head"><span class="pv-ava"></span><b>El grupo</b></div>' +
          '<div class="pv-wa-msgs">' +
            bub('in', 54) + bub('out', 42) + bub('in', 34) + bub('out', 50) +
          '</div>' +
          '<div class="pv-wa-input"><span></span></div>' +
        '</div>' +
      '</div>'
    );
  }

  function pvGmail() {
    const row = (unread) => (
      `<div class="pv-mail-row${unread ? ' is-unread' : ''}"><span class="pv-box"></span><span class="pv-star"></span>` +
      '<i class="pv-from"></i>' + pvLines([88, 52]) + '<i class="pv-time"></i></div>'
    );
    return (
      '<div class="pv pv-mail">' +
        '<div class="pv-mail-side">' +
          '<span class="pv-mail-new">Redactar</span>' +
          pvLines([86, 64, 72, 50]) +
        '</div>' +
        '<div class="pv-mail-main">' +
          '<span class="pv-mail-search"></span>' +
          row(true) + row(true) + row(false) + row(false) + row(false) +
        '</div>' +
      '</div>'
    );
  }

  function pvDrive() {
    const folder = '<span class="pv-folder"><i></i></span>';
    const file = (c) => `<span class="pv-file is-${c}"><i></i><i></i><i></i></span>`;
    return (
      '<div class="pv pv-drive">' +
        '<div class="pv-drive-side">' +
          '<span class="pv-drive-new"><em>+</em>Nuevo</span>' +
          pvLines([80, 62, 74, 56]) +
        '</div>' +
        '<div class="pv-drive-main">' +
          '<b class="pv-drive-title">Mi unidad</b>' +
          `<div class="pv-drive-row">${folder}${folder}${folder}${folder}</div>` +
          `<div class="pv-drive-row">${file('b')}${file('g')}${file('y')}${file('b')}</div>` +
        '</div>' +
      '</div>'
    );
  }

  function pvLinkedin() {
    const post = '<div class="pv-li-post"><div class="pv-li-who"><span class="pv-ava"></span>' + pvLines([46, 28]) + '</div>' + pvLines([94, 78]) + '<span class="pv-li-img"></span></div>';
    return (
      '<div class="pv pv-li">' +
        '<div class="pv-li-nav"><span class="pv-li-logo">in</span><span class="pv-li-search"></span></div>' +
        '<div class="pv-li-body">' +
          '<div class="pv-li-card"><span class="pv-li-banner"></span><span class="pv-ava is-big"></span>' + pvLines([70, 48]) + '</div>' +
          '<div class="pv-li-feed">' + post + '</div>' +
          '<div class="pv-li-card is-side">' + pvLines([80, 60, 70, 52]) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function pvChatgpt() {
    return (
      '<div class="pv pv-gpt">' +
        '<div class="pv-gpt-side">' + pvLines([80, 60, 70, 52, 66]) + '</div>' +
        '<div class="pv-gpt-main">' +
          '<span class="pv-gpt-user"><i style="width:80%"></i></span>' +
          '<div class="pv-gpt-ans"><span class="pv-gpt-dot"></span>' + pvLines([96, 88, 92, 60]) + '</div>' +
          '<span class="pv-gpt-input"><i></i></span>' +
        '</div>' +
      '</div>'
    );
  }

  function pvYoutube() {
    const item = '<div class="pv-yt-item"><span class="pv-yt-thumb"></span>' + pvLines([90, 58]) + '</div>';
    return (
      '<div class="pv pv-yt">' +
        '<div class="pv-yt-nav"><span class="pv-yt-logo"></span><span class="pv-yt-search"></span></div>' +
        '<div class="pv-yt-body">' +
          '<div class="pv-yt-main"><span class="pv-yt-player"><em></em><span class="pv-yt-bar"><i></i></span></span>' + pvLines([70, 40]) + '</div>' +
          '<div class="pv-yt-list">' + item + item + item + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function pvNotion() {
    const todo = (done) => `<div class="pv-nt-todo${done ? ' is-done' : ''}"><span class="pv-nt-check"></span>${pvLines([done ? 44 : 62])}</div>`;
    return (
      '<div class="pv pv-nt">' +
        '<div class="pv-nt-side">' + pvLines([76, 58, 68, 50, 62]) + '</div>' +
        '<div class="pv-nt-main">' +
          '<span class="pv-nt-title"></span>' +
          pvLines([92, 74]) +
          todo(true) + todo(false) + todo(false) +
        '</div>' +
      '</div>'
    );
  }

  function pvGoogle() {
    const letters = [['G', 'b'], ['o', 'r'], ['o', 'y'], ['g', 'b'], ['l', 'g'], ['e', 'r']]
      .map(([l, c]) => `<span class="is-${c}">${l}</span>`).join('');
    return (
      '<div class="pv pv-g">' +
        `<div class="pv-g-logo">${letters}</div>` +
        '<span class="pv-g-search"><i></i></span>' +
        '<div class="pv-g-btns"><span></span><span></span></div>' +
      '</div>'
    );
  }

  /** Por archivo del ícono: cómo se llama la ventana, su dirección y el dibujo de adentro. */
  const APP_PREVIEWS = {
    calendar: { name: 'Calendar', url: 'calendar.google.com', build: pvCalendar },
    whatsapp: { name: 'WhatsApp', url: 'web.whatsapp.com', build: pvWhatsapp },
    gmail: { name: 'Gmail', url: 'mail.google.com', build: pvGmail },
    dirve: { name: 'Drive', url: 'drive.google.com', build: pvDrive },
    linkedin: { name: 'LinkedIn', url: 'linkedin.com', build: pvLinkedin },
    gpt: { name: 'ChatGPT', url: 'chatgpt.com', build: pvChatgpt },
    youtube: { name: 'YouTube', url: 'youtube.com', build: pvYoutube },
    notion: { name: 'Notion', url: 'notion.so', build: pvNotion },
    google: { name: 'Google', url: 'google.com', build: pvGoogle },
  };

  function previewKeyForIcon(icon) {
    return String(icon || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  }

  /** La ventana de la app: pestaña con su ícono, dirección y el dibujo. */
  function appWindowInner(icon) {
    const def = APP_PREVIEWS[previewKeyForIcon(icon)];
    const name = def ? def.name : 'Ventana';
    const body = def ? def.build() : '<div class="wc-lines"><i></i><i></i><i></i><i></i></div>';
    // Se ve como una app nativa: barra de título con ícono y nombre, sin pestañas ni dirección.
    return (
      '<div class="wc-bar is-native"><div class="wc-title">' +
        `<img src="${escapeHtml(icon)}" alt="" /><span>${escapeHtml(name)}</span>` +
      '</div>' + WINDOW_CONTROLS + '</div>' +
      body
    );
  }

  /** Al tocar un ícono de la barra, la ventana de abajo pasa a ser esa app. */
  function setDeskPreview(mon, icon) {
    const win = mon && mon.querySelector('.onboarding-desk-window');
    if (!win) return;
    win.innerHTML = appWindowInner(icon);
    mon.classList.add('is-previewed');
    mon.querySelectorAll('.onboarding-dockbar-icons img').forEach((img) => {
      img.classList.toggle('is-active', img.getAttribute('data-icon') === icon);
    });
  }

  function resetDeskPreview(mon) {
    if (!mon || !mon.classList.contains('is-previewed')) return;
    const win = mon.querySelector('.onboarding-desk-window');
    if (win) win.innerHTML = deskWindowInner();
    mon.classList.remove('is-previewed');
    mon.querySelectorAll('.onboarding-dockbar-icons img.is-active').forEach((img) => img.classList.remove('is-active'));
  }

  /** El cursor propio: la flecha violeta que reemplaza al del sistema sobre la pantalla. */
  function monitorCursorMarkup() {
    return (
      '<div class="onb-cursor is-home" aria-hidden="true">' +
        '<span class="onb-cursor-ripple"></span>' +
        '<svg class="onb-cursor-art" viewBox="4.2 2 15.8 19.6" aria-hidden="true">' +
          '<path d="M5.5 3.2l13.2 9.4-6 1.1 2.4 6.1-2.3.9-2.4-6.2-5 4.2z" fill="#7c6cff" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>' +
        '</svg>' +
      '</div>'
    );
  }

  /**
   * Cursor propio y clics sobre la barra del monitor. Solo vale en la segunda
   * parte del atajo (`.is-interactive`) y mientras inplaize está a la vista.
   */
  function bindMonitorPointer(mon) {
    const screen = mon.querySelector('.onboarding-monitor-screen');
    const cursor = mon.querySelector('.onb-cursor');
    if (!screen || !cursor) return;
    const iconOf = (target) => (
      target && target.closest ? target.closest('.onboarding-dockbar-icons img:not(.is-out)') : null
    );
    const live = () => mon.classList.contains('is-interactive') && !mon.classList.contains('is-dock-hidden');
    const place = (x, y) => {
      cursor.style.left = x + '%';
      cursor.style.top = y + '%';
    };
    const goHome = () => {
      cursor.classList.add('is-home');
      cursor.classList.remove('is-over', 'is-down', 'is-arrive');
      place(50, 50);
    };

    screen.addEventListener('mousemove', (e) => {
      if (!mon.classList.contains('is-interactive')) return;
      const r = screen.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
      const y = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
      cursor.classList.remove('is-home');
      place(x, y);
      cursor.classList.toggle('is-over', live() && !!iconOf(e.target));
    });
    screen.addEventListener('mouseleave', goHome);
    screen.addEventListener('mousedown', () => {
      if (live()) cursor.classList.add('is-down');
    });
    window.addEventListener('mouseup', () => cursor.classList.remove('is-down'));
    screen.addEventListener('click', (e) => {
      if (!live()) return;
      const img = iconOf(e.target);
      if (!img) return;
      cursor.classList.remove('is-click');
      void cursor.offsetWidth;
      cursor.classList.add('is-click');
      setDeskPreview(mon, img.getAttribute('data-icon'));
    });
    cursor.addEventListener('animationend', (e) => {
      if (e.target.classList && e.target.classList.contains('onb-cursor-ripple')) cursor.classList.remove('is-click');
    });
    // Al entrar a la segunda parte, la flecha llega desde un costado al centro y se agranda un poco.
    const arrive = () => {
      cursor.classList.remove('is-home', 'is-arrive', 'is-over', 'is-down');
      place(78, 76);
      void cursor.offsetWidth;
      cursor.classList.add('is-home', 'is-arrive');
      place(50, 50);
    };
    // Al salir de la segunda parte, el cursor vuelve al centro.
    mon.__onbCursorHome = goHome;
    mon.__onbCursorArrive = arrive;
  }

  function monitorMarkup(withChaos) {
    return (
      '<div class="onboarding-monitor-bezel">' +
        '<div class="onboarding-monitor-screen">' +
          renderWindowsDesktop() +
          (withChaos ? monitorChaosMarkup() : '') +
          monitorDeskMarkup() +
          '<div class="onboarding-dockbar">' +
            '<span class="onboarding-dockbar-logo"></span>' +
            '<span class="onboarding-dockbar-icons"></span>' +
            '<span class="onb-dock-hint" aria-hidden="true"><span>Tocá un ícono de la barra</span></span>' +
            '<span class="onboarding-dockbar-slot"></span>' +
            '<span class="onboarding-dockbar-plus">+</span>' +
          '</div>' +
          renderWindowsTaskbar() +
          monitorCursorMarkup() +
        '</div>' +
      '</div>' +
      '<div class="onboarding-monitor-stand"></div>' +
      '<div class="onboarding-monitor-base"></div>'
    );
  }

  /**
   * El monitor se crea una sola vez por tour. En todos los pasos la pantalla
   * muestra el escritorio ya ordenado por inplaize.
   */
  function ensureMonitor() {
    if (state.monitorEl) return state.monitorEl;
    const el = document.createElement('div');
    el.className = 'onboarding-monitor is-ordered';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = monitorMarkup(false);
    bindMonitorPointer(el);
    state.monitorEl = el;
    return el;
  }

  /** Las ventanas ya se fueron (o el usuario siguió antes): inplaize deja todo en su lugar. */
  function settleMonitor() {
    if (state.monitorTimer) {
      clearTimeout(state.monitorTimer);
      state.monitorTimer = 0;
    }
    const el = state.monitorEl;
    if (!el || !el.classList.contains('is-chaos')) return;
    el.classList.remove('is-chaos');
    el.classList.add('is-ordered');
    const chaos = el.querySelector('.onb-chaos');
    if (chaos) chaos.remove();
  }

  function chosenAppIcons() {
    const personalize = STEPS.find((s) => s.id === 'personalize');
    const apps = personalize && Array.isArray(personalize.apps) ? personalize.apps : [];
    return apps.filter((app) => state.selectedApps.has(app.id)).map((app) => app.icon);
  }

  /** Todas las apps que se pueden elegir; es la barra con la que arranca la bienvenida. */
  function allAppIcons() {
    const personalize = STEPS.find((s) => s.id === 'personalize');
    const apps = personalize && Array.isArray(personalize.apps) ? personalize.apps : [];
    return apps.length ? apps.map((app) => app.icon) : FALLBACK_BAR.slice();
  }

  /** Íconos que lleva la barra del monitor en el paso actual. */
  function desiredBarIcons(step) {
    const id = step ? step.id : '';
    const chosen = chosenAppIcons();
    // En la bienvenida la computadora ya se ve funcionando: la barra arranca con todas las apps y una sola ventana.
    if (id === 'welcome') return allAppIcons();
    if (id === 'hotkey' && chosen.length === 0) return FALLBACK_BAR.slice();
    return chosen;
  }

  /**
   * Deja la barra del monitor con los íconos del paso. Los que ya estaban no se
   * tocan, los nuevos entran con una animación y los que sobran se van.
   */
  function syncMonitorBar(animate) {
    const mon = state.monitorEl;
    if (!mon) return;
    const bar = mon.querySelector('.onboarding-dockbar');
    const holder = mon.querySelector('.onboarding-dockbar-icons');
    if (!bar || !holder) return;
    const want = desiredBarIcons(STEPS[state.step]);

    Array.from(holder.children).forEach((img) => {
      if (img.classList.contains('is-out')) return;
      if (want.includes(img.getAttribute('data-icon'))) return;
      if (!animate) {
        img.remove();
        return;
      }
      img.classList.add('is-out');
      setTimeout(() => img.remove(), MONITOR_ICON_OUT_MS);
    });

    let previous = null;
    want.forEach((icon) => {
      let img = Array.from(holder.children).find(
        (c) => c.getAttribute('data-icon') === icon && !c.classList.contains('is-out'),
      );
      if (!img) {
        img = document.createElement('img');
        img.src = icon;
        img.alt = '';
        img.setAttribute('data-icon', icon);
        if (animate) {
          img.classList.add('is-new');
          img.addEventListener('animationend', () => img.classList.remove('is-new'), { once: true });
        }
      }
      const slot = previous ? previous.nextElementSibling : holder.firstElementChild;
      if (slot !== img) holder.insertBefore(img, slot);
      previous = img;
    });

    bar.classList.toggle('is-empty', want.length === 0);
  }

  /** Saca el monitor del bocadillo antes de volver a armarlo, para no perderlo. */
  function detachMonitor() {
    const el = state.monitorEl;
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /** Pone el monitor en el hueco del paso. Es el mismo elemento en los tres pasos. */
  function mountMonitor(step, bubble) {
    const slot = bubble.querySelector('.onb-monitor-slot');
    if (!slot) return;
    const el = ensureMonitor();
    if (step.id !== 'welcome') settleMonitor();
    slot.appendChild(el);
    el.classList.toggle('is-dock-hidden', step.id === 'hotkey' && !state.hotkeyDockShown);
    // Segunda parte del atajo: el cursor propio y los íconos de la barra se pueden tocar.
    const interactive = step.id === 'hotkey' && state.hotkeyStage === 'desk' && !state.hotkeyCapturing;
    const wasInteractive = el.classList.contains('is-interactive');
    el.classList.toggle('is-interactive', interactive);
    if (!interactive) {
      // En la bienvenida la ventana ya muestra una sesión de WhatsApp (se arma abajo, con la barra lista).
      if (step.id !== 'welcome') resetDeskPreview(el);
      if (typeof el.__onbCursorHome === 'function') el.__onbCursorHome();
    } else if (!wasInteractive && typeof el.__onbCursorArrive === 'function') {
      el.__onbCursorArrive();
    }
    // Sin esto, los íconos que se van no tienen estilo previo y desaparecen de golpe.
    void el.offsetWidth;
    syncMonitorBar(true);
    if (step.id === 'welcome') setDeskPreview(el, WELCOME_APP_ICON);
  }

  /** Monitor arriba y, abajo, lo propio de cada paso. */
  function renderStage(step) {
    let below = '';
    let overlay = '';
    if (step.id === 'welcome' && step.title) {
      below = `<p class="onboarding-welcome-line">${escapeHtml(step.title)}</p>`;
    } else if (step.id === 'personalize' && Array.isArray(step.apps)) below = renderAppGrid(step.apps);
    else if (step.id === 'hotkey') {
      below = renderKeyboard(hotkeySlots());
      overlay = renderKeyboardOverlay();
    }
    const modeClass = step.id === 'hotkey'
      ? ' is-' + (state.hotkeyCapturing ? 'capturing' : state.hotkeyStage)
      : '';
    return (
      // La zona de abajo se reserva siempre (aunque esté vacía) para que la computadora
      // tenga el mismo tamaño y lugar en todos los pasos.
      `<div class="onb-stage has-below${modeClass}" data-stage="${escapeHtml(step.id)}">` +
        `<div class="onb-monitor-slot">${overlay}</div>` +
        `<div class="onb-below">${below}</div>` +
      '</div>'
    );
  }

  function renderBubble(step) {
    const bubble = ensureBubble();
    bubble.dataset.stepId = step.id;
    bubble.dataset.kind = step.kind;
    const stepIndex = STEPS.indexOf(step);
    const stepperSteps = STEPS.filter((s) => s.stepperLabel);
    const stepperIndex = stepperSteps.indexOf(step);
    const stepper = stepperIndex >= 0
      ? `<ol class="onboarding-stepper" aria-label="Paso ${stepperIndex + 1} de ${stepperSteps.length}">${
          stepperSteps.map((s, i) => {
            const n = i + 1;
            const stateClass = i < stepperIndex ? ' is-done' : i === stepperIndex ? ' is-current' : '';
            const label = s.stepperLabel;
            const current = i === stepperIndex ? ' aria-current="step"' : '';
            return (
              `<li class="onboarding-step${stateClass}" aria-label="${escapeHtml(label)}"${current}>` +
                `<span class="onboarding-step-mark">${n}</span>` +
              '</li>'
            );
          }).join('')
        }</ol>`
      : '';

    // En modo preview los pasos auto-avanzados (p. ej. "Agregá tu primera
    // ventana") deben tener un botón "Siguiente" porque el usuario ya tiene
    // shortcuts y no vamos a forzarlo a crear uno nuevo solo para ver el tour.
    const isLast = stepIndex === STEPS.length - 1;
    const primaryLabel = step.primaryLabel
      ? step.primaryLabel
      : (state.preview ? (isLast ? 'Terminar' : 'Siguiente') : null);

    const primaryDisabled = step.id === 'personalize' && state.selectedApps.size === 0 ? ' disabled' : '';
    const primary = primaryLabel
      ? `<button type="button" class="onboarding-btn-primary" data-onboarding-action="next"${primaryDisabled}>${escapeHtml(primaryLabel)}</button>`
      : '';
    const back = stepIndex > 0
      ? `<button type="button" class="onboarding-btn-secondary" data-onboarding-action="back">Atrás</button>`
      : '';
    const bodyCopy = step.id === 'hotkey' ? hotkeyBody() : step.body;
    let bodyHtml = bodyCopy ? escapeHtml(bodyCopy) : '';
    if (bodyHtml && step.bodyUnderline) {
      const target = escapeHtml(step.bodyUnderline);
      bodyHtml = bodyHtml.replace(target, `<u>${target}</u>`);
    }
    const body = bodyHtml
      ? `<p class="onboarding-bubble-body">${bodyHtml}</p>`
      : '';
    const counter = step.id === 'hotkey' && showHotkeyCounter() ? renderHotkeyCounter() : '';
    // Bienvenida, personalizar y atajo comparten la computadora de arriba.
    const hasMonitor = MONITOR_STEPS.includes(step.id);
    const stage = hasMonitor
      ? renderStage(step)
      : (step.id === 'import-sessions'
        ? '<div class="onb-stage onb-import"><div id="onboarding-import-area" class="onboarding-import-area"></div></div>'
        : '');
    const showHotkeyWarning =
      step.id === 'hotkey' && state.hotkeyAttemptedNext && !hotkeyReadyToAdvance();
    const warning = showHotkeyWarning
      ? `<p class="onboarding-hotkey-gate" role="alert">${escapeHtml(hotkeyGateCopy())}</p>`
      : '';

    const closeButton = step.kind === 'modal'
      ? '<button type="button" class="onboarding-close" data-onboarding-action="skip" aria-label="Cerrar">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
            '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
          '</svg>' +
        '</button>'
      : '';

    const title = step.id === 'hotkey' ? hotkeyTitle() : step.title;
    // En la bienvenida el encabezado es la marca (ícono + nombre); el texto va debajo de la computadora.
    const headerTitle = step.id === 'welcome'
      ? (
        '<div class="onboarding-welcome-brand" role="img" aria-label="inplaize">' +
          '<span class="onboarding-welcome-mark" aria-hidden="true"></span>' +
          '<span class="onboarding-welcome-name" aria-hidden="true">inplaize</span>' +
        '</div>'
      )
      : (title ? `<h3 class="onboarding-bubble-title">${escapeHtml(title)}</h3>` : '');
    const pane = `
      ${closeButton}
      <header class="onboarding-bubble-header">
        ${stepper}
        ${headerTitle}
        ${body}
        ${counter}
      </header>
      <div class="onboarding-bubble-main">
        ${stage}
      </div>
      <footer class="onboarding-bubble-footer">
        ${warning}
        <div class="onboarding-bubble-actions">
          ${back}
          ${primary}
        </div>
      </footer>
    `;
    bubble.classList.toggle('has-stepper', Boolean(stepper));
    // El monitor no se vuelve a crear: se saca antes de pisar el contenido y se pone de nuevo.
    detachMonitor();
    bubble.innerHTML = pane;
    if (hasMonitor) mountMonitor(step, bubble);

    bubble.querySelectorAll('[data-onboarding-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const action = btn.getAttribute('data-onboarding-action');
        if (action === 'next') goNext();
        else if (action === 'back') goBack();
        else if (action === 'skip') skip();
        else if (action === 'change-hotkey') beginHotkeyCapture();
        else if (action === 'cancel-hotkey') cancelHotkeyCapture();
        else if (action === 'show-desk') showHotkeyDesk();
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
        const step = STEPS[state.step];
        if (step && step.id === 'personalize' && Array.isArray(step.apps)) {
          const count = state.selectedApps.size;
          syncMonitorBar(true);
          // La ventana de la computadora muestra la vista de la última app elegida (o vuelve al inicio si no queda ninguna).
          const monitor = state.monitorEl;
          if (monitor) {
            const lastId = Array.from(state.selectedApps).pop();
            const lastApp = step.apps.find((app) => app.id === lastId);
            if (lastApp) setDeskPreview(monitor, lastApp.icon);
            else resetDeskPreview(monitor);
          }
          const next = bubble.querySelector('.onboarding-btn-primary[data-onboarding-action="next"]');
          if (next) next.disabled = count === 0;
        }
      });
    });

    if (step.id === 'import-sessions') {
      renderImportArea();
      initImportStepData();
    }
  }

  /**
   * Demo en loop del long-press izquierdo: el cursor aprieta un acceso y
   * aparece la píldora «× Cerrar», igual que en la franja.
   * La usa el popup tardío de gestos, no el tour.
   */
  function renderCloseGesture() {
    return (
      '<div class="onboarding-gesture-demo" aria-hidden="true">' +
        '<div class="onboarding-gesture-stage">' +
          '<div class="onboarding-gesture-icon">' +
            '<span class="onboarding-gesture-glyph"></span>' +
          '</div>' +
          '<div class="onboarding-gesture-pill">' +
            '<span class="onboarding-gesture-pill-x">×</span>' +
            '<span>Cerrar</span>' +
          '</div>' +
          '<div class="onboarding-gesture-cursor">' +
            '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">' +
              '<path d="M5.5 3.2l13.2 9.4-6 1.1 2.4 6.1-2.3.9-2.4-6.2-5 4.2z" fill="#202124" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>' +
            '</svg>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /**
   * Demo del click derecho: el icono queda en foco (marco violeta) y el
   * de al lado se silencia.
   */
  function renderFocusGesture() {
    return (
      '<div class="onboarding-gesture-demo" aria-hidden="true">' +
        '<div class="onboarding-gesture-stage">' +
          '<div class="gesture-coach-neighbor">' +
            '<span class="onboarding-gesture-glyph"></span>' +
          '</div>' +
          '<span class="gesture-coach-mute" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" width="14" height="14">' +
              '<path fill="currentColor" d="M4 9h3.2L11 5.6v12.8L7.2 15H4z"/>' +
              '<path stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M15.5 9.2l4.2 5.2M19.7 9.2l-4.2 5.2"/>' +
            '</svg>' +
          '</span>' +
          '<div class="gesture-coach-focus-icon">' +
            '<span class="onboarding-gesture-glyph"></span>' +
          '</div>' +
          '<div class="onboarding-gesture-pill gesture-coach-focus-pill">' +
            '<span>Foco</span>' +
          '</div>' +
          '<div class="onboarding-gesture-cursor gesture-coach-focus-cursor">' +
            '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">' +
              '<path d="M5.5 3.2l13.2 9.4-6 1.1 2.4 6.1-2.3.9-2.4-6.2-5 4.2z" fill="#202124" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>' +
            '</svg>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /** Popup fuera del tour: apagar una ventana, o silenciar el resto y dejarla en foco. */
  let coachEl = null;
  let coachKeyHandler = null;

  function dismissGestureCoach(defer) {
    document.documentElement.classList.remove('gesture-coach-open');
    if (coachKeyHandler) {
      window.removeEventListener('keydown', coachKeyHandler, true);
      coachKeyHandler = null;
    }
    if (coachEl) {
      try {
        coachEl.remove();
      } catch {
        /* noop */
      }
      coachEl = null;
    }
    const resume = () => {
      if (typeof window.__dockSchedulePointerPassthrough === 'function') {
        window.__dockSchedulePointerPassthrough();
      }
    };
    const api = window.usualDesk;
    if (!api || typeof api.closeGestureCoach !== 'function') {
      resume();
      return;
    }
    api.closeGestureCoach(defer ? { defer: true } : {})
      .catch(() => {})
      .then(resume);
  }

  function showGestureCoach() {
    if (isActive()) {
      dismissGestureCoach(true);
      return;
    }
    if (coachEl && coachEl.isConnected) return;

    const root = document.createElement('div');
    root.id = 'gesture-coach';
    root.className = 'gesture-coach';
    root.setAttribute('data-mouse-hit', '');
    root.innerHTML =
      '<div class="gesture-coach-dim"></div>' +
      '<section class="gesture-coach-card" role="dialog" aria-modal="true" aria-labelledby="gesture-coach-title">' +
        '<h3 id="gesture-coach-title" class="gesture-coach-title">Dos gestos para cada ventana</h3>' +
        '<p class="gesture-coach-lead">Ya venís abriendo y cerrando con el atajo. Sobre el icono de cada app podés apagarla, o dejarla en foco y silenciar el resto.</p>' +
        '<div class="gesture-coach-grid">' +
          '<article class="gesture-coach-col">' +
            '<p class="gesture-coach-kicker">Apagar</p>' +
            renderCloseGesture() +
            '<p class="gesture-coach-caption">Mantené el click izquierdo. Aparece «× Cerrar» y se apaga solo esa ventana.</p>' +
          '</article>' +
          '<article class="gesture-coach-col">' +
            '<p class="gesture-coach-kicker is-focus">Foco</p>' +
            renderFocusGesture() +
            '<p class="gesture-coach-caption">Click derecho: esa ventana queda en foco y el resto se silencia.</p>' +
          '</article>' +
        '</div>' +
        '<footer class="gesture-coach-footer">' +
          '<button type="button" class="onboarding-btn-primary" data-gesture-coach-dismiss>Entendido</button>' +
        '</footer>' +
      '</section>';

    const dismissBtn = root.querySelector('[data-gesture-coach-dismiss]');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => dismissGestureCoach(false));
    }
    coachKeyHandler = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      dismissGestureCoach(false);
    };
    window.addEventListener('keydown', coachKeyHandler, true);

    document.documentElement.classList.add('gesture-coach-open');
    document.body.appendChild(root);
    coachEl = root;
    if (window.usualDesk && typeof window.usualDesk.setIgnoreMouse === 'function') {
      window.usualDesk.setIgnoreMouse(false);
    }
    if (dismissBtn && typeof dismissBtn.focus === 'function') dismissBtn.focus();
  }

  /** Ruta bajo assets/icons/… o emoji viejo. */
  function appIconMarkup(icon) {
    const value = String(icon || '');
    if (value.includes('/') || /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(value)) {
      return `<img src="${escapeHtml(value)}" alt="" />`;
    }
    return escapeHtml(value);
  }

  /**
   * Fichas de las apps del paso de personalización. La barra donde se van
   * sumando está en el monitor de arriba.
   * @param {Array} apps
   */
  function renderAppGrid(apps) {
    const items = apps
      .map((app) => {
        const selected = state.selectedApps.has(app.id) ? 'is-selected' : '';
        return `
          <div class="onboarding-app-option ${selected}" data-app-id="${escapeHtml(app.id)}">
            <div class="onboarding-app-icon">${appIconMarkup(app.icon)}</div>
            <div class="onboarding-app-name">${escapeHtml(app.name)}</div>
          </div>
        `;
      })
      .join('');
    return `<div class="onboarding-app-grid">${items}</div>`;
  }

  /** Apretadas del atajo en la primera parte, antes de ver cómo aparece y desaparece inplaize. */
  const HOTKEY_KEYS_TRIES = 3;
  /** Apretadas en la segunda parte, para ver aparecer y desaparecer inplaize en la pantalla. */
  const HOTKEY_DESK_TRIES = 2;

  function hotkeyReadyToAdvance() {
    if (state.hotkeyStage === 'desk') return state.hotkeyDeskPresses >= HOTKEY_DESK_TRIES;
    return state.hotkeyPressCount >= HOTKEY_KEYS_TRIES;
  }

  function hotkeyGateCopy() {
    if (state.hotkeyStage === 'desk') {
      return 'Apretalo un par de veces más para ver cómo inplaize aparece y desaparece.';
    }
    return 'Apretá el atajo tres veces para seguir.';
  }

  function hotkeyTitle() {
    if (state.hotkeyStage === 'desk' && !state.hotkeyCapturing) {
      return 'Tu atajo mágico en acción 🌠';
    }
    if (state.hotkeyCapturing) return 'Tu atajo mágico';
    return 'Aprendiendo tu atajo mágico';
  }

  function hotkeyBody() {
    if (state.hotkeyCapturing) return 'Apretá las tres teclas del nuevo atajo, de a una.';
    if (state.hotkeyStage === 'desk') {
      return 'Apretando tu atajo mágico, todo siempre estará en orden.';
    }
    return 'Apretá el atajo tres veces.';
  }

  /** Manitos del contador: una por cada apretada del atajo (1, 2 y 3 dedos). */
  const HOTKEY_COUNT_HANDS = ['☝️', '✌️', '🤟'];

  /** El contador solo va en la primera parte del atajo, mientras no se cambian las teclas. */
  function showHotkeyCounter() {
    return state.hotkeyStage !== 'desk' && !state.hotkeyCapturing;
  }

  function renderHotkeyCounter() {
    const count = state.hotkeyPressCount;
    const hands = HOTKEY_COUNT_HANDS.map((hand, i) => {
      const lit = count > i ? ' is-lit' : '';
      return `<span class="onboarding-hotkey-hand${lit}" data-n="${i + 1}" aria-hidden="true">${hand}</span>`;
    }).join('');
    return (
      '<div class="onboarding-hotkey-count" role="img"' +
        ` aria-label="Apretaste el atajo ${count} de ${HOTKEY_KEYS_TRIES} veces">${hands}</div>`
    );
  }

  /** Prende las manitos hasta la apretada actual, sin volver a armar el bocadillo. */
  function updateHotkeyCounter() {
    const el = state.bubbleEl && state.bubbleEl.querySelector('.onboarding-hotkey-count');
    if (!el) return;
    const count = state.hotkeyPressCount;
    el.setAttribute('aria-label', `Apretaste el atajo ${count} de ${HOTKEY_KEYS_TRIES} veces`);
    el.querySelectorAll('.onboarding-hotkey-hand').forEach((hand, i) => {
      const wasLit = hand.classList.contains('is-lit');
      const lit = count > i;
      hand.classList.toggle('is-lit', lit);
      if (lit && !wasLit) {
        hand.classList.remove('is-pop');
        void hand.offsetWidth;
        hand.classList.add('is-pop');
      }
    });
  }

  /** Lo que tarda el teclado en plegarse antes de dejar solo la computadora (ver `.kb-with-check.is-leaving`). */
  const HOTKEY_KEYS_OUT_MS = 280;
  /** Tiempo con los tres dedos en alto, para que el conteo se lea antes de seguir. */
  const HOTKEY_COUNT_HOLD_MS = 880;

  /** Índice del paso del atajo en esa parte ('keys' o 'desk'). */
  function hotkeyStepIndex(stage) {
    return STEPS.findIndex((s) => s.id === 'hotkey' && s.hotkeyStage === stage);
  }

  let guideMouseTimer = 0;

  /**
   * Lleva el mouse real al centro de la pantalla de la computadora, que es donde
   * la flecha violeta arranca. Si el mouse ya está encima, no se toca.
   */
  function guideMouseToMonitor(delayMs) {
    if (guideMouseTimer) clearTimeout(guideMouseTimer);
    guideMouseTimer = setTimeout(() => {
      guideMouseTimer = 0;
      if (!isHotkeyStep() || state.hotkeyStage !== 'desk' || state.hotkeyCapturing) return;
      if (!window.usualDesk || typeof window.usualDesk.moveOnboardingCursor !== 'function') return;
      const screenEl = state.bubbleEl && state.bubbleEl.querySelector('.onboarding-monitor-screen');
      if (!screenEl || screenEl.matches(':hover')) return;
      const r = screenEl.getBoundingClientRect();
      if (!r.width || !r.height) return;
      window.usualDesk
        .moveOnboardingCursor({ x: r.left + r.width / 2, y: r.top + r.height / 2, ms: 650 })
        .catch(() => {});
    }, delayMs);
  }

  /**
   * Pasa de la primera parte a la segunda: el teclado se pliega y la
   * computadora, que ya estaba, gana ese lugar.
   */
  function showHotkeyDesk() {
    if (state.hotkeyFlipping) return;
    const deskIndex = hotkeyStepIndex('desk');
    if (deskIndex < 0) return;

    const board = state.bubbleEl && state.bubbleEl.querySelector('.onb-kb-overlay');
    if (!board) {
      showStep(deskIndex);
      return;
    }

    // Es un fundido corto: se hace aunque el sistema pida menos movimiento.
    state.hotkeyFlipping = true;
    board.classList.add('is-leaving');
    setTimeout(() => {
      state.hotkeyFlipping = false;
      if (!isHotkeyStep() || state.hotkeyStage !== 'keys' || state.hotkeyCapturing) return;
      showStep(deskIndex);
    }, HOTKEY_KEYS_OUT_MS);
  }

  function hotkeySlots() {
    if (state.hotkeyCapturing) {
      const slots = state.hotkeyCapture.slice();
      while (slots.length < 3) slots.push('');
      return slots;
    }
    return state.hotkeyKeys.slice();
  }

  function renderHotkeyChange() {
    if (state.hotkeyCapturing) {
      const n = state.hotkeyCapture.length;
      const hint = n === 0
        ? 'Apretá la primera tecla.'
        : n === 1
          ? 'Apretá la segunda tecla.'
          : 'Apretá la tercera tecla.';
      return (
        '<p class="onboarding-hotkey-hint">' + escapeHtml(hint) + '</p>'
        + '<button type="button" class="onboarding-hotkey-change" data-onboarding-action="cancel-hotkey">Cancelar</button>'
      );
    }
    const error = state.hotkeyError
      ? `<p class="onboarding-hotkey-error">${escapeHtml(state.hotkeyError)}</p>`
      : '';
    return (
      error
      + '<button type="button" class="onboarding-hotkey-change" data-onboarding-action="change-hotkey">Quiero cambiar las teclas del atajo</button>'
    );
  }

  function renderHotkeySlots(slots) {
    const parts = [];
    slots.forEach((label, i) => {
      if (i > 0) parts.push('<span class="onboarding-key-plus" aria-hidden="true">+</span>');
      const empty = !label;
      const chosen = !empty ? ' is-lit' : '';
      const emptyClass = empty ? ' is-empty' : '';
      const text = empty ? '·' : label;
      parts.push(
        `<span class="onboarding-key${chosen}${emptyClass}" data-hotkey="${escapeHtml(label)}">${escapeHtml(text)}</span>`,
      );
    });
    return (
      '<div class="onboarding-keyboard-row">' +
        '<div class="onboarding-keyboard" role="group" aria-label="Nuevo atajo">' +
          parts.join('') +
        '</div>' +
      '</div>'
    );
  }

  /**
   * Teclado en unidades reales (1u = tecla de letra). Cada fila suma 15u,
   * así que la D mide igual que la A o el 5. Las teclas del atajo quedan
   * con borde azul; al apretarlas aparece un disco gris translúcido
   * (`paintHotkeyKeys`), sin pintar la tecla.
   * El tercer valor en false es la copia de la derecha: da la forma, no el atajo.
   */
  function renderKeyboardBoard() {
    const shownLabel = {
      Space: '',
      Backspace: '⌫',
    };
    const rows = [
      [
        ['Esc', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1],
        ['6', 1], ['7', 1], ['8', 1], ['9', 1], ['0', 1], ['-', 1], ['=', 1], ['Backspace', 2],
      ],
      [
        ['Tab', 1.5], ['Q', 1], ['W', 1], ['E', 1], ['R', 1], ['T', 1],
        ['Y', 1], ['U', 1], ['I', 1], ['O', 1], ['P', 1], ['[', 1], [']', 1], ['\\', 1.5],
      ],
      [
        ['Caps', 1.75], ['A', 1], ['S', 1], ['D', 1], ['F', 1], ['G', 1],
        ['H', 1], ['J', 1], ['K', 1], ['L', 1], [';', 1], ["'", 1], ['Enter', 2.25],
      ],
      [
        ['Shift', 2.25], ['Z', 1], ['X', 1], ['C', 1], ['V', 1], ['B', 1],
        ['N', 1], ['M', 1], [',', 1], ['.', 1], ['/', 1], ['Shift', 2.75, false],
      ],
      [
        ['Ctrl', 1.5], ['Win', 1.5], ['Alt', 1.5], ['Space', 7.5],
        ['Alt', 1.5, false], ['Ctrl', 1.5, false],
      ],
    ];
    const chord = state.hotkeyCapturing ? [] : state.hotkeyKeys;
    const onBoard = new Set();
    const rowHtml = rows.map((row) => {
      const keys = row.map((spec) => {
        const label = spec[0];
        const units = spec[1];
        const primary = spec[2] !== false && /^[A-Za-z0-9]+$/.test(label);
        const span = Math.round(units * 4);
        const idx = primary ? chord.indexOf(label) : -1;
        if (idx >= 0) onBoard.add(label);
        const held = idx >= 0 && state.hotkeyLit.has(label) ? ' is-lit' : '';
        const chordClass = idx >= 0 ? ' is-chord' : '';
        const shown = Object.prototype.hasOwnProperty.call(shownLabel, label) ? shownLabel[label] : label;
        const word = shown.length > 1 ? ' is-word' : '';
        const hotkeyAttr = primary ? ` data-hotkey="${escapeHtml(label)}"` : '';
        return (
          `<span class="kb-key${word}${chordClass}${held}"${hotkeyAttr} style="grid-column:span ${span};--i:${idx >= 0 ? idx : 0}">` +
            `<span>${escapeHtml(shown)}</span>` +
          '</span>'
        );
      }).join('');
      return `<div class="kb-row">${keys}</div>`;
    }).join('');
    const missing = chord.filter((label) => !onBoard.has(label));
    const extra = missing.length
      ? '<div class="kb-row kb-row-extra">' + missing.map((label) => {
          const held = state.hotkeyLit.has(label) ? ' is-lit' : '';
          const word = label.length > 1 ? ' is-word' : '';
          return (
            `<span class="kb-key${word} is-chord${held}" data-hotkey="${escapeHtml(label)}" style="--i:${chord.indexOf(label)}">` +
              `<span>${escapeHtml(label)}</span>` +
            '</span>'
          );
        }).join('') + '</div>'
      : '';
    const capturing = state.hotkeyCapturing ? ' is-capturing' : '';
    const marked = state.hotkeyCapturing ? '' : ' is-marked';
    return (
      '<div class="kb-shell" aria-hidden="true">' +
        `<div class="kb-board${capturing}${marked}">${rowHtml}${extra}</div>` +
      '</div>'
    );
  }

  function hotkeyHeldCount() {
    return state.hotkeyKeys.filter((label) => state.hotkeyLit.has(label)).length;
  }

  /** Una sola barra: se llena de izquierda a derecha según cuántas teclas están apretadas. */
  function renderHotkeyMeter() {
    const total = state.hotkeyKeys.length || 1;
    const held = hotkeyHeldCount();
    const pct = Math.round((held / total) * 100);
    return (
      '<div class="onboarding-hotkey-meter" role="progressbar"' +
        ' aria-label="Teclas del atajo apretadas"' +
        ' aria-valuemin="0" aria-valuemax="' + total + '"' +
        ' aria-valuenow="' + held + '">' +
        '<span class="onboarding-hotkey-meter-fill" style="width:' + pct + '%"></span>' +
      '</div>'
    );
  }

  /** Las tres teclas del atajo, juntas, y la barra que marca cuántas están apretadas. */
  function renderHeldHotkeyChips() {
    const keys = state.hotkeyKeys.map((label) => {
      const held = state.hotkeyLit.has(label) ? ' is-lit' : '';
      return `<span class="onboarding-key${held}" data-hotkey="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
    }).join('');
    return (
      '<div class="onboarding-hotkey-stack">' +
        '<div class="onboarding-hotkey-chips" role="group" aria-label="Teclas del atajo">' +
          keys +
        '</div>' +
        renderHotkeyMeter() +
      '</div>'
    );
  }

  function clearHotkeyCountTimer() {
    if (!state.hotkeyCountTimer) return;
    clearTimeout(state.hotkeyCountTimer);
    state.hotkeyCountTimer = 0;
  }

  /**
   * Lo que va debajo del monitor en el paso del atajo.
   * Primera y segunda parte: las teclas del atajo y la barra de cuántas están apretadas.
   * Al cambiar el atajo, acá también van los selectores y el teclado.
   */
  function renderKeyboard(keys) {
    const slots = Array.isArray(keys) && keys.length ? keys : hotkeySlots();
    if (state.hotkeyCapturing) {
      return (
        '<div class="onboarding-hotkey-keys">' +
          renderHotkeySlots(slots) +
          '<div class="kb-with-check">' +
            renderKeyboardBoard() +
          '</div>' +
          renderHotkeyChange() +
        '</div>'
      );
    }
    return renderHeldHotkeyChips();
  }

  /**
   * Primera parte del atajo: el teclado aparece encima de la computadora, que se ve de fondo.
   * (Al cambiar el atajo el teclado va abajo, junto a los selectores, no acá.)
   */
  function renderKeyboardOverlay() {
    if (state.hotkeyCapturing || state.hotkeyStage === 'desk') return '';
    return (
      '<div class="onb-kb-overlay">' +
        '<div class="kb-with-check">' +
          renderKeyboardBoard() +
        '</div>' +
      '</div>'
    );
  }

  function winDesktopIcon(svg, label) {
    return (
      '<div class="win-icon">' +
        '<span class="win-glyph">' + svg + '</span>' +
        '<span class="win-label">' + escapeHtml(label) + '</span>' +
      '</div>'
    );
  }

  function renderWindowsDesktop() {
    const bin =
      '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#b0b6be" d="M11 5h10l1.2 2.2H9.8z"/><rect x="7" y="7.2" width="18" height="2.2" rx="1" fill="#8b919a"/><path fill="#6d727a" d="M9.2 10.2h13.6l-1.15 15.1a2 2 0 0 1-2 1.8h-7.3a2 2 0 0 1-2-1.8z"/><path stroke="#fff" stroke-width="1.3" stroke-linecap="round" d="M13 14.2v7.2M16 14.2v7.2M19 14.2v7.2"/></svg>';
    const pc =
      '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="4" width="26" height="17" rx="2" fill="#5f6368"/><rect x="5" y="6" width="22" height="13" rx="1" fill="#8ab4f8"/><rect x="13" y="22" width="6" height="3" fill="#5f6368"/><rect x="9" y="25" width="14" height="2.4" rx="1" fill="#80868b"/></svg>';
    const folder =
      '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#f9ab00" d="M3 9h9.2l2.2 2.4H29V26H3z"/><path fill="#fdd663" d="M3 13.2h26V26H3z"/></svg>';
    const downloads =
      '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#f9ab00" d="M3 9h9.2l2.2 2.4H29V26H3z"/><path fill="#fdd663" d="M3 13.2h26V26H3z"/><path fill="#fff" d="M15 15.5h2v5.2h2.8L16 24.2l-3.8-3.5H15z"/></svg>';
    const photos =
      '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="6" width="24" height="20" rx="2" fill="#1e8e3e"/><circle cx="12" cy="13" r="2.4" fill="#fff"/><path fill="#e6f4ea" d="M6 22.2l5.6-5.6 3.8 3.8 3.2-3.2 7.4 6.6V24a2 2 0 0 1-2 2H6z"/></svg>';
    const notes =
      '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#fff" d="M7 3h12l6 6v20H7z"/><path fill="#e8eaed" d="M19 3v6h6"/><path stroke="#1a73e8" stroke-width="1.5" stroke-linecap="round" d="M11 16h10M11 20h10M11 24h6"/></svg>';
    return (
      '<div class="onboarding-win-desktop">' +
        '<div class="win-icons">' +
          winDesktopIcon(bin, 'Papelera') +
          winDesktopIcon(pc, 'Este equipo') +
          winDesktopIcon(folder, 'Documentos') +
          winDesktopIcon(downloads, 'Descargas') +
          winDesktopIcon(photos, 'Imágenes') +
          winDesktopIcon(notes, 'Notas') +
        '</div>' +
      '</div>'
    );
  }

  function renderWindowsTaskbar() {
    return (
      '<div class="win-taskbar">' +
        '<span class="win-start"></span>' +
        '<span class="win-search"></span>' +
        '<span class="win-pin is-blue"></span>' +
        '<span class="win-pin is-green"></span>' +
        '<span class="win-pin is-yellow"></span>' +
        '<span class="win-clock">11:48<br>24/10/2026</span>' +
      '</div>'
    );
  }

  function paintHotkeyKeys() {
    if (!state.bubbleEl) return;
    state.bubbleEl.querySelectorAll('[data-hotkey]').forEach((el) => {
      el.classList.toggle('is-lit', state.hotkeyLit.has(el.getAttribute('data-hotkey')));
    });
    const meter = state.bubbleEl.querySelector('.onboarding-hotkey-meter');
    if (meter) {
      const total = state.hotkeyKeys.length || 1;
      const held = hotkeyHeldCount();
      meter.setAttribute('aria-valuemax', String(total));
      meter.setAttribute('aria-valuenow', String(held));
      const fill = meter.querySelector('.onboarding-hotkey-meter-fill');
      if (fill) fill.style.width = `${Math.round((held / total) * 100)}%`;
    }
  }

  function isHotkeyStep() {
    if (!state.active) return false;
    const step = STEPS[state.step];
    return !!(step && step.id === 'hotkey');
  }

  /** @param {KeyboardEvent} e */
  function eventToLabel(e) {
    const code = e.code || '';
    const key = e.key || '';
    if (code === 'ControlLeft' || code === 'ControlRight' || key === 'Control') return 'Ctrl';
    if (code === 'AltLeft' || code === 'AltRight' || key === 'Alt') return 'Alt';
    if (code === 'ShiftLeft' || code === 'ShiftRight' || key === 'Shift') return 'Shift';
    if (code === 'MetaLeft' || code === 'MetaRight' || key === 'Meta') return 'Win';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    const named = {
      Space: 'Space',
      Enter: 'Enter',
      NumpadEnter: 'Enter',
      Escape: 'Esc',
      Tab: 'Tab',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Backspace: 'Backspace',
      Delete: 'Delete',
    };
    return named[code] || null;
  }

  function hotkeyLabelForKey(e) {
    return eventToLabel(e);
  }

  function setHotkeyLit(label, on) {
    if (!label || !isHotkeyStep()) return;
    if (!state.hotkeyKeys.includes(label)) return;
    const had = state.hotkeyLit.has(label);
    if (on) state.hotkeyLit.add(label);
    else state.hotkeyLit.delete(label);
    if (had !== on) paintHotkeyKeys();
  }

  const HOTKEY_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Win'];

  function noteHotkeyModifier(label, down) {
    if (!HOTKEY_MODIFIERS.includes(label)) return;
    state.hotkeyModsDown[label] = down;
  }

  function chordModifiersHeld() {
    const needed = state.hotkeyKeys.filter((label) => HOTKEY_MODIFIERS.includes(label));
    if (!needed.length) return false;
    return needed.every((label) => state.hotkeyModsDown[label]);
  }

  /**
   * El atajo global se come la tecla final (la D de Ctrl+Alt+D): ese keydown
   * no llega a la ventana. Cuando el atajo dispara, las tres siguen apretadas
   * y las prendemos. Si el usuario ya las soltó, no las dejamos pegadas.
   */
  function lightSwallowedChordKey() {
    if (!isHotkeyStep() || state.hotkeyCapturing) return;
    if (Date.now() - state.lastHotkeyModifierUpAt < 80) return;
    let changed = false;
    state.hotkeyKeys.forEach((label) => {
      if (HOTKEY_MODIFIERS.includes(label)) state.hotkeyModsDown[label] = true;
      if (state.hotkeyLit.has(label)) return;
      state.hotkeyLit.add(label);
      changed = true;
    });
    if (changed) paintHotkeyKeys();
  }

  function releaseSwallowedChordKey() {
    if (chordModifiersHeld()) return;
    let changed = false;
    state.hotkeyKeys.forEach((label) => {
      if (HOTKEY_MODIFIERS.includes(label)) return;
      if (!state.hotkeyLit.has(label)) return;
      state.hotkeyLit.delete(label);
      changed = true;
    });
    if (changed) paintHotkeyKeys();
  }

  function clearHotkeyLit() {
    state.hotkeyModsDown.Ctrl = false;
    state.hotkeyModsDown.Alt = false;
    state.hotkeyModsDown.Shift = false;
    state.hotkeyModsDown.Win = false;
    if (state.hotkeyLit.size === 0) return;
    state.hotkeyLit.clear();
    paintHotkeyKeys();
  }

  /**
   * Prende solo la tecla que se está apretando. Soltarla (o perder el foco)
   * la apaga. Seguir de paso igual exige el atajo real.
   * @param {KeyboardEvent} e
   * @param {boolean} down
   */
  function syncHotkeyHeld(e, down) {
    if (!isHotkeyStep() || state.hotkeyCapturing) return;
    const label = hotkeyLabelForKey(e);
    if (down) {
      if (label) {
        noteHotkeyModifier(label, true);
        setHotkeyLit(label, true);
      }
      if (e.ctrlKey) {
        noteHotkeyModifier('Ctrl', true);
        setHotkeyLit('Ctrl', true);
      }
      if (e.altKey) {
        noteHotkeyModifier('Alt', true);
        setHotkeyLit('Alt', true);
      }
      if (e.shiftKey) {
        noteHotkeyModifier('Shift', true);
        setHotkeyLit('Shift', true);
      }
      if (e.metaKey) {
        noteHotkeyModifier('Win', true);
        setHotkeyLit('Win', true);
      }
      return;
    }
    if (label) {
      noteHotkeyModifier(label, false);
      setHotkeyLit(label, false);
    }
    if (!e.ctrlKey) {
      noteHotkeyModifier('Ctrl', false);
      setHotkeyLit('Ctrl', false);
    }
    if (!e.altKey) {
      noteHotkeyModifier('Alt', false);
      setHotkeyLit('Alt', false);
    }
    if (!e.shiftKey) {
      noteHotkeyModifier('Shift', false);
      setHotkeyLit('Shift', false);
    }
    if (!e.metaKey) {
      noteHotkeyModifier('Win', false);
      setHotkeyLit('Win', false);
    }
    if (label && HOTKEY_MODIFIERS.includes(label)) {
      state.lastHotkeyModifierUpAt = Date.now();
    }
    releaseSwallowedChordKey();
  }

  function refreshHotkeyStep() {
    const step = STEPS[state.step];
    if (!step || step.id !== 'hotkey') return;
    renderBubble(step);
    scheduleReflow();
  }

  function beginHotkeyCapture() {
    if (!isHotkeyStep()) return;
    state.hotkeyCapturing = true;
    state.hotkeyCapture = [];
    state.hotkeyError = '';
    state.hotkeyLit.clear();
    refreshHotkeyStep();
  }

  function cancelHotkeyCapture() {
    state.hotkeyCapturing = false;
    state.hotkeyCapture = [];
    refreshHotkeyStep();
  }

  async function commitHotkeyCapture() {
    const next = state.hotkeyCapture.slice(0, 3);
    const prev = state.hotkeyKeys.slice();
    state.hotkeyCapturing = false;
    state.hotkeyCapture = [];
    state.hotkeyKeys = next;
    state.hotkeyPressed = false;
    state.hotkeyLit.clear();
    state.hotkeyError = '';
    clearHotkeyCountTimer();
    const keysIndex = hotkeyStepIndex('keys');
    if (state.hotkeyStage !== 'keys' && keysIndex >= 0) {
      showStep(keysIndex);
    } else {
      state.hotkeyPressCount = 0;
      state.hotkeyDeskPresses = 0;
      state.hotkeyDockShown = true;
      refreshHotkeyStep();
    }
    let res = null;
    try {
      if (window.usualDesk && typeof window.usualDesk.setAppSettings === 'function') {
        res = await window.usualDesk.setAppSettings({ dockHotkey: next });
      }
    } catch {
      res = null;
    }
    if (!res || res.dockHotkeyRejected) {
      state.hotkeyKeys = res && Array.isArray(res.dockHotkey) ? res.dockHotkey.slice() : prev;
      state.hotkeyError = 'Esas teclas no se pueden usar juntas. Incluí Ctrl, Alt o Shift y una letra.';
      refreshHotkeyStep();
      return;
    }
    if (Array.isArray(res.dockHotkey)) state.hotkeyKeys = res.dockHotkey.slice();
    refreshHotkeyStep();
  }

  function onHotkeyKeyDown(e) {
    if (e.repeat) return;
    if (state.hotkeyCapturing && isHotkeyStep()) {
      if (e.key === 'Escape' || e.code === 'Escape') {
        e.preventDefault();
        cancelHotkeyCapture();
        return;
      }
      const label = eventToLabel(e);
      if (!label) return;
      e.preventDefault();
      e.stopPropagation();
      if (state.hotkeyCapture.includes(label) || state.hotkeyCapture.length >= 3) return;
      state.hotkeyCapture.push(label);
      if (state.hotkeyCapture.length >= 3) commitHotkeyCapture();
      else refreshHotkeyStep();
      return;
    }
    syncHotkeyHeld(e, true);
  }

  function onHotkeyKeyUp(e) {
    syncHotkeyHeld(e, false);
  }

  function showStep(stepIndex) {
    const step = STEPS[stepIndex];
    if (!step) {
      finish();
      return;
    }
    
    clearHotkeyCountTimer();
    if (step.id === 'hotkey') {
      state.hotkeyPressed = false;
      state.hotkeyAttemptedNext = false;
      state.hotkeyLit.clear();
      state.hotkeyCapturing = false;
      state.hotkeyCapture = [];
      state.hotkeyError = '';
      state.hotkeyStage = step.hotkeyStage === 'desk' ? 'desk' : 'keys';
      state.hotkeyPressCount = 0;
      state.hotkeyDeskPresses = 0;
      state.hotkeyDockShown = state.hotkeyStage !== 'desk';
      state.hotkeyFlipping = false;
    }
    state.step = stepIndex;
    setHotkeyTrial(step.id === 'hotkey');
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
    if (step.id === 'hotkey' && state.hotkeyStage === 'desk') guideMouseToMonitor(450);
    // Render inicial: dejamos que el navegador layoute y luego posicionamos.
    requestAnimationFrame(() => {
      reflowCurrentStep();
      // Doble RAF: algunos cambios de tamaño del bocadillo recién aparecen tras
      // el primer paint; reposicionamos otra vez para encuadrar bien la flecha.
      requestAnimationFrame(() => reflowCurrentStep());
    });
  }

  function goBack() {
    if (!state.active || state.step <= 0) return;
    showStep(state.step - 1);
  }

  function goNext() {
    if (!state.active) return;
    const step = STEPS[state.step];

    // Paso "personalize": hace falta al menos una app para armar la barra.
    if (step && step.id === 'personalize' && state.selectedApps.size === 0) {
      renderBubble(step);
      return;
    }

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
    if (step && step.id === 'hotkey' && !hotkeyReadyToAdvance()) {
      state.hotkeyAttemptedNext = true;
      renderBubble(step);
      return;
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
          icon: app.icon || '',
        });
      } catch (error) {
        console.error(`Error creating shortcut for ${app.name}:`, error);
      }
    }
  }

  function advanceToNextStep() {
    const next = state.step + 1;
    if (next >= STEPS.length) {
      showFarewell();
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
    try {
      if (window.usualDesk && typeof window.usualDesk.setOnboardingActive === 'function') {
        window.usualDesk.setOnboardingActive(true);
      }
    } catch {
      /* el conteo del atajo sigue igual si el aviso no llega */
    }
    state.preview = !!o.preview;
    state.selectedApps.clear();
    resetImportState();
    state.hotkeyCapturing = false;
    state.hotkeyCapture = [];
    state.hotkeyError = '';
    const skipWelcome = !!o.skipWelcome;

    if (!state.repositionListener) {
      const listener = () => scheduleReflow();
      window.addEventListener('resize', listener);
      window.addEventListener('scroll', listener, true);
      state.repositionListener = listener;
    }

    armSidebarStateListener();
    armHotkeyKeyListener();
    startModalObserver();
    loadSavedHotkey();
    showStep(startStepIndex(o, skipWelcome));
    applyModalSuppression();
  }

  /** Paso inicial: `step` puede ser el id (`hotkey`) o el número. Si no viene, arranca en 0. */
  function startStepIndex(o, skipWelcome) {
    if (o.hotkeyStage === 'desk' && (o.step == null || o.step === '' || String(o.step) === 'hotkey')) {
      return hotkeyStepIndex('desk');
    }
    if (o.step != null && o.step !== '') {
      const raw = String(o.step);
      const byId = STEPS.findIndex((s) => s.id === raw);
      if (byId >= 0) return byId;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0 && n < STEPS.length) return n;
    }
    return skipWelcome ? 1 : 0;
  }

  async function loadSavedHotkey() {
    try {
      if (!window.usualDesk || typeof window.usualDesk.getAppSettings !== 'function') return;
      const settings = await window.usualDesk.getAppSettings();
      if (!settings || !Array.isArray(settings.dockHotkey) || settings.dockHotkey.length !== 3) return;
      state.hotkeyKeys = settings.dockHotkey.slice();
      if (isHotkeyStep() && !state.hotkeyCapturing) refreshHotkeyStep();
    } catch {
      /* seguimos con Ctrl + Alt + D */
    }
  }

  /** Avisa al main si estamos en la prueba del atajo: ahí el atajo global no abre ni cierra nada. */
  function setHotkeyTrial(on) {
    try {
      if (window.usualDesk && typeof window.usualDesk.setOnboardingHotkeyTrial === 'function') {
        window.usualDesk.setOnboardingHotkeyTrial(on === true);
      }
    } catch {
      /* noop */
    }
  }

  /**
   * Durante el paso del atajo, el main no togglea el dock: solo nos avisa que
   * se apretó (`onboarding-hotkey-press`) y acá lo contamos como prueba.
   * Se arma una sola vez porque el wrapper del preload solo agrega listeners
   * (no los reemplaza), y queremos evitar duplicados si el usuario re-abre el
   * preview varias veces.
   */
  function armSidebarStateListener() {
    if (state.sidebarStateListenerArmed) return;
    if (!window.usualDesk || typeof window.usualDesk.onOnboardingHotkeyPress !== 'function') return;
    window.usualDesk.onOnboardingHotkeyPress(() => {
      if (!state.active) return;
      const step = STEPS[state.step];
      if (!step || step.id !== 'hotkey' || state.hotkeyCapturing) return;
      lightSwallowedChordKey();
      state.hotkeyPressed = true;
      state.hotkeyAttemptedNext = false;
      const gate = state.bubbleEl && state.bubbleEl.querySelector('.onboarding-hotkey-gate');
      if (gate) gate.remove();
      if (state.hotkeyStage !== 'desk') {
        if (state.hotkeyPressCount >= HOTKEY_KEYS_TRIES || state.hotkeyFlipping) return;
        state.hotkeyPressCount += 1;
        updateHotkeyCounter();
        if (state.hotkeyPressCount >= HOTKEY_KEYS_TRIES) {
          clearHotkeyCountTimer();
          state.hotkeyCountTimer = setTimeout(() => {
            state.hotkeyCountTimer = 0;
            if (!isHotkeyStep() || state.hotkeyCapturing || state.hotkeyStage !== 'keys') return;
            if (state.hotkeyPressCount < HOTKEY_KEYS_TRIES) return;
            showHotkeyDesk();
          }, HOTKEY_COUNT_HOLD_MS);
        }
        return;
      }
      if (state.hotkeyFlipping) return;
      state.hotkeyDeskPresses += 1;
      state.hotkeyDockShown = !state.hotkeyDockShown;
      const monitor = state.bubbleEl && state.bubbleEl.querySelector('.onboarding-monitor');
      if (monitor) monitor.classList.toggle('is-dock-hidden', !state.hotkeyDockShown);
      if (state.hotkeyDockShown) guideMouseToMonitor(120);
      if (state.hotkeyDeskPresses >= HOTKEY_DESK_TRIES) {
        const gate = state.bubbleEl && state.bubbleEl.querySelector('.onboarding-hotkey-gate');
        if (gate) gate.remove();
      }
    });
    state.sidebarStateListenerArmed = true;
  }

  /** Prende cada tecla al bajar y la apaga al soltar o al perder el foco. */
  function armHotkeyKeyListener() {
    if (state.hotkeyKeyListenerArmed) return;
    window.addEventListener('keydown', onHotkeyKeyDown, true);
    window.addEventListener('keyup', onHotkeyKeyUp, true);
    window.addEventListener('blur', clearHotkeyLit);
    state.hotkeyKeyListenerArmed = true;
  }

  /** Lo que se ve al terminar el tour: la marca y la frase, un momento, y se cierra. */
  const FAREWELL_MS = 2200;

  function showFarewell() {
    const bubble = state.bubbleEl;
    if (!bubble || state.farewellShown) {
      if (!state.farewellShown) finish();
      return;
    }
    state.farewellShown = true;
    bubble.dataset.stepId = 'farewell';
    bubble.classList.remove('has-stepper');
    bubble.innerHTML =
      '<div class="onboarding-farewell" role="status">' +
        '<span class="onboarding-welcome-mark" aria-hidden="true"></span>' +
        '<p class="onboarding-farewell-text">inplaize. Todo en su lugar.</p>' +
      '</div>';
    setTimeout(() => {
      state.farewellShown = false;
      finish();
    }, FAREWELL_MS);
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
    // Internal y querrá seguir interactuando con él.
    const skippedBeforeFirstShortcut =
      !state.preview && state.step >= 0 && state.step <= hotkeyStepIndex('desk');
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
    showGestureCoach,
  };
})();

'use strict';

/**
 * Ventana del instalador de inplaize.
 *
 * El .exe que se baja de la web es chico: abre esta ventana y recién al
 * apretar "Comenzar" descarga la app. Mientras baja, la computadora del
 * onboarding (la misma, `UsualDeskOnboarding.createMonitor`) muestra cómo
 * funciona inplaize. Al terminar se abre la app, que arranca con su tour.
 *
 * Con el programa (installer/Installer.cs) se habla por mensajes:
 *   de acá para allá   'ready' | 'install' | 'retry' | 'open-full'
 *   de allá para acá   { type: 'init', version, sizeBytes }
 *                      { type: 'progress', received, total }
 *                      { type: 'phase', phase }   downloading | verifying | installing | launching
 *                      { type: 'error', code, detail }   network | disk | signature | install
 *
 * Abierta en un navegador (sin programa atrás) simula la descarga, para poder
 * ver y ajustar la ventana: `npm run preview:onboarding` y entrar a
 * http://127.0.0.1:4173/installer/ (con `?fail=network` muestra el error).
 */
(function () {
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const $ = (id) => document.getElementById(id);

  const root = $('setup');
  const bar = $('bar');
  const barFill = $('bar-fill');
  const statusText = $('status-text');
  const statusDetail = $('status-detail');

  const icon = (name) => `assets/icons/${name}.png`;
  const BAR = ['whatsapp', 'gmail', 'calendar', 'dirve', 'gpt', 'youtube'].map(icon);

  // El ícono de Google que hay en assets es la palabra entera y en una pestaña no se lee: va la G.
  const GOOGLE_G =
    '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<path fill="#ea4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
      '<path fill="#4285f4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
      '<path fill="#fbbc05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
      '<path fill="#34a853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
    '</svg>';

  /** Los perfiles de la navegación libre (www): cada uno con su pestaña. */
  const PROFILES = [
    { initial: 'I', tone: 'pink', site: 'google', title: 'Google', url: 'https://www.google.com/', favicon: GOOGLE_G },
    { initial: 'M', tone: 'blue', site: 'youtube', title: 'YouTube', url: 'https://www.youtube.com/' },
    { initial: 'T', tone: 'amber', site: 'linkedin', title: 'LinkedIn', url: 'https://www.linkedin.com/feed/' },
  ];

  /**
   * Los pasos del recorrido que pasa mientras baja. A la izquierda se ven los
   * tres, uno debajo del otro, y el que está prendido muestra su frase. `ms` es
   * lo que dura cada uno y `play` lo que hace la flecha en la computadora
   * durante ese tiempo. `enter`, si está, deja la computadora como tiene que
   * verse al empezar ese paso (se llama con la pantalla apagada).
   */
  const SLIDES = [
    {
      title: 'Tu espacio, a un atajo',
      body:
        'Estés donde estés, apretando ' +
        '<span class="setup-keys"><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>D</kbd>,</span> ' +
        'tu espacio de trabajo aparecerá al instante.',
      ms: 8600,
      // Arranca con inplaize escondido: en la pantalla está solo el escritorio.
      enter() {
        mon.classList.add('is-dock-hidden');
      },
      play() {
        // Los tiempos siguen a quien lee (unas 3 o 4 palabras por segundo): primero
        // «Estés donde estés, apretando», después las teclas de a una, y con la
        // tercera aparece el espacio, justo cuando la frase lo dice.
        pressHotkey(2200, false, 450, 350);
        // Ya visto una vez, el mismo atajo lo esconde y lo vuelve a traer, más rápido.
        pressHotkey(5700, true, 150, 200);
        pressHotkey(7000, false, 150, 200);
      },
    },
    {
      title: 'Tus apps, sin distracciones',
      body:
        'Fijas en la barra, con sus notificaciones a la vista. ' +
        'Clic derecho: una en foco, el resto en silencio.',
      ms: 7800,
      play() {
        // Las apps, en su lugar: un clic y se abre.
        tapIcon('calendar', 300);
        // Las notificaciones: llegan como un número sobre el ícono y se van al abrir esa app.
        later(1700, () => setBadge('whatsapp', 2));
        later(2300, () => setBadge('gmail', 1));
        // El foco: el resto pierde el color y sus notificaciones se callan hasta que termina la pantalla.
        act(3500, () => iconEl('gmail'), {
          pause: 800,
          onOver: () => showFx('right', 'gmail'),
          onClick() {
            openApp('gmail');
            setFocus('gmail');
            showFx('focus', 'gmail');
          },
        });
      },
    },
    {
      title: 'Tus cuentas, sin mezclarse',
      body: 'En <b>www</b>, cada perfil navega<br>con su propia sesión y sus pestañas.',
      ms: 5600,
      play() {
        act(500, () => segWww, { onClick: () => setMode('www') });
        act(2700, () => profileEls[1], { onClick: () => selectProfile(1) });
      },
    },
  ];

  const ERRORS = {
    network: 'No se pudo descargar inplaize. Revisá la conexión y probá de nuevo.',
    disk: 'No se pudo guardar la descarga. Fijate que haya lugar en el disco y probá de nuevo.',
    signature: 'La descarga no pasó la verificación de firma, así que no se instaló.',
    install: 'La instalación no terminó. Probá de nuevo o bajá el instalador completo.',
  };

  /** ---------------- La computadora ---------------- */

  const monitor = window.UsualDeskOnboarding.createMonitor(BAR);
  const mon = monitor.el;
  const screen = mon.querySelector('.onboarding-monitor-screen');
  const cursor = mon.querySelector('.onb-cursor');
  const dock = mon.querySelector('.onboarding-dockbar');
  const iconsEl = dock.querySelector('.onboarding-dockbar-icons');
  const iconEl = (name) => iconsEl.querySelector(`img[data-icon="${icon(name)}"]`);

  // El segmentado «inplaize | www» de la franja, donde el onboarding tiene el logo solo.
  const seg = document.createElement('span');
  seg.className = 'setup-seg';
  seg.innerHTML = '<i class="setup-seg-home"></i><i class="setup-seg-www">www</i>';
  mon.querySelector('.onboarding-dockbar-logo').replaceWith(seg);
  const segWww = seg.querySelector('.setup-seg-www');

  // Lo que muestra la franja en www: los perfiles y la pestaña abierta.
  const www = document.createElement('span');
  www.className = 'setup-www';
  www.innerHTML =
    `<span class="setup-profiles">${
      PROFILES.map((p) => `<i class="setup-profile is-${p.tone}"><b>${p.initial}</b></i>`).join('')
    }</span>` +
    '<span class="setup-tab"><span class="setup-tab-ico"></span><b></b><em>×</em></span>' +
    '<span class="setup-tab-new">+</span>';
  iconsEl.after(www);
  const profileEls = Array.from(www.querySelectorAll('.setup-profile'));
  const tabEl = www.querySelector('.setup-tab');

  // Los carteles que salen debajo del ícono que se está tocando. Se ve un grupo
  // por vez, el que diga `data-show`: qué clic es y qué pasó con esa app.
  const MOUSE_RIGHT =
    '<svg viewBox="0 0 12 16" aria-hidden="true">' +
      '<rect x="1" y="1" width="10" height="14" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M6 1.2h.2A4.8 4.8 0 0 1 11 6v1H6z" fill="currentColor"/>' +
    '</svg>';
  const MUTED =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M4 9h3.2L11 5.6v12.8L7.2 15H4z"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M15.5 9.4l4.4 5.2M19.9 9.4l-4.4 5.2"/>' +
    '</svg>';
  const fx = document.createElement('div');
  fx.className = 'setup-fx';
  fx.innerHTML =
    `<span class="setup-pill is-tag" data-for="right">${MOUSE_RIGHT}Clic derecho</span>` +
    '<span class="setup-pill is-focus" data-for="focus">Foco</span>' +
    `<span class="setup-pill is-tag" data-for="focus">${MUTED}El resto, en silencio</span>`;
  screen.insertBefore(fx, cursor);

  /** La app que está abierta en la ventana, para volver a ella al salir de www. */
  /** La app que está abierta al empezar cada paso. */
  const HOME_APP = 'whatsapp';
  let currentApp = HOME_APP;
  /** Los números de notificaciones que hay sobre los íconos, por app. */
  const badges = new Map();

  $('monitor-slot').appendChild(mon);
  // De entrada se ve inplaize como queda en uso: la barra con los accesos y una app abierta.
  openApp(currentApp);

  /** ---------------- Tiempos ---------------- */

  /** Lo que dispara cada pantalla. Se corta entero al pasar a la siguiente. */
  const slideTimers = [];
  const later = (ms, fn) => slideTimers.push(setTimeout(fn, ms));
  const clearSlideTimers = () => slideTimers.splice(0).forEach(clearTimeout);

  let touring = false;

  /** ---------------- Texto ---------------- */

  /** El título y la frase de antes y después del recorrido (mientras baja se ven los pasos). */
  function setCopy(title, body) {
    $('copy-title').textContent = title;
    $('copy-body').textContent = body;
  }

  function setState(state) {
    root.dataset.state = state;
  }

  const megas = (bytes) => Math.max(1, Math.round(bytes / 1048576));

  function setStatus(text, detail, busy) {
    statusText.textContent = text;
    statusDetail.textContent = detail || '';
    bar.classList.toggle('is-busy', busy === true);
  }

  /** ---------------- Lo que pasa en la computadora ---------------- */

  /** Abre una app en la ventana. Al abrirla, sus notificaciones quedan vistas. */
  function openApp(name) {
    currentApp = name;
    monitor.openApp(icon(name));
    setBadge(name, 0);
  }

  /** Las notificaciones pendientes de una app: el número sobre su ícono, como en inplaize. Con 0 se va. */
  function setBadge(name, count) {
    let badge = badges.get(name);
    if (!count) {
      if (badge) badge.remove();
      badges.delete(name);
      return;
    }
    const img = iconEl(name);
    if (!img) return;
    if (!badge) {
      badge = document.createElement('i');
      badge.className = 'setup-badge';
      dock.appendChild(badge);
      badges.set(name, badge);
    }
    badge.textContent = count;
    badge.style.left = `${img.offsetLeft + img.offsetWidth - 7}px`;
    badge.style.top = `${img.offsetTop - 5}px`;
  }

  /** Dónde queda un elemento de la pantalla, en porcentaje de la pantalla. */
  function spotOf(el, biasY) {
    const s = screen.getBoundingClientRect();
    const r = el ? el.getBoundingClientRect() : null;
    if (!r || !r.width || !s.width || !s.height) return null;
    return {
      x: ((r.left + r.width / 2 - s.left) / s.width) * 100,
      y: ((r.top + r.height * biasY - s.top) / s.height) * 100,
      left: ((r.left - s.left) / s.width) * 100,
    };
  }

  /**
   * La flecha va sola hasta un elemento, aprieta y suelta. `target` se busca
   * recién al llegar el momento, porque los perfiles no están en pantalla
   * hasta entrar a www. Opciones:
   *   pause    cuánto espera quieta antes de apretar
   *   onOver   al llegar · onClick   al soltar
   */
  function act(at, target, opts) {
    const o = opts || {};
    const over = at + 560;
    const down = over + (o.pause || 260);
    const up = down + 140;
    later(at, () => {
      const spot = spotOf(target(), 0.6);
      if (!spot) return;
      cursor.classList.remove('is-arrive', 'is-over', 'is-down', 'is-click');
      cursor.classList.add('is-home');
      cursor.style.left = `${spot.x}%`;
      cursor.style.top = `${spot.y}%`;
    });
    later(over, () => {
      cursor.classList.add('is-over');
      if (o.onOver) o.onOver();
    });
    later(down, () => cursor.classList.add('is-down'));
    later(up, () => {
      cursor.classList.remove('is-down', 'is-click');
      void cursor.offsetWidth;
      cursor.classList.add('is-click');
      if (o.onClick) o.onClick();
    });
    later(up + 740, () => cursor.classList.remove('is-over'));
  }

  /** Clic común en un ícono de la barra: se abre esa app. */
  function tapIcon(name, at) {
    act(at, () => iconEl(name), { onClick: () => openApp(name) });
  }

  /** Muestra un grupo de carteles debajo de ese ícono; sin grupo, no queda ninguno. */
  function showFx(group, name) {
    const spot = group ? spotOf(iconEl(name), 0.5) : null;
    if (spot) fx.style.left = `${spot.left}%`;
    fx.dataset.show = spot ? group : '';
  }

  /** Foco: esa app queda con el marco violeta y las demás, apagadas de color y en silencio. */
  function setFocus(name) {
    const target = name ? iconEl(name) : null;
    iconsEl.querySelectorAll('img').forEach((img) => img.classList.toggle('is-focus', img === target));
    badges.forEach((badge, app) => badge.classList.toggle('is-quiet', Boolean(target) && app !== name));
    mon.classList.toggle('is-focus', Boolean(target));
  }

  /** La dirección y los botones del navegador, donde las apps tienen su barra de título. */
  function navMarkup(url) {
    return (
      '<div class="setup-nav">' +
        '<span class="setup-nav-pin">Fijar</span>' +
        '<span class="setup-nav-btns"><i>‹</i><i>›</i><i>↻</i></span>' +
        `<span class="setup-nav-url">${url}</span>` +
      '</div>'
    );
  }

  /** En www, cada perfil trae su pestaña y su página. */
  function selectProfile(index) {
    const profile = PROFILES[index];
    profileEls.forEach((el, i) => el.classList.toggle('is-on', i === index));
    monitor.openApp(icon(profile.site));
    const titleBar = mon.querySelector('.onboarding-desk-window .wc-bar');
    if (titleBar) titleBar.outerHTML = navMarkup(profile.url);
    tabEl.querySelector('.setup-tab-ico').innerHTML =
      profile.favicon || `<img src="${icon(profile.site)}" alt="" />`;
    tabEl.querySelector('b').textContent = profile.title;
    tabEl.classList.remove('is-swap');
    void tabEl.offsetWidth;
    tabEl.classList.add('is-swap');
  }

  /** El segmentado: `apps` es inplaize con sus accesos; `www`, la navegación libre. */
  function setMode(mode) {
    const toWww = mode === 'www';
    mon.classList.toggle('is-www', toWww);
    if (toWww) selectProfile(0);
    else monitor.openApp(icon(currentApp));
  }

  /** Deja la computadora como al principio de una pantalla: sin foco, en inplaize, con la primera app abierta y la flecha en el centro. */
  function resetScene() {
    setFocus(null);
    showFx('');
    Array.from(badges.keys()).forEach((app) => setBadge(app, 0));
    cursor.classList.remove('is-over', 'is-down');
    cursor.style.left = '';
    cursor.style.top = '';
    hotkeyEls().forEach((key) => key.classList.remove('is-lit'));
    mon.classList.remove('is-www');
    openApp(HOME_APP);
    mon.classList.remove('is-dock-hidden');
  }

  /** Las teclas del atajo, en la frase del primer paso. */
  const hotkeyEls = () => Array.from(stepsEl.querySelectorAll('kbd'));

  /**
   * El atajo: las teclas se prenden de a una, cada `gap` ms, y quedan apretadas
   * juntas. `hold` ms después de la última, inplaize se esconde o vuelve, y
   * enseguida se sueltan las tres.
   */
  function pressHotkey(at, hide, gap, hold) {
    const keys = hotkeyEls();
    keys.forEach((key, i) => later(at + i * gap, () => key.classList.add('is-lit')));
    const fire = at + (keys.length - 1) * gap + hold;
    later(fire, () => mon.classList.toggle('is-dock-hidden', hide));
    later(fire + 300, () => keys.forEach((key) => key.classList.remove('is-lit')));
  }

  // Los pasos, uno debajo del otro: el título de cada uno y, plegada, su frase.
  const stepsEl = $('steps');
  stepsEl.innerHTML = SLIDES.map((slide) => (
    `<li><h2>${slide.title}</h2><div class="setup-step-body"><p>${slide.body}</p></div></li>`
  )).join('');
  const stepEls = Array.from(stepsEl.children);

  /** Prende el paso que se está viendo (su barra y su frase) y apaga los otros dos. */
  function setStep(active) {
    stepEls.forEach((el, i) => {
      el.classList.toggle('is-on', i === active);
      if (i === active) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
    });
  }

  /** Lo que tarda la pantalla de la computadora en apagarse entre un paso y el siguiente. */
  const CUT_MS = 280;

  /**
   * Muestra un paso. Entre uno y otro (`cut`) la pantalla de la computadora se
   * apaga, se acomoda a oscuras y vuelve, para que cada paso se lea por separado.
   */
  function showSlide(index, cut) {
    clearSlideTimers();
    if (!touring) return;
    const slide = SLIDES[index];
    setStep(index);
    const run = () => {
      // A oscuras se acomoda de golpe: que al volver no se vea nada a medio camino.
      mon.classList.add('is-resetting');
      resetScene();
      if (slide.enter) slide.enter();
      void screen.offsetWidth;
      mon.classList.remove('is-resetting', 'is-cut');
      slide.play();
      later(slide.ms, () => showSlide((index + 1) % SLIDES.length, true));
    };
    if (!cut) {
      run();
      return;
    }
    mon.classList.add('is-cut');
    later(CUT_MS, run);
  }

  /** Arranca el recorrido: aparece la flecha y empieza a moverse sola. */
  function startTour() {
    if (touring) return;
    touring = true;
    mon.classList.add('is-interactive');
    showSlide(0, true);
  }

  function stopTour() {
    touring = false;
    clearSlideTimers();
    mon.classList.remove('is-cut', 'is-resetting');
    resetScene();
  }

  /** ---------------- Estados ---------------- */

  function begin(retrying) {
    setState('working');
    setStatus(retrying ? 'Reintentando…' : 'Conectando…', '', true);
    startTour();
  }

  function onProgress(received, total) {
    const known = total > 0;
    const percent = known ? Math.min(100, (received / total) * 100) : 0;
    bar.classList.remove('is-busy');
    barFill.style.width = `${percent}%`;
    statusText.textContent = known ? `Descargando · ${Math.floor(percent)} %` : 'Descargando…';
    statusDetail.textContent = known ? `${megas(received)} de ${megas(total)} MB` : `${megas(received)} MB`;
  }

  function onPhase(phase) {
    if (phase === 'downloading') {
      if (root.dataset.state !== 'working') begin(false);
      return;
    }
    if (phase === 'verifying') {
      setStatus('Verificando la descarga…', '', true);
      return;
    }
    if (phase === 'installing') {
      setStatus('Instalando…', 'Falta poco', true);
      return;
    }
    if (phase === 'launching') {
      stopTour();
      setState('done');
      setCopy('Listo, ya está instalado', 'Se abre inplaize con un recorrido corto para dejarlo a\u00a0tu\u00a0gusto.');
      setStatus('Abriendo inplaize…', '', false);
      barFill.style.width = '100%';
    }
  }

  function onError(code) {
    stopTour();
    setState('error');
    $('error-text').textContent = ERRORS[code] || ERRORS.network;
    // Si falló antes de instalar, el equipo quedó como estaba; si falló instalando, no se sabe.
    setCopy(
      'Algo no salió bien',
      code === 'install' ? 'inplaize no quedó instalado.' : 'No se cambió nada en tu equipo.',
    );
  }

  function onInit(info) {
    const bits = [];
    if (info.version) bits.push(`inplaize ${info.version}`);
    if (info.sizeBytes > 0) bits.push(`descarga de ${megas(info.sizeBytes)} MB`);
    bits.push('no pide permisos de administrador');
    $('install-note').textContent = bits.join(' · ');
  }

  function onHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') onInit(msg);
    else if (msg.type === 'progress') onProgress(Number(msg.received) || 0, Number(msg.total) || 0);
    else if (msg.type === 'phase') onPhase(msg.phase);
    else if (msg.type === 'error') onError(msg.code);
  }

  /** ---------------- Sin programa atrás: descarga de mentira ---------------- */

  let fakeTimer = 0;
  let fakeFailed = false;

  function simulate(command) {
    if (command === 'ready') {
      onHostMessage({ type: 'init', version: '0.0.0', sizeBytes: 126 * 1048576 });
      return;
    }
    if (command !== 'install' && command !== 'retry') return;
    const params = new URLSearchParams(location.search);
    const failWith = fakeFailed ? '' : params.get('fail');
    const total = 126 * 1048576;
    let received = 0;
    clearInterval(fakeTimer);
    onHostMessage({ type: 'phase', phase: 'downloading' });
    fakeTimer = setInterval(() => {
      received = Math.min(total, received + total / 220);
      onHostMessage({ type: 'progress', received, total });
      if (failWith && received > total * 0.3) {
        clearInterval(fakeTimer);
        fakeFailed = true;
        onHostMessage({ type: 'error', code: failWith });
        return;
      }
      if (received < total) return;
      clearInterval(fakeTimer);
      onHostMessage({ type: 'phase', phase: 'verifying' });
      setTimeout(() => onHostMessage({ type: 'phase', phase: 'installing' }), 1200);
      setTimeout(() => onHostMessage({ type: 'phase', phase: 'launching' }), 6200);
    }, 120);
  }

  function send(command) {
    if (host) host.postMessage(command);
    else simulate(command);
  }

  /** ---------------- Arranque ---------------- */

  setCopy(
    'Todo en su lugar.',
    'Tus sitios y programas de todos los días en una barra, cada uno en su propia ventana.',
  );
  onInit({});

  $('install-btn').addEventListener('click', () => {
    if (root.dataset.state !== 'welcome') return;
    begin(false);
    send('install');
  });
  $('retry-btn').addEventListener('click', () => {
    if (root.dataset.state !== 'error') return;
    begin(true);
    send('retry');
  });
  $('full-btn').addEventListener('click', () => send('open-full'));
  // Es una ventana de programa, no una página: sin menú del navegador.
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  if (host) host.addEventListener('message', (e) => onHostMessage(e.data));
  send('ready');
  $('install-btn').focus();
})();

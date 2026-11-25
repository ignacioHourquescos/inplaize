/**
 * Entrada de una pestaña nueva.
 * Lottie pinta el rosa de la marca (--key-line): arranca a plena intensidad
 * y se apaga hasta dejar la pestaña como en reposo. El slide up lo hace el CSS.
 */
(function (root) {
  function colorChannels(token) {
    const probe = document.createElement('span');
    probe.style.color = 'var(' + token + ')';
    document.body.appendChild(probe);
    const raw = getComputedStyle(probe).color;
    probe.remove();
    const parts = String(raw || '').match(/[\d.]+/g);
    if (!parts || parts.length < 3) return [0.957, 0.447, 0.714];
    return [
      Math.min(1, Number(parts[0]) / 255),
      Math.min(1, Number(parts[1]) / 255),
      Math.min(1, Number(parts[2]) / 255),
    ];
  }

  function mix(rgb, toward, amount) {
    return rgb.map((channel, i) => channel + (toward[i] - channel) * amount);
  }

  function hold(prop) {
    return { a: 0, k: prop };
  }

  function opacityKeys(keys) {
    const frames = [];
    for (let i = 0; i < keys.length; i += 1) {
      const frame = { t: keys[i].t, s: [keys[i].v] };
      if (i < keys.length - 1) {
        frame.i = { x: [0.4], y: [1] };
        frame.o = { x: [0.2], y: [0] };
      }
      frames.push(frame);
    }
    return { a: 1, k: frames };
  }

  function rectGroup(width, height, rgb, name) {
    return {
      ty: 'gr',
      nm: name,
      np: 3,
      cix: 2,
      bm: 0,
      ix: 1,
      hd: false,
      it: [
        {
          ty: 'rc',
          d: 1,
          s: hold([width, height]),
          p: hold([0, 0]),
          r: hold(0),
          nm: 'rect',
        },
        {
          ty: 'fl',
          c: hold(rgb.concat(1)),
          o: hold(100),
          r: 1,
          bm: 0,
          nm: 'fill',
          hd: false,
        },
        {
          ty: 'tr',
          p: hold([0, 0]),
          a: hold([0, 0]),
          s: hold([100, 100]),
          r: hold(0),
          o: hold(100),
          sk: hold(0),
          sa: hold(0),
          nm: 'tr',
        },
      ],
    };
  }

  function layer(index, name, shapes, opacity, position) {
    return {
      ddd: 0,
      ind: index,
      ty: 4,
      nm: name,
      sr: 1,
      ks: {
        o: opacity,
        r: hold(0),
        p: position,
        a: hold([0, 0, 0]),
        s: hold([100, 100, 100]),
      },
      ao: 0,
      shapes: shapes,
      ip: 0,
      op: 30,
      st: 0,
      bm: 0,
    };
  }

  function animationData() {
    const rgb = colorChannels('--key-line');
    const sheen = mix(rgb, [1, 1, 1], 0.42);
    return {
      v: '5.7.4',
      fr: 60,
      ip: 0,
      op: 30,
      w: 100,
      h: 40,
      nm: 'tab-enter',
      ddd: 0,
      assets: [],
      layers: [
        layer(
          1,
          'wash',
          [rectGroup(100, 40, rgb, 'wash')],
          opacityKeys([
            { t: 0, v: 88 },
            { t: 30, v: 0 },
          ]),
          hold([50, 20, 0]),
        ),
        layer(
          2,
          'sheen',
          [rectGroup(26, 48, sheen, 'sheen')],
          opacityKeys([
            { t: 0, v: 70 },
            { t: 30, v: 0 },
          ]),
          {
            a: 1,
            k: [
              {
                i: { x: 0.2, y: 1 },
                o: { x: 0.45, y: 0 },
                t: 0,
                s: [50, 58, 0],
                to: [0, 0, 0],
                ti: [0, 0, 0],
              },
              { t: 30, s: [50, -16, 0] },
            ],
          },
        ),
      ],
    };
  }

  function stretch(fx) {
    const svg = fx.querySelector('svg');
    if (!svg) return;
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.width = '100%';
    svg.style.height = '100%';
  }

  function play(el) {
    if (!el || !root.lottie) return null;
    const fx = document.createElement('div');
    fx.className = 'subtab-enter-fx';
    fx.setAttribute('aria-hidden', 'true');
    el.appendChild(fx);
    let anim = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        if (anim) anim.destroy();
      } catch {
        /* ya destruida */
      }
      if (fx.parentNode) fx.remove();
    };
    try {
      anim = root.lottie.loadAnimation({
        container: fx,
        renderer: 'svg',
        loop: false,
        autoplay: true,
        animationData: animationData(),
        rendererSettings: {
          preserveAspectRatio: 'none',
          progressiveLoad: false,
          hideOnTransparent: true,
        },
      });
    } catch {
      close();
      el.classList.add('is-entering-css');
      return null;
    }
    anim.addEventListener('DOMLoaded', () => stretch(fx));
    anim.addEventListener('complete', close);
    anim.addEventListener('data_failed', () => {
      close();
      el.classList.add('is-entering-css');
    });
    root.setTimeout(close, 2000);
    return anim;
  }

  root.InplaizeTabEnter = { play };
})(typeof window !== 'undefined' ? window : globalThis);

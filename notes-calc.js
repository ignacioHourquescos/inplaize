'use strict';

/**
 * Cálculos en los renglones de Notas.
 * Un renglón que empieza con "=" se calcula: "=23414*2". Además abre el modo
 * cálculo: los renglones que siguen se calculan sin necesidad del "=", hasta
 * el primer renglón vacío (un documento o una imagen también lo cortan).
 * "=sueldo: 850000" define una variable, que vale para los renglones de más
 * abajo en la misma columna. "total" suma los resultados de arriba, desde el
 * total anterior. "1200 + 21%" suma el porcentaje.
 * Coma y punto valen como decimal; "1.234,56" y "1.234.567" llevan miles.
 * Lo que no se puede calcular queda como texto común, sin resultado.
 * El resultado se escribe con el formato de setFormat: separador de miles,
 * separador decimal y cantidad de decimales. Por defecto, miles con punto,
 * decimales con coma y hasta seis decimales, sin ceros de más.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.InplaizeNotesCalc = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*/u;
  const DEF_RE = /^([\p{L}_][\p{L}\p{N}_]*)\s*[:=]\s*(\S.*)$/u;
  const NUM_RE = /^(?:\d+(?:[.,]\d*)*|[.,]\d+)/;
  const OP_ALIASES = { '×': '*', '÷': '/', '−': '-', '–': '-' };
  const OPS = '+-*/^()%';
  const TOTAL_NAMES = new Set(['total', 'suma']);
  const MAX_ABS = 1e15;
  const FAIL = new Error('calc');
  const FORMAT_KEY = '__inplaizeCalcFormat';
  const DEFAULT_FORMAT = { thousands: '.', decimal: ',', decimals: 'auto' };

  function formatHost() {
    if (typeof globalThis !== 'undefined') return globalThis;
    if (typeof window !== 'undefined') return window;
    return null;
  }

  function normalizeFormat(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const thousands = src.thousands === ',' || src.thousands === ' ' || src.thousands === '' || src.thousands === '.'
      ? src.thousands
      : DEFAULT_FORMAT.thousands;
    let decimal = src.decimal === '.' ? '.' : ',';
    if (thousands && decimal === thousands) decimal = thousands === '.' ? ',' : '.';
    let decimals = 'auto';
    if (src.decimals != null && src.decimals !== '' && src.decimals !== 'auto') {
      const n = Number(src.decimals);
      if (Number.isInteger(n) && n >= 0 && n <= 6) decimals = String(n);
    }
    return { thousands, decimal, decimals };
  }

  function getFormat() {
    const host = formatHost();
    return normalizeFormat(host && host[FORMAT_KEY]);
  }

  function setFormat(partial) {
    const patch = {};
    if (partial && typeof partial === 'object') {
      if (partial.thousands != null) patch.thousands = partial.thousands;
      if (partial.decimal != null) patch.decimal = partial.decimal;
      if (partial.decimals != null && partial.decimals !== '') patch.decimals = partial.decimals;
    }
    const next = normalizeFormat({ ...getFormat(), ...patch });
    const host = formatHost();
    if (host) host[FORMAT_KEY] = next;
    return { ...next };
  }

  function fail() {
    throw FAIL;
  }

  function clean(value) {
    return Number(value.toPrecision(12));
  }

  function parseNumber(raw) {
    const dots = raw.split('.').length - 1;
    const commas = raw.split(',').length - 1;
    let text;
    if (dots && commas) {
      const decimal = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
      if ((decimal === '.' ? dots : commas) !== 1) return null;
      text = raw.split(decimal === '.' ? ',' : '.').join('').replace(',', '.');
    } else if (dots > 1 || commas > 1) {
      if (!/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) return null;
      text = raw.replace(/[.,]/g, '');
    } else {
      text = raw.replace(',', '.');
    }
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      const rest = src.slice(i);
      const num = NUM_RE.exec(rest);
      if (num) {
        const value = parseNumber(num[0]);
        if (value === null) return null;
        tokens.push({ t: 'num', v: value });
        i += num[0].length;
        continue;
      }
      const name = NAME_RE.exec(rest);
      if (name) {
        tokens.push({ t: 'id', v: name[0].toLowerCase() });
        i += name[0].length;
        continue;
      }
      const op = OP_ALIASES[ch] || ch;
      if (!OPS.includes(op)) return null;
      tokens.push({ t: op });
      i += 1;
    }
    return tokens;
  }

  /** Cada valor es { v, pct }: con pct, v es un porcentaje (21 para "21%"). */
  function evaluate(tokens, vars, sumAbove) {
    let pos = 0;
    let usesTotal = false;
    const take = (type) => {
      if (!tokens[pos] || tokens[pos].t !== type) return false;
      pos += 1;
      return true;
    };
    const plain = (x) => (x.pct ? x.v / 100 : x.v);

    function primary() {
      const tok = tokens[pos];
      pos += 1;
      if (!tok) fail();
      if (tok.t === 'num') return { v: tok.v, pct: false };
      if (tok.t === 'id') {
        if (vars.has(tok.v)) return vars.get(tok.v);
        if (!TOTAL_NAMES.has(tok.v)) fail();
        usesTotal = true;
        return { v: sumAbove, pct: false };
      }
      if (tok.t !== '(') fail();
      const inner = sum();
      if (!take(')')) fail();
      return inner;
    }

    function postfix() {
      const x = primary();
      if (!take('%')) return x;
      if (x.pct) fail();
      return { v: x.v, pct: true };
    }

    function power() {
      const base = postfix();
      if (!take('^')) return base;
      return { v: Math.pow(plain(base), plain(unary())), pct: false };
    }

    function unary() {
      if (take('-')) {
        const x = unary();
        return { v: -x.v, pct: x.pct };
      }
      if (take('+')) return unary();
      return power();
    }

    function product() {
      let left = unary();
      for (;;) {
        if (take('*')) {
          left = { v: plain(left) * plain(unary()), pct: false };
        } else if (take('/')) {
          const divisor = plain(unary());
          if (divisor === 0) fail();
          left = { v: plain(left) / divisor, pct: false };
        } else {
          return left;
        }
      }
    }

    function sum() {
      let left = product();
      for (;;) {
        const sign = take('+') ? 1 : take('-') ? -1 : 0;
        if (!sign) return left;
        const right = product();
        if (right.pct && left.pct) left = { v: left.v + sign * right.v, pct: true };
        else if (right.pct) left = { v: left.v + (sign * left.v * right.v) / 100, pct: false };
        else left = { v: plain(left) + sign * right.v, pct: false };
      }
    }

    const result = sum();
    if (pos !== tokens.length) fail();
    return { v: result.v, pct: result.pct, usesTotal };
  }

  function parseLine(src) {
    const body = (src[0] === '=' ? src.slice(1) : src).trim();
    if (!body) return null;
    const def = DEF_RE.exec(body);
    return def ? { name: def[1], expr: def[2].trim(), body } : { name: '', expr: body, body };
  }

  /**
   * Escribe un número con el formato activo. grouped en false omite los miles
   * (lo que se copia). override cambia solo esa llamada, sin guardar.
   */
  function formatNumber(value, grouped, override) {
    const fmt = override ? normalizeFormat({ ...getFormat(), ...override }) : getFormat();
    const rounded = clean(value);
    if (!Number.isFinite(rounded) || Math.abs(rounded) >= MAX_ABS) return '';
    const places = fmt.decimals === 'auto' ? 6 : Number(fmt.decimals);
    const parts = Math.abs(rounded).toFixed(places).split('.');
    let frac = parts[1] || '';
    if (fmt.decimals === 'auto') frac = frac.replace(/0+$/, '');
    const thousands = grouped === false ? '' : fmt.thousands;
    const whole = thousands ? parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands) : parts[0];
    const magnitude = Number(`${parts[0]}.${frac || '0'}`);
    const negative = rounded < 0 && magnitude !== 0;
    return (negative ? '-' : '') + whole + (frac ? `${fmt.decimal}${frac}` : '');
  }

  function isLiteral(tokens) {
    if (!tokens.length || tokens[0].t !== 'num') return false;
    return tokens.length === 1 || (tokens.length === 2 && tokens[1].t === '%');
  }

  /**
   * Recibe los textos de una columna, de arriba hacia abajo ('' para lo que
   * no es texto).
   * Devuelve, por renglón, null o { value, percent, name, display, copy, text }.
   */
  function evaluateLines(lines) {
    const vars = new Map();
    let sumAbove = 0;
    let calcMode = false;
    return (Array.isArray(lines) ? lines : []).map((raw) => {
      const src = String(raw == null ? '' : raw).trim();
      if (!src) {
        calcMode = false;
        return null;
      }
      if (src[0] === '=') calcMode = true;
      if (!calcMode) return null;
      const line = parseLine(src);
      if (!line) return null;
      const tokens = tokenize(line.expr);
      if (!tokens || !tokens.length) return null;
      let result;
      try {
        result = evaluate(tokens, vars, sumAbove);
      } catch {
        // Expresión incompleta, variable sin definir o demasiado anidada.
        return null;
      }
      const value = clean(result.v);
      const number = formatNumber(value, true);
      if (!number) return null;
      if (line.name) vars.set(line.name.toLowerCase(), { v: value, pct: result.pct });
      if (result.usesTotal) sumAbove = 0;
      else if (!result.pct) sumAbove = clean(sumAbove + value);
      const suffix = result.pct ? '%' : '';
      const display = number + suffix;
      return {
        value,
        percent: result.pct,
        name: line.name,
        display,
        copy: formatNumber(value, false) + suffix,
        text: isLiteral(tokens) ? line.body : `${line.body} = ${display}`,
      };
    });
  }

  return { evaluateLines, formatNumber, getFormat, setFormat };
});

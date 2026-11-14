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

  /** Miles con punto y decimales con coma; hasta seis decimales. */
  function formatNumber(value, grouped) {
    const rounded = clean(value);
    if (!Number.isFinite(rounded) || Math.abs(rounded) >= MAX_ABS) return '';
    const parts = Math.abs(rounded).toFixed(6).split('.');
    const frac = parts[1].replace(/0+$/, '');
    const whole = grouped ? parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') : parts[0];
    const negative = rounded < 0 && (frac || whole !== '0');
    return (negative ? '-' : '') + whole + (frac ? `,${frac}` : '');
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

  return { evaluateLines, formatNumber };
});

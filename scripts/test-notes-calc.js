'use strict';

const assert = require('assert');
const { evaluateLines, formatNumber } = require('../notes-calc');

function shown(lines) {
  return evaluateLines(lines).map((item) => (item ? item.display : null));
}

function one(text) {
  return shown([text])[0];
}

// Lo básico y la precedencia.
assert.strictEqual(one('=23414*2'), '46.828');
assert.strictEqual(one('=12313*1'), '12.313');
assert.strictEqual(one('  = 2 + 3 * 4'), '14');
assert.strictEqual(one('=(2 + 3) * 4'), '20');
assert.strictEqual(one('=2^3^2'), '512');
assert.strictEqual(one('=-2^2'), '-4');
assert.strictEqual(one('=10 - -3'), '13');
assert.strictEqual(one('=10 × 2 ÷ 4'), '5');
assert.strictEqual(one('=\u00a02\u00a0+\u00a02'), '4');
assert.strictEqual(one('=0,1 + 0,2'), '0,3');
assert.strictEqual(one('=1/3'), '0,333333');
assert.strictEqual(one('=5 - 5,0000000001'), '0');

// Números: coma y punto como decimal, miles solo cuando no hay duda.
assert.strictEqual(one('=1,5 + 1.5'), '3');
assert.strictEqual(one('=2.'), '2');
assert.strictEqual(one('=.5 * 2'), '1');
assert.strictEqual(one('=1.234,56'), '1.234,56');
assert.strictEqual(one('=1,234.56'), '1.234,56');
assert.strictEqual(one('=1.234.567'), '1.234.567');
assert.strictEqual(one('=1.500'), '1,5');
assert.strictEqual(one('=1.2.3'), null);
assert.strictEqual(one('=1,2.3,4'), null);

// Porcentajes.
assert.strictEqual(one('=1200 + 21%'), '1.452');
assert.strictEqual(one('=1200 - 10%'), '1.080');
assert.strictEqual(one('=1200 * 21%'), '252');
assert.strictEqual(one('=21% * 1200'), '252');
assert.strictEqual(one('=50 / 10%'), '500');
assert.strictEqual(one('=21%'), '21%');
assert.strictEqual(one('=10% + 5%'), '15%');
assert.strictEqual(one('=5%%'), null);

// Lo que no se calcula queda como texto.
assert.strictEqual(one('Pedido a LOCX'), null);
assert.strictEqual(one('='), null);
assert.strictEqual(one('=23414*'), null);
assert.strictEqual(one('=(2+3'), null);
assert.strictEqual(one('=2 3'), null);
assert.strictEqual(one('=hola'), null);
assert.strictEqual(one('==5'), null);
assert.strictEqual(one('=5/0'), null);
assert.strictEqual(one('=10^400'), null);
assert.strictEqual(one(`=${'('.repeat(4000)}1`), null);
assert.strictEqual(one(null), null);

// Variables: valen hacia abajo, sin distinguir mayúsculas.
assert.deepStrictEqual(
  shown(['=sueldo * 2', '=sueldo: 850000', 'una nota', '=Sueldo * 0,3', '=ahorro = sueldo - 255000', '=AHORRO / 2']),
  [null, '850.000', null, '255.000', '595.000', '297.500'],
);
assert.deepStrictEqual(shown(['=año_1: 10', '=año_1 + 1']), ['10', '11']);
assert.deepStrictEqual(shown(['=iva: 21%', '=1000 + iva', '=1000 * iva']), ['21%', '1.210', '210']);
assert.deepStrictEqual(shown(['=a: 2', '=a: a * 5', '=a']), ['2', '10', '10']);

// Total: suma lo de arriba desde el total anterior; los porcentajes no suman.
assert.deepStrictEqual(
  shown(['=alquiler: 300000', '=80000', 'texto', '=iva: 21%', '=total', '=100', '=50', '=suma', '=total']),
  ['300.000', '80.000', null, '21%', '380.000', '100', '50', '150', '0'],
);
assert.deepStrictEqual(shown(['=100', '=total + 21%', '=total']), ['100', '121', '0']);
assert.deepStrictEqual(shown(['=100', '=total: 5', '=total']), ['100', '5', '5']);

// Modo cálculo: un "=" lo abre y sigue hasta el primer renglón vacío.
assert.deepStrictEqual(
  shown(['sueldo*3', '=sueldo=3000', 'sueldo*3', 'una nota', 'extra: 500', 'sueldo + extra', 'total', '', 'sueldo*3', '100', '=sueldo']),
  [null, '3.000', '9.000', null, '500', '3.500', '16.000', null, null, null, '3.000'],
);
assert.deepStrictEqual(shown(['=', '2 + 2', '   ', '2 + 2']), [null, '4', null, null]);
assert.deepStrictEqual(shown(['=hola', '10 * 2', '\u00a0', '10 * 2']), [null, '20', null, null]);
assert.strictEqual(evaluateLines(['=1', '23414*2'])[1].text, '23414*2 = 46.828');

// Lo que se copia y lo que pasa a un documento.
const [calc, literal, named, percent] = evaluateLines(['=23414*2 + 0,5', '=850000', '=sueldo: 850000 * 2', '=iva: 21%']);
assert.strictEqual(calc.copy, '46828,5');
assert.strictEqual(calc.text, '23414*2 + 0,5 = 46.828,5');
assert.strictEqual(literal.text, '850000');
assert.strictEqual(named.name, 'sueldo');
assert.strictEqual(named.text, 'sueldo: 850000 * 2 = 1.700.000');
assert.strictEqual(percent.text, 'iva: 21%');
assert.strictEqual(percent.copy, '21%');

assert.strictEqual(formatNumber(-1234567.891, true), '-1.234.567,891');
assert.strictEqual(formatNumber(-0.0000001, true), '0');
assert.strictEqual(formatNumber(1e15, true), '');
assert.strictEqual(formatNumber(NaN, true), '');

console.log('notes-calc: ok');

// Tests para src/services/heading — pipeline completo con filtrado
// de ruido (distancia/tiempo mínimos) y suavizado.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHeadingCalculator } = require('../src/services/heading');

test('heading: primera posición devuelve 0', () => {
    const h = createHeadingCalculator();
    assert.equal(h.update(-34.25, -59.47, 1000), 0);
});

test('heading: segunda posición muy cercana (< 0.5m) mantiene heading previo', () => {
    const h = createHeadingCalculator();
    h.update(-34.25, -59.47, 1000);
    const r = h.update(-34.250001, -59.470001, 2000); // <1m
    assert.equal(r, 0, 'no hay suficiente movimiento para calcular');
    assert.equal(h.historyLength(), 0);
});

test('heading: movimiento norte real (>0.5m) devuelve heading ~0°', () => {
    const h = createHeadingCalculator();
    h.update(-34.25,    -59.47, 1000);
    // +0.0001° latitud ≈ 11 m al norte
    const r = h.update(-34.2499, -59.47, 2000);
    assert.ok(h.historyLength() > 0);
    assert.ok(r < 5 || r > 355, `esperado cerca de 0°, got ${r}`);
});

test('heading: movimiento este devuelve ~90°', () => {
    const h = createHeadingCalculator();
    h.update(-34.25, -59.47, 1000);
    const r = h.update(-34.25, -59.4699, 2000); // +0.0001 lon
    assert.ok(Math.abs(r - 90) < 5, `esperado ~90°, got ${r}`);
});

test('heading: intervalo < 100ms descarta muestra', () => {
    const h = createHeadingCalculator();
    h.update(-34.25, -59.47, 1000);
    h.update(-34.2499, -59.47, 1050); // solo 50ms después
    assert.equal(h.historyLength(), 0);
});

test('heading: reset limpia historial y lastPosition', () => {
    const h = createHeadingCalculator();
    h.update(-34.25, -59.47, 1000);
    h.update(-34.2499, -59.47, 2000);
    h.reset();
    assert.equal(h.historyLength(), 0);
    assert.equal(h.current(), 0);
    assert.equal(h.update(-34.25, -59.47, 3000), 0, 'tras reset, primera update = 0');
});

test('heading: history tope = maxHistory', () => {
    const h = createHeadingCalculator({ maxHistory: 3 });
    let t = 1000;
    // warm up
    h.update(-34.25, -59.47, t); t += 200;
    // 5 muestras válidas con > 100ms y > 0.5m entre ellas
    for (let i = 1; i <= 5; i++) {
        h.update(-34.25 + i * 0.0001, -59.47, t);
        t += 200;
    }
    assert.equal(h.historyLength(), 3, 'history debe estar capado en 3');
});

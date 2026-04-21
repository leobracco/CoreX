// Tests para src/services/geo — funciones puras de geografía.

const test = require('node:test');
const assert = require('node:assert/strict');

const { haversineMeters, bearingDeg, smoothHeadingDeg } = require('../src/services/geo');

// ---------- haversineMeters ----------

test('haversine: mismo punto = 0', () => {
    assert.equal(haversineMeters(-34.25, -59.47, -34.25, -59.47), 0);
});

test('haversine: 1° de latitud ≈ 111 km', () => {
    const d = haversineMeters(0, 0, 1, 0);
    assert.ok(Math.abs(d - 111_195) < 50, `esperado ~111195, got ${d}`);
});

test('haversine: 1° de longitud en ecuador ≈ 111 km', () => {
    const d = haversineMeters(0, 0, 0, 1);
    assert.ok(Math.abs(d - 111_195) < 50);
});

test('haversine: simétrica (ida y vuelta)', () => {
    const a = haversineMeters(-34.25, -59.47, -34.26, -59.48);
    const b = haversineMeters(-34.26, -59.48, -34.25, -59.47);
    assert.equal(a, b);
});

// ---------- bearingDeg ----------

test('bearing: norte puro = 0°', () => {
    const h = bearingDeg(0, 0, 1, 0);
    assert.ok(Math.abs(h - 0) < 0.01);
});

test('bearing: este puro ≈ 90°', () => {
    const h = bearingDeg(0, 0, 0, 1);
    assert.ok(Math.abs(h - 90) < 0.01);
});

test('bearing: sur puro = 180°', () => {
    const h = bearingDeg(0, 0, -1, 0);
    assert.ok(Math.abs(h - 180) < 0.01);
});

test('bearing: oeste puro = 270°', () => {
    const h = bearingDeg(0, 0, 0, -1);
    assert.ok(Math.abs(h - 270) < 0.01);
});

test('bearing: siempre en [0, 360)', () => {
    for (const [la1, lo1, la2, lo2] of [[0,0,1,1],[0,0,-1,-1],[45,45,44,46]]) {
        const h = bearingDeg(la1, lo1, la2, lo2);
        assert.ok(h >= 0 && h < 360);
    }
});

// ---------- smoothHeadingDeg ----------

test('smoothHeading: array vacío = 0', () => {
    assert.equal(smoothHeadingDeg([]), 0);
});

test('smoothHeading: rumbos iguales → mismo rumbo', () => {
    const h = smoothHeadingDeg([45, 45, 45, 45, 45]);
    assert.ok(Math.abs(h - 45) < 0.01);
});

test('smoothHeading: maneja discontinuidad 359° ↔ 1° (circular)', () => {
    // Media circular de 359° y 1° debe ser ~0°, no 180°
    const h = smoothHeadingDeg([359, 1]);
    assert.ok(h < 5 || h > 355, `esperado cerca de 0, got ${h}`);
});

test('smoothHeading: pondera más al último valor', () => {
    // Peso (i+1)/N: el último (i=N-1) tiene peso 1, el primero (i=0) tiene peso 1/N.
    // Con [0, 90] el resultado debe inclinarse hacia 90.
    const h = smoothHeadingDeg([0, 90]);
    assert.ok(h > 45, `ponderado hacia 90, got ${h}`);
});

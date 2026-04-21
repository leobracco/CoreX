// Tests para src/services/metrics — registry + formato Prometheus.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMetrics, fullKey, labelsKey } = require('../src/services/metrics');

// ---------- helpers de naming ----------

test('labelsKey: ordena claves alfabéticamente (output determinista)', () => {
    const a = labelsKey({ b: 2, a: 1 });
    const b = labelsKey({ a: 1, b: 2 });
    assert.equal(a, b);
    assert.equal(a, 'a="1",b="2"');
});

test('labelsKey: escapa comillas y saltos de línea', () => {
    assert.equal(labelsKey({ x: 'say "hi"' }), 'x="say _hi_"');
    assert.equal(labelsKey({ x: 'a\nb' }),      'x="a_b"');
});

test('fullKey: sin labels solo el nombre; con labels con {}', () => {
    assert.equal(fullKey('foo'),               'foo');
    assert.equal(fullKey('foo', {}),           'foo');
    assert.equal(fullKey('foo', { x: 'y' }),   'foo{x="y"}');
});

// ---------- counter ----------

test('counter: empieza en 0 e incrementa', () => {
    const m = createMetrics();
    const c = m.counter('hits_total');
    assert.equal(c.value(), 0);
    c.inc();
    c.inc(4);
    assert.equal(c.value(), 5);
});

test('counter: mismas etiquetas devuelven el mismo contador', () => {
    const m = createMetrics();
    m.counter('http_total', { code: '200' }).inc();
    m.counter('http_total', { code: '200' }).inc();
    m.counter('http_total', { code: '500' }).inc();
    assert.equal(m.counter('http_total', { code: '200' }).value(), 2);
    assert.equal(m.counter('http_total', { code: '500' }).value(), 1);
});

// ---------- gauge ----------

test('gauge: set/inc/dec', () => {
    const m = createMetrics();
    const g = m.gauge('temp');
    g.set(22.5);
    assert.equal(g.value(), 22.5);
    g.inc(1.5);
    assert.equal(g.value(), 24);
    g.dec(4);
    assert.equal(g.value(), 20);
});

// ---------- render (formato Prometheus) ----------

test('render: incluye HELP y TYPE una vez por métrica', () => {
    const m = createMetrics();
    m.counter('foo_total', {}, 'cuenta de foos').inc();
    m.counter('foo_total', { x: 'a' }).inc(2);
    m.gauge('bar', {}, 'valor de bar').set(42);

    const out = m.render();
    // HELP/TYPE aparecen una vez por nombre, no por serie
    assert.equal(out.match(/# HELP foo_total/g).length, 1);
    assert.equal(out.match(/# TYPE foo_total counter/g).length, 1);
    assert.equal(out.match(/# HELP bar/g).length, 1);
    assert.equal(out.match(/# TYPE bar gauge/g).length, 1);
});

test('render: emite todas las series de una métrica', () => {
    const m = createMetrics();
    m.counter('udp_total', { pgn: '100' }).inc(3);
    m.counter('udp_total', { pgn: '254' }).inc(7);
    const out = m.render();
    assert.match(out, /udp_total\{pgn="100"\} 3/);
    assert.match(out, /udp_total\{pgn="254"\} 7/);
});

test('render: series sin labels se emiten sin llaves', () => {
    const m = createMetrics();
    m.gauge('uptime_seconds').set(100);
    assert.match(m.render(), /^uptime_seconds 100$/m);
});

test('render: métrica declarada sin help no emite línea HELP', () => {
    const m = createMetrics();
    m.counter('noop').inc();
    const out = m.render();
    assert.doesNotMatch(out, /# HELP noop/);
    assert.match(out, /# TYPE noop counter/);
});

test('reset: vacía registry', () => {
    const m = createMetrics();
    m.counter('foo').inc();
    m.reset();
    assert.equal(m.render(), '');
});

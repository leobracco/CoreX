// Tests para src/modules/observability — HTTP /healthz /metrics /version.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createMetrics } = require('../src/services/metrics');
const { createObservabilityModule, buildHealthz } = require('../src/modules/observability');
const { createLogger } = require('../src/services/logger');

function fakeState(overrides = {}) {
    const s = {
        position:  { lat: 0, lon: 0, ts: 0 },
        heading:   0,
        speed_kmh: 0,
        painting:  false,
        field:     { name: '', accion: '', ts: 0 },
        ...overrides,
    };
    return { get: (k) => s[k], set: (k, v) => { s[k] = v; } };
}
const fakeMqtt = (connected = true) => ({ connected });

// ---------- buildHealthz ----------

test('healthz: status "ok" con MQTT conectado y sin GPS aún', () => {
    const m = createMetrics();
    const body = buildHealthz({ state: fakeState(), mqtt: fakeMqtt(true), metrics: m });
    assert.equal(body.status, 'ok');
    assert.equal(body.mqtt_connected, true);
    assert.equal(body.last_gps_ts, 0);
});

test('healthz: status "degraded" si MQTT desconectado', () => {
    const m = createMetrics();
    const body = buildHealthz({ state: fakeState(), mqtt: fakeMqtt(false), metrics: m });
    assert.equal(body.status, 'degraded');
});

test('healthz: status "degraded" si GPS viejo (>5s)', () => {
    const m = createMetrics();
    const state = fakeState({ position: { lat: 1, lon: 2, ts: Date.now() - 10_000 } });
    const body = buildHealthz({ state, mqtt: fakeMqtt(true), metrics: m });
    assert.equal(body.status, 'degraded');
    assert.ok(body.last_gps_age_ms >= 10_000);
});

test('healthz: incluye udp_frames_total desde metrics', () => {
    const m = createMetrics();
    m.counter('corex_udp_frames_total').inc(42);
    const body = buildHealthz({ state: fakeState(), mqtt: fakeMqtt(true), metrics: m });
    assert.equal(body.udp_frames_total, 42);
});

// ---------- HTTP end-to-end ----------

function getResponse(port, path) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${path}`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

async function startModule({ state, metrics, mqtt } = {}) {
    const logger = createLogger(0);
    const mod = createObservabilityModule({
        mqtt:    mqtt    || fakeMqtt(true),
        state:   state   || fakeState(),
        metrics: metrics || createMetrics(),
        logger,
        config:  { observability: { port: 0 } }, // 0 → OS-assigned
    });
    await mod.start();
    return { mod, port: mod.address().port };
}

test('observability: port<0 no abre server', async () => {
    const logger = createLogger(0);
    const mod = createObservabilityModule({
        mqtt: fakeMqtt(true), state: fakeState(), metrics: createMetrics(), logger,
        config: { observability: { port: -1 } },
    });
    await mod.start();
    assert.equal(mod.address(), null);
    mod.stop();
});

test('observability: GET /healthz devuelve 200 + body saludable', async () => {
    const metrics = createMetrics();
    metrics.counter('corex_udp_frames_total').inc(3);
    const { mod, port } = await startModule({ metrics });
    try {
        const r = await getResponse(port, '/healthz');
        assert.equal(r.status, 200);
        assert.match(r.headers['content-type'], /application\/json/);
        const body = JSON.parse(r.body);
        assert.equal(body.status, 'ok');
        assert.equal(body.udp_frames_total, 3);
        assert.ok(body.uptime_s >= 0);
    } finally { mod.stop(); }
});

test('observability: GET /healthz devuelve 503 si degradado', async () => {
    const { mod, port } = await startModule({ mqtt: fakeMqtt(false) });
    try {
        const r = await getResponse(port, '/healthz');
        assert.equal(r.status, 503);
    } finally { mod.stop(); }
});

test('observability: GET /metrics devuelve formato Prometheus', async () => {
    const metrics = createMetrics();
    metrics.counter('corex_udp_frames_total', {}, 'frames').inc(7);
    metrics.gauge('corex_speed_kmh').set(12.3);
    const { mod, port } = await startModule({ metrics });
    try {
        const r = await getResponse(port, '/metrics');
        assert.equal(r.status, 200);
        assert.match(r.headers['content-type'], /text\/plain/);
        assert.match(r.body, /# TYPE corex_udp_frames_total counter/);
        assert.match(r.body, /corex_udp_frames_total 7/);
        assert.match(r.body, /corex_speed_kmh 12\.3/);
    } finally { mod.stop(); }
});

test('observability: GET /version devuelve JSON', async () => {
    const { mod, port } = await startModule();
    try {
        const r = await getResponse(port, '/version');
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        assert.ok(typeof body.version === 'string' && body.version.length > 0);
        assert.equal(typeof body.pid, 'number');
    } finally { mod.stop(); }
});

test('observability: 404 en path desconocido', async () => {
    const { mod, port } = await startModule();
    try {
        const r = await getResponse(port, '/nope');
        assert.equal(r.status, 404);
    } finally { mod.stop(); }
});

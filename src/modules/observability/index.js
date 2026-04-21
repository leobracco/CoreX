// Módulo Observability: expone un pequeño HTTP server con
//   GET /healthz  → JSON con uptime, versión, último ts de cada fuente,
//                    flag MQTT conectado. 200 si saludable, 503 si no.
//   GET /metrics  → texto Prometheus con todos los contadores/gauges
//   GET /version  → JSON con versión y PID
//
// Usa solo el módulo `http` nativo, sin dependencias extras.

const http = require('node:http');
const { version } = require('../../../package.json');

const START_TS = Date.now();

function buildHealthz({ state, mqtt, metrics }) {
    const now = Date.now();
    const pos = state.get('position');
    const field = state.get('field');

    const body = {
        status:           'ok',
        version,
        uptime_s:         Math.floor((now - START_TS) / 1000),
        mqtt_connected:   !!mqtt?.connected,
        last_gps_ts:      pos?.ts || 0,
        last_gps_age_ms:  pos?.ts ? now - pos.ts : null,
        speed_kmh:        state.get('speed_kmh'),
        painting:         state.get('painting'),
        field_name:       field?.name || '',
        udp_frames_total: metrics.counter('corex_udp_frames_total').value(),
    };

    // Healthy si MQTT conectado y (no hay GPS aún, o GPS < 5s)
    const gpsFresh = !pos?.ts || (now - pos.ts) < 5000;
    if (!body.mqtt_connected || !gpsFresh) {
        body.status = 'degraded';
    }
    return body;
}

function createObservabilityModule({ mqtt, state, logger, config, metrics }) {
    let server = null;

    return {
        name: 'observability',
        subscribe: [],

        start() {
            const port = config.observability?.port ?? 9090;
            if (port < 0) {
                logger.dbg(2, 'OBS', 'deshabilitado (port<0)');
                return Promise.resolve();
            }
            // port=0 → asignado por OS (útil en tests)

            server = http.createServer((req, res) => {
                const url = req.url.split('?')[0];
                if (req.method !== 'GET') {
                    res.writeHead(405); res.end();
                    return;
                }

                if (url === '/healthz') {
                    const body = buildHealthz({ state, mqtt, metrics });
                    const code = body.status === 'ok' ? 200 : 503;
                    res.writeHead(code, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(body));
                    return;
                }

                if (url === '/metrics') {
                    const body = metrics.render();
                    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
                    res.end(body);
                    return;
                }

                if (url === '/version') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ version, pid: process.pid, uptime_s: Math.floor((Date.now() - START_TS) / 1000) }));
                    return;
                }

                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('not found');
            });

            server.on('error', (err) => {
                logger.err('OBS', `http listen: ${err.message}`);
            });

            return new Promise((resolve) => {
                server.listen(port, '0.0.0.0', () => {
                    const bound = server.address()?.port;
                    logger.dbg(1, 'OBS', `HTTP :${bound} — GET /healthz /metrics /version`);
                    resolve();
                });
            });
        },

        stop() {
            if (server) {
                try { server.close(); } catch (_) {}
                server = null;
            }
        },

        address() {
            return server?.address?.() ?? null;
        },
    };
}

module.exports = { createObservabilityModule, buildHealthz };

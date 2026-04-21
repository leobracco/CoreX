// Punto de entrada de CoreX. Cableado puro: sin lógica de dominio acá.
//
//   config → services → state + bus → transport (udp + mqtt) → módulos → arranque
//
// Tras los módulos, conectamos el debug-level dinámico (corex/debug/level)
// y el graceful shutdown (SIGINT/SIGTERM).

const config = require('./config/env');
const { createLogger } = require('./services/logger');
const { createVRA } = require('./services/vra');
const { readJsonSafe, ensureDir } = require('./services/persist');
const { createStore } = require('./state/store');
const { createUdpTransport } = require('./transport/udp');
const { createMqttTransport } = require('./transport/mqtt');
const fs = require('fs');

const { createAogModule }      = require('./modules/aog');
const { createVistaxModule }   = require('./modules/vistax');
const { createFlowxModule }    = require('./modules/flowx');
const { createQuantixModule }  = require('./modules/quantix');
const { createSectionxModule } = require('./modules/sectionx');
const { createLinexModule }    = require('./modules/linex');
const { createStormxModule }   = require('./modules/stormx');

// ── 1. Bootstrap services ──────────────────────────────────────
ensureDir(config.dataDir);

const logger = createLogger(config.debug.level);
const { bus, get, set, merge, snapshot } = createStore();
const store = { get, set, merge, snapshot, bus };

const vra = createVRA();

function cargarMapa() {
    const data = readJsonSafe(config.vra.mapFile);
    if (data) {
        vra.setMap(data);
        logger.dbg(1, 'VRA', 'Mapa prescripción cargado');
    }
}
fs.watchFile(config.vra.mapFile, cargarMapa);
cargarMapa();

logger.dbg(1, 'INIT', `MQTT:${config.mqtt.broker} | UDP:${config.udp.port} | Debug:${logger.getLevel()}`);
logger.dbg(1, 'INIT', `AOG output → ${config.udp.broadcastIp}:${config.udp.portOut} (PGN 253)`);

// ── 2. Transport ───────────────────────────────────────────────
const udp  = createUdpTransport({ port: config.udp.port, bus, logger });
const mqtt = createMqttTransport({ brokerUrl: config.mqtt.broker, bus, logger });

// ── 3. Módulos AgroParallel ────────────────────────────────────
const deps = { mqtt, bus, state: store, logger, config, udp, vra };
const modules = [
    createAogModule(deps),
    createSectionxModule(deps),
    createVistaxModule(deps),
    createFlowxModule(deps),
    createQuantixModule(deps),
    createLinexModule(deps),
    createStormxModule(deps),
];

for (const mod of modules) {
    mod.start();
    for (const topic of mod.subscribe || []) {
        mqtt.subscribe(topic, (t, p) => mod.onMqttMessage(t, p));
    }
}

// ── 4. Debug level dinámico vía MQTT ───────────────────────────
mqtt.subscribe('corex/debug/level', (_topic, payload) => {
    logger.setLevel(parseInt(payload.toString()));
});

// ── 5. UDP listen ──────────────────────────────────────────────
udp.start().then(() => {
    logger.dbg(1, 'INIT', `📡 CoreX Bridge activo | UDP:${config.udp.port}`);
    logger.dbg(1, 'INIT', 'Cambiar nivel: mosquitto_pub -t corex/debug/level -m 2');
});

// ── 6. Graceful shutdown ──────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.dbg(1, 'SHUTDOWN', `Señal ${signal} recibida — cerrando recursos...`);

    for (const mod of modules) {
        try { mod.stop(); } catch (e) { logger.err('SHUTDOWN', `${mod.name}: ${e.message}`); }
    }
    try { udp.stop(); } catch (e) { logger.err('SHUTDOWN', `udp: ${e.message}`); }

    mqtt.stop().then(() => {
        logger.dbg(1, 'SHUTDOWN', '✓ Cerrado limpio');
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { bus, store, mqtt, udp, logger, modules };

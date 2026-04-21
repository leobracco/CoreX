// Carga y normaliza variables de entorno. Fuente única.
// fail-fast suave: valores inválidos caen a defaults y se advierten al log.

require('dotenv').config();
const path = require('path');
const os = require('os');

function envInt(name, def) {
    const v = parseInt(process.env[name]);
    return Number.isFinite(v) ? v : def;
}

function envFloat(name, def) {
    const v = parseFloat(process.env[name]);
    return Number.isFinite(v) ? v : def;
}

function envStr(name, def) {
    const v = process.env[name];
    return (v && v.length > 0) ? v : def;
}

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const config = {
    rootDir:  ROOT_DIR,
    dataDir:  DATA_DIR,

    mqtt: {
        broker: envStr('MQTT_BROKER', 'mqtt://127.0.0.1'),
    },

    udp: {
        port:          envInt('UDP_PORT',       17777),
        broadcastIp:   envStr('AOG_BROADCAST_IP', '127.0.0.1'),
        portOut:       envInt('AOG_PORT_OUT',   17777),
    },

    quantix: {
        configUrl:     envStr('CONFIG_URL', 'http://localhost:8080/api/gis/config-implemento'),
        syncMs:        envInt('QUANTIX_SYNC_MS', 30_000),
    },

    flowx: {
        configFile:    path.join(DATA_DIR, 'flowx_config.json'),
    },

    vra: {
        mapFile:       path.join(DATA_DIR, 'ultimo_mapa.json'),
    },

    sectionx: {
        velMinPintado: envFloat('VEL_MIN_PINTADO', 0.5),
        distTrenMDefault: 1.5,
        historyCap: 2000,
    },

    aog: {
        fieldsPath:    envStr('AOG_FIELDS_PATH', path.join(os.homedir(), 'Documents', 'AgOpenGPS', 'Fields')),
        currentFieldPath: envStr('CURRENT_FIELD_PATH', path.join(os.homedir(), 'Documents', 'AgOpenGPS', 'current_field.json')),
        heartbeatMs:   200,   // PGN 253 heartbeat (crítico: no cambiar sin romper AutoSteer)
        fieldStatusMs: 3_000,
        syncTimeMs:    1_000,
    },

    debug: {
        level:         envInt('DEBUG_LEVEL', 1),
        aogLogDebug:   envInt('AOGLOG_DEBUG', 1),
        logFormat:     envStr('LOG_FORMAT', 'text'), // 'text' | 'json'
    },

    observability: {
        port:          envInt('HEALTH_PORT', 9090),   // 0 para deshabilitar
    },
};

module.exports = config;

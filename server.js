const dgram = require("dgram");
const mqtt  = require("mqtt");
const fs    = require("fs");
const path  = require("path");
const turf  = require("@turf/turf");
const axios = require("axios");
const os    = require("os");
require("dotenv").config();

// ── CoreX: fuente de verdad para campo activo de AgOpenGPS ──
const aogLogWatcher = require("./core/logic/aog_log_watcher");

// ── Protocolo AgOpenGPS (encode/decode/CRC/constantes) ──
const protocol = require("./src/protocol");

// ============================================================
// DEBUG — 3 niveles
// ============================================================
let DBG_LEVEL = parseInt(process.env.DEBUG_LEVEL) || 1;
const C = { r:'\x1b[0m', red:'\x1b[31m', grn:'\x1b[32m', yel:'\x1b[33m', cyn:'\x1b[36m', mag:'\x1b[35m', gry:'\x1b[90m' };

function dbg(level, tag, msg, data) {
  if (level > DBG_LEVEL) return;
  const ts = new Date().toISOString().substr(11, 12);
  const lbl = ['','▸','▸▸','▸▸▸'][level] || '▸';
  const clr = [C.r, C.grn, C.cyn, C.gry][level] || C.r;
  let line = `${C.gry}${ts}${C.r} ${clr}${lbl} [${tag}]${C.r} ${msg}`;
  if (data !== undefined && DBG_LEVEL >= 3) line += ` ${C.gry}${typeof data === 'object' ? JSON.stringify(data) : data}${C.r}`;
  console.log(line);
}
function dbgErr(tag, msg) { console.error(`${C.red}✖ [${tag}]${C.r} ${msg}`); }

let _udpCount = 0;
let _gpsCount = 0;
let _velCount = 0;
let _secCount = 0;

const udpSocket  = dgram.createSocket("udp4");
const mqttClient = mqtt.connect(process.env.MQTT_BROKER || "mqtt://127.0.0.1");

// --- CONFIGURACIÓN ---
const UDP_PORT = parseInt(process.env.UDP_PORT) || 17777;
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const MAPA_PATH        = path.join(DATA_DIR, "ultimo_mapa.json");
const FLOW_CONFIG_PATH = path.join(DATA_DIR, "flowx_config.json");
const CONFIG_URL       = process.env.CONFIG_URL || "http://localhost:8080/api/gis/config-implemento";
const VEL_MIN_PINTADO  = parseFloat(process.env.VEL_MIN_PINTADO) || 0.5;

// ── Envío hacia AgOpenGPS (PGN 253 - From AutoSteer) ──
// Confirmado por pcap del emulador real:
//   - El work switch va en el byte "Switch" del PGN 253 (NO en PGN 237)
//   - AOG escucha en :17777 (loopback) y :8888 (LAN)
//   - El byte Switch: bit 0=work, bit 1=steer, bit 2=mainSwitch (SIEMPRE 1)
const AOG_BROADCAST_IP = process.env.AOG_BROADCAST_IP || "127.0.0.1";
const AOG_PORT_OUT     = parseInt(process.env.AOG_PORT_OUT) || 17777;
const PGN_FROM_STEER   = protocol.PGN.FROM_STEER; // 253 (0xFD)
const SRC_AUTOSTEER    = protocol.SRC.AUTOSTEER;  // 126 (0x7E)

// Estado persistente del PGN 253 (8 bytes)
// Formato del payload: [steerAngleLo][steerAngleHi][hdgLo][hdgHi][rollLo][rollHi][Switch][PWM]
// Inicializamos con mainSwitch=1 (bit 2), todo el resto en 0
const pgn253State = Buffer.alloc(8, 0);
pgn253State[6] = protocol.SWITCH.MAIN; // mainSwitch ON, work OFF, steer OFF

dbg(1, 'INIT', `MQTT: ${process.env.MQTT_BROKER || "mqtt://127.0.0.1"} | UDP: ${UDP_PORT} | Debug: nivel ${DBG_LEVEL}`);

// --- ESTADO GLOBAL ---
let mapaPrescripcion = null;
let configImplemento = {
    anchos_secciones_cm:    [],
    cantidad_secciones_aog: 0,
    motores:                [],
};
let velocidadActual = 0;
let latitud  = 0;
let longitud = 0;

// --- PERSISTENCIA FLOWX ---
let flowConfig = {
    dosisManual: 0,
    modoManual:  true,
    meterCal:    1,
    pwmMinimo:   0,
    pid: { kp: 0.1, ki: 0.0, kd: 0.0 },
};

if (fs.existsSync(FLOW_CONFIG_PATH)) {
    try {
        flowConfig = { ...flowConfig, ...JSON.parse(fs.readFileSync(FLOW_CONFIG_PATH)) };
        dbg(2, 'INIT', 'flowx_config.json cargado');
    } catch (e) {
        dbgErr('INIT', 'Error cargando flowx_config.json');
    }
}

// --- LÓGICA DE SECCIONES ---
let estadosSecciones      = new Array(64).fill(0);
let estadosSeccionesTren2 = new Array(64).fill(0);
let historialSecciones    = [];
let distanciaAcumulada    = 0;
let lastTimestamp         = Date.now();

// --- TRACKING DE HEADING ---
let posicionesHistorial = [];
const MAX_HISTORIAL  = 5;
let ultimaPosicion   = null;
let headingSuavizado = 0;
let ultimoTiempo     = Date.now();

// --- ESTADO PINTADO ---
let aogPainting = false;

// ============================================================
// 1. SINCRONIZACIÓN Y ARCHIVOS
// ============================================================
async function sincronizarConfig() {
    try {
        const res = await axios.get(CONFIG_URL);
        configImplemento = { ...configImplemento, ...res.data };
        dbg(2, 'SYNC', 'Config sincronizada con QuantiX API');
    } catch (e) {
        dbg(2, 'SYNC', 'Esperando API de QuantiX...');
    }
}

function cargarMapa() {
    if (fs.existsSync(MAPA_PATH)) {
        try {
            mapaPrescripcion = JSON.parse(fs.readFileSync(MAPA_PATH));
            dbg(1, 'VRA', 'Mapa prescripción cargado');
        } catch (e) {
            dbgErr('VRA', 'Error leyendo mapa');
        }
    }
}

fs.watchFile(MAPA_PATH, () => cargarMapa());
const configTimer = setInterval(sincronizarConfig, 30000);
sincronizarConfig();
cargarMapa();

// Timers creados dentro de mqttClient.on("connect"); referenciados en shutdown
let pgn253Timer    = null;
let syncTimeTimer  = null;
let fieldStatusTimer = null;

// ============================================================
// 2. ESTADO DE PINTADO
// ============================================================
function actualizarEstadoPintado(secciones) {
    const nuevoPainting = secciones.some(s => s === 1) && velocidadActual > VEL_MIN_PINTADO;
    if (nuevoPainting === aogPainting) return;

    aogPainting = nuevoPainting;
    const campoActual = aogLogWatcher.getCampoActual();
    dbg(1, 'PAINT', `${nuevoPainting ? '▶ INICIADO' : '⏹ DETENIDO'} — "${campoActual}" | vel: ${velocidadActual.toFixed(1)}`);

    if (!mqttClient.connected) return;
    mqttClient.publish("aog/field/status", JSON.stringify({
        painting:  aogPainting,
        fieldName: campoActual,
        ts:        Date.now(),
    }));
}

fieldStatusTimer = setInterval(() => {
    if (!mqttClient.connected) return;
    const payload = {
        painting:  aogPainting,
        fieldName: aogLogWatcher.getCampoActual(),
        ts:        Date.now(),
    };
    mqttClient.publish("aog/field/status", JSON.stringify(payload));
    dbg(3, 'HEART', `painting:${aogPainting} field:"${payload.fieldName}"`);
}, 3000);

// ============================================================
// 3. MQTT
// ============================================================
mqttClient.on("connect", () => {
    dbg(1, 'MQTT', '🚀 Conectado al broker');
    mqttClient.subscribe("agp/flow/ui_cmd");
    mqttClient.subscribe("agp/flow/config_save");
    mqttClient.subscribe("corex/debug/level");
    mqttClient.subscribe("vistax/corex/aog/cmd");

    aogLogWatcher.iniciar(mqttClient);

    syncTimeTimer = setInterval(() => {
        if (latitud === 0 && longitud === 0) return;
        mqttClient.publish("vistax/sync/time", JSON.stringify({
            gps_ts: Date.now(),
            lat:    latitud,
            lon:    longitud,
        }));
        dbg(3, 'SYNC', `time sync lat:${latitud.toFixed(6)} lon:${longitud.toFixed(6)}`);
    }, 1000);

    // ⭐ IMPORTANTE: AOG espera un stream constante del AutoSteer, no solo cambios.
    // Si solo mandamos en el cambio de estado, AOG marca el módulo como desconectado
    // y puede ignorar el workSwitch. Por eso emitimos PGN 253 cada 200ms.
    pgn253Timer = setInterval(enviarPGN253, 200);
});

mqttClient.on("message", (topic, message) => {
    try {
        if (topic === "corex/debug/level") {
            const newLevel = parseInt(message.toString());
            if (newLevel >= 0 && newLevel <= 3) {
                DBG_LEVEL = newLevel;
                console.log(`${C.yel}[DEBUG]${C.r} Nivel cambiado a ${DBG_LEVEL}`);
            }
            return;
        }

        if (topic === "vistax/corex/aog/cmd") {
            const cmd = JSON.parse(message.toString());

            switch (cmd.funcion) {
                case "bajada_herramienta":
                    setWorkSwitch(cmd.value === 1);
                    dbg(2, 'AOG-CMD', `bajada_herramienta=${cmd.value} (origen: ${cmd.source?.uid || '?'}/c${cmd.source?.cable ?? '?'})`);
                    break;

                default:
                    dbg(1, 'AOG-CMD', `⚠ Función no soportada: ${cmd.funcion}`);
            }
            return;
        }

        const data = JSON.parse(message.toString());

        if (topic === "agp/flow/ui_cmd" && data.type === "SET_DOSIS") {
            flowConfig.dosisManual = data.valor;
            flowConfig.modoManual  = true;
            saveFlowConfig();
            dbg(2, 'FLOW', `Dosis manual: ${data.valor}`);
        }
        if (topic === "agp/flow/config_save") {
            flowConfig = { ...flowConfig, ...data };
            saveFlowConfig();
            dbg(2, 'FLOW', 'Config guardada');
        }
    } catch (e) {
        dbgErr('MQTT', `Error procesando ${topic}: ${e.message}`);
    }
});

function saveFlowConfig() {
    fs.writeFile(FLOW_CONFIG_PATH, JSON.stringify(flowConfig, null, 2), () => {
        ejecutarCalculosModulares();
    });
}

// ============================================================
// 4. MÓDULOS DE CÁLCULO
// ============================================================
function calcularYEnviarTargetFlow() {
    const anchoTotal = (configImplemento.anchos_secciones_cm || []).reduce((a, b) => a + b, 0) / 100;
    if (anchoTotal <= 0) return;

    const dosisObjetivo = flowConfig.modoManual
        ? flowConfig.dosisManual
        : obtenerDosisMapa(latitud, longitud);

    const velMs = velocidadActual / 3.6;
    const litrosPorMin = (dosisObjetivo * anchoTotal * velMs * 60) / 10000;
    const pulsosPorSeg = litrosPorMin * flowConfig.meterCal / 60;

    mqttClient.publish("agp/flow/target", JSON.stringify({
        pps_target: pulsosPorSeg.toFixed(2),
        dosis:      dosisObjetivo,
        vel:        velocidadActual.toFixed(1),
        ts:         Date.now(),
    }));

    dbg(3, 'FLOW', `pps:${pulsosPorSeg.toFixed(2)} dosis:${dosisObjetivo} vel:${velocidadActual.toFixed(1)}`);
}

function procesarDosisQuantiX(lat, lon) {
    const motores = configImplemento.motores || [];
    if (motores.length === 0) return;

    const dosisObjetivo = obtenerDosisMapa(lat, lon);
    const velMs = velocidadActual / 3.6;

    motores.forEach(motor => {
        const anchoMotor = (motor.ancho_cm || 0) / 100;
        const ppsTarget  = (dosisObjetivo * anchoMotor * velMs * (motor.cal || 1)) / 10000;
        const motorDebeGirar = velMs > 0 && dosisObjetivo > 0 && aogPainting;

        mqttClient.publish(`agp/motor/${motor.uid_esp}/target`, JSON.stringify({
            pps:  ppsTarget.toFixed(2),
            on:   motorDebeGirar,
            ts:   Date.now(),
        }));

        dbg(3, 'QTX', `motor ${motor.uid_esp} pps:${ppsTarget.toFixed(2)} on:${motorDebeGirar}`);
    });
}

function obtenerDosisMapa(lat, lon) {
    if (!mapaPrescripcion || lat === 0) return 0;
    try {
        const punto = turf.point([lon, lat]);
        for (const f of mapaPrescripcion.features) {
            if (turf.booleanPointInPolygon(punto, f))
                return parseFloat(f.properties.Rate || f.properties.SemillasxMetro) || 0;
        }
    } catch (e) {}
    return 0;
}

function ejecutarCalculosModulares() {
    calcularYEnviarTargetFlow();
    procesarDosisQuantiX(latitud, longitud);
}

// ============================================================
// 4.b ENVÍO DE PGN 253 HACIA AOG (work switch + heartbeat)
// ============================================================
/**
 * Envía el estado actual del PGN 253 (From AutoSteer) hacia AOG.
 * Se llama tanto cuando cambia el work switch como periódicamente
 * (cada 200ms) desde el interval del mqttClient.on("connect").
 */
function enviarPGN253() {
    const packet = protocol.encode(SRC_AUTOSTEER, PGN_FROM_STEER, pgn253State);

    udpSocket.send(packet, AOG_PORT_OUT, AOG_BROADCAST_IP, (err) => {
        if (err) {
            dbgErr('AOG-OUT', `Error enviando PGN 253: ${err.message}`);
            return;
        }
        dbg(3, 'AOG-OUT', `PGN 253 → ${AOG_BROADCAST_IP}:${AOG_PORT_OUT} | switchByte=0x${pgn253State[6].toString(16).padStart(2,'0')}`);
    });
}

/**
 * Setea el bit de work switch en el byte Switch del PGN 253.
 * Byte Switch (índice 6 del payload):
 *   bit 0 = workSwitch  (1 = herramienta abajo / trabajando)
 *   bit 1 = steerSwitch (autosteer enable)
 *   bit 2 = mainSwitch  (SIEMPRE 1 o AOG descarta)
 */
function setWorkSwitch(isDown) {
    pgn253State[6] = protocol.SWITCH.MAIN;   // reset: solo mainSwitch
    if (isDown) pgn253State[6] |= protocol.SWITCH.WORK;

    enviarPGN253();
    console.log(`${C.mag}▸ [AOG-OUT]${C.r} 🔧 workSwitch=${isDown ? 'DOWN ⬇' : 'UP ⬆'} | byte=0x${pgn253State[6].toString(16).padStart(2,'0')} (${pgn253State[6].toString(2).padStart(8,'0')})`);
}

// ============================================================
// 5. EVENTOS UDP (recepción desde AOG)
// ============================================================
udpSocket.on("message", (msg) => {
    if (msg.length < 8) return;
    const pgn = msg[3];

    _udpCount++;
    dbg(3, 'UDP', `PGN ${pgn} | len:${msg.length} | #${_udpCount}`);

    if (pgn === 254) {
        const velAnterior = velocidadActual;
        velocidadActual = msg.readInt16LE(5) / 10;
        mqttClient.publish("aog/machine/speed", velocidadActual.toFixed(1));

        _velCount++;
        if (Math.abs(velocidadActual - velAnterior) > 0.5) {
            dbg(1, 'VEL', `${velocidadActual.toFixed(1)} km/h (era ${velAnterior.toFixed(1)})`);
        }
        else if (_velCount % 10 === 0) {
            dbg(2, 'VEL', `${velocidadActual.toFixed(1)} km/h (pkt #${_velCount})`);
        }
        else {
            dbg(3, 'VEL', `${velocidadActual.toFixed(1)} km/h`);
        }

        ejecutarCalculosModulares();
    }
    else if (pgn === 100) {
        longitud = msg.readDoubleLE(5);
        latitud  = msg.readDoubleLE(13);
        const headingFinal = calcularHeadingDesdePosiciones(latitud, longitud);

        mqttClient.publish("aog/machine/position", JSON.stringify({
            lat:     latitud,
            lon:     longitud,
            heading: headingFinal,
            gps_ts:  Date.now(),
        }));

        _gpsCount++;
        if (_gpsCount % 50 === 0) {
            dbg(1, 'GPS', `#${_gpsCount} lat:${latitud.toFixed(6)} lon:${longitud.toFixed(6)} hdg:${headingFinal.toFixed(1)}° vel:${velocidadActual.toFixed(1)}`);
        }
        else if (_gpsCount % 10 === 0) {
            dbg(2, 'GPS', `#${_gpsCount} lat:${latitud.toFixed(6)} lon:${longitud.toFixed(6)} hdg:${headingFinal.toFixed(1)}°`);
        }
        else {
            dbg(3, 'GPS', `lat:${latitud.toFixed(6)} lon:${longitud.toFixed(6)} hdg:${headingFinal.toFixed(1)}°`);
        }

        ejecutarCalculosModulares();
    }
    else if (pgn === 235) {
        if (msg.length >= 38) {
            const cantidadSeccionesAOG = msg[37];
            const anchos_cm = [];
            for (let i = 0; i < cantidadSeccionesAOG; i++) {
                anchos_cm.push(msg.readUInt16LE(5 + i * 2));
            }
            if (cantidadSeccionesAOG > 0) {
                configImplemento.cantidad_secciones_aog = cantidadSeccionesAOG;
                configImplemento.anchos_secciones_cm    = anchos_cm;
                mqttClient.publish("aog/machine/sections_config", JSON.stringify({
                    secciones_detectadas: cantidadSeccionesAOG,
                    anchos_detectados:    anchos_cm,
                }), { retain: true });
                dbg(1, 'SEC-CFG', `${cantidadSeccionesAOG} secciones detectadas | anchos: [${anchos_cm.join(',')}]cm`);
            }
        }
    }
    else if (pgn === 229) {
        const seccionesActuales = new Array(64).fill(0);
        for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
            const byteValue = msg[5 + byteIdx];
            for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
                const idx = byteIdx * 8 + bitIdx;
                if (idx < 64) seccionesActuales[idx] = (byteValue >> bitIdx) & 1;
            }
        }
        actualizarLogicaSecciones(seccionesActuales);
    }
});

function actualizarLogicaSecciones(seccionesActuales) {
    const now = Date.now();
    const dt  = (now - lastTimestamp) / 1000;
    lastTimestamp = now;
    distanciaAcumulada += (velocidadActual / 3.6) * dt;

    estadosSecciones = [...seccionesActuales];

    const distTren2 = parseFloat(
        configImplemento?.implemento_activo?.geometria?.distancia_trenes_m
    ) || 1.5;

    historialSecciones.push({
        estados:       [...seccionesActuales],
        distanciaMeta: distanciaAcumulada + distTren2,
    });
    if (historialSecciones.length > 2000) historialSecciones.shift();

    while (
        historialSecciones.length > 0 &&
        distanciaAcumulada >= historialSecciones[0].distanciaMeta
    ) {
        estadosSeccionesTren2 = historialSecciones.shift().estados;
    }

    mqttClient.publish("sections/state", JSON.stringify({
        t1: estadosSecciones,
        t2: estadosSeccionesTren2,
    }));

    _secCount++;
    if (_secCount % 5 === 0) {
        const t1on = estadosSecciones.filter(s => s === 1).length;
        const t2on = estadosSeccionesTren2.filter(s => s === 1).length;
        const fmtSec = arr => arr.slice(0, 16).map(v => v ? '█' : '·').join('');
        dbg(2, 'SEC', `T1:[${fmtSec(estadosSecciones)}] (${t1on}) T2:[${fmtSec(estadosSeccionesTren2)}] (${t2on}) | dist:${distanciaAcumulada.toFixed(1)}m`);
    }

    actualizarEstadoPintado(estadosSecciones);
    ejecutarCalculosModulares();
}

// ============================================================
// 6. HELPERS GPS / HEADING
// ============================================================
function calcularHeadingDesdePosiciones(latActual, lonActual) {
    const ahora = Date.now();
    if (!ultimaPosicion) {
        ultimaPosicion = { lat: latActual, lon: lonActual, timestamp: ahora };
        return 0;
    }
    const distancia = calcularDistanciaMetros(
        ultimaPosicion.lat, ultimaPosicion.lon, latActual, lonActual
    );
    if (distancia < 0.5 || ahora - ultimoTiempo < 100) return headingSuavizado;

    const headingBruto = calcularHeadingGPS(
        ultimaPosicion.lat, ultimaPosicion.lon, latActual, lonActual
    );
    posicionesHistorial.push({ heading: headingBruto });
    if (posicionesHistorial.length > MAX_HISTORIAL) posicionesHistorial.shift();

    headingSuavizado = suavizarHeading(posicionesHistorial);
    ultimaPosicion   = { lat: latActual, lon: lonActual, timestamp: ahora };
    ultimoTiempo     = ahora;
    return headingSuavizado;
}

function calcularHeadingGPS(lat1, lon1, lat2, lon2) {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const lat1R = (lat1 * Math.PI) / 180;
    const lat2R = (lat2 * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2R);
    const x = Math.cos(lat1R) * Math.sin(lat2R) -
               Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function suavizarHeading(historial) {
    let sSin = 0, sCos = 0;
    historial.forEach((h, i) => {
        const p = (i + 1) / historial.length;
        sSin += Math.sin((h.heading * Math.PI) / 180) * p;
        sCos += Math.cos((h.heading * Math.PI) / 180) * p;
    });
    return ((Math.atan2(sSin, sCos) * 180) / Math.PI + 360) % 360;
}

function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
    const R    = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// 7. ARRANQUE
// ============================================================
udpSocket.bind(UDP_PORT, () => {
    udpSocket.setBroadcast(true);
    dbg(1, 'INIT', `📡 CoreX Bridge activo | UDP:${UDP_PORT} | Debug:${DBG_LEVEL}`);
    dbg(1, 'INIT', `AOG output → ${AOG_BROADCAST_IP}:${AOG_PORT_OUT} (PGN 253)`);
    dbg(1, 'INIT', `Cambiar nivel: mosquitto_pub -t corex/debug/level -m 2`);
});

// ============================================================
// 8. GRACEFUL SHUTDOWN
// ============================================================
// PM2 manda SIGINT y tras 1.6s SIGKILL. Cerramos recursos a tiempo:
//  - detenemos timers (heartbeat PGN 253, sync, config, field status)
//  - cerramos socket UDP
//  - desconectamos MQTT con flush
//  - detenemos field watcher (intervals + fs.watchFile)
let _shuttingDown = false;
function shutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    dbg(1, 'SHUTDOWN', `Señal ${signal} recibida — cerrando recursos...`);

    try { clearInterval(pgn253Timer);    } catch (_) {}
    try { clearInterval(syncTimeTimer);  } catch (_) {}
    try { clearInterval(configTimer);    } catch (_) {}
    try { clearInterval(fieldStatusTimer); } catch (_) {}

    try {
        if (aogLogWatcher && typeof aogLogWatcher.detener === 'function') {
            aogLogWatcher.detener();
        }
    } catch (e) { dbgErr('SHUTDOWN', `watcher: ${e.message}`); }

    try { udpSocket.close(); } catch (e) { dbgErr('SHUTDOWN', `udp: ${e.message}`); }

    try {
        mqttClient.end(false, {}, () => {
            dbg(1, 'SHUTDOWN', '✓ Cerrado limpio');
            process.exit(0);
        });
    } catch (e) {
        dbgErr('SHUTDOWN', `mqtt: ${e.message}`);
        process.exit(1);
    }

    // Fallback si MQTT no responde a tiempo
    setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

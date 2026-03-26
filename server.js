const dgram = require("dgram");
const mqtt  = require("mqtt");
const fs    = require("fs");
const path  = require("path");
const turf  = require("@turf/turf");
const axios = require("axios");
const os    = require("os");
require("dotenv").config();

const udpSocket  = dgram.createSocket("udp4");
const mqttClient = mqtt.connect(process.env.MQTT_BROKER || "mqtt://127.0.0.1");

// --- CONFIGURACIÓN ---
const UDP_PORT = parseInt(process.env.UDP_PORT) || 17777;
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const MAPA_PATH        = path.join(DATA_DIR, "ultimo_mapa.json");
const FLOW_CONFIG_PATH = path.join(DATA_DIR, "flowx_config.json");
const CONFIG_URL       = process.env.CONFIG_URL || "http://localhost:8080/api/gis/config-implemento";

// Ruta campos AOG: primero .env, si está vacío → Documents del usuario
const AOG_FIELDS_PATH = process.env.AOG_FIELDS_PATH
  ? path.normalize(process.env.AOG_FIELDS_PATH)
  : path.join(os.homedir(), "Documents", "AgOpenGPS", "Fields");

// Umbral de velocidad para considerar pintado activo
const VEL_MIN_PINTADO = parseFloat(process.env.VEL_MIN_PINTADO) || 0.5;

console.log(`\x1b[36m[CoreX]\x1b[0m Campos AOG: ${AOG_FIELDS_PATH}`);
console.log(`\x1b[36m[CoreX]\x1b[0m MQTT: ${process.env.MQTT_BROKER || "mqtt://127.0.0.1"}`);

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
    } catch (e) {
        console.error("❌ Bridge: Error cargando flowx_config.json");
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
const MAX_HISTORIAL = 5;
let ultimaPosicion  = null;
let headingSuavizado = 0;
let ultimoTiempo    = Date.now();

// --- ESTADO CAMPO AOG ---
let aogField = {
  nombre:   "",
  painting: false,
};

// ============================================================
// 1. SINCRONIZACIÓN Y ARCHIVOS
// ============================================================
async function sincronizarConfig() {
    try {
        const res = await axios.get(CONFIG_URL);
        configImplemento = { ...configImplemento, ...res.data };
        console.log("⚙️ Bridge: Config sincronizada con QuantiX API");
    } catch (e) {
        console.error("❌ Bridge: Esperando API de QuantiX...");
    }
}

function cargarMapa() {
    if (fs.existsSync(MAPA_PATH)) {
        try {
            mapaPrescripcion = JSON.parse(fs.readFileSync(MAPA_PATH));
            console.log("🗺️ Bridge: Mapa VRA cargado");
        } catch (e) {
            console.error("❌ Error leyendo mapa");
        }
    }
}

fs.watchFile(MAPA_PATH, () => cargarMapa());
setInterval(sincronizarConfig, 30000);
sincronizarConfig();
cargarMapa();

// ============================================================
// 2. WATCHER CAMPOS AOG
// ============================================================
// "2026-03-23 18-35", "2026-01-27 11-40", etc.
// AOG los genera como: YYYY-MM-DD HH-mm
const AOG_NOMBRE_AUTO = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}$/;

/**
 * Devuelve true si el nombre de carpeta fue generado
 * automáticamente por AOG (no tiene nombre de campo real).
 */
function esCarpetaAuto(nombre) {
  return AOG_NOMBRE_AUTO.test(nombre.trim());
}

/**
 * De la lista de subcarpetas con Field.txt, devuelve la más
 * reciente que tenga nombre real (no auto-generado por AOG).
 * Si no hay ninguna con nombre real, cae al más reciente de todos.
 */
function elegirCampoActivo(subdirs) {
  if (!subdirs.length) return null;

  // Primero buscar entre los campos con nombre real
  const conNombre = subdirs.filter(d => !esCarpetaAuto(d.name));
  if (conNombre.length) {
    conNombre.sort((a, b) => b.mtime - a.mtime);
    return conNombre[0].name;
  }

  // Fallback: tomar el más reciente aunque sea auto-generado
  subdirs.sort((a, b) => b.mtime - a.mtime);
  return subdirs[0].name;
}

function iniciarWatcherCampos() {
  if (!fs.existsSync(AOG_FIELDS_PATH)) {
    console.log(`\x1b[33m[FieldWatcher]\x1b[0m Carpeta no encontrada: ${AOG_FIELDS_PATH}`);
    console.log("[FieldWatcher] Reintentando en 30s...");
    setTimeout(iniciarWatcherCampos, 30000);
    return;
  }

  detectarCampoActual();

  try {
    // AOG toca distintos archivos según la acción:
    //   Field.txt   → campo nuevo creado desde cero
    //   Field.kml   → campo existente abierto (con boundary)
    //   agshare.txt → campo abierto (siempre)
    //   Boundary.txt → boundary cargado
    // Escuchamos todos para no perder ningún caso.
    const ARCHIVOS_AOG = new Set(["Field.txt", "Field.kml", "agshare.txt", "Boundary.txt"]);

    fs.watch(AOG_FIELDS_PATH, { recursive: true }, (event, filename) => {
      if (!filename) return;
      if (!ARCHIVOS_AOG.has(path.basename(filename))) return;

      const fieldName = filename.split(/[\\/]/)[0];
      if (!fieldName) return;

      // Ignorar carpetas auto-generadas por AOG
      if (esCarpetaAuto(fieldName)) {
        console.log(`\x1b[90m[FieldWatcher]\x1b[0m Ignorando carpeta auto: "${fieldName}"`);
        return;
      }

      if (fieldName === aogField.nombre) return;

      aogField.nombre = fieldName;
      console.log(`\x1b[36m[FieldWatcher]\x1b[0m Campo detectado: "${fieldName}"`);
      mqttClient.publish("aog/field/name", fieldName);
      publicarEstadoCampo();
    });

    console.log(`\x1b[36m[FieldWatcher]\x1b[0m Vigilando: ${AOG_FIELDS_PATH}`);
  } catch (err) {
    console.log("[FieldWatcher] Modo polling cada 5s (Linux)");
    setInterval(detectarCampoActual, 5000);
  }
}

function detectarCampoActual() {
  if (!fs.existsSync(AOG_FIELDS_PATH)) return;
  try {
    const subdirs = fs.readdirSync(AOG_FIELDS_PATH, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        // Prioridad: agshare.txt > Field.kml > Field.txt
        // agshare.txt es el que AOG toca siempre al abrir un campo existente
        for (const archivo of ["agshare.txt", "Field.kml", "Field.txt"]) {
          const f = path.join(AOG_FIELDS_PATH, d.name, archivo);
          if (fs.existsSync(f)) {
            return { name: d.name, mtime: fs.statSync(f).mtimeMs };
          }
        }
        return null;
      })
      .filter(Boolean);

    if (!subdirs.length) return;

    const campo = elegirCampoActivo(subdirs);
    if (!campo || campo === aogField.nombre) return;

    aogField.nombre = campo;
    console.log(`\x1b[36m[FieldWatcher]\x1b[0m Campo activo: "${campo}"`);
    mqttClient.publish("aog/field/name", campo);
    publicarEstadoCampo();
  } catch (err) {
    console.error("[FieldWatcher] Error:", err.message);
  }
}


function actualizarEstadoPintado(secciones) {
  const nuevoPainting = secciones.some(s => s === 1) && velocidadActual > VEL_MIN_PINTADO;
  if (nuevoPainting === aogField.painting) return;

  aogField.painting = nuevoPainting;
  const color = nuevoPainting ? "\x1b[32m" : "\x1b[33m";
  console.log(`${color}[FieldWatcher]\x1b[0m Pintado ${nuevoPainting ? "INICIADO" : "DETENIDO"} — "${aogField.nombre}"`);
  publicarEstadoCampo();
}

function publicarEstadoCampo() {
  if (!mqttClient.connected) return;
  mqttClient.publish("aog/field/status", JSON.stringify({
    painting:  aogField.painting,
    fieldName: aogField.nombre,
    ts:        Date.now(),
  }));
}

// Heartbeat cada 3s para sincronizar reconexiones
setInterval(() => { if (mqttClient.connected) publicarEstadoCampo(); }, 3000);

// ============================================================
// 3. MQTT
// ============================================================
mqttClient.on("connect", () => {
    console.log("🚀 CoreX Bridge: MQTT Conectado.");
    mqttClient.subscribe("agp/flow/ui_cmd");
    mqttClient.subscribe("agp/flow/config_save");

    iniciarWatcherCampos();

    setInterval(() => {
        if (latitud === 0 && longitud === 0) return;
        mqttClient.publish("vistax/sync/time", JSON.stringify({
            gps_ts: Date.now(),
            lat:    latitud,
            lon:    longitud,
        }));
    }, 1000);
});

mqttClient.on("message", (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        if (topic === "agp/flow/ui_cmd" && data.type === "SET_DOSIS") {
            flowConfig.dosisManual = data.valor;
            flowConfig.modoManual  = true;
            saveFlowConfig();
        }
        if (topic === "agp/flow/config_save") {
            flowConfig = { ...flowConfig, ...data };
            saveFlowConfig();
        }
    } catch (e) {
        console.error("❌ Bridge: Error MQTT", topic);
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
    if (!configImplemento?.anchos_secciones_cm?.length) return;

    let anchoActivoM = 0;
    let seccionesByte = 0;
    const maxAProcesar = Math.min(configImplemento.anchos_secciones_cm.length, 10);

    for (let i = 0; i < maxAProcesar; i++) {
        if (estadosSecciones[i] === 1) {
            anchoActivoM += (configImplemento.anchos_secciones_cm[i] || 0) / 100;
            seccionesByte |= 1 << i;
        }
    }

    const dosisTarget = flowConfig.modoManual || !mapaPrescripcion
        ? flowConfig.dosisManual
        : obtenerDosisMapa(latitud, longitud);

    const lminTarget = velocidadActual > 0.5 && anchoActivoM > 0
        ? (dosisTarget * velocidadActual * anchoActivoM) / 600
        : 0;

    mqttClient.publish("agp/flow/target", JSON.stringify({
        target: parseFloat(lminTarget.toFixed(2)),
        sec:    seccionesByte,
        vel:    velocidadActual,
        pwmMin: flowConfig.pwmMinimo,
        pid:    flowConfig.pid,
    }));

    mqttClient.publish("agp/flow/state", JSON.stringify({
        dosisTarget,
        velocidad:    velocidadActual,
        caudalActual: 0,
    }));
}

async function procesarDosisQuantiX(lat, lon) {
    if (!configImplemento?.motores?.length) return;

    const dosisBase    = obtenerDosisMapa(lat, lon);
    const m_s          = velocidadActual > 0.5 ? velocidadActual / 3.6 : 0;
    const separacion_m = (configImplemento.implemento_activo?.geometria?.separacion_cm || 19) / 100;

    configImplemento.motores.forEach((motor) => {
        if (!motor.configuracion_secciones) return;

        const motorDebeGirar = motor.configuracion_secciones.some((sec) => {
            const idx = sec.seccion_aog - 1;
            return sec.tipo === "trasero"
                ? estadosSeccionesTren2[idx] === 1
                : estadosSecciones[idx] === 1;
        });

        let ppsTarget = 0;
        if (motorDebeGirar && dosisBase > 0 && m_s > 0) {
            const cpReal      = parseFloat(motor.meter_cal) || 1.0;
            const factorDosis = dosisBase > 500
                ? (dosisBase * separacion_m) / 10000
                : dosisBase;
            ppsTarget = (factorDosis * m_s) / cpReal;
        }

        mqttClient.publish(`agp/quantix/${motor.uid_esp}/target`, JSON.stringify({
            id:         motor.indice_interno,
            pps:        parseFloat(ppsTarget.toFixed(2)),
            seccion_on: motorDebeGirar,
        }));
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
// 5. EVENTOS UDP
// ============================================================
udpSocket.on("message", (msg) => {
    if (msg.length < 8) return;
    const pgn = msg[3];

    if (pgn === 254) {
        velocidadActual = msg.readInt16LE(5) / 10;
        mqttClient.publish("aog/machine/speed", velocidadActual.toFixed(1));
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

udpSocket.bind(UDP_PORT, () =>
    console.log(`📡 CoreX Bridge activo en puerto ${UDP_PORT}`)
);

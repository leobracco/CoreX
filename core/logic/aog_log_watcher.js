// ============================================================
// core/logic/aog_log_watcher.js  — v1.1
//
// CAMBIOS v1.1:
//   - Polling paralelo a 500ms como backup de watchFile
//     (fs.watchFile falla silenciosamente en Windows cuando
//      el escritor usa patrones atómicos write+rename o
//      cuando el proceso es .NET)
//   - Debug temporal: loguea el contenido del archivo en cada
//     lectura para confirmar qué recibe. Desactivar con
//     AOGLOG_DEBUG=0 en el .env cuando todo funcione.
// ============================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const CURRENT_FIELD_PATH = process.env.CURRENT_FIELD_PATH
  ? path.normalize(process.env.CURRENT_FIELD_PATH)
  : path.join(os.homedir(), "Documents", "AgOpenGPS", "current_field.json");

const DEBUG = process.env.AOGLOG_DEBUG !== "0"; // default: activo

let _mqttClient  = null;
let _campoActual = "";
let _cfWatcher   = null;
let _cfLastTs    = 0;
let _pollingTimer = null;

// ── API pública ──────────────────────────────────────────────
function iniciar(mqttClient) {
  _mqttClient = mqttClient;
  console.log(`[AOGLog] CurrentField: ${CURRENT_FIELD_PATH}`);
  _iniciarWatcher();
}

function getCampoActual() { return _campoActual; }

function detener() {
  try { fs.unwatchFile(CURRENT_FIELD_PATH); } catch (_) {}
  try { _cfWatcher?.close(); }               catch (_) {}
  if (_pollingTimer) { clearInterval(_pollingTimer); _pollingTimer = null; }
}

module.exports = { iniciar, getCampoActual, detener };

// ── Watcher principal ────────────────────────────────────────
function _iniciarWatcher() {
  // Lectura inicial — por si el archivo ya existe de una sesión previa
  _leerCurrentField();

  if (!fs.existsSync(CURRENT_FIELD_PATH)) {
    console.log(`\x1b[33m[AOGLog]\x1b[0m current_field.json no existe aún — esperando...`);
    const dir = path.dirname(CURRENT_FIELD_PATH);
    if (fs.existsSync(dir)) {
      try {
        _cfWatcher = fs.watch(dir, (event, filename) => {
          if (filename === path.basename(CURRENT_FIELD_PATH)) {
            _leerCurrentField();
            if (fs.existsSync(CURRENT_FIELD_PATH)) {
              try { _cfWatcher?.close(); } catch (_) {}
              _iniciarWatchFile();
            }
          }
        });
      } catch (e) {
        console.log(`\x1b[33m[AOGLog]\x1b[0m Watch dir falló — usando solo polling`);
      }
    }
    // Polling siempre activo mientras el archivo no existe
    _activarPolling();
    return;
  }

  _iniciarWatchFile();
  _activarPolling(); // Belt-and-suspenders: polling paralelo siempre
}

function _iniciarWatchFile() {
  try {
    fs.watchFile(CURRENT_FIELD_PATH, { interval: 300 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        if (DEBUG) console.log(`[AOGLog] 📁 watchFile detectó cambio (mtime ${prev.mtimeMs} → ${curr.mtimeMs})`);
        _leerCurrentField();
      }
    });
    console.log(`\x1b[36m[AOGLog]\x1b[0m Watching: ${CURRENT_FIELD_PATH}`);
  } catch (e) {
    console.log(`\x1b[33m[AOGLog]\x1b[0m watchFile falló: ${e.message} — solo polling activo`);
  }
}

// ── Polling paralelo (backup para Windows) ───────────────────
function _activarPolling() {
  if (_pollingTimer) return; // Ya activo
  _pollingTimer = setInterval(_leerCurrentField, 500);
  console.log(`\x1b[36m[AOGLog]\x1b[0m Polling backup activo (500ms)`);
}

// ── Lectura y procesamiento ───────────────────────────────────
function _leerCurrentField() {
  try {
    if (!fs.existsSync(CURRENT_FIELD_PATH)) return;

    const raw  = fs.readFileSync(CURRENT_FIELD_PATH, "utf8").replace(/^\uFEFF/, "");

    // Debug: loguear contenido crudo para diagnosticar
    if (DEBUG) {
      console.log(`[AOGLog] 📄 Contenido del archivo: ${raw.trim()}`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      if (DEBUG) console.log(`[AOGLog] ⚠ JSON inválido (escritura parcial) — ignorando`);
      return; // JSON parcial durante escritura — reintentar en próximo ciclo
    }

    if (!data?.ts) {
      if (DEBUG) console.log(`[AOGLog] ⚠ Archivo sin campo 'ts' — ignorando`);
      return;
    }

    if (data.ts <= _cfLastTs) {
      if (DEBUG) console.log(`[AOGLog] ⏭ ts ${data.ts} ≤ último ${_cfLastTs} — duplicado, ignorando`);
      return;
    }

    _cfLastTs = data.ts;
    const { fieldName, accion } = data;

    console.log(`[AOGLog] ✅ Evento detectado: accion="${accion}" fieldName="${fieldName}" ts=${data.ts}`);

    switch (accion) {

      case "nuevo":
      case "abierto":
      case "continuar":
        _campoActual = fieldName || "";
        console.log(`\x1b[32m[AOGLog]\x1b[0m ▶ ${accion}: "${_campoActual}"`);
        _publicar(_campoActual, accion);
        break;

      case "cerrado":
        console.log(`\x1b[33m[AOGLog]\x1b[0m ■ Cerrado: "${_campoActual}"`);
        _publicar("", "cerrado");
        _campoActual = "";
        break;

      case "area_borrada": {
        const base = (fieldName || _campoActual || "")
          .replace(/\s*-\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}$/, "")
          .trim();

        if (!base) {
          console.log(`\x1b[33m[AOGLog]\x1b[0m area_borrada sin nombre — ignorado`);
          break;
        }

        const ahora  = new Date();
        const dd     = String(ahora.getDate()).padStart(2, "0");
        const mm     = String(ahora.getMonth() + 1).padStart(2, "0");
        const yyyy   = ahora.getFullYear();
        const hh     = String(ahora.getHours()).padStart(2, "0");
        const min    = String(ahora.getMinutes()).padStart(2, "0");
        const nombre = `${base}- ${dd}/${mm}/${yyyy} ${hh}:${min}`;

        _campoActual = nombre;
        console.log(`\x1b[35m[AOGLog]\x1b[0m ✂ Área borrada → nuevo lote: "${nombre}"`);
        _publicar(nombre, "abierto");
        break;
      }

      default:
        console.log(`\x1b[33m[AOGLog]\x1b[0m Acción desconocida: "${accion}"`);
    }

  } catch (e) {
    if (DEBUG) console.log(`[AOGLog] Error leyendo archivo: ${e.message}`);
  }
}

// ── MQTT ─────────────────────────────────────────────────────
function _publicar(fieldName, accion) {
  if (!_mqttClient?.connected) {
    console.log(`[AOGLog] ⚠ MQTT no conectado — no se puede publicar`);
    return;
  }

  if (fieldName) _mqttClient.publish("aog/field/name", fieldName);

  _mqttClient.publish("aog/field/status", JSON.stringify({
    fieldName,
    accion,
    painting: accion !== "cerrado",
    ts:       Date.now(),
  }), { retain: true });

  console.log(`[AOGLog] 📡 Publicado aog/field/status → accion="${accion}" fieldName="${fieldName}"`);
}

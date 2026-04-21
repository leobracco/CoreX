// ============================================================
// sniff_aog.js — Ejecutar en el directorio del bridge:
//   node sniff_aog.js
//
// Muestra en tiempo real CADA cambio en el directorio de campos
// Y en el archivo de log. Sirve para ver exactamente qué toca
// AgOpenGPS al abrir/cerrar un campo.
// ============================================================

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Rutas ──
const LOG_FILE = "AgOpenGPS_Events_Log.txt";
let logPath = process.env.AOG_LOG_PATH || path.join(os.homedir(), "Documents", "AgOpenGPS", "Logs", LOG_FILE);
if (fs.existsSync(logPath) && fs.statSync(logPath).isDirectory()) {
  logPath = path.join(logPath, LOG_FILE);
}

const fieldsPath = process.env.AOG_FIELDS_PATH || path.join(os.homedir(), "Documents", "AgOpenGPS", "Fields");

console.log("╔══════════════════════════════════════════╗");
console.log("║          AOG SNIFFER — AgroParallel      ║");
console.log("╚══════════════════════════════════════════╝");
console.log(`Log:    ${logPath}  [existe: ${fs.existsSync(logPath)}]`);
console.log(`Fields: ${fieldsPath}  [existe: ${fs.existsSync(fieldsPath)}]`);
console.log("─".repeat(60));
console.log("Abrí y cerrá campos en AOG. Ctrl+C para salir.\n");

// ── 1. Sniffer del ARCHIVO DE LOG ──
if (fs.existsSync(logPath)) {
  let lastSize = fs.statSync(logPath).size;

  // Leer las últimas 5 líneas para contexto
  const raw = fs.readFileSync(logPath);
  const enc = (raw[0] === 0xFF && raw[1] === 0xFE) ? "utf16le" : "utf8";
  const bom = enc === "utf16le" ? 2 : (raw[0] === 0xEF ? 3 : 0);
  const inicial = raw.slice(bom).toString(enc).split(/\r?\n/).filter(l => l.trim());
  console.log(`[LOG] Últimas 3 líneas al arrancar:`);
  inicial.slice(-3).forEach(l => console.log(`  ${l}`));
  console.log("");

  fs.watch(logPath, (event) => {
    if (event !== "change") return;
    try {
      const stat = fs.statSync(logPath);
      if (stat.size === lastSize) return;
      if (stat.size < lastSize) { lastSize = 0; } // rotación

      const fd  = fs.openSync(logPath, "r");
      const buf = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;

      const chunk = buf.toString(enc);
      // Mostrar líneas nuevas parseadas
      const lineas = chunk.split(/\r?\n/).filter(l => l.trim());
      lineas.forEach(l => {
        const ts = new Date().toLocaleTimeString();
        if (l.includes("** Opened **") || l.includes("** Closed **") || l.includes("** Field closed **")) {
          console.log(`\x1b[32m[LOG ${ts}] ${l}\x1b[0m`);
        } else {
          console.log(`\x1b[90m[LOG ${ts}] ${l}\x1b[0m`);
        }
      });
    } catch (e) {
      console.error(`[LOG error] ${e.message}`);
    }
  });
  console.log(`[LOG] Vigilando log en vivo...`);
} else {
  console.log(`\x1b[31m[LOG] ⚠️  Archivo no encontrado: ${logPath}\x1b[0m`);
}

// ── 2. Sniffer del DIRECTORIO DE CAMPOS ──
if (fs.existsSync(fieldsPath)) {
  // Snapshot inicial de mtimes
  const snapshot = {};
  try {
    fs.readdirSync(fieldsPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .forEach(d => {
        snapshot[d.name] = _scanDir(path.join(fieldsPath, d.name));
      });
  } catch (_) {}

  fs.watch(fieldsPath, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const ts       = new Date().toLocaleTimeString();
    const parts    = filename.split(/[\\/]/);
    const campo    = parts[0];
    const archivo  = parts.slice(1).join("/") || "(raíz)";
    const fullPath = path.join(fieldsPath, filename);

    let info = "";
    try {
      if (fs.existsSync(fullPath)) {
        const s = fs.statSync(fullPath);
        info = s.isDirectory() ? "[dir]" : `[${s.size}b, mtime:${s.mtime.toLocaleTimeString()}]`;
      } else {
        info = "[eliminado]";
      }
    } catch (_) { info = "[error stat]"; }

    console.log(`\x1b[36m[FIELDS ${ts}]\x1b[0m event="${event}" campo="\x1b[33m${campo}\x1b[0m" archivo="${archivo}" ${info}`);
  });

  console.log(`[FIELDS] Vigilando directorio en vivo: ${fieldsPath}\n`);
} else {
  console.log(`\x1b[33m[FIELDS] Directorio no encontrado: ${fieldsPath}\x1b[0m`);
  console.log(`[FIELDS] Agregá AOG_FIELDS_PATH al .env si la ruta es distinta\n`);
}

function _scanDir(dirPath) {
  const result = {};
  try {
    fs.readdirSync(dirPath).forEach(f => {
      try {
        result[f] = fs.statSync(path.join(dirPath, f)).mtimeMs;
      } catch (_) {}
    });
  } catch (_) {}
  return result;
}

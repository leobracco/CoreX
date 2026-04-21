// ============================================================
// debug_aoglog.js — Ejecutar en el directorio del bridge:
//   node debug_aoglog.js
//
// Diagnóstica exactamente qué está leyendo el watcher del log.
// ============================================================

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Misma lógica de resolución de ruta que aog_log_watcher.js ──
const LOG_FILE = "AgOpenGPS_Events_Log.txt";
let logPath = process.env.AOG_LOG_PATH || path.join(
  os.homedir(), "Documents", "AgOpenGPS", "Logs", LOG_FILE
);
if (fs.existsSync(logPath) && fs.statSync(logPath).isDirectory()) {
  logPath = path.join(logPath, LOG_FILE);
}

console.log("=== AOGLog DEBUG ===");
console.log(`Ruta: ${logPath}`);
console.log(`Existe: ${fs.existsSync(logPath)}`);

if (!fs.existsSync(logPath)) {
  console.error("❌ Archivo no encontrado. Verificá AOG_LOG_PATH en .env");
  process.exit(1);
}

// ── Info del archivo ──
const stat = fs.statSync(logPath);
console.log(`Tamaño: ${stat.size} bytes`);
console.log(`Última modificación: ${stat.mtime}`);

// ── Leer raw para detectar encoding ──
const rawBuffer = fs.readFileSync(logPath);
console.log(`\nPrimeros bytes (hex): ${rawBuffer.slice(0, 8).toString("hex")}`);

// Detectar BOM
let contenido;
if (rawBuffer[0] === 0xFF && rawBuffer[1] === 0xFE) {
  console.log("⚠️  Encoding detectado: UTF-16 LE (con BOM)");
  contenido = rawBuffer.slice(2).toString("utf16le");
} else if (rawBuffer[0] === 0xFE && rawBuffer[1] === 0xFF) {
  console.log("⚠️  Encoding detectado: UTF-16 BE (con BOM)");
  contenido = rawBuffer.swap16().slice(2).toString("utf16le");
} else if (rawBuffer[0] === 0xEF && rawBuffer[1] === 0xBB && rawBuffer[2] === 0xBF) {
  console.log("✅ Encoding detectado: UTF-8 con BOM");
  contenido = rawBuffer.slice(3).toString("utf8");
} else {
  console.log("✅ Encoding detectado: UTF-8 / ASCII");
  contenido = rawBuffer.toString("utf8");
}

// ── Analizar líneas ──
const lineas = contenido.split(/\r?\n/).filter(l => l.trim());
console.log(`\nTotal líneas: ${lineas.length}`);
console.log(`\nÚltimas 10 líneas:`);
lineas.slice(-10).forEach((l, i) => {
  console.log(`  [${lineas.length - 10 + i}] ${JSON.stringify(l)}`);
});

// ── Probar regex ──
const RE_OPENED = /\*\* Opened \*\*\s+(.+?)\s{2,}/;
const RE_CLOSED = /\*\* Field closed \*\*\s+(.+?)\s{2,}/;

const lineaOpen  = lineas.filter(l => l.includes("** Opened **"));
const lineaClose = lineas.filter(l => l.includes("** Field closed **"));

console.log(`\n=== Líneas con "** Opened **" (${lineaOpen.length} encontradas) ===`);
lineaOpen.slice(-5).forEach(l => {
  const m = l.match(RE_OPENED);
  console.log(`  Línea:  ${JSON.stringify(l)}`);
  console.log(`  Match:  ${m ? `✅ campo="${m[1].trim()}"` : "❌ NO MATCHEA"}`);
});

console.log(`\n=== Líneas con "** Field closed **" (${lineaClose.length} encontradas) ===`);
lineaClose.slice(-3).forEach(l => {
  const m = l.match(RE_CLOSED);
  console.log(`  Línea:  ${JSON.stringify(l)}`);
  console.log(`  Match:  ${m ? `✅ campo="${m[1].trim()}"` : "❌ NO MATCHEA"}`);
});

// ── Estado actual (último open vs último close) ──
const lastOpenIdx  = lineas.findLastIndex(l => RE_OPENED.test(l));
const lastCloseIdx = lineas.findLastIndex(l => RE_CLOSED.test(l));

console.log(`\n=== Estado actual ===`);
console.log(`Índice último Opened:        ${lastOpenIdx}`);
console.log(`Índice último Field closed:  ${lastCloseIdx}`);

if (lastOpenIdx > lastCloseIdx && lastOpenIdx >= 0) {
  const m = lineas[lastOpenIdx].match(RE_OPENED);
  console.log(`✅ Campo ACTIVO: "${m ? m[1].trim() : "(no parseó)"}"`);
} else if (lastOpenIdx === -1) {
  console.log("⚠️  No se encontró ningún '** Opened **' en el log");
} else {
  console.log("ℹ️  Ningún campo activo (el último evento fue cierre)");
}

// ── Watch en vivo para probar detección ──
console.log(`\n=== Watch en vivo (abrí/cerrá un campo en AOG) ===`);
console.log("Ctrl+C para salir\n");

let lastSize = stat.size;
fs.watch(logPath, (event) => {
  if (event !== "change") return;
  try {
    const newStat = fs.statSync(logPath);
    if (newStat.size === lastSize) return;

    const fd  = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(newStat.size - lastSize);
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = newStat.size;

    // Mismo decode que arriba
    let chunk;
    if (rawBuffer[0] === 0xFF && rawBuffer[1] === 0xFE) {
      chunk = buf.toString("utf16le");
    } else {
      chunk = buf.toString("utf8");
    }

    const nuevas = chunk.split(/\r?\n/).filter(l => l.trim());
    nuevas.forEach(linea => {
      console.log(`[NUEVA] ${JSON.stringify(linea)}`);
      const mO = linea.match(RE_OPENED);
      const mC = linea.match(RE_CLOSED);
      if (mO) console.log(`  → ✅ OPENED: "${mO[1].trim()}"`);
      if (mC) console.log(`  → ✅ CLOSED: "${mC[1].trim()}"`);
    });
  } catch (e) {
    console.error("[Watch error]", e.message);
  }
});

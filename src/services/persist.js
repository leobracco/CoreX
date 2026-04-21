// Lectura/escritura de JSON con manejo de errores y BOM.

const fs = require('fs');
const path = require('path');

function readJsonSafe(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        let raw = fs.readFileSync(filePath, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function writeJsonSafe(filePath, data, cb) {
    const json = JSON.stringify(data, null, 2);
    if (typeof cb === 'function') {
        fs.writeFile(filePath, json, cb);
    } else {
        return new Promise((resolve, reject) => {
            fs.writeFile(filePath, json, err => (err ? reject(err) : resolve()));
        });
    }
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = { readJsonSafe, writeJsonSafe, ensureDir, path };

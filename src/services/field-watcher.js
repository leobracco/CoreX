// Watcher de current_field.json (producido por el plugin de AgOpenGPS).
// Detección dual: fs.watchFile (interval 300ms) + polling backup (500ms)
// para sobrevivir escrituras atómicas en Windows.
//
// En vez de publicar MQTT directamente (como la versión anterior),
// emite eventos en el bus. La capa AOG decide cómo traducirlos a MQTT.
//
// Eventos emitidos:
//   field:changed  { fieldName, accion, ts }
//   field:closed   { ts }

const fs   = require('fs');
const path = require('path');

function createFieldWatcher({ currentFieldPath, bus, logger, debug = true }) {
    let campoActual = '';
    let cfWatcher = null;
    let cfLastTs = 0;
    let pollingTimer = null;
    let stopped = false;

    function getCampoActual() { return campoActual; }

    function iniciar() {
        logger.dbg(1, 'AOGLog', `CurrentField: ${currentFieldPath}`);
        _leerCurrentField();

        if (!fs.existsSync(currentFieldPath)) {
            logger.warn('AOGLog', 'current_field.json no existe aún — esperando...');
            const dir = path.dirname(currentFieldPath);
            if (fs.existsSync(dir)) {
                try {
                    cfWatcher = fs.watch(dir, (_evt, filename) => {
                        if (filename === path.basename(currentFieldPath)) {
                            _leerCurrentField();
                            if (fs.existsSync(currentFieldPath)) {
                                try { cfWatcher?.close(); } catch (_) {}
                                _iniciarWatchFile();
                            }
                        }
                    });
                } catch (_) {
                    logger.warn('AOGLog', 'watch dir falló — usando solo polling');
                }
            }
            _activarPolling();
            return;
        }

        _iniciarWatchFile();
        _activarPolling(); // Belt-and-suspenders
    }

    function detener() {
        stopped = true;
        try { fs.unwatchFile(currentFieldPath); } catch (_) {}
        try { cfWatcher?.close(); } catch (_) {}
        if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    }

    function _iniciarWatchFile() {
        try {
            fs.watchFile(currentFieldPath, { interval: 300 }, (curr, prev) => {
                if (curr.mtimeMs !== prev.mtimeMs) {
                    if (debug) logger.dbg(3, 'AOGLog', `watchFile detectó cambio (${prev.mtimeMs} → ${curr.mtimeMs})`);
                    _leerCurrentField();
                }
            });
            logger.dbg(1, 'AOGLog', `Watching: ${currentFieldPath}`);
        } catch (e) {
            logger.warn('AOGLog', `watchFile falló: ${e.message} — solo polling activo`);
        }
    }

    function _activarPolling() {
        if (pollingTimer || stopped) return;
        pollingTimer = setInterval(_leerCurrentField, 500);
        logger.dbg(1, 'AOGLog', 'Polling backup activo (500ms)');
    }

    function _leerCurrentField() {
        try {
            if (!fs.existsSync(currentFieldPath)) return;

            const raw = fs.readFileSync(currentFieldPath, 'utf8').replace(/^﻿/, '');
            if (debug) logger.dbg(3, 'AOGLog', `Contenido: ${raw.trim()}`);

            let data;
            try {
                data = JSON.parse(raw);
            } catch (_) {
                if (debug) logger.dbg(3, 'AOGLog', 'JSON inválido (escritura parcial) — ignorando');
                return;
            }

            if (!data?.ts) return;
            if (data.ts <= cfLastTs) {
                if (debug) logger.dbg(3, 'AOGLog', `ts ${data.ts} ≤ último ${cfLastTs} — duplicado, ignorando`);
                return;
            }

            cfLastTs = data.ts;
            const { fieldName, accion } = data;
            logger.dbg(2, 'AOGLog', `accion="${accion}" fieldName="${fieldName}" ts=${data.ts}`);

            switch (accion) {
                case 'nuevo':
                case 'abierto':
                case 'continuar':
                    campoActual = fieldName || '';
                    bus.emit('field:changed', { fieldName: campoActual, accion, ts: data.ts });
                    break;

                case 'cerrado':
                    bus.emit('field:closed', { ts: data.ts });
                    campoActual = '';
                    break;

                case 'area_borrada': {
                    const base = (fieldName || campoActual || '')
                        .replace(/\s*-\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}$/, '')
                        .trim();
                    if (!base) {
                        logger.warn('AOGLog', 'area_borrada sin nombre — ignorado');
                        break;
                    }
                    const ahora = new Date();
                    const dd  = String(ahora.getDate()).padStart(2, '0');
                    const mm  = String(ahora.getMonth() + 1).padStart(2, '0');
                    const yy  = ahora.getFullYear();
                    const hh  = String(ahora.getHours()).padStart(2, '0');
                    const min = String(ahora.getMinutes()).padStart(2, '0');
                    campoActual = `${base}- ${dd}/${mm}/${yy} ${hh}:${min}`;
                    bus.emit('field:changed', { fieldName: campoActual, accion: 'abierto', ts: data.ts });
                    break;
                }

                default:
                    logger.warn('AOGLog', `Acción desconocida: "${accion}"`);
            }
        } catch (e) {
            if (debug) logger.dbg(3, 'AOGLog', `Error leyendo: ${e.message}`);
        }
    }

    return { iniciar, detener, getCampoActual };
}

module.exports = { createFieldWatcher };

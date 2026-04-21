// Módulo AOG: puente con AgOpenGPS.
//
// Publica MQTT:
//   aog/machine/position         {lat, lon, heading, gps_ts}
//   aog/machine/speed            string km/h
//   aog/machine/sections_config  (retain) {secciones_detectadas, anchos_detectados}
//   aog/field/name               string
//   aog/field/status             (retain) {fieldName, accion, painting, ts}
//
// Envía UDP a AOG:
//   PGN 253 (From AutoSteer) heartbeat cada 200ms — crítico: sin stream
//   continuo AOG marca AutoSteer como desconectado.
//
// Reacciona a:
//   bus 'gps:update'     → publica posición + heading
//   bus 'speed:update'   → publica velocidad + registra en store
//   bus 'field:changed'  → publica field/name + field/status
//   bus 'field:closed'   → publica field/status con accion=cerrado
//   bus 'painting:changed'→ publica field/status con painting actualizado
//   bus 'work:changed'   → setea bit work en PGN 253 y envía

const protocol = require('../../protocol');
const { createHeadingCalculator } = require('../../services/heading');
const { createFieldWatcher } = require('../../services/field-watcher');

function createAogModule({ mqtt, bus, state, logger, config, udp }) {
    const timers = [];
    const heading = createHeadingCalculator();

    // Payload persistente del PGN 253 (8 bytes)
    const pgn253 = Buffer.alloc(8, 0);
    pgn253[6] = protocol.SWITCH.MAIN; // mainSwitch siempre ON

    const fieldWatcher = createFieldWatcher({
        currentFieldPath: config.aog.currentFieldPath,
        bus,
        logger,
        debug: config.debug.aogLogDebug !== 0,
    });

    function enviarPGN253() {
        const packet = protocol.encode(protocol.SRC.AUTOSTEER, protocol.PGN.FROM_STEER, pgn253);
        udp.send(packet, config.udp.portOut, config.udp.broadcastIp, (err) => {
            if (err) return logger.err('AOG-OUT', `PGN 253: ${err.message}`);
            logger.dbg(3, 'AOG-OUT', `PGN 253 → ${config.udp.broadcastIp}:${config.udp.portOut} | switch=0x${pgn253[6].toString(16).padStart(2,'0')}`);
        });
    }

    function setWorkSwitch(isDown) {
        pgn253[6] = protocol.SWITCH.MAIN;
        if (isDown) pgn253[6] |= protocol.SWITCH.WORK;
        enviarPGN253();
        logger.dbg(1, 'AOG-OUT', `🔧 workSwitch=${isDown ? 'DOWN ⬇' : 'UP ⬆'} | byte=0x${pgn253[6].toString(16).padStart(2,'0')}`);
    }

    function publishFieldStatus(extra = {}) {
        const fieldName = state.get('field')?.name || '';
        const painting  = state.get('painting');
        mqtt.publish('aog/field/status', JSON.stringify({
            fieldName, painting, ts: Date.now(), ...extra,
        }), { retain: true });
    }

    return {
        name: 'aog',
        subscribe: [],

        start() {
            // --- GPS / heading ---
            let gpsCount = 0;
            bus.on('gps:update', ({ lat, lon, ts }) => {
                const hdg = heading.update(lat, lon, ts);
                state.set('position', { lat, lon, ts });
                state.set('heading', hdg);

                mqtt.publish('aog/machine/position', JSON.stringify({
                    lat, lon, heading: hdg, gps_ts: ts,
                }));

                gpsCount++;
                if (gpsCount % 50 === 0) {
                    logger.dbg(1, 'GPS', `#${gpsCount} lat:${lat.toFixed(6)} lon:${lon.toFixed(6)} hdg:${hdg.toFixed(1)}° vel:${state.get('speed_kmh').toFixed(1)}`);
                } else if (gpsCount % 10 === 0) {
                    logger.dbg(2, 'GPS', `#${gpsCount} lat:${lat.toFixed(6)} lon:${lon.toFixed(6)} hdg:${hdg.toFixed(1)}°`);
                } else {
                    logger.dbg(3, 'GPS', `lat:${lat.toFixed(6)} lon:${lon.toFixed(6)} hdg:${hdg.toFixed(1)}°`);
                }
            });

            // --- Speed ---
            let velCount = 0;
            bus.on('speed:update', ({ speed_kmh }) => {
                const prev = state.get('speed_kmh');
                state.set('speed_kmh', speed_kmh);
                mqtt.publish('aog/machine/speed', speed_kmh.toFixed(1));

                velCount++;
                if (Math.abs(speed_kmh - prev) > 0.5) {
                    logger.dbg(1, 'VEL', `${speed_kmh.toFixed(1)} km/h (era ${prev.toFixed(1)})`);
                } else if (velCount % 10 === 0) {
                    logger.dbg(2, 'VEL', `${speed_kmh.toFixed(1)} km/h (pkt #${velCount})`);
                } else {
                    logger.dbg(3, 'VEL', `${speed_kmh.toFixed(1)} km/h`);
                }
            });

            // --- Sections dimensions (config) ---
            bus.on('sections:dimensions', ({ count, widths_cm }) => {
                state.merge('configImplemento', {
                    cantidad_secciones_aog: count,
                    anchos_secciones_cm:    widths_cm,
                });
                mqtt.publish('aog/machine/sections_config', JSON.stringify({
                    secciones_detectadas: count,
                    anchos_detectados:    widths_cm,
                }), { retain: true });
                logger.dbg(1, 'SEC-CFG', `${count} secciones | anchos:[${widths_cm.join(',')}]cm`);
            });

            // --- Field watcher → MQTT ---
            bus.on('field:changed', ({ fieldName, accion, ts }) => {
                state.set('field', { name: fieldName, accion, ts });
                if (fieldName) mqtt.publish('aog/field/name', fieldName);
                publishFieldStatus({ accion });
            });

            bus.on('field:closed', ({ ts }) => {
                state.set('field', { name: '', accion: 'cerrado', ts });
                mqtt.publish('aog/field/name', '');
                publishFieldStatus({ accion: 'cerrado' });
            });

            // --- Painting state sincronizado con field/status ---
            bus.on('painting:changed', () => publishFieldStatus());

            // --- Heartbeat aog/field/status cada 3s ---
            timers.push(setInterval(() => {
                if (!mqtt.connected) return;
                publishFieldStatus();
                logger.dbg(3, 'HEART', `painting:${state.get('painting')} field:"${state.get('field').name}"`);
            }, config.aog.fieldStatusMs));

            // --- Work switch command → PGN 253 ---
            bus.on('work:changed', ({ down }) => setWorkSwitch(down));

            // --- PGN 253 heartbeat crítico 200ms ---
            bus.on('mqtt:connect', () => {
                fieldWatcher.iniciar();
                timers.push(setInterval(enviarPGN253, config.aog.heartbeatMs));
            });
        },

        stop() {
            timers.forEach(clearInterval);
            timers.length = 0;
            fieldWatcher.detener();
        },

        // Para debug externo
        _internals: { pgn253, heading, fieldWatcher },
    };
}

module.exports = { createAogModule };

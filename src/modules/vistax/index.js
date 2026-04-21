// Módulo VistaX.
//
// Publica MQTT:
//   vistax/sync/time  {gps_ts, lat, lon}   cada 1s
//
// Suscribe MQTT:
//   vistax/corex/aog/cmd  {funcion, value, source}
//     funcion='bajada_herramienta' → emite bus 'work:changed' que el módulo
//     AOG traduce a PGN 253 (byte Switch).

function createVistaxModule({ mqtt, bus, state, logger, config }) {
    const timers = [];

    return {
        name: 'vistax',
        subscribe: ['vistax/corex/aog/cmd'],

        onMqttMessage(topic, payload) {
            if (topic !== 'vistax/corex/aog/cmd') return;
            try {
                const cmd = JSON.parse(payload.toString());
                switch (cmd.funcion) {
                    case 'bajada_herramienta':
                        bus.emit('work:changed', { down: cmd.value === 1 });
                        logger.dbg(2, 'AOG-CMD', `bajada_herramienta=${cmd.value} (origen: ${cmd.source?.uid || '?'}/c${cmd.source?.cable ?? '?'})`);
                        break;
                    default:
                        logger.warn('AOG-CMD', `⚠ Función no soportada: ${cmd.funcion}`);
                }
            } catch (e) {
                logger.err('VISTAX', `parse ${topic}: ${e.message}`);
            }
        },

        start() {
            bus.on('mqtt:connect', () => {
                timers.push(setInterval(() => {
                    if (!mqtt.connected) return;
                    const pos = state.get('position');
                    if (pos.lat === 0 && pos.lon === 0) return;
                    mqtt.publish('vistax/sync/time', JSON.stringify({
                        gps_ts: Date.now(),
                        lat:    pos.lat,
                        lon:    pos.lon,
                    }));
                    logger.dbg(3, 'SYNC', `time sync lat:${pos.lat.toFixed(6)} lon:${pos.lon.toFixed(6)}`);
                }, config.aog.syncTimeMs));
            });
        },

        stop() {
            timers.forEach(clearInterval);
            timers.length = 0;
        },
    };
}

module.exports = { createVistaxModule };

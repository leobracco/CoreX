// Módulo QuantiX.
//
// HTTP GET `CONFIG_URL` cada 30s (default) para refrescar configuración
// del implemento (anchos de sección, lista de motores, geometría).
//
// Publica MQTT:
//   agp/motor/{uid_esp}/target {pps, on, ts}  por motor, en cada update GPS/vel

const axios = require('axios');

function createQuantixModule({ mqtt, bus, state, logger, config, vra }) {
    let syncTimer = null;

    async function sincronizar() {
        try {
            const res = await axios.get(config.quantix.configUrl, { timeout: 5000 });
            state.merge('configImplemento', res.data || {});
            logger.dbg(2, 'SYNC', 'Config sincronizada con QuantiX API');
        } catch (_) {
            logger.dbg(2, 'SYNC', 'Esperando API de QuantiX...');
        }
    }

    function procesarMotores() {
        const implemento = state.get('configImplemento');
        const motores = implemento.motores || [];
        if (motores.length === 0) return;

        const pos = state.get('position');
        const vel = state.get('speed_kmh');
        const painting = state.get('painting');

        const dosisObjetivo = vra.lookup(pos.lat, pos.lon);
        const velMs = vel / 3.6;

        for (const motor of motores) {
            const anchoMotor = (motor.ancho_cm || 0) / 100;
            const ppsTarget  = (dosisObjetivo * anchoMotor * velMs * (motor.cal || 1)) / 10000;
            const motorDebeGirar = velMs > 0 && dosisObjetivo > 0 && painting;

            mqtt.publish(`agp/motor/${motor.uid_esp}/target`, JSON.stringify({
                pps: ppsTarget.toFixed(2),
                on:  motorDebeGirar,
                ts:  Date.now(),
            }));
            logger.dbg(3, 'QTX', `motor ${motor.uid_esp} pps:${ppsTarget.toFixed(2)} on:${motorDebeGirar}`);
        }
    }

    return {
        name: 'quantix',
        subscribe: [],

        start() {
            syncTimer = setInterval(sincronizar, config.quantix.syncMs);
            sincronizar(); // kick off inmediato

            bus.on('speed:update', procesarMotores);
            bus.on('gps:update',   procesarMotores);
        },

        stop() {
            if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
        },
    };
}

module.exports = { createQuantixModule };

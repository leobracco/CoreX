// Módulo FlowX.
//
// Publica MQTT:
//   agp/flow/target {pps_target, dosis, vel, ts}   por cada update GPS/velocidad
//
// Suscribe MQTT:
//   agp/flow/ui_cmd      {type:"SET_DOSIS", valor}  → actualiza dosisManual
//   agp/flow/config_save {config completa}           → persiste en disco
//
// Persistencia:
//   data/flowx_config.json  (dosisManual, modoManual, meterCal, pwmMinimo, pid)

const { readJsonSafe, writeJsonSafe } = require('../../services/persist');

function createFlowxModule({ mqtt, bus, state, logger, config, vra }) {
    // Cargar config persistente mergeada con defaults del store
    const saved = readJsonSafe(config.flowx.configFile, {});
    state.merge('flowConfig', saved);
    if (Object.keys(saved).length > 0) {
        logger.dbg(2, 'FLOW', 'flowx_config.json cargado');
    }

    function saveFlowConfig() {
        writeJsonSafe(config.flowx.configFile, state.get('flowConfig'), () => {
            recalc();
        });
    }

    function recalc() {
        const implemento = state.get('configImplemento');
        const flow = state.get('flowConfig');
        const pos = state.get('position');
        const vel = state.get('speed_kmh');

        const anchoTotal = (implemento.anchos_secciones_cm || []).reduce((a, b) => a + b, 0) / 100;
        if (anchoTotal <= 0) return;

        const dosisObjetivo = flow.modoManual
            ? flow.dosisManual
            : vra.lookup(pos.lat, pos.lon);

        const velMs = vel / 3.6;
        const litrosPorMin = (dosisObjetivo * anchoTotal * velMs * 60) / 10000;
        const pulsosPorSeg = litrosPorMin * flow.meterCal / 60;

        mqtt.publish('agp/flow/target', JSON.stringify({
            pps_target: pulsosPorSeg.toFixed(2),
            dosis:      dosisObjetivo,
            vel:        vel.toFixed(1),
            ts:         Date.now(),
        }));
        logger.dbg(3, 'FLOW', `pps:${pulsosPorSeg.toFixed(2)} dosis:${dosisObjetivo} vel:${vel.toFixed(1)}`);
    }

    return {
        name: 'flowx',
        subscribe: ['agp/flow/ui_cmd', 'agp/flow/config_save'],

        onMqttMessage(topic, payload) {
            try {
                const data = JSON.parse(payload.toString());
                if (topic === 'agp/flow/ui_cmd' && data.type === 'SET_DOSIS') {
                    state.merge('flowConfig', { dosisManual: data.valor, modoManual: true });
                    saveFlowConfig();
                    logger.dbg(2, 'FLOW', `Dosis manual: ${data.valor}`);
                } else if (topic === 'agp/flow/config_save') {
                    state.merge('flowConfig', data);
                    saveFlowConfig();
                    logger.dbg(2, 'FLOW', 'Config guardada');
                }
            } catch (e) {
                logger.err('FLOW', `parse ${topic}: ${e.message}`);
            }
        },

        start() {
            // Recalcular en cada update de velocidad o posición
            bus.on('speed:update', recalc);
            bus.on('gps:update', recalc);
        },

        stop() { /* nada persistente */ },
    };
}

module.exports = { createFlowxModule };

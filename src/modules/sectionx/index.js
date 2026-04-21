// Módulo SectionX.
//
// Consume:
//   bus 'sections:raw'  {bitmap: Array(64), ts}  (desde PGN 229)
//
// Publica MQTT:
//   sections/state  {t1: Array(64), t2: Array(64)}
//
// Lógica de tren 2: delay por distancia recorrida. El estado actual (tren 1)
// se encola junto con la meta de distancia acumulada + distancia_trenes_m;
// cuando la distancia real alcanza la meta, se libera el estado al tren 2.
//
// Además deriva el flag global `painting` (alguna sección ON && vel > mínimo)
// y lo coloca en el store. La re-emisión por bus permite a AOG publicar
// aog/field/status actualizado.

function createSectionxModule({ mqtt, bus, state, logger, config }) {
    let distanciaAcumulada = 0;
    let lastTs = Date.now();
    const history = []; // [{ estados: Array(64), distanciaMeta: number }]
    let secCount = 0;

    function updatePainting(sections) {
        const vel = state.get('speed_kmh');
        const nuevo = sections.some(s => s === 1) && vel > config.sectionx.velMinPintado;
        if (nuevo === state.get('painting')) return;
        state.set('painting', nuevo);
        const fieldName = state.get('field')?.name || '';
        logger.dbg(1, 'PAINT', `${nuevo ? '▶ INICIADO' : '⏹ DETENIDO'} — "${fieldName}" | vel:${vel.toFixed(1)}`);
        bus.emit('painting:changed', { painting: nuevo, fieldName, ts: Date.now() });
    }

    function procesarSecciones({ bitmap }) {
        const now = Date.now();
        const dt = (now - lastTs) / 1000;
        lastTs = now;
        distanciaAcumulada += (state.get('speed_kmh') / 3.6) * dt;

        const implemento = state.get('configImplemento');
        const distTren2 = parseFloat(
            implemento?.implemento_activo?.geometria?.distancia_trenes_m
        ) || config.sectionx.distTrenMDefault;

        history.push({
            estados: [...bitmap],
            distanciaMeta: distanciaAcumulada + distTren2,
        });
        if (history.length > config.sectionx.historyCap) history.shift();

        state.set('sections_t1', [...bitmap]);

        while (history.length > 0 && distanciaAcumulada >= history[0].distanciaMeta) {
            state.set('sections_t2', history.shift().estados);
        }

        mqtt.publish('sections/state', JSON.stringify({
            t1: state.get('sections_t1'),
            t2: state.get('sections_t2'),
        }));

        secCount++;
        if (secCount % 5 === 0) {
            const t1on = state.get('sections_t1').filter(s => s === 1).length;
            const t2on = state.get('sections_t2').filter(s => s === 1).length;
            const fmt  = arr => arr.slice(0, 16).map(v => v ? '█' : '·').join('');
            logger.dbg(2, 'SEC', `T1:[${fmt(state.get('sections_t1'))}] (${t1on}) T2:[${fmt(state.get('sections_t2'))}] (${t2on}) | dist:${distanciaAcumulada.toFixed(1)}m`);
        }

        updatePainting(bitmap);
    }

    return {
        name: 'sectionx',
        subscribe: [],

        start() {
            bus.on('sections:raw', procesarSecciones);
        },

        stop() { /* nada persistente */ },
    };
}

module.exports = { createSectionxModule };

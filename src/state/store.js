// State store centralizado con EventEmitter como bus de eventos.
// Los módulos leen estado vía `get(key)` y reaccionan suscribiéndose al bus.

const EventEmitter = require('node:events');

function createStore() {
    const state = {
        position:        { lat: 0, lon: 0, ts: 0 },
        heading:         0,
        speed_kmh:       0,
        painting:        false,
        field:           { name: '', accion: '', ts: 0 },
        sections_t1:     new Array(64).fill(0),
        sections_t2:     new Array(64).fill(0),
        configImplemento:{ anchos_secciones_cm: [], cantidad_secciones_aog: 0, motores: [] },
        flowConfig:      { dosisManual: 0, modoManual: true, meterCal: 1, pwmMinimo: 0, pid: { kp: 0.1, ki: 0, kd: 0 } },
    };

    const bus = new EventEmitter();
    bus.setMaxListeners(50);

    return {
        bus,
        get(key)       { return state[key]; },
        set(key, val)  {
            state[key] = val;
            bus.emit(`state:${key}`, val);
        },
        merge(key, partial) {
            state[key] = { ...state[key], ...partial };
            bus.emit(`state:${key}`, state[key]);
            return state[key];
        },
        snapshot()     { return { ...state }; },
    };
}

module.exports = { createStore };

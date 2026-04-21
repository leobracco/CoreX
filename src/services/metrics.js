// Registry de métricas en memoria con formato de texto Prometheus.
// Diseñado para una sola instancia — no hay locking, runtime single-threaded.
//
// Tipos soportados:
//   - counter: monotónico creciente (total events)
//   - gauge:   valor puntual (último ts, vel, etc.)
//
// API:
//   m.counter(name, labels).inc(n=1)
//   m.gauge(name, labels).set(v)
//   m.render()  → texto en formato Prometheus

function labelsKey(labels) {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return '';
    return keys.map(k => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`).join(',');
}

function fullKey(name, labels) {
    const lk = labelsKey(labels);
    return lk ? `${name}{${lk}}` : name;
}

function createMetrics() {
    const defs = new Map();      // name → { type, help }
    const values = new Map();    // fullKey → { name, labels, value }

    function registerDef(name, type, help) {
        if (!defs.has(name)) defs.set(name, { type, help });
    }

    function counter(name, labels, help = '') {
        registerDef(name, 'counter', help);
        const key = fullKey(name, labels);
        if (!values.has(key)) values.set(key, { name, labels: labels || {}, value: 0 });
        const entry = values.get(key);
        return {
            inc(n = 1) { entry.value += n; },
            value: () => entry.value,
        };
    }

    function gauge(name, labels, help = '') {
        registerDef(name, 'gauge', help);
        const key = fullKey(name, labels);
        if (!values.has(key)) values.set(key, { name, labels: labels || {}, value: 0 });
        const entry = values.get(key);
        return {
            set(v) { entry.value = v; },
            inc(n = 1) { entry.value += n; },
            dec(n = 1) { entry.value -= n; },
            value: () => entry.value,
        };
    }

    function render() {
        // Agrupar por nombre para emitir HELP/TYPE una sola vez.
        const byName = new Map();
        for (const entry of values.values()) {
            if (!byName.has(entry.name)) byName.set(entry.name, []);
            byName.get(entry.name).push(entry);
        }
        let out = '';
        for (const [name, entries] of byName) {
            const def = defs.get(name) || { type: 'gauge', help: '' };
            if (def.help) out += `# HELP ${name} ${def.help}\n`;
            out += `# TYPE ${name} ${def.type}\n`;
            for (const e of entries) {
                out += `${fullKey(e.name, e.labels)} ${e.value}\n`;
            }
        }
        return out;
    }

    function reset() {
        defs.clear();
        values.clear();
    }

    return { counter, gauge, render, reset };
}

module.exports = { createMetrics, labelsKey, fullKey };

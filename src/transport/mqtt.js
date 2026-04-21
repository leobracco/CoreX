// Transport MQTT: cliente envuelto con registry de suscripciones y dispatch
// por topic. Mantiene el contrato pub/sub simple para los módulos.

const mqtt = require('mqtt');

function createMqttTransport({ brokerUrl, bus, logger }) {
    const client = mqtt.connect(brokerUrl);
    const handlers = new Map(); // topic → Set<fn(topic, payload)>

    client.on('connect', () => {
        logger.dbg(1, 'MQTT', `🚀 Conectado al broker ${brokerUrl}`);
        bus.emit('mqtt:connect');
    });

    client.on('reconnect', () => {
        logger.warn('MQTT', 'Reconectando al broker...');
    });

    client.on('error', (err) => {
        logger.err('MQTT', err.message);
    });

    client.on('message', (topic, payload) => {
        const set = handlers.get(topic);
        if (!set) return;
        for (const fn of set) {
            try {
                fn(topic, payload);
            } catch (e) {
                logger.err('MQTT', `handler ${topic}: ${e.message}`);
            }
        }
    });

    function subscribe(topic, handler) {
        let set = handlers.get(topic);
        if (!set) {
            set = new Set();
            handlers.set(topic, set);
            client.subscribe(topic, (err) => {
                if (err) logger.err('MQTT', `subscribe ${topic}: ${err.message}`);
            });
        }
        set.add(handler);
    }

    function publish(topic, payload, opts) {
        if (!client.connected) return;
        client.publish(topic, payload, opts);
    }

    function stop() {
        return new Promise((resolve) => {
            try {
                client.end(false, {}, () => resolve());
            } catch (_) {
                resolve();
            }
        });
    }

    return {
        client,
        subscribe,
        publish,
        stop,
        get connected() { return client.connected; },
    };
}

module.exports = { createMqttTransport };

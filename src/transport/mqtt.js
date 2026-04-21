// Transport MQTT: cliente envuelto con registry de suscripciones y dispatch
// por topic. Mantiene el contrato pub/sub simple para los módulos.

const mqtt = require('mqtt');

function createMqttTransport({ brokerUrl, bus, logger, metrics }) {
    const client = mqtt.connect(brokerUrl);
    const handlers = new Map(); // topic → Set<fn(topic, payload)>

    const mConnects      = metrics?.counter('corex_mqtt_connects_total', {}, 'MQTT connect events') ?? { inc: () => {} };
    const mReconnects    = metrics?.counter('corex_mqtt_reconnects_total', {}, 'MQTT reconnect attempts') ?? { inc: () => {} };
    const mErrors        = metrics?.counter('corex_mqtt_errors_total', {}, 'MQTT client errors') ?? { inc: () => {} };
    const mPublishes     = metrics?.counter('corex_mqtt_publishes_total', {}, 'MQTT publishes issued') ?? { inc: () => {} };
    const mMessagesRcvd  = metrics?.counter('corex_mqtt_messages_total', {}, 'MQTT messages received') ?? { inc: () => {} };
    const mConnected     = metrics?.gauge('corex_mqtt_connected', {}, 'MQTT broker connection (1=up, 0=down)') ?? { set: () => {} };
    mConnected.set(0);

    client.on('connect', () => {
        mConnects.inc();
        mConnected.set(1);
        logger.dbg(1, 'MQTT', `🚀 Conectado al broker ${brokerUrl}`);
        bus.emit('mqtt:connect');
    });

    client.on('reconnect', () => {
        mReconnects.inc();
        logger.warn('MQTT', 'Reconectando al broker...');
    });

    client.on('close', () => mConnected.set(0));
    client.on('offline', () => mConnected.set(0));

    client.on('error', (err) => {
        mErrors.inc();
        logger.err('MQTT', err.message);
    });

    client.on('message', (topic, payload) => {
        mMessagesRcvd.inc();
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
        mPublishes.inc();
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

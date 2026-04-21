// Transport UDP: un socket dgram que decodifica PGN y emite eventos en el bus.
// Eventos emitidos:
//   gps:update          { lat, lon, ts }              (PGN 100)
//   speed:update        { speed_kmh, ts }             (PGN 254)
//   sections:dimensions { count, widths_cm }          (PGN 235)
//   sections:raw        { bitmap: Array(64), ts }     (PGN 229)
//
// También expone `send(buf, port, host, cb)` para que los módulos que necesiten
// transmitir PGN (ej: AOG con PGN 253) reutilicen el mismo socket.

const dgram = require('dgram');
const protocol = require('../protocol');

function createUdpTransport({ port, bus, logger }) {
    const socket = dgram.createSocket('udp4');
    let frameCount = 0;

    socket.on('message', (msg) => {
        if (msg.length < protocol.MIN_FRAME_LEN) return;
        const frame = protocol.decode(msg);
        if (!frame) return;

        frameCount++;
        logger.dbg(3, 'UDP', `PGN ${frame.pgn} len:${frame.len} #${frameCount}`);

        const now = Date.now();
        const d = frame.data;

        switch (frame.pgn) {
            case protocol.PGN.STEER_DATA: { // 254
                if (d.length >= 3) {
                    bus.emit('speed:update', { speed_kmh: d.readInt16LE(0) / 10, ts: now });
                }
                break;
            }
            case protocol.PGN.POSITION: { // 100
                // Formato original: lat@msg[13] lon@msg[5] (doubleLE).
                // En frame.data (que empieza en msg[5]): lon@0, lat@8.
                if (d.length >= 16) {
                    const lon = d.readDoubleLE(0);
                    const lat = d.readDoubleLE(8);
                    bus.emit('gps:update', { lat, lon, ts: now });
                }
                break;
            }
            case protocol.PGN.SECTION_DIMS: { // 235
                // cantidad en msg[37] → data[32]; anchos uint16LE desde msg[5] → data[0]
                if (d.length >= 33) {
                    const count = d[32];
                    if (count > 0 && d.length >= count * 2) {
                        const widths_cm = [];
                        for (let i = 0; i < count; i++) widths_cm.push(d.readUInt16LE(i * 2));
                        bus.emit('sections:dimensions', { count, widths_cm });
                    }
                }
                break;
            }
            case protocol.PGN.SECTIONS_STATE: { // 229
                if (d.length >= 8) {
                    const bitmap = new Array(64).fill(0);
                    for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
                        const b = d[byteIdx];
                        for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
                            bitmap[byteIdx * 8 + bitIdx] = (b >> bitIdx) & 1;
                        }
                    }
                    bus.emit('sections:raw', { bitmap, ts: now });
                }
                break;
            }
            default: {
                bus.emit('udp:unknown', frame);
            }
        }
    });

    socket.on('error', (err) => {
        logger.err('UDP', `socket error: ${err.message}`);
    });

    return {
        start() {
            return new Promise((resolve) => {
                socket.bind(port, () => {
                    try { socket.setBroadcast(true); } catch (_) {}
                    resolve();
                });
            });
        },
        send(buf, destPort, destHost, cb) {
            socket.send(buf, destPort, destHost, cb);
        },
        stop() {
            try { socket.close(); } catch (_) {}
        },
        get frameCount() { return frameCount; },
    };
}

module.exports = { createUdpTransport };

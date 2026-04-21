// Encode / decode / CRC del protocolo AgOpenGPS.
// Formato: [0x80][0x81][Src][PGN][Len][...Data(len bytes)...][CRC]
// CRC = Σ bytes[2 .. n-2] & 0xFF

const { HEADER_0, HEADER_1, MIN_FRAME_LEN } = require('./constants');

function computeCRC(frame) {
    let sum = 0;
    for (let i = 2; i < frame.length - 1; i++) {
        sum = (sum + frame[i]) & 0xFF;
    }
    return sum;
}

function isValidPGN(msg) {
    return (
        Buffer.isBuffer(msg) &&
        msg.length >= MIN_FRAME_LEN &&
        msg[0] === HEADER_0 &&
        msg[1] === HEADER_1
    );
}

function validateCRC(msg) {
    if (!isValidPGN(msg)) return false;
    return computeCRC(msg) === msg[msg.length - 1];
}

function encode(src, pgn, data) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const len = payload.length;
    const frame = Buffer.alloc(5 + len + 1);
    frame[0] = HEADER_0;
    frame[1] = HEADER_1;
    frame[2] = src & 0xFF;
    frame[3] = pgn & 0xFF;
    frame[4] = len & 0xFF;
    payload.copy(frame, 5);
    frame[frame.length - 1] = computeCRC(frame);
    return frame;
}

/**
 * Decodifica una trama. Devuelve null si la trama es inválida
 * (header incorrecto, longitud truncada). NO descarta por CRC inválido;
 * expone `crcValid` para que el consumidor decida.
 */
function decode(msg) {
    if (!isValidPGN(msg)) return null;
    const len = msg[4];
    if (msg.length < 5 + len + 1) return null;
    return {
        src: msg[2],
        pgn: msg[3],
        len,
        data: msg.slice(5, 5 + len),
        crc: msg[msg.length - 1],
        crcValid: computeCRC(msg) === msg[msg.length - 1],
    };
}

module.exports = {
    encode,
    decode,
    computeCRC,
    validateCRC,
    isValidPGN,
};

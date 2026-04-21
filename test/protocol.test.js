// Tests para src/protocol — encode/decode/CRC del protocolo AgOpenGPS.
// Ejecutar: npm test  (node --test test/)

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    encode,
    decode,
    computeCRC,
    validateCRC,
    isValidPGN,
    SRC,
    PGN,
    SWITCH,
    HEADER_0,
    HEADER_1,
} = require('../src/protocol');

// ---------- encode ----------

test('encode: cabecera 0x80 0x81 y campos básicos correctos', () => {
    const data = Buffer.from([0x01, 0x02, 0x03]);
    const f = encode(SRC.AUTOSTEER, PGN.FROM_STEER, data);

    assert.equal(f[0], HEADER_0);
    assert.equal(f[1], HEADER_1);
    assert.equal(f[2], SRC.AUTOSTEER);
    assert.equal(f[3], PGN.FROM_STEER);
    assert.equal(f[4], 3);
    assert.deepEqual(f.slice(5, 8), data);
    assert.equal(f.length, 5 + 3 + 1);
});

test('encode: CRC = suma de bytes [2..n-2] & 0xFF', () => {
    const data = Buffer.from([0x4B, 0x01, 0x0F, 0x27, 0xB8, 0x22, 0x05, 0x2C]);
    const f = encode(SRC.AUTOSTEER, PGN.FROM_STEER, data);
    // suma manual: 0x7E + 0xFD + 0x08 + (0x4B+0x01+0x0F+0x27+0xB8+0x22+0x05+0x2C)
    let expected = 0;
    for (let i = 2; i < f.length - 1; i++) expected = (expected + f[i]) & 0xFF;
    assert.equal(f[f.length - 1], expected);
    assert.ok(validateCRC(f));
});

test('encode: acepta array además de Buffer', () => {
    const f = encode(0x7E, 100, [0xAA, 0xBB]);
    assert.equal(f[5], 0xAA);
    assert.equal(f[6], 0xBB);
    assert.ok(validateCRC(f));
});

test('encode: compatibilidad byte-a-byte con buildPGN legacy (vector pcap PGN 253)', () => {
    // Payload tomado de la captura del emulador AOG (tools/test_pgn253.js)
    const payload = Buffer.from([0x4B, 0x01, 0x0F, 0x27, 0xB8, 0x22, 0x05, 0x2C]);

    const fNew = encode(0x7E, 0xFD, payload);

    // Reimplementamos la lógica original inline para asegurar paridad
    const fLegacy = Buffer.alloc(5 + payload.length + 1);
    fLegacy[0] = 0x80; fLegacy[1] = 0x81;
    fLegacy[2] = 0x7E; fLegacy[3] = 0xFD; fLegacy[4] = payload.length;
    payload.copy(fLegacy, 5);
    let crc = 0;
    for (let i = 2; i < fLegacy.length - 1; i++) crc = (crc + fLegacy[i]) & 0xFF;
    fLegacy[fLegacy.length - 1] = crc;

    assert.deepEqual(fNew, fLegacy);
});

test('encode: src/pgn mayores a 255 se truncan a byte', () => {
    const f = encode(0x17E, 0x1FD, Buffer.alloc(0));
    assert.equal(f[2], 0x7E);
    assert.equal(f[3], 0xFD);
});

test('encode: payload vacío produce trama de 6 bytes', () => {
    const f = encode(0x7E, 100, Buffer.alloc(0));
    assert.equal(f.length, 6);
    assert.ok(validateCRC(f));
});

// ---------- isValidPGN ----------

test('isValidPGN: rechaza no-Buffer', () => {
    assert.equal(isValidPGN('0x80 0x81 ...'), false);
    assert.equal(isValidPGN(null), false);
    assert.equal(isValidPGN(undefined), false);
});

test('isValidPGN: rechaza trama demasiado corta', () => {
    assert.equal(isValidPGN(Buffer.alloc(0)), false);
    assert.equal(isValidPGN(Buffer.from([0x80, 0x81])), false);
    assert.equal(isValidPGN(Buffer.from([0x80, 0x81, 0x7E, 0xFD, 0x00])), false);
});

test('isValidPGN: rechaza header incorrecto', () => {
    const bad = Buffer.alloc(10);
    bad[0] = 0xAA; bad[1] = 0xBB;
    assert.equal(isValidPGN(bad), false);
});

test('isValidPGN: acepta trama válida mínima', () => {
    const f = encode(0x7E, 100, Buffer.alloc(0));
    assert.equal(isValidPGN(f), true);
});

// ---------- validateCRC ----------

test('validateCRC: detecta CRC corrupto', () => {
    const f = encode(0x7E, 100, Buffer.from([0x01, 0x02]));
    f[f.length - 1] ^= 0xFF;
    assert.equal(validateCRC(f), false);
});

test('validateCRC: acepta CRC correcto', () => {
    const f = encode(0x7E, 100, Buffer.from([0x01, 0x02]));
    assert.equal(validateCRC(f), true);
});

// ---------- decode ----------

test('decode: roundtrip preserva src, pgn, len, data', () => {
    const payload = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]);
    const f = encode(SRC.MACHINE, PGN.FROM_MACHINE, payload);
    const d = decode(f);

    assert.equal(d.src, SRC.MACHINE);
    assert.equal(d.pgn, PGN.FROM_MACHINE);
    assert.equal(d.len, 5);
    assert.deepEqual(d.data, payload);
    assert.equal(d.crcValid, true);
});

test('decode: devuelve null si trama inválida', () => {
    assert.equal(decode(Buffer.alloc(0)), null);
    assert.equal(decode(Buffer.from([0xAA, 0xBB, 0x7E, 0xFD, 0x00, 0x00])), null);
});

test('decode: devuelve null si len declara más datos que los disponibles', () => {
    // Header OK pero len=10 y solo hay 2 bytes de data
    const f = Buffer.from([0x80, 0x81, 0x7E, 0xFD, 0x0A, 0x01, 0x02, 0x00]);
    assert.equal(decode(f), null);
});

test('decode: expone crcValid=false sin descartar la trama', () => {
    const f = encode(0x7E, PGN.POSITION, Buffer.from([0x01, 0x02]));
    f[f.length - 1] ^= 0xFF;
    const d = decode(f);
    assert.ok(d, 'decode debe devolver objeto, no null');
    assert.equal(d.crcValid, false);
    assert.equal(d.pgn, PGN.POSITION);
});

// ---------- computeCRC ----------

test('computeCRC: es sum&0xFF desde índice 2 hasta length-2', () => {
    const f = Buffer.from([0x80, 0x81, 0x7E, 0xFD, 0x02, 0xAA, 0xBB, 0x00]);
    // suma = 0x7E + 0xFD + 0x02 + 0xAA + 0xBB = 0x02E2 → & 0xFF = 0xE2
    assert.equal(computeCRC(f), 0xE2);
});

// ---------- SWITCH bitmask (contrato con PGN 253) ----------

test('SWITCH: MAIN=0x04, WORK=0x01, STEER=0x02 (contrato AOG)', () => {
    assert.equal(SWITCH.MAIN,  0x04);
    assert.equal(SWITCH.WORK,  0x01);
    assert.equal(SWITCH.STEER, 0x02);
});

test('SWITCH: byte típico "trabajando + main" = 0x05', () => {
    assert.equal(SWITCH.MAIN | SWITCH.WORK, 0x05);
});

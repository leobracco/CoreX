// ============================================================
// test_pgn253.js — Envía un PGN 253 de prueba a AOG
// ============================================================
// Uso:
//   node test_pgn253.js <ip> <port> <workSwitch 0|1>
//
// Ejemplos:
//   node test_pgn253.js 127.0.0.1 15555 1
//   node test_pgn253.js 192.168.1.255 9999 1
//   node test_pgn253.js 127.0.0.1 15555 0
//
// Basado en captura pcap del emulador de AOG:
// PGN 253 From AutoSteer
//   Src: 0x7E (126)
//   Len: 8
//   Bytes: [steerAngleLo][steerAngleHi][hdgLo][hdgHi][rollLo][rollHi][Switch][PWM]
//
// Byte Switch:
//   bit 0 = workSwitch
//   bit 1 = steerSwitch
//   bit 2 = mainSwitch (SIEMPRE 1)
// ============================================================

const dgram = require('dgram');

const ip    = process.argv[2] || '127.0.0.1';
const port  = parseInt(process.argv[3]) || 15555;
const work  = parseInt(process.argv[4]) || 0;

function buildPGN(src, pgn, data) {
    const msg = Buffer.alloc(5 + data.length + 1);
    msg[0] = 0x80;
    msg[1] = 0x81;
    msg[2] = src;
    msg[3] = pgn;
    msg[4] = data.length;
    data.copy(msg, 5);
    let crc = 0;
    for (let i = 2; i < msg.length - 1; i++) crc = (crc + msg[i]) & 0xFF;
    msg[msg.length - 1] = crc;
    return msg;
}

// Payload idéntico al que captura el pcap, salvo el byte Switch
// 4b 01 = steerAngle 0x014B = 331 = 3.31°
// 0f 27 = heading    0x270F = 9999 = 99.99°
// b8 22 = roll       0x22B8 = 8888
// [switch]
// 2c = PWM 44
const payload = Buffer.from([
    0x4B, 0x01,              // steerAngle
    0x0F, 0x27,              // heading
    0xB8, 0x22,              // roll
    work ? 0x05 : 0x04,      // switch (bit 2 mainSwitch + opcional bit 0 work)
    0x2C                     // pwmDisplay
]);

const packet = buildPGN(0x7E, 0xFD, payload);

console.log('╔════════════════════════════════════════════════╗');
console.log('║    Test PGN 253 — From AutoSteer                ║');
console.log('╚════════════════════════════════════════════════╝');
console.log(`Target:      ${ip}:${port}`);
console.log(`workSwitch:  ${work} (${work ? 'DOWN ⬇' : 'UP ⬆'})`);
console.log(`switchByte:  0x${payload[6].toString(16).padStart(2, '0')} (${payload[6].toString(2).padStart(8, '0')})`);
console.log(`raw packet:  ${[...packet].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
console.log('');

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

// Envío en loop cada 100ms durante 5 segundos
// (AOG espera stream continuo del AutoSteer)
let count = 0;
const maxCount = 50;

sock.bind(0, () => {
    try { sock.setBroadcast(true); } catch (e) {}

    console.log(`Enviando ${maxCount} paquetes (10 Hz, 5 seg)...`);

    const interval = setInterval(() => {
        sock.send(packet, port, ip, (err) => {
            if (err) {
                console.error(`✖ Error: ${err.message}`);
                clearInterval(interval);
                sock.close();
                process.exit(1);
            }
            count++;
            if (count % 10 === 0) process.stdout.write(`  ${count}/${maxCount}\r`);
            if (count >= maxCount) {
                clearInterval(interval);
                console.log(`\n✓ ${count} paquetes enviados correctamente.`);
                console.log('Si AOG reaccionó, este es el puerto correcto.');
                sock.close();
                process.exit(0);
            }
        });
    }, 1000);
});

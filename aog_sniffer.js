// ============================================================
// AOG Sniffer v2 — escucha tráfico UDP y decodifica PGN
// ============================================================
// Modos de uso:
//
//   1) LISTEN (default) — escucha puertos indicados
//      node aog_sniffer.js
//      node aog_sniffer.js 9998 17777
//
//   2) DISCOVER — envía Scan Request a la red y muestra respuestas
//      node aog_sniffer.js --discover
//      node aog_sniffer.js --discover 192.168.5.255
//
//   3) TEST-PGN237 — envía un PGN 237 de prueba a una IP:puerto
//      node aog_sniffer.js --test 127.0.0.1 9999 1
//      node aog_sniffer.js --test 192.168.5.255 8888 0
//
// NOTA sobre Windows:
//   Si ves "bind EACCES", ese puerto ya está ocupado por AgIO/AOG.
//   Es BUENA señal: confirma que algo escucha ahí.
//   Usá puertos libres para escuchar (ej: 9998) y apuntá CoreX a ellos.
// ============================================================

const dgram = require('dgram');

const C = {
  r:   '\x1b[0m',
  red: '\x1b[31m',
  grn: '\x1b[32m',
  yel: '\x1b[33m',
  blu: '\x1b[34m',
  mag: '\x1b[35m',
  cyn: '\x1b[36m',
  gry: '\x1b[90m',
  bld: '\x1b[1m',
};

const PGN_NAMES = {
  100: 'Position GPS',
  202: 'Scan Request',
  203: 'Subnet Reply',
  211: 'From IMU',
  214: 'Main Antenna GPS',
  221: 'Hardware Message',
  222: 'Nudge by Machine',
  229: '64 Sections State',
  235: 'Section Dimensions',
  236: 'Pin Config',
  237: 'From Machine ⭐',
  238: 'Machine Config',
  239: 'Machine Data',
  250: 'From Autosteer 2',
  251: 'Steer Config',
  252: 'Steer Settings',
  253: 'From Autosteer',
  254: 'Steer Data',
};

function ts() {
  return new Date().toISOString().substr(11, 12);
}

function hex(buf, max = 32) {
  const bytes = [...buf.slice(0, max)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
  return buf.length > max ? bytes + ` ... (+${buf.length - max})` : bytes;
}

function isValidPGN(msg) {
  return msg.length >= 5 && msg[0] === 0x80 && msg[1] === 0x81;
}

function validateCRC(msg) {
  if (msg.length < 6) return false;
  let sum = 0;
  for (let i = 2; i < msg.length - 1; i++) sum = (sum + msg[i]) & 0xFF;
  return sum === msg[msg.length - 1];
}

function buildPGN(src, pgn, data) {
  const len = data.length;
  const msg = Buffer.alloc(5 + len + 1);
  msg[0] = 0x80;
  msg[1] = 0x81;
  msg[2] = src;
  msg[3] = pgn;
  msg[4] = len;
  data.copy(msg, 5);
  let crc = 0;
  for (let i = 2; i < msg.length - 1; i++) crc = (crc + msg[i]) & 0xFF;
  msg[msg.length - 1] = crc;
  return msg;
}

function decodePGN(msg) {
  const src = msg[2];
  const pgn = msg[3];
  const len = msg[4];
  const data = msg.slice(5, 5 + len);
  const name = PGN_NAMES[pgn] || `PGN ${pgn}`;
  const parts = [`${C.bld}${name}${C.r}`, `${C.gry}src:0x${src.toString(16)}(${src}) len:${len}${C.r}`];

  switch (pgn) {
    case 237: {
      const workSwitch = (data[0] & 0x01) ? 'ON' : 'OFF';
      parts.push(`${C.mag}workSwitch=${workSwitch}${C.r}`);
      parts.push(`${C.gry}byte0=0b${data[0].toString(2).padStart(8,'0')}${C.r}`);
      break;
    }
    case 239: {
      if (len >= 8) {
        const hydLift = data[2];
        parts.push(`${C.mag}hydLift:${hydLift}${C.r} speed:${(data[1]/10).toFixed(1)} tram:${data[3]}`);
      }
      break;
    }
    case 254: {
      if (len >= 8) {
        const speed = msg.readInt16LE(5) / 10;
        parts.push(`speed:${speed.toFixed(1)}km/h status:0x${msg[7].toString(16)}`);
      }
      break;
    }
    case 203: {
      if (len >= 7) {
        parts.push(`IP: ${data[0]}.${data[1]}.${data[2]}.${data[3]}`);
      }
      break;
    }
    case 202:
      parts.push(`${C.yel}(discovery)${C.r}`);
      break;
    default:
      parts.push(`${C.gry}data: ${hex(data, 8)}${C.r}`);
  }
  return parts.join(' ');
}

// ── Sockets activos (para cierre seguro) ────────────────────
const activeSockets = new Set();

function closeSocketSafe(sock) {
  try {
    if (sock && activeSockets.has(sock)) {
      sock.close();
      activeSockets.delete(sock);
    }
  } catch (e) { /* ignorar */ }
}

// ── MODO: LISTEN ────────────────────────────────────────────
function modoListen(ports) {
  console.log(`${C.bld}${C.cyn}╔══════════════════════════════════════════════════════════╗${C.r}`);
  console.log(`${C.bld}${C.cyn}║           AOG UDP Sniffer — modo LISTEN                 ║${C.r}`);
  console.log(`${C.bld}${C.cyn}╚══════════════════════════════════════════════════════════╝${C.r}`);
  console.log(`${C.gry}Escuchando puertos: ${ports.join(', ')}${C.r}`);
  console.log(`${C.gry}Ctrl+C para salir.${C.r}\n`);

  const stats = {};

  ports.forEach(port => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', (msg, rinfo) => {
      stats[port] = stats[port] || { total: 0, pgns: {}, sources: new Set() };
      stats[port].total++;
      stats[port].sources.add(rinfo.address);

      const arrow = `${C.gry}${rinfo.address}:${rinfo.port}${C.r} ${C.yel}→${C.r} ${C.cyn}:${port}${C.r}`;

      if (!isValidPGN(msg)) {
        console.log(`${C.gry}${ts()}${C.r} ${arrow} ${C.red}[NO-PGN]${C.r} ${hex(msg, 16)}`);
        return;
      }

      const pgn = msg[3];
      stats[port].pgns[pgn] = (stats[port].pgns[pgn] || 0) + 1;
      const crcOK = validateCRC(msg);
      const crcTag = crcOK ? `${C.grn}✓${C.r}` : `${C.red}✗CRC${C.r}`;

      console.log(`${C.gry}${ts()}${C.r} ${arrow} ${crcTag} ${decodePGN(msg)}`);
      if (pgn === 237) {
        console.log(`       ${C.gry}raw: ${hex(msg)}${C.r}`);
      }
    });

    sock.on('error', (err) => {
      if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
        console.log(`${C.yel}⚠${C.r} :${port} ocupado (${err.code}) — ${C.gry}otro proceso ya escucha ahí (AgIO/AOG)${C.r}`);
      } else {
        console.log(`${C.red}✖ :${port} ${err.message}${C.r}`);
      }
      closeSocketSafe(sock);
    });

    sock.bind(port, () => {
      activeSockets.add(sock);
      try { sock.setBroadcast(true); } catch (e) {}
      console.log(`${C.grn}✓${C.r} Escuchando en ${C.bld}:${port}${C.r}`);
    });
  });

  process.on('SIGINT', () => {
    console.log(`\n\n${C.bld}${C.cyn}═══ RESUMEN ═══${C.r}`);
    if (Object.keys(stats).length === 0) {
      console.log(`${C.yel}No se recibió ningún paquete en los puertos escuchados.${C.r}`);
      console.log(`${C.gry}Los puertos ocupados (EACCES) sí tienen tráfico, pero no podemos verlo desde Node.${C.r}`);
      console.log(`${C.gry}Usá Wireshark para verlos, o redirigí CoreX a un puerto libre.${C.r}`);
    } else {
      for (const [port, data] of Object.entries(stats)) {
        console.log(`\n${C.bld}Puerto :${port}${C.r} — ${data.total} paquetes`);
        console.log(`  ${C.gry}Sources: ${[...data.sources].join(', ')}${C.r}`);
        for (const [pgn, count] of Object.entries(data.pgns).sort((a, b) => b[1] - a[1])) {
          const name = PGN_NAMES[pgn] || `PGN ${pgn}`;
          console.log(`    ${pgn.toString().padStart(3)} ${name.padEnd(30)} × ${count}`);
        }
      }
    }
    activeSockets.forEach(closeSocketSafe);
    setTimeout(() => process.exit(0), 100);
  });
}

// ── MODO: DISCOVER ──────────────────────────────────────────
function modoDiscover(targetIP) {
  console.log(`${C.bld}${C.cyn}╔══════════════════════════════════════════════════════════╗${C.r}`);
  console.log(`${C.bld}${C.cyn}║           AOG UDP Sniffer — modo DISCOVER               ║${C.r}`);
  console.log(`${C.bld}${C.cyn}╚══════════════════════════════════════════════════════════╝${C.r}`);
  console.log(`${C.gry}Enviando Scan Request a ${targetIP}...${C.r}\n`);

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.bind(0, () => {
    try { sock.setBroadcast(true); } catch (e) {}
    activeSockets.add(sock);

    const scanRequest = buildPGN(0x7F, 0xCA, Buffer.from([0xCA, 0xCA, 0x05]));

    const portsToScan = [8888, 9999, 5123, 5126, 5121, 17777];
    portsToScan.forEach(port => {
      sock.send(scanRequest, port, targetIP, (err) => {
        if (err) console.log(`${C.red}✖${C.r} :${port} ${err.message}`);
        else console.log(`${C.grn}→${C.r} Scan enviado a ${targetIP}:${port}`);
      });
    });

    console.log(`\n${C.gry}Esperando respuestas 5 segundos...${C.r}\n`);
  });

  sock.on('message', (msg, rinfo) => {
    const arrow = `${C.gry}${rinfo.address}:${rinfo.port}${C.r}`;
    if (isValidPGN(msg)) {
      console.log(`${C.grn}✓ RESPUESTA${C.r} de ${arrow} ${decodePGN(msg)}`);
    } else {
      console.log(`${C.yel}? RAW${C.r} de ${arrow}: ${hex(msg, 16)}`);
    }
  });

  sock.on('error', (err) => {
    console.log(`${C.red}✖${C.r} ${err.message}`);
    closeSocketSafe(sock);
  });

  setTimeout(() => {
    console.log(`\n${C.gry}Fin del discovery.${C.r}`);
    closeSocketSafe(sock);
    process.exit(0);
  }, 5000);
}

// ── MODO: TEST PGN 237 ──────────────────────────────────────
function modoTest(targetIP, targetPort, value) {
  console.log(`${C.bld}${C.cyn}╔══════════════════════════════════════════════════════════╗${C.r}`);
  console.log(`${C.bld}${C.cyn}║           AOG UDP Sniffer — modo TEST PGN 237           ║${C.r}`);
  console.log(`${C.bld}${C.cyn}╚══════════════════════════════════════════════════════════╝${C.r}`);

  const data = Buffer.alloc(8, 0);
  if (value === 1) data[0] = 0x01;

  const packet = buildPGN(0x7B, 0xED, data);

  console.log(`${C.gry}Target:${C.r}   ${targetIP}:${targetPort}`);
  console.log(`${C.gry}Value:${C.r}    ${value} (${value === 1 ? 'DOWN ⬇' : 'UP ⬆'})`);
  console.log(`${C.gry}PGN 237:${C.r} ${hex(packet)}\n`);

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.bind(0, () => {
    try { sock.setBroadcast(true); } catch (e) {}
    activeSockets.add(sock);

    sock.send(packet, targetPort, targetIP, (err) => {
      if (err) {
        console.log(`${C.red}✖ Error:${C.r} ${err.message}`);
      } else {
        console.log(`${C.grn}✓${C.r} Paquete enviado correctamente.`);
        console.log(`${C.gry}Si AOG está escuchando en ese puerto, el work switch debería cambiar.${C.r}`);
      }
      setTimeout(() => {
        closeSocketSafe(sock);
        process.exit(err ? 1 : 0);
      }, 200);
    });
  });

  sock.on('error', (err) => {
    console.log(`${C.red}✖${C.r} ${err.message}`);
    closeSocketSafe(sock);
    process.exit(1);
  });
}

// ── Parse args y dispatch ───────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === '--discover') {
  const ip = args[1] || '255.255.255.255';
  modoDiscover(ip);
} else if (args[0] === '--test') {
  const ip    = args[1] || '127.0.0.1';
  const port  = parseInt(args[2]) || 9999;
  const value = parseInt(args[3]) || 0;
  modoTest(ip, port, value);
} else {
  const ports = args.length > 0
    ? args.map(Number).filter(n => !isNaN(n))
    : [9998, 17777, 5123, 5126, 5121];
  modoListen(ports);
}

const dgram = require('dgram');
const client = dgram.createSocket('udp4');

const PORT = 9999;
const HOST = '192.168.5.1';

// Configuración de simulación
let lat = -34.250000; 
let lon = -59.466667;
const speedKmh = 3.0; // Velocidad objetivo
const intervalMs = 100; // 10Hz

// Incremento de latitud para que el GPS "se mueva" físicamente
const latIncrement = (speedKmh / 3.6) * (intervalMs / 1000) / 111320;

function getNmeaChecksum(str) {
    let checksum = 0;
    for (let i = 0; i < str.length; i++) {
        checksum ^= str.charCodeAt(i);
    }
    return checksum.toString(16).toUpperCase().padStart(2, '0');
}

function sendGpsData() {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(8, 14);
    
    // 1. Generar GGA (Posición y Fix)
    const latAbs = Math.abs(lat);
    const latDeg = Math.floor(latAbs);
    const latMin = ((latAbs - latDeg) * 60).toFixed(5).padStart(8, '0');
    const latHemi = lat < 0 ? 'S' : 'N';

    const lonAbs = Math.abs(lon);
    const lonDeg = Math.floor(lonAbs);
    const lonMin = ((lonAbs - lonDeg) * 60).toFixed(5).padStart(8, '0');
    const lonHemi = lon < 0 ? 'W' : 'E';

    const ggaPayload = `GPGGA,${timestamp},${latDeg}${latMin},${latHemi},0${lonDeg}${lonMin},${lonHemi},4,12,0.8,50.0,M,0.0,M,,`;
    const gga = `$${ggaPayload}*${getNmeaChecksum(ggaPayload)}\r\n`;

    // 2. Generar VTG (Velocidad Crucial para AOG)
    // GPVTG, curso_verdadero, T, curso_mag, M, nudos, N, kmh, K, modo
    const speedKnots = (speedKmh / 1.852).toFixed(1);
    const vtgPayload = `GPVTG,0.0,T,,M,${speedKnots},N,${speedKmh.toFixed(1)},K,A`;
    const vtg = `$${vtgPayload}*${getNmeaChecksum(vtgPayload)}\r\n`;

    // Enviar ambos
    client.send(Buffer.from(gga + vtg), PORT, HOST);

    // Mover la posición para el próximo ciclo
    lat += latIncrement;
}

console.log(`Simulando GPS a ${speedKmh} km/h en ${HOST}:${PORT}...`);
setInterval(sendGpsData, intervalMs);
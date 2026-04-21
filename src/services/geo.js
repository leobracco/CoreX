// Funciones puras de geografía esférica.
// Sin estado, testeables 1:1 contra vectores conocidos.

const R_EARTH_M = 6_371_000;

const toRad = deg => (deg * Math.PI) / 180;
const toDeg = rad => (rad * 180) / Math.PI;

/**
 * Distancia haversine en metros entre dos puntos (lat/lon en grados).
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return R_EARTH_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Rumbo (bearing) inicial en grados [0, 360) desde punto 1 hacia punto 2.
 */
function bearingDeg(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    const lat1R = toRad(lat1);
    const lat2R = toRad(lat2);
    const y = Math.sin(dLon) * Math.cos(lat2R);
    const x = Math.cos(lat1R) * Math.sin(lat2R) -
              Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Media circular ponderada de rumbos. Cada elemento tiene peso (i+1)/N,
 * donde N es la longitud del array. Idéntico al suavizado original.
 */
function smoothHeadingDeg(bearings) {
    if (!bearings || bearings.length === 0) return 0;
    let sSin = 0, sCos = 0;
    for (let i = 0; i < bearings.length; i++) {
        const w = (i + 1) / bearings.length;
        sSin += Math.sin(toRad(bearings[i])) * w;
        sCos += Math.cos(toRad(bearings[i])) * w;
    }
    return (toDeg(Math.atan2(sSin, sCos)) + 360) % 360;
}

module.exports = { haversineMeters, bearingDeg, smoothHeadingDeg, R_EARTH_M };

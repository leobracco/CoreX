// Pipeline de cálculo de heading desde stream de posiciones GPS.
// Mantiene historial interno para suavizar. Filtra ruido cuando el
// vehículo está cuasi-detenido (distancia < 0.5 m o dt < 100 ms).

const { haversineMeters, bearingDeg, smoothHeadingDeg } = require('./geo');

function createHeadingCalculator({
    maxHistory = 5,
    minDistanceM = 0.5,
    minIntervalMs = 100,
} = {}) {
    const history = [];       // rumbos brutos recientes
    let lastPosition = null;  // { lat, lon, ts }
    let smoothed = 0;
    let lastUpdateTs = 0;

    function update(lat, lon, nowMs = Date.now()) {
        if (!lastPosition) {
            lastPosition = { lat, lon, ts: nowMs };
            lastUpdateTs = nowMs;
            return 0;
        }
        const dist = haversineMeters(lastPosition.lat, lastPosition.lon, lat, lon);
        if (dist < minDistanceM || nowMs - lastUpdateTs < minIntervalMs) {
            return smoothed;
        }
        const raw = bearingDeg(lastPosition.lat, lastPosition.lon, lat, lon);
        history.push(raw);
        if (history.length > maxHistory) history.shift();
        smoothed = smoothHeadingDeg(history);
        lastPosition = { lat, lon, ts: nowMs };
        lastUpdateTs = nowMs;
        return smoothed;
    }

    function reset() {
        history.length = 0;
        lastPosition = null;
        smoothed = 0;
    }

    return {
        update,
        reset,
        current: () => smoothed,
        historyLength: () => history.length,
    };
}

module.exports = { createHeadingCalculator };

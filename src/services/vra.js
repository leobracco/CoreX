// VRA (Variable Rate Application): dado un punto GPS, devuelve la dosis
// asociada según el polígono que lo contiene en el mapa de prescripción.
// Propiedades soportadas: `Rate` o `SemillasxMetro`.

const turf = require('@turf/turf');

function createVRA() {
    let map = null;

    function setMap(geojson) {
        map = geojson;
    }

    function clearMap() {
        map = null;
    }

    function hasMap() {
        return map !== null && Array.isArray(map.features);
    }

    /**
     * Devuelve la dosis para (lat, lon) según el primer polígono que contenga el punto.
     * Devuelve 0 si no hay mapa cargado, si lat es 0 (posición inválida),
     * o si el punto no cae en ningún polígono.
     */
    function lookup(lat, lon) {
        if (!hasMap() || lat === 0) return 0;
        try {
            const pt = turf.point([lon, lat]);
            for (const f of map.features) {
                if (turf.booleanPointInPolygon(pt, f)) {
                    const rate = f.properties?.Rate ?? f.properties?.SemillasxMetro;
                    return parseFloat(rate) || 0;
                }
            }
        } catch (_) { /* mapa corrupto: devolver 0 */ }
        return 0;
    }

    return { setMap, clearMap, hasMap, lookup };
}

module.exports = { createVRA };

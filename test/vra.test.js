// Tests para src/services/vra — lookup por punto-en-polígono con GeoJSON.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createVRA } = require('../src/services/vra');

function polygonAroundOrigin({ rate = 100, prop = 'Rate' } = {}) {
    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { [prop]: rate },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1],
                    ]],
                },
            },
        ],
    };
}

test('vra: sin mapa cargado devuelve 0', () => {
    const v = createVRA();
    assert.equal(v.hasMap(), false);
    assert.equal(v.lookup(0.5, 0.5), 0);
});

test('vra: lat=0 devuelve 0 (posición inválida)', () => {
    const v = createVRA();
    v.setMap(polygonAroundOrigin({ rate: 42 }));
    assert.equal(v.lookup(0, 0.5), 0);
});

test('vra: punto dentro del polígono devuelve Rate', () => {
    const v = createVRA();
    v.setMap(polygonAroundOrigin({ rate: 42 }));
    assert.equal(v.lookup(0.5, 0.5), 42);
});

test('vra: punto fuera devuelve 0', () => {
    const v = createVRA();
    v.setMap(polygonAroundOrigin({ rate: 42 }));
    assert.equal(v.lookup(5, 5), 0);
});

test('vra: fallback a SemillasxMetro si no hay Rate', () => {
    const v = createVRA();
    v.setMap(polygonAroundOrigin({ rate: 77, prop: 'SemillasxMetro' }));
    assert.equal(v.lookup(0.5, 0.5), 77);
});

test('vra: clearMap desactiva lookup', () => {
    const v = createVRA();
    v.setMap(polygonAroundOrigin({ rate: 100 }));
    v.clearMap();
    assert.equal(v.hasMap(), false);
    assert.equal(v.lookup(0.5, 0.5), 0);
});

test('vra: mapa sin features no rompe', () => {
    const v = createVRA();
    v.setMap({ type: 'FeatureCollection', features: [] });
    assert.equal(v.lookup(0.5, 0.5), 0);
});

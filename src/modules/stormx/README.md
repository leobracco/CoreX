# StormX — contrato esperado

Estado: **stub**. No hay integración todavía.

## Rol esperado

StormX integra datos meteorológicos (viento, lluvia, temperatura, humedad)
al bridge para habilitar decisiones operativas en tiempo real
(ej: corte automático de pulverización por deriva, alertas).

## Topics sugeridos

### PUB (CoreX → StormX consumers)

| Topic | Payload | Frecuencia |
|---|---|---|
| `stormx/weather/current` | `{temp_c, rh, wind_ms, wind_dir_deg, rain_mm_h, ts}` | 1 min |
| `stormx/alerts/drift` | `{level: "warn"\|"block", reason, ts}` | on change |

### SUB (sensor → CoreX)

| Topic | Payload | Acción |
|---|---|---|
| `stormx/sensor/raw` | `{source, ...}` | normalizar y reexponer |

## Datos disponibles hoy en CoreX

Ninguno específico. StormX requiere una fuente externa (estación meteo,
API, sensor I2C/serie).

## Pasos para integrar

1. Elegir fuente: API HTTP, MQTT externo, sensor local, o ingestión desde otro bridge.
2. Definir umbrales operativos (ej: wind_ms > 8 → drift:block).
3. Instanciar con `createStormxModule({ mqtt, bus, state, logger, config })`.
4. Publicar `stormx/alerts/drift` para que FlowX/SectionX corten motores si corresponde.
5. Agregar tests en `test/stormx.test.js`.

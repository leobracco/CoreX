# CLAUDE.md — CoreX Bridge

## Qué es
Bridge Node.js que conecta **AgOpenGPS** (agricultura de precisión) con el ecosistema **AgroParallel**: **VistaX**, **FlowX**, **QuantiX**, **SectionX** (indirecto), y placeholders para **LineX** y **StormX**. Corre en Windows con PM2.

## Arquitectura

```
AgOpenGPS ──UDP──► CoreX ──MQTT──► VistaX / FlowX / QuantiX (motores)
                     ▲                │
                     └── UDP PGN 253 ──┘ (work switch + heartbeat)
```

Internamente, CoreX está dividido por responsabilidad. El entry point `server.js` es solo un shim que delega en `src/index.js`.

```
src/
├── index.js              # wiring: services → transport → módulos → shutdown
├── config/env.js         # .env + defaults validados
├── protocol/             # encode/decode/CRC PGN (unificado con tools/)
├── services/             # logger, geo, heading, vra, persist, field-watcher
├── state/store.js        # estado + EventEmitter como bus de eventos
├── transport/
│   ├── udp.js            # dgram socket, decodifica y emite al bus
│   └── mqtt.js           # cliente MQTT con registry de subscripciones
└── modules/              # un directorio por módulo AgroParallel
    ├── aog/              # PUB aog/machine/*, aog/field/* + PGN 253 out
    ├── vistax/           # PUB vistax/sync/time, SUB vistax/corex/aog/cmd
    ├── flowx/            # PUB agp/flow/target, SUB agp/flow/*, persist JSON
    ├── quantix/          # HTTP sync + PUB agp/motor/{uid}/target por motor
    ├── sectionx/         # PUB sections/state con delay tren 2 por distancia
    ├── linex/            # STUB — ver README.md del módulo
    └── stormx/           # STUB — ver README.md del módulo
```

## Bus de eventos (src/state/store.js)

Los transports emiten hacia el bus; los módulos se suscriben. No hay acoplamiento directo UDP→MQTT.

| Evento | Emisor | Consumidores |
|---|---|---|
| `gps:update` `{lat,lon,ts}` | `transport/udp` (PGN 100) | aog, flowx, quantix |
| `speed:update` `{speed_kmh,ts}` | `transport/udp` (PGN 254) | aog, flowx, quantix |
| `sections:raw` `{bitmap,ts}` | `transport/udp` (PGN 229) | sectionx |
| `sections:dimensions` `{count,widths_cm}` | `transport/udp` (PGN 235) | aog |
| `field:changed` `{fieldName,accion,ts}` | `services/field-watcher` | aog |
| `field:closed` `{ts}` | `services/field-watcher` | aog |
| `painting:changed` `{painting,fieldName,ts}` | `modules/sectionx` | aog |
| `work:changed` `{down}` | `modules/vistax` | aog (→ PGN 253 byte Switch) |
| `mqtt:connect` | `transport/mqtt` | aog, vistax |

## Protocolo UDP (AgOpenGPS ↔ CoreX)

Formato trama: `[0x80][0x81][Src][PGN][Len][...Data...][CRC=Σbytes[2..n-2]&0xFF]`.
Librería: `src/protocol/` (usada también por `tools/aog_sniffer.js` y `tools/test_pgn253.js`).

### RX (CoreX recibe, decodificados en `transport/udp.js`)
| PGN | Nombre | Campos | Emite |
|---|---|---|---|
| 100 | Position GPS | `lat=doubleLE@13`, `lon=doubleLE@5` | `gps:update` |
| 229 | 64 Sections State | 8 bytes bitmap (@5–12) | `sections:raw` |
| 235 | Section Dimensions | cantidad `@37`, anchos `uint16LE@5+i*2` | `sections:dimensions` |
| 254 | Steer Data | `vel = int16LE@5 / 10` km/h | `speed:update` |

### TX (CoreX envía desde `modules/aog`)
| PGN | Detalle |
|---|---|
| 253 From AutoSteer | Src=`0x7E`. Byte[6] Switch: bit0=work, bit1=steer, bit2=mainSwitch(siempre 1). **Heartbeat 200 ms.** Sin stream continuo AOG marca AutoSteer desconectado. |

## Topics MQTT

| Topic | Dir | Retain | Módulo | Payload |
|---|---|---|---|---|
| `aog/machine/position` | PUB | | aog | `{lat, lon, heading, gps_ts}` |
| `aog/machine/speed` | PUB | | aog | string km/h |
| `aog/machine/sections_config` | PUB | ✓ | aog | `{secciones_detectadas, anchos_detectados}` |
| `aog/field/name` | PUB | | aog | string |
| `aog/field/status` | PUB | ✓ | aog | `{fieldName, accion?, painting, ts}` |
| `sections/state` | PUB | | sectionx | `{t1:[64], t2:[64]}` |
| `vistax/sync/time` | PUB | | vistax | `{gps_ts, lat, lon}` cada 1s |
| `vistax/corex/aog/cmd` | SUB | | vistax | `{funcion:"bajada_herramienta", value:0|1}` |
| `agp/flow/target` | PUB | | flowx | `{pps_target, dosis, vel, ts}` |
| `agp/flow/ui_cmd` | SUB | | flowx | `{type:"SET_DOSIS", valor}` |
| `agp/flow/config_save` | SUB | | flowx | config completa |
| `agp/motor/{uid_esp}/target` | PUB | | quantix | `{pps, on, ts}` |
| `corex/debug/level` | SUB | | (root) | 0-3, cambia nivel en runtime |

## VRA (Variable Rate Application)
`src/services/vra.js` usa `@turf/turf` para punto-en-polígono sobre `data/ultimo_mapa.json`. Propiedades soportadas: `Rate` o `SemillasxMetro`.

## Detección de campo activo
`src/services/field-watcher.js` lee `current_field.json` (escrito por el plugin de AOG). Formato: `{fieldName, accion, ts}` donde `accion ∈ {nuevo, abierto, continuar, cerrado, area_borrada}`. Dual watch (`fs.watchFile` @300ms + polling @500ms) para sobrevivir escrituras atómicas en Windows. Emite `field:changed`/`field:closed` al bus.

## Lógica de pintado
`painting = true` cuando: alguna sección ON y `vel > VEL_MIN_PINTADO` (default 0.5 km/h). Calculado en `modules/sectionx` y propagado a `modules/aog` por el evento `painting:changed`.

## Dependencias
- `mqtt` ^5.15 — cliente MQTT
- `axios` ^1.13 — HTTP → QuantiX
- `dotenv` ^17.3 — variables de entorno
- `@turf/turf` ^7.3 — geoespacial (VRA)

## Observabilidad
Módulo `modules/observability/` levanta un HTTP server nativo en `HEALTH_PORT` (default 9090) con tres endpoints:

| Endpoint | Formato | Contenido |
|---|---|---|
| `GET /healthz` | JSON | `{status, version, uptime_s, mqtt_connected, last_gps_ts, last_gps_age_ms, speed_kmh, painting, field_name, udp_frames_total}`. 200 si ok, 503 si degradado (MQTT caído o GPS >5s) |
| `GET /metrics` | Prometheus | Counters + gauges (ver tabla abajo) |
| `GET /version` | JSON | `{version, pid, uptime_s}` |

Métricas expuestas (todas prefijadas `corex_`):

| Métrica | Tipo | Labels | Fuente |
|---|---|---|---|
| `corex_udp_frames_total` | counter | — | transport/udp |
| `corex_udp_frames_by_pgn_total` | counter | `pgn` | transport/udp |
| `corex_udp_invalid_total` | counter | — | transport/udp |
| `corex_mqtt_connects_total` | counter | — | transport/mqtt |
| `corex_mqtt_reconnects_total` | counter | — | transport/mqtt |
| `corex_mqtt_errors_total` | counter | — | transport/mqtt |
| `corex_mqtt_publishes_total` | counter | — | transport/mqtt |
| `corex_mqtt_messages_total` | counter | — | transport/mqtt |
| `corex_mqtt_connected` | gauge | — | transport/mqtt |
| `corex_pgn253_sent_total` | counter | — | modules/aog |
| `corex_gps_updates_total` | counter | — | modules/aog |
| `corex_speed_kmh` | gauge | — | modules/aog |
| `corex_heading_deg` | gauge | — | modules/aog |
| `corex_painting` | gauge | — | modules/aog |
| `corex_last_gps_ts_seconds` | gauge | — | modules/aog |

`HEALTH_PORT=0` asigna puerto dinámico (tests). `HEALTH_PORT=-1` deshabilita el server.

## Logging estructurado
`LOG_FORMAT=json` en `.env` hace que todos los logs salgan como un JSON por línea (`{ts, level, tag, msg, data?}`), apto para agregadores como ELK o Loki:
```
{"ts":"2026-04-21T12:00:00.000Z","level":"dbg","dbgLvl":1,"tag":"INIT","msg":"📡 CoreX Bridge activo"}
```
Default `LOG_FORMAT=text` mantiene la salida coloreada para operación interactiva.

## Tests
`npm test` corre `node --test test/*.test.js`. Cubre:
- `test/protocol.test.js` — encode/decode/CRC (incluye vector byte-a-byte del pcap)
- `test/geo.test.js` — haversine + bearing + suavizado circular
- `test/heading.test.js` — pipeline con filtrado de ruido
- `test/vra.test.js` — lookup por punto-en-polígono
- `test/metrics.test.js` — counters/gauges + formato Prometheus
- `test/observability.test.js` — /healthz, /metrics, /version end-to-end

## Variables de entorno (.env)
```
MQTT_BROKER=mqtt://127.0.0.1
UDP_PORT=17777
CONFIG_URL=http://localhost:8080/api/gis/config-implemento
QUANTIX_SYNC_MS=30000
AOG_BROADCAST_IP=127.0.0.1
AOG_PORT_OUT=17777
VEL_MIN_PINTADO=0.5
DEBUG_LEVEL=1
CURRENT_FIELD_PATH=          # default: ~/Documents/AgOpenGPS/current_field.json
AOG_FIELDS_PATH=             # default: ~/Documents/AgOpenGPS/Fields
AOGLOG_DEBUG=1               # 0 para desactivar logs verbose del watcher

HEALTH_PORT=9090             # 0=OS-assigned, <0=deshabilita /healthz /metrics
LOG_FORMAT=text              # 'text' (colores) o 'json' (structured)
QUANTIX_SYNC_MS=30000        # intervalo sync HTTP con QuantiX
```

## Notas de implementación
- PGN 253 se envía cada 200 ms (heartbeat). Sin ese stream continuo AOG marca AutoSteer como desconectado.
- Heading suavizado: media circular ponderada sobre 5 muestras (`services/heading.js`). Filtra muestras con distancia <0.5m o intervalo <100ms.
- Secciones tren 2: delay por distancia recorrida (`distancia_trenes_m`, default 1.5 m).
- Puerto UDP 17777 puede estar ocupado por AgIO; usar puertos alternativos para sniffing.
- Config de FlowX se persiste en `data/flowx_config.json`.
- Entry point PM2: `server.js` (shim de 3 líneas que delega en `src/index.js`).

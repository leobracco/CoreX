# CLAUDE.md — CoreX Bridge

## Qué es
Bridge Node.js que conecta **AgOpenGPS** (agricultura de precisión) con el ecosistema propio: **AgroParallel**, **QuantiX** y **VistaX**. Corre en Windows con PM2.

## Arquitectura

```
AgOpenGPS ──UDP──► CoreX (server.js) ──MQTT──► QuantiX / VistaX / FlowX
                        ▲                          │
                        └──── UDP PGN 253 ◄────────┘ (work switch)
```

## Archivos principales
- `server.js` — Bridge principal. Escucha UDP, publica MQTT, envía PGN 253.
- `core/logic/aog_log_watcher.js` — Detecta campo activo via `current_field.json` (polling 500ms + watchFile).
- `corex.config.js` — Config PM2 para producción (`C:\CoreX\`).
- `tools/aog_sniffer.js` — Sniffer UDP para diagnóstico de PGNs.
- `tools/test_pgn253.js` — Test manual de envío PGN 253.
- `tools/nmea.js` — Simulador GPS NMEA para testing.

## Protocolo UDP — PGNs de AgOpenGPS
Formato: `[0x80][0x81][Src][PGN][Len][...Data...][CRC]`

### PGNs que CoreX RECIBE (desde AOG):
| PGN | Nombre | Datos clave |
|-----|--------|-------------|
| 100 | Position GPS | lat (doubleLE @13), lon (doubleLE @5) |
| 229 | 64 Sections State | 8 bytes bitmap (64 secciones) |
| 235 | Section Dimensions | anchos en cm (uint16LE), cantidad en byte[37] |
| 254 | Steer Data | velocidad (int16LE @5, ÷10 = km/h) |

### PGN que CoreX ENVÍA (hacia AOG):
| PGN | Nombre | Detalles |
|-----|--------|----------|
| 253 | From AutoSteer | Src=0x7E. Byte[6]=Switch: bit0=work, bit1=steer, bit2=mainSwitch(siempre 1). Se envía cada 200ms como heartbeat. |

## Topics MQTT
| Topic | Dirección | Contenido |
|-------|-----------|-----------|
| `aog/machine/position` | PUB | `{lat, lon, heading, gps_ts}` |
| `aog/machine/speed` | PUB | velocidad string (km/h) |
| `aog/machine/sections_config` | PUB retain | `{secciones_detectadas, anchos_detectados}` |
| `aog/field/status` | PUB retain | `{painting, fieldName, accion, ts}` |
| `aog/field/name` | PUB | nombre del campo activo |
| `sections/state` | PUB | `{t1: [...], t2: [...]}` (tren 1 y 2) |
| `agp/flow/target` | PUB | `{pps_target, dosis, vel}` |
| `agp/motor/{uid}/target` | PUB | `{pps, on, ts}` |
| `vistax/sync/time` | PUB | `{gps_ts, lat, lon}` cada 1s |
| `vistax/corex/aog/cmd` | SUB | `{funcion:"bajada_herramienta", value:0|1}` |
| `agp/flow/ui_cmd` | SUB | `{type:"SET_DOSIS", valor}` |
| `agp/flow/config_save` | SUB | config completa de FlowX |
| `corex/debug/level` | SUB | 0-3, cambia nivel de debug en runtime |

## VRA (Variable Rate Application)
Usa `@turf/turf` para punto-en-polígono sobre mapa de prescripción GeoJSON.  
Mapa en `data/ultimo_mapa.json`. Propiedades: `Rate` o `SemillasxMetro`.

## Detección de campo activo
`aog_log_watcher.js` lee `current_field.json` (escrito por el plugin de AOG).  
Formato: `{fieldName, accion, ts}` donde accion = nuevo|abierto|continuar|cerrado|area_borrada.

## Lógica de pintado
`aogPainting = true` cuando: alguna sección ON + velocidad > VEL_MIN_PINTADO (default 0.5 km/h).

## Dependencias
- `mqtt` ^5.15 — Cliente MQTT
- `axios` ^1.13 — HTTP para API QuantiX
- `dotenv` ^17.3 — Variables de entorno
- `@turf/turf` ^7.3 — Geoespacial (punto en polígono para VRA)

## Variables de entorno (.env)
```
MQTT_BROKER=mqtt://127.0.0.1
UDP_PORT=17777
CONFIG_URL=http://localhost:8080/api/gis/config-implemento
AOG_FIELDS_PATH=
VEL_MIN_PINTADO=0.5
DEBUG_LEVEL=1
AOG_BROADCAST_IP=127.0.0.1
AOG_PORT_OUT=17777
CURRENT_FIELD_PATH=  # default: ~/Documents/AgOpenGPS/current_field.json
AOGLOG_DEBUG=1       # 0 para desactivar logs verbose del watcher
```

## Notas de implementación
- PGN 253 se envía cada 200ms (heartbeat). Si no se envía continuamente, AOG marca el AutoSteer como desconectado.
- El heading se calcula desde posiciones GPS con suavizado (promedio ponderado de últimas 5 posiciones).
- Secciones tren 2: se aplica delay basado en distancia recorrida (`distancia_trenes_m`).
- Puerto UDP 17777 puede estar ocupado por AgIO; usar puertos alternativos para sniffing.
- Config de FlowX se persiste en `data/flowx_config.json`.

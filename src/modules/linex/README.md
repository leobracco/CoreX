# LineX — contrato esperado

Estado: **stub**. No hay integración todavía.

## Rol esperado

LineX consume datos de guiado/líneas (AB lines, curvas, pasadas) desde
AgOpenGPS y los reexpone al ecosistema AgroParallel.

## Topics sugeridos

### PUB (CoreX → LineX)

| Topic | Payload | Frecuencia |
|---|---|---|
| `linex/line/active` | `{id, name, type: "AB"\|"curve", points: [[lat,lon]...]}` | on change |
| `linex/pass/current` | `{pass_n, offset_m, ts}` | ~10 Hz |

### SUB (LineX → CoreX)

| Topic | Payload | Acción |
|---|---|---|
| `linex/cmd/set_line` | `{id}` | cambiar línea activa (futura PGN?) |

## Datos disponibles hoy en CoreX

Posición GPS, heading, velocidad (PGN 100 y 254) ya se publican en
`aog/machine/position` y `aog/machine/speed`. El módulo LineX podría
suscribirse a esos para calcular offset a la línea sin protocolo nuevo.

## Pasos para integrar

1. Definir qué PGN de AgOpenGPS se consume (si hay) o qué fuente.
2. Instanciar el módulo con la misma interfaz del resto (`createLinexModule`).
3. Suscribir a `bus` eventos relevantes (`gps:update`, `sections:raw`).
4. Publicar en el topic definitivo.
5. Agregar tests en `test/linex.test.js`.

// Constantes del protocolo AgOpenGPS.
// Fuente única compartida por server.js y tools/*.

const HEADER_0 = 0x80;
const HEADER_1 = 0x81;

// Tamaño mínimo de una trama válida: header(2) + src + pgn + len + crc = 6 bytes
const MIN_FRAME_LEN = 6;

// Source IDs observados en capturas del emulador AOG
const SRC = {
    AUTOSTEER: 0x7E, // 126 — módulo AutoSteer (PGN 253)
    MACHINE:   0x7B, // 123 — módulo Machine  (PGN 237)
    SCAN:      0x7F, // 127 — Scan Request broadcaster
};

// PGN IDs del protocolo
const PGN = {
    POSITION:       100,
    SCAN_REQUEST:   202,
    SUBNET_REPLY:   203,
    FROM_IMU:       211,
    MAIN_ANTENNA:   214,
    HARDWARE_MSG:   221,
    NUDGE:          222,
    SECTIONS_STATE: 229, // 64 secciones en bitmap (8 bytes)
    SECTION_DIMS:   235, // anchos de sección en cm (uint16LE)
    PIN_CONFIG:     236,
    FROM_MACHINE:   237,
    MACHINE_CONFIG: 238,
    MACHINE_DATA:   239,
    FROM_STEER_2:   250,
    STEER_CONFIG:   251,
    STEER_SETTINGS: 252,
    FROM_STEER:     253, // heartbeat AutoSteer → AOG (0xFD)
    STEER_DATA:     254, // velocidad (int16LE @5, ÷10 km/h)
};

const PGN_NAMES = {
    [PGN.POSITION]:       'Position GPS',
    [PGN.SCAN_REQUEST]:   'Scan Request',
    [PGN.SUBNET_REPLY]:   'Subnet Reply',
    [PGN.FROM_IMU]:       'From IMU',
    [PGN.MAIN_ANTENNA]:   'Main Antenna GPS',
    [PGN.HARDWARE_MSG]:   'Hardware Message',
    [PGN.NUDGE]:          'Nudge by Machine',
    [PGN.SECTIONS_STATE]: '64 Sections State',
    [PGN.SECTION_DIMS]:   'Section Dimensions',
    [PGN.PIN_CONFIG]:     'Pin Config',
    [PGN.FROM_MACHINE]:   'From Machine',
    [PGN.MACHINE_CONFIG]: 'Machine Config',
    [PGN.MACHINE_DATA]:   'Machine Data',
    [PGN.FROM_STEER_2]:   'From Autosteer 2',
    [PGN.STEER_CONFIG]:   'Steer Config',
    [PGN.STEER_SETTINGS]: 'Steer Settings',
    [PGN.FROM_STEER]:     'From Autosteer',
    [PGN.STEER_DATA]:     'Steer Data',
};

// Bits del byte "Switch" del PGN 253 (índice 6 del payload).
// Invariante: bit MAIN debe estar siempre en 1 o AOG descarta la trama.
const SWITCH = {
    WORK:  0x01, // bit 0 — herramienta abajo / trabajando
    STEER: 0x02, // bit 1 — autosteer habilitado
    MAIN:  0x04, // bit 2 — SIEMPRE 1
};

module.exports = {
    HEADER_0,
    HEADER_1,
    MIN_FRAME_LEN,
    SRC,
    PGN,
    PGN_NAMES,
    SWITCH,
};

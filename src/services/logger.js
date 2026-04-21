// Logger con 3 niveles + colores ANSI. Fuente única para todo el proyecto.

const C = {
    r:   '\x1b[0m',
    red: '\x1b[31m',
    grn: '\x1b[32m',
    yel: '\x1b[33m',
    blu: '\x1b[34m',
    mag: '\x1b[35m',
    cyn: '\x1b[36m',
    gry: '\x1b[90m',
    bld: '\x1b[1m',
};

const LABELS = ['', '▸', '▸▸', '▸▸▸'];
const COLORS = [C.r, C.grn, C.cyn, C.gry];

function ts() {
    return new Date().toISOString().substr(11, 12);
}

function createLogger(initialLevel = 1) {
    let level = Math.max(0, Math.min(3, initialLevel));

    function dbg(lvl, tag, msg, data) {
        if (lvl > level) return;
        const lbl = LABELS[lvl] || '▸';
        const clr = COLORS[lvl] || C.r;
        let line = `${C.gry}${ts()}${C.r} ${clr}${lbl} [${tag}]${C.r} ${msg}`;
        if (data !== undefined && level >= 3) {
            line += ` ${C.gry}${typeof data === 'object' ? JSON.stringify(data) : data}${C.r}`;
        }
        console.log(line);
    }

    function err(tag, msg) {
        console.error(`${C.red}✖ [${tag}]${C.r} ${msg}`);
    }

    function warn(tag, msg) {
        console.warn(`${C.yel}⚠ [${tag}]${C.r} ${msg}`);
    }

    return {
        dbg,
        err,
        warn,
        getLevel()        { return level; },
        setLevel(newLvl)  {
            const n = parseInt(newLvl);
            if (Number.isFinite(n) && n >= 0 && n <= 3) {
                level = n;
                console.log(`${C.yel}[DEBUG]${C.r} Nivel cambiado a ${level}`);
                return true;
            }
            return false;
        },
        C,
    };
}

module.exports = { createLogger, C, ts };

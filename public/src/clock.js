// Japan time, service days and the weekday/holiday timetable switch.

const JST_OFFSET_MS = 9 * 3600 * 1000;
// Railway service days roll over at 03:00, not midnight
export const DAY_START_MIN = 180;

// Wall-clock fields of a timestamp in Japan time
export function jstParts(ms) {
    const d = new Date(ms + JST_OFFSET_MS);
    return {
        y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
        h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(),
        dow: d.getUTCDay()
    };
}

function ymd(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dow(y, m, d) {
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nthMonday(y, m, n) {
    const first = dow(y, m, 1);
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

const holidayCache = new Map();

// National holidays of Japan (Act on National Holidays, rules in force since 2020)
export function holidaysOf(y) {
    if (holidayCache.has(y)) {
        return holidayCache.get(y);
    }
    const vernal = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    const autumnal = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    const base = [
        [1, 1], [1, nthMonday(y, 1, 2)], [2, 11], [2, 23], [3, vernal], [4, 29], [5, 3], [5, 4], [5, 5],
        [7, nthMonday(y, 7, 3)], [8, 11], [9, nthMonday(y, 9, 3)], [9, autumnal], [10, nthMonday(y, 10, 2)],
        [11, 3], [11, 23]
    ];
    const set = new Set(base.map(([m, d]) => ymd(y, m, d)));
    // Substitute holiday: a holiday on Sunday moves to the next non-holiday weekday
    for (const [m, d] of base) {
        if (dow(y, m, d) === 0) {
            let t = new Date(Date.UTC(y, m - 1, d + 1));
            while (set.has(ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()))) {
                t = new Date(t.getTime() + 86400000);
            }
            set.add(ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()));
        }
    }
    // A weekday sandwiched between two holidays is also a holiday
    for (let t = Date.UTC(y, 0, 2); t < Date.UTC(y, 11, 31); t += 86400000) {
        const c = new Date(t), p = new Date(t - 86400000), n = new Date(t + 86400000);
        const key = c.toISOString().slice(0, 10);
        if (!set.has(key) && c.getUTCDay() !== 0 &&
            set.has(p.toISOString().slice(0, 10)) && set.has(n.toISOString().slice(0, 10))) {
            set.add(key);
        }
    }
    holidayCache.set(y, set);
    return set;
}

// Service day containing the given instant, plus minutes since that day's 00:00
export function serviceTime(ms) {
    let p = jstParts(ms);
    let minutes = p.h * 60 + p.mi + p.s / 60 + p.ms / 60000;
    if (minutes < DAY_START_MIN) {
        p = jstParts(ms - 86400000);
        minutes += 1440;
    }
    const key = ymd(p.y, p.mo, p.d);
    // Rail operators run holiday timetables on weekends, holidays and over New Year
    const newYear = (p.mo === 12 && p.d >= 30) || (p.mo === 1 && p.d <= 3);
    const holiday = p.dow === 0 || p.dow === 6 || newYear || holidaysOf(p.y).has(key);
    return {key, minutes, dayType: holiday ? 'holiday' : 'weekday', dow: p.dow};
}

export function formatClock(ms) {
    const p = jstParts(ms);
    return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}:${String(p.s).padStart(2, '0')}`;
}

export function formatMinutes(min) {
    const m = Math.round(min) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Timetable-driven trains: every scheduled train is placed by interpolating
// between its stop times, then shifted by live delay data when available.

import {travelled} from './network.js';

// Time a train stands at its origin before departure / at its terminus after arrival
const STAND_MIN = 1;
// Assumed dwell when only a departure time is published
const DWELL_MIN = 0.4;
// How long a live delay report stays valid without refresh
const LIVE_TTL_MS = 3 * 60 * 1000;

export const KIND_SCHEDULED = 0;
export const KIND_LIVE = 1;

class TimetableTrain {
    constructor(rec, network) {
        const [line, type, dir, number, dest, name, t0, flat, flags] = rec;
        this.line = network.lines[line];
        this.type = type;
        this.dir = dir === 0 ? 1 : -1;
        this.number = number;
        this.dest = dest;
        this.name = name;
        this.flags = flags || 0;
        this.t0 = t0;
        this.flat = flat;
        const n = flat.length / 3;
        const first = flat[2] >= 0 ? flat[2] : flat[1];
        const last = flat[(n - 1) * 3 + 1] >= 0 ? flat[(n - 1) * 3 + 1] : flat[(n - 1) * 3 + 2];
        this.start = t0 + first - (this.flags & 1 ? 0 : STAND_MIN);
        this.end = t0 + last + (this.flags & 2 ? 0 : STAND_MIN);
        this.delay = 0;          // minutes, target
        this.shownDelay = 0;     // minutes, eased towards target
        this.liveAt = 0;         // ms timestamp of last live report
        this.cursor = 0;
        this.arr = null;
    }

    // Expand stop arrays lazily: absolute arrival/departure minutes and distances
    prepare() {
        if (this.arr) {
            return;
        }
        const f = this.flat, n = f.length / 3, t0 = this.t0;
        const arr = new Float64Array(n), dep = new Float64Array(n), pos = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const a = f[i * 3 + 1], d = f[i * 3 + 2];
            dep[i] = d >= 0 ? t0 + d : t0 + a;
            arr[i] = a >= 0 ? t0 + a : dep[i] - (i === 0 ? 0 : DWELL_MIN);
            pos[i] = this.line.offsets[f[i * 3]];
        }
        for (let i = 1; i < n; i++) {
            if (arr[i] < dep[i - 1]) {
                arr[i] = Math.min(dep[i], dep[i - 1] + (dep[i] - dep[i - 1]) * 0.8);
            }
        }
        this.arr = arr;
        this.dep = dep;
        this.pos = pos;
    }

    // Distance along the line at service time T (minutes); null if not running
    locate(T) {
        this.prepare();
        const arr = this.arr, dep = this.dep, pos = this.pos, n = arr.length;
        if (T <= dep[0]) {
            this.cursor = 0;
            return pos[0];
        }
        if (T >= arr[n - 1]) {
            this.cursor = n - 1;
            return pos[n - 1];
        }
        let i = Math.min(this.cursor, n - 2);
        if (T < dep[i]) {
            while (i > 0 && T < dep[i]) {
                i--;
            }
        }
        while (i < n - 2 && T >= dep[i + 1]) {
            i++;
        }
        this.cursor = i;
        // i: last stop departed (T >= dep[i]); now running to i+1 or standing at i+1
        if (T >= arr[i + 1]) {
            return pos[i + 1];
        }
        const total = (arr[i + 1] - dep[i]) * 60, t = (T - dep[i]) * 60;
        const dist = pos[i + 1] - pos[i];
        return pos[i] + Math.sign(dist) * travelled(Math.abs(dist), total, t);
    }

    // Next stop index and its scheduled arrival, for the info card
    nextStop(T) {
        this.prepare();
        const n = this.arr.length;
        for (let i = 0; i < n; i++) {
            if (this.arr[i] > T || (i === n - 1)) {
                return {index: this.flat[i * 3], station: this.line.stations[this.flat[i * 3]], time: this.arr[i], atStation: false};
            }
            if (T < this.dep[i]) {
                return {index: this.flat[i * 3], station: this.line.stations[this.flat[i * 3]], time: this.dep[i], atStation: true};
            }
        }
        return null;
    }

    alpha(T) {
        const fadeIn = this.flags & 1 ? 1 : Math.min(1, (T - this.start) / 0.25);
        const fadeOut = this.flags & 2 ? 1 : Math.min(1, (this.end - T) / 0.25);
        return Math.max(0, Math.min(fadeIn, fadeOut));
    }
}

export class TimetableProvider {
    constructor(network, records) {
        this.network = network;
        this.trains = records.map(r => new TimetableTrain(r, network));
        this.byKey = new Map();
        for (const tr of this.trains) {
            this.byKey.set(`${tr.line.id}|${tr.number}`, tr);
        }
        this.active = [];
        this.lastScan = -1e9;
        this.lastScanT = -1e9;
    }

    // Rebuild the active window every few seconds; a generous margin covers delays
    scan(T, nowMs) {
        const active = [];
        for (const tr of this.trains) {
            if (tr.start - 1 <= T && tr.end + 30 >= T) {
                active.push(tr);
            }
        }
        this.active = active;
        this.lastScan = nowMs;
        this.lastScanT = T;
    }

    setLiveDelay(lineId, number, delayMin, nowMs) {
        const tr = this.byKey.get(`${lineId}|${number}`);
        if (!tr) {
            return false;
        }
        if (!tr.liveAt) {
            tr.shownDelay = delayMin;
        }
        tr.delay = delayMin;
        tr.liveAt = nowMs;
        return true;
    }

    update(T, nowMs, dtMs, emit) {
        if (nowMs - this.lastScan > 5000 || Math.abs(T - this.lastScanT) > 2) {
            this.scan(T, nowMs);
        }
        const ease = 1 - Math.exp(-dtMs / 4000);
        let count = 0;
        for (const tr of this.active) {
            const live = tr.liveAt && nowMs - tr.liveAt < LIVE_TTL_MS;
            if (!live && tr.liveAt) {
                tr.delay = 0;
            }
            tr.shownDelay += (tr.delay - tr.shownDelay) * ease;
            const Te = T - tr.shownDelay;
            if (Te < tr.start || Te > tr.end) {
                continue;
            }
            const s = tr.locate(Te);
            emit(tr.line, s, tr.dir, live ? KIND_LIVE : KIND_SCHEDULED, tr.alpha(Te), tr);
            count++;
        }
        return count;
    }

    describe(tr, T, lang) {
        const net = this.network;
        const type = net.types[tr.type];
        const [nameJa, nameEn] = tr.name ? tr.name.split('|') : ['', ''];
        const next = tr.nextStop(T - tr.shownDelay);
        const live = tr.liveAt && Date.now() - tr.liveAt < LIVE_TTL_MS;
        return {
            line: tr.line,
            typeName: type ? (lang === 'ja' ? type.ja : type.en) : '',
            trainName: lang === 'ja' ? nameJa : (nameEn || nameJa),
            number: tr.number,
            dest: tr.dest >= 0 ? net.stationName(tr.dest, lang) : '',
            direction: tr.dir > 0 ? tr.line.asc : tr.line.desc,
            next: next && {name: net.stationName(next.station, lang), time: next.time, atStation: next.atStation},
            delay: live ? Math.round(tr.delay) : null,
            source: live ? 'live' : 'timetable'
        };
    }
}

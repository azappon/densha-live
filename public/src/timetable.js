// Timetable-driven trains: every scheduled train is placed by interpolating
// between its stop times, then corrected by live data when available:
//   - a single delay (ODPT odpt:Train), carried on to the legs it runs through to
//   - per-stop predicted times (ODPT GTFS-RT TripUpdates), which replace the timetable outright

import {travelled} from './network.js';

// Time a train stands at its origin before departure / at its terminus after arrival
const STAND_MIN = 1;
// Assumed dwell when only a departure time is published
const DWELL_MIN = 0.4;
// How long a live report stays valid without refresh
const LIVE_TTL_MS = 3 * 60 * 1000;
// How far a live delay is carried along a through-running train
const MAX_CHAIN = 8;

export const KIND_SCHEDULED = 0;
export const KIND_LIVE = 1;

class TimetableTrain {
    constructor(rec, network) {
        const [line, type, dir, number, dest, name, t0, flat, flags, prev, next] = rec;
        this.line = network.lines[line];
        this.type = type;
        this.dir = dir === 0 ? 1 : -1;
        this.number = number;
        this.dest = dest;
        this.name = name;
        this.flags = flags || 0;
        this.prevIndex = prev ?? -1;
        this.nextIndex = next ?? -1;
        this.prev = null;        // train this one continues from (through service)
        this.next = null;        // train this one continues as
        this.t0 = t0;
        this.flat = flat;
        const n = flat.length / 3;
        const first = flat[2] >= 0 ? flat[2] : flat[1];
        const last = flat[(n - 1) * 3 + 1] >= 0 ? flat[(n - 1) * 3 + 1] : flat[(n - 1) * 3 + 2];
        this.start = t0 + first - (this.flags & 1 ? 0 : STAND_MIN);
        this.end = t0 + last + (this.flags & 2 ? 0 : STAND_MIN);
        this.delay = 0;          // minutes, target
        this.shownDelay = 0;     // minutes, eased towards target
        this.liveAt = 0;         // ms timestamp of last own live report
        this.inheritAt = 0;      // ms timestamp of a delay carried over from an earlier leg
        this.predictedAt = 0;    // ms timestamp of per-stop predictions
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

    // Per-stop predicted times (minutes, same clock as the timetable). Stops without a
    // prediction keep their scheduled time shifted by the nearest known delay.
    setPredictions(arrPred, depPred, nowMs) {
        this.prepare();
        const n = this.arr.length;
        const arr = new Float64Array(n), dep = new Float64Array(n);
        let delay = 0;
        for (let i = 0; i < n; i++) {
            if (arrPred[i] !== undefined) {
                delay = arrPred[i] - this.arr[i];
            } else if (depPred[i] !== undefined) {
                delay = depPred[i] - this.dep[i];
            }
            arr[i] = arrPred[i] ?? this.arr[i] + delay;
            dep[i] = Math.max(arr[i], depPred[i] ?? this.dep[i] + delay);
        }
        this.arrRT = arr;
        this.depRT = dep;
        this.predictedAt = nowMs;
    }

    predicted(nowMs) {
        return this.predictedAt && nowMs - this.predictedAt < LIVE_TTL_MS;
    }

    // Distance along the line at service time T (minutes)
    locate(T, nowMs) {
        this.prepare();
        const rt = nowMs !== undefined && this.predicted(nowMs);
        const arr = rt ? this.arrRT : this.arr, dep = rt ? this.depRT : this.dep;
        const pos = this.pos, n = arr.length;
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

    // Next stop and its expected time, for the info card
    nextStop(T, nowMs) {
        this.prepare();
        const rt = this.predicted(nowMs);
        const arr = rt ? this.arrRT : this.arr, dep = rt ? this.depRT : this.dep;
        const n = arr.length;
        for (let i = 0; i < n; i++) {
            if (arr[i] > T || (i === n - 1)) {
                return {i, station: this.line.stations[this.flat[i * 3]], time: arr[i], atStation: false};
            }
            if (T < dep[i]) {
                return {i, station: this.line.stations[this.flat[i * 3]], time: dep[i], atStation: true};
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
        // Through service: one physical train is a chain of per-line legs
        for (const tr of this.trains) {
            tr.prev = tr.prevIndex >= 0 ? this.trains[tr.prevIndex] : null;
            tr.next = tr.nextIndex >= 0 ? this.trains[tr.nextIndex] : null;
        }
        for (const tr of this.trains) {
            // Stay at the hand-over station until the next leg departs
            if (tr.next) {
                tr.end = Math.max(tr.end, tr.next.start);
            }
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

    find(lineId, number) {
        return this.byKey.get(`${lineId}|${number}`);
    }

    setLiveDelay(lineId, number, delayMin, nowMs) {
        const tr = this.find(lineId, number);
        if (!tr) {
            return false;
        }
        if (!tr.liveAt) {
            tr.shownDelay = delayMin;
        }
        tr.delay = delayMin;
        tr.liveAt = nowMs;
        this.carryDelay(tr, delayMin, nowMs);
        return true;
    }

    // A delayed train stays delayed on the lines it runs through to, unless those report their own data
    carryDelay(tr, delayMin, nowMs) {
        let n = tr.next;
        for (let k = 0; n && k < MAX_CHAIN; k++, n = n.next) {
            if (n.liveAt && nowMs - n.liveAt < LIVE_TTL_MS) {
                break;
            }
            if (!n.inheritAt) {
                n.shownDelay = delayMin;
            }
            n.delay = delayMin;
            n.inheritAt = nowMs;
        }
    }

    update(T, nowMs, dtMs, emit) {
        if (nowMs - this.lastScan > 5000 || Math.abs(T - this.lastScanT) > 2) {
            this.scan(T, nowMs);
        }
        const ease = 1 - Math.exp(-dtMs / 4000);
        let count = 0;
        for (const tr of this.active) {
            const live = tr.liveAt && nowMs - tr.liveAt < LIVE_TTL_MS;
            const inherited = !live && tr.inheritAt && nowMs - tr.inheritAt < LIVE_TTL_MS;
            const predicted = tr.predicted(nowMs);
            if (!live && !inherited) {
                tr.delay = 0;
            }
            // Per-stop predictions already contain the delay
            const target = predicted ? 0 : tr.delay;
            tr.shownDelay += (target - tr.shownDelay) * ease;
            const Te = T - tr.shownDelay;
            const end = predicted ? Math.max(tr.end, tr.arrRT[tr.arrRT.length - 1]) : tr.end;
            if (Te < tr.start || Te > end) {
                continue;
            }
            const s = tr.locate(Te, nowMs);
            emit(tr.line, s, tr.dir, live || predicted ? KIND_LIVE : KIND_SCHEDULED, tr.alpha(Te), tr);
            count++;
        }
        return count;
    }

    // The whole through-running journey this leg belongs to
    journey(tr) {
        let first = tr;
        for (let k = 0; first.prev && k < 12; k++) {
            first = first.prev;
        }
        const legs = [];
        for (let n = first, k = 0; n && k < 16; n = n.next, k++) {
            legs.push(n);
        }
        return legs;
    }

    describe(tr, T, lang) {
        const net = this.network, now = Date.now();
        const type = net.types[tr.type];
        const [nameJa, nameEn] = tr.name ? tr.name.split('|') : ['', ''];
        const live = tr.liveAt && now - tr.liveAt < LIVE_TTL_MS;
        const inherited = !live && tr.inheritAt && now - tr.inheritAt < LIVE_TTL_MS;
        const predicted = tr.predicted(now);
        const next = tr.nextStop(T - tr.shownDelay, now);
        // The operator's reported delay wins. Otherwise compare the prediction with the timetable at
        // the same stop; timetable times are whole minutes, so under a minute counts as on time.
        let delay = null;
        if (live || inherited) {
            delay = Math.round(tr.delay);
        } else if (predicted && next) {
            const late = next.time - (next.atStation ? tr.dep[next.i] : tr.arr[next.i]);
            delay = late < 1 ? 0 : Math.round(late);
        }
        // Lines this train runs on, in order, without repeating consecutive legs on one line
        const route = [];
        for (const leg of this.journey(tr)) {
            const last = route[route.length - 1];
            if (!last || last.line !== leg.line) {
                route.push({line: leg.line, current: leg === tr});
            } else if (leg === tr) {
                last.current = true;
            }
        }
        return {
            line: tr.line,
            typeName: type ? (lang === 'ja' ? type.ja : type.en) : '',
            trainName: lang === 'ja' ? nameJa : (nameEn || nameJa),
            number: tr.number,
            dest: tr.dest >= 0 ? net.stationName(tr.dest, lang) : '',
            direction: tr.dir > 0 ? tr.line.asc : tr.line.desc,
            // Predicted times already include the delay
            next: next && {
                name: net.stationName(next.station, lang),
                time: next.time + (predicted ? 0 : Math.max(0, tr.shownDelay)),
                atStation: next.atStation
            },
            delay,
            delayCarried: inherited,
            cars: tr.line.cars,
            route: route.length > 1 ? route : null,
            source: live || predicted ? 'live' : 'timetable'
        };
    }
}

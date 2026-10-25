// Live feeds that report trains as "at station X" or "between X and Y".
// LiveSegmentProvider turns those discrete reports into smooth motion.

import {travelled} from './network.js';
import {KIND_LIVE} from './timetable.js';

// Nominal running speed used to animate between reported stations, m/s
const NOMINAL_SPEED = 14;
// Never run past this share of a segment until the feed confirms the next station
const MAX_PROGRESS = 0.94;
// Remove a vehicle after it has been missing from the feed for this long
const STALE_MS = 150 * 1000;

class LiveVehicle {
    constructor(key) {
        this.key = key;
        this.s = null;
        this.alpha = 0;
        this.gone = false;
    }
}

export class LiveSegmentProvider {
    constructor(network) {
        this.network = network;
        this.vehicles = new Map();
    }

    // Find the index of a station within a line; for loop lines with duplicate
    // entries pick the one nearest to `near`
    stationIndex(line, stationIdx, near) {
        let best = -1;
        for (let i = 0; i < line.stations.length; i++) {
            if (line.stations[i] === stationIdx) {
                if (best < 0 || (near !== undefined && Math.abs(i - near) < Math.abs(best - near))) {
                    best = i;
                }
            }
        }
        return best;
    }

    // reports: [{key, line, from, to, dir, info}] with from/to as indices into line.stations (to may be -1)
    ingest(reports, nowMs) {
        for (const r of reports) {
            let v = this.vehicles.get(r.key);
            if (!v) {
                v = new LiveVehicle(r.key);
                this.vehicles.set(r.key, v);
            }
            const sameSegment = v.line === r.line && v.from === r.from && v.to === r.to;
            if (!sameSegment) {
                const line = r.line, offs = line.offsets;
                const a = offs[r.from], b = r.to >= 0 ? offs[r.to] : a;
                const dist = Math.abs(b - a);
                const nominal = Math.max(45, dist / NOMINAL_SPEED);
                let startT = 0;
                if (v.s === null || v.line !== r.line) {
                    // First sighting mid-segment: assume it is about a third of the way along
                    startT = r.to >= 0 ? nominal * 0.35 : 0;
                    v.s = a + Math.sign(b - a) * travelled(dist, nominal, startT);
                } else if (r.to >= 0 && dist > 0) {
                    // Continue from where the marker currently is
                    const done = Math.max(0, Math.min(dist * 0.9, (v.s - a) * Math.sign(b - a)));
                    startT = nominal * (done / dist);
                }
                v.line = r.line;
                v.from = r.from;
                v.to = r.to;
                v.a = a;
                v.b = b;
                v.dist = dist;
                v.nominal = nominal;
                v.segStart = nowMs - startT * 1000;
            }
            v.dir = r.dir;
            v.info = r.info;
            v.seen = nowMs;
            v.gone = false;
        }
    }

    // Mark vehicles of a source as gone when they disappear from its feed
    retire(sourcePrefix, seenKeys, nowMs) {
        for (const [key, v] of this.vehicles) {
            if (key.startsWith(sourcePrefix) && !seenKeys.has(key) && nowMs - v.seen > 45000) {
                v.gone = true;
            }
        }
    }

    has(key) {
        return this.vehicles.has(key);
    }

    update(T, nowMs, dtMs, emit) {
        const ease = 1 - Math.exp(-dtMs / 900);
        let count = 0;
        for (const [key, v] of this.vehicles) {
            if (nowMs - v.seen > STALE_MS) {
                v.gone = true;
            }
            v.alpha += ((v.gone ? 0 : 1) - v.alpha) * (1 - Math.exp(-dtMs / 600));
            if (v.gone && v.alpha < 0.02) {
                this.vehicles.delete(key);
                continue;
            }
            let target;
            if (v.to < 0 || v.dist === 0) {
                target = v.a;
            } else {
                const t = (nowMs - v.segStart) / 1000;
                const d = Math.min(travelled(v.dist, v.nominal, t), v.dist * MAX_PROGRESS);
                target = v.a + Math.sign(v.b - v.a) * d;
            }
            v.s += (target - v.s) * ease;
            const dir = v.to >= 0 && v.b !== v.a ? Math.sign(v.b - v.a) : v.dir;
            emit(v.line, v.s, dir || 1, KIND_LIVE, v.alpha, v);
            count++;
        }
        return count;
    }

    describe(v, T, lang) {
        const net = this.network, info = v.info || {};
        const nextIdx = v.to >= 0 ? v.to : v.from;
        return {
            line: v.line,
            typeName: (lang === 'ja' ? info.typeJa : info.typeEn) || info.typeJa || '',
            trainName: (lang === 'ja' ? info.nameJa : info.nameEn) || info.nameJa || '',
            number: info.number || '',
            dest: (lang === 'ja' ? info.destJa : info.destEn) || info.destJa || '',
            next: {name: net.stationName(v.line.stations[nextIdx], lang), time: null, atStation: v.to < 0},
            delay: info.delay ?? null,
            cars: info.cars,
            source: 'live',
            feed: info.feed
        };
    }
}

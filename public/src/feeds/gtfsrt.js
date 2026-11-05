// Minimal GTFS Realtime reader (TripUpdates only) and the ODPT per-stop prediction feed.
// Protobuf wire format: https://protobuf.dev/programming-guides/encoding/

import {serviceTime} from '../clock.js';

class Reader {
    constructor(buf, start = 0, end = buf.length) {
        this.buf = buf;
        this.pos = start;
        this.end = end;
    }

    varint() {
        let result = 0, shift = 0, b;
        do {
            b = this.buf[this.pos++];
            if (shift < 49) {
                result += (b & 0x7f) * Math.pow(2, shift);
            } else {
                // Negative int32/int64 values use ten bytes; recover them with BigInt
                return this.bigTail(result, shift, b);
            }
            shift += 7;
        } while (b & 0x80);
        return result;
    }

    bigTail(low, shift, b) {
        let v = BigInt(low) + (BigInt(b & 0x7f) << BigInt(shift));
        while (b & 0x80) {
            shift += 7;
            b = this.buf[this.pos++];
            v += BigInt(b & 0x7f) << BigInt(shift);
        }
        v &= (1n << 64n) - 1n;
        return Number(v >= (1n << 63n) ? v - (1n << 64n) : v);
    }

    // Iterate fields: calls fn(fieldNumber, wireType, reader-for-length-delimited | value)
    fields(fn) {
        while (this.pos < this.end) {
            const key = this.varint(), field = Math.floor(key / 8), wire = key & 7;
            if (wire === 0) {
                fn(field, this.varint());
            } else if (wire === 2) {
                const len = this.varint(), sub = new Reader(this.buf, this.pos, this.pos + len);
                this.pos += len;
                fn(field, sub);
            } else if (wire === 1) {
                this.pos += 8;
            } else if (wire === 5) {
                this.pos += 4;
            } else {
                throw new Error(`unsupported wire type ${wire}`);
            }
        }
    }

    string() {
        return new TextDecoder().decode(this.buf.subarray(this.pos, this.end));
    }
}

function stopTimeEvent(r) {
    const e = {};
    r.fields((f, v) => {
        if (f === 1) {
            e.delay = v;
        } else if (f === 2) {
            e.time = v;
        }
    });
    return e;
}

// Returns [{tripId, routeId, delay, stops: [{seq, stopId, arrival, departure}]}]
export function decodeTripUpdates(arrayBuffer) {
    const out = [];
    new Reader(new Uint8Array(arrayBuffer)).fields((f, entity) => {
        if (f !== 2) {
            return;
        }
        entity.fields((ef, v) => {
            if (ef !== 3) {
                return;
            }
            const tu = {tripId: '', routeId: '', delay: undefined, stops: []};
            v.fields((tf, w) => {
                if (tf === 1) {
                    w.fields((df, x) => {
                        if (df === 1) {
                            tu.tripId = x.string();
                        } else if (df === 5) {
                            tu.routeId = x.string();
                        }
                    });
                } else if (tf === 2) {
                    const st = {};
                    w.fields((sf, x) => {
                        if (sf === 1) {
                            st.seq = x;
                        } else if (sf === 2) {
                            st.arrival = stopTimeEvent(x);
                        } else if (sf === 3) {
                            st.departure = stopTimeEvent(x);
                        } else if (sf === 4) {
                            st.stopId = x.string();
                        }
                    });
                    tu.stops.push(st);
                } else if (tf === 5) {
                    tu.delay = w;
                }
            });
            out.push(tu);
        });
    });
    return out;
}

// Toei trip_id: route digit, day/direction digit, 5-character train number, variant
// ("100403T0" -> 403T, "121727NB" -> 1727Nb). The Arakawa tram uses "ODPT" + 4 digits.
const TOEI = {
    url: 'https://api-public.odpt.org/api/v4/gtfs/realtime/toei_odpt_train_trip_update',
    lines: {1: 'Toei.Asakusa', 2: 'Toei.Mita', 3: 'Toei.Shinjuku', 4: 'Toei.Oedo', 5: 'Toei.NipporiToneri', 6: 'Toei.Arakawa'},
    number(id) {
        if (id[0] === '6') {
            return `ODPT${id.slice(2, 6)}`;
        }
        const variant = id[7] && id[7] !== '0' ? id[7].toLowerCase() : '';
        return id.slice(2, 7).replace(/^0+/, '') + variant;
    }
};

// Ignore a prediction this far from the timetable: it belongs to some other train
const MAX_DEVIATION_MIN = 180;

// The feed identifies stops by stop_sequence only. GTFS lists every station on the route, including
// those an express passes, so sequence k is the k-th stop for all-stops trains and the k-th
// station along the line for expresses. Checked against every trip in Toei's static GTFS.
function stopFinder(tr, lastSeq) {
    const f = tr.flat, n = f.length / 3;
    if (lastSeq <= n) {
        return seq => seq - 1;
    }
    const first = f[0], step = f[f.length - 3] >= first ? 1 : -1;
    const stopAt = new Map();
    for (let i = 0; i < n; i++) {
        stopAt.set(f[i * 3], i);
    }
    return seq => stopAt.get(first + step * (seq - 1)) ?? -1;
}

export class TripUpdateFeed {
    constructor({network, timetable, onUpdate}) {
        this.network = network;
        this.timetable = timetable;
        this.onUpdate = onUpdate;
        this.state = {};
        this.trains = 0;
        this.timer = null;
    }

    start() {
        this.stop();
        const tick = () => this.poll().finally(() => {
            this.timer = setTimeout(tick, 20000);
        });
        tick();
    }

    stop() {
        clearTimeout(this.timer);
    }

    async poll() {
        try {
            const res = await fetch(TOEI.url, {cache: 'no-store'});
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            this.apply(decodeTripUpdates(await res.arrayBuffer()), Date.now());
            this.state = {ok: true, at: Date.now(), trains: this.trains};
        } catch (e) {
            this.state = {ok: false, error: String(e.message || e)};
        }
        this.onUpdate && this.onUpdate();
    }

    apply(updates, nowMs) {
        let n = 0;
        for (const tu of updates) {
            const lineId = TOEI.lines[tu.tripId[0]];
            const tr = lineId && this.timetable.find(lineId, TOEI.number(tu.tripId));
            if (!tr) {
                continue;
            }
            tr.prepare();
            const arr = [], dep = [];
            let any = false;
            const lastSeq = tu.stops.reduce((m, st) => Math.max(m, st.seq || 0), 0);
            const stopIndex = stopFinder(tr, lastSeq);
            for (const st of tu.stops) {
                const i = st.seq ? stopIndex(st.seq) : -1;
                if (i < 0 || i >= tr.arr.length) {
                    continue;
                }
                const a = eventMinutes(st.arrival, tr.arr[i]), d = eventMinutes(st.departure, tr.dep[i]);
                if (a !== undefined && Math.abs(a - tr.arr[i]) < MAX_DEVIATION_MIN) {
                    arr[i] = a;
                    any = true;
                }
                if (d !== undefined && Math.abs(d - tr.dep[i]) < MAX_DEVIATION_MIN) {
                    dep[i] = d;
                    any = true;
                }
            }
            if (any) {
                tr.setPredictions(arr, dep, nowMs);
                n++;
            } else if (tu.delay !== undefined) {
                this.timetable.setLiveDelay(lineId, tr.number, tu.delay / 60, nowMs);
                n++;
            }
        }
        this.trains = n;
        return n;
    }
}

// Predicted time in service-day minutes from an absolute time or a delay on the schedule
function eventMinutes(e, scheduled) {
    if (!e) {
        return undefined;
    }
    if (e.time) {
        return serviceTime(e.time * 1000).minutes;
    }
    if (e.delay !== undefined) {
        return scheduled + e.delay / 60;
    }
    return undefined;
}

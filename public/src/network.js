// Rail network geometry: lines as polylines in Web Mercator with distance lookup.

export function mercatorX(lng) {
    return (lng + 180) / 360;
}

export function mercatorY(lat) {
    const s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function toLngLat(x, y) {
    return [x * 360 - 180, 360 / Math.PI * Math.atan(Math.exp((1 - y * 2) * Math.PI)) - 90];
}

export function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// Maximum acceleration/braking used to shape motion between stops, m/s²
const ACC = 0.8;

// Distance covered t seconds into a run of `dist` metres scheduled to take `total` seconds:
// accelerate, cruise, brake (trapezoid speed profile), falling back to a smooth ease
export function travelled(dist, total, t) {
    if (t <= 0 || total <= 0) {
        return t <= 0 ? 0 : dist;
    }
    if (t >= total) {
        return dist;
    }
    const disc = ACC * ACC * total * total - 4 * ACC * dist;
    if (disc >= 0) {
        const v = (ACC * total - Math.sqrt(disc)) / 2, ta = v / ACC;
        if (t < ta) {
            return 0.5 * ACC * t * t;
        }
        if (t > total - ta) {
            const r = total - t;
            return dist - 0.5 * ACC * r * r;
        }
        return 0.5 * ACC * ta * ta + v * (t - ta);
    }
    const u = t / total;
    return dist * u * u * (3 - 2 * u);
}

export class Line {
    constructor(data, index) {
        this.index = index;
        this.id = data.id;
        this.op = data.op;
        this.ja = data.ja;
        this.en = data.en;
        this.color = data.color;
        this.rgb = hexToRgb(data.color);
        this.asc = data.asc;
        this.desc = data.desc;
        this.stations = data.st;
        this.offsets = Float64Array.from(data.off);
        this.coords = data.c;
        const n = data.c.length;
        this.x = new Float64Array(n);
        this.y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            this.x[i] = mercatorX(data.c[i][0]);
            this.y[i] = mercatorY(data.c[i][1]);
        }
        this.m = Float64Array.from(data.m);
        this.length = this.m[n - 1];
        this.cars = data.cars || 6;
        this.carLen = data.carLen || 20;
        // Tunnel sections as [start, end] chainage pairs
        this.ug = data.ug || [];
    }

    underground(s) {
        for (const [a, b] of this.ug) {
            if (s >= a && s <= b) {
                return true;
            }
        }
        return false;
    }

    _seg(s) {
        const m = this.m;
        let lo = 0, hi = m.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (m[mid] <= s) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    point(s, out) {
        s = Math.max(0, Math.min(this.length, s));
        const i = this._seg(s), m = this.m;
        const span = m[i + 1] - m[i];
        const t = span > 0 ? (s - m[i]) / span : 0;
        out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t;
        out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
        return out;
    }

    // Position and smoothed heading (unit vector in mercator space) at distance s.
    // dir = +1 when travelling towards increasing distance.
    at(s, dir, out) {
        this.point(s, out);
        const ax = out.x, ay = out.y;
        const look = 25;
        this.point(s + look, tmpA);
        this.point(s - look, tmpB);
        let hx = tmpA.x - tmpB.x, hy = tmpA.y - tmpB.y;
        const len = Math.hypot(hx, hy);
        if (len > 0) {
            hx /= len;
            hy /= len;
        } else {
            hx = 1;
            hy = 0;
        }
        out.x = ax;
        out.y = ay;
        out.hx = hx * dir;
        out.hy = hy * dir;
        return out;
    }

    // The drawn line, split into surface (ug 0) and tunnel (ug 1) runs
    toFeatures() {
        const props = ug => ({id: this.id, color: this.color, op: this.op, ug});
        const cuts = [0];
        for (const [a, b] of this.ug) {
            cuts.push(a, b);
        }
        cuts.push(this.length);
        const features = [];
        const p = {x: 0, y: 0};
        for (let k = 0; k < cuts.length - 1; k++) {
            const a = cuts[k], b = cuts[k + 1];
            if (b - a < 1) {
                continue;
            }
            const coords = [];
            this.point(a, p);
            coords.push(toLngLat(p.x, p.y));
            for (let i = 0; i < this.m.length; i++) {
                if (this.m[i] > a && this.m[i] < b) {
                    coords.push(this.coords[i]);
                }
            }
            this.point(b, p);
            coords.push(toLngLat(p.x, p.y));
            features.push({type: 'Feature', properties: props(k % 2), geometry: {type: 'LineString', coordinates: coords}});
        }
        return features;
    }
}

const tmpA = {x: 0, y: 0}, tmpB = {x: 0, y: 0};

export class Network {
    constructor(data) {
        this.city = data.city;
        this.source = data.source;
        this.operators = data.operators;
        this.types = data.types || [];
        this.directions = data.directions || {};
        // "Meiji-jingumae<Harajuku>" -> "Meiji-jingumae (Harajuku)", "明治神宮前〈原宿〉"
        this.stations = data.stations.map(s => ({
            ...s,
            en: (s.en || '').replace(/<([^>]*)>/g, ' ($1)'),
            ja: (s.ja || '').replace(/</g, '〈').replace(/>/g, '〉')
        }));
        this.lines = data.lines.map((l, i) => new Line(l, i));
        this.lineById = new Map(this.lines.map(l => [l.id, l]));
        this.stationById = new Map(this.stations.map((s, i) => [s.id, i]));
    }

    stationName(index, lang) {
        const s = this.stations[index];
        if (!s) {
            return '';
        }
        return (lang === 'ja' ? s.ja : s.en) || s.ja || s.en;
    }

    linesGeoJSON() {
        return {type: 'FeatureCollection', features: this.lines.flatMap(l => l.toFeatures())};
    }

    stationsGeoJSON() {
        // One dot per line stop; one label per station name cluster (same name within ~500 m)
        const dots = [], clusters = new Map();
        const done = new Set();
        const p = {x: 0, y: 0};
        for (const line of this.lines) {
            for (let i = 0; i < line.stations.length; i++) {
                const si = line.stations[i];
                const s = this.stations[si];
                if (!s || done.has(si)) {
                    continue;
                }
                done.add(si);
                // Snap the dot onto the drawn line (which may be offset from parallel tracks)
                line.point(line.offsets[i], p);
                const c = toLngLat(p.x, p.y);
                dots.push({type: 'Feature', properties: {kind: 'dot'}, geometry: {type: 'Point', coordinates: c}});
                s.c = s.c || c;
                const list = clusters.get(s.ja) || [];
                let cl = list.find(k => Math.abs(k.x / k.n - c[0]) < 0.0045 && Math.abs(k.y / k.n - c[1]) < 0.0035);
                if (!cl) {
                    cl = {x: 0, y: 0, n: 0, ja: s.ja, en: s.en || s.ja};
                    list.push(cl);
                    clusters.set(s.ja, list);
                }
                cl.x += c[0];
                cl.y += c[1];
                cl.n++;
            }
        }
        const labels = [];
        for (const list of clusters.values()) {
            for (const c of list) {
                labels.push({
                    type: 'Feature',
                    properties: {kind: 'label', ja: c.ja, en: c.en, lines: c.n},
                    geometry: {type: 'Point', coordinates: [c.x / c.n, c.y / c.n]}
                });
            }
        }
        return {type: 'FeatureCollection', features: dots.concat(labels)};
    }
}

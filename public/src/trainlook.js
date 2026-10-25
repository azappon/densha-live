// How a train looks at the current zoom ("semantic zoom"):
//   far out   a bright point with a soft pulse glow, so busy corridors light up
//   mid       a glowing capsule that stretches with zoom towards its real length
//   close     real-length cars (car count x car length) that split apart and bend along the track,
//             with a headlight in front and a tail light behind
// Moving trains drag a fading light trail along the track behind them, longer when faster.

import {STRIDE} from './trainlayer.js';

const EARTH = 40075016.7;
const LAT_COS = Math.cos(35.68 * Math.PI / 180);
const TRAIL_POINTS = 7;

export const KIND = {capsule: 0, car: 1, trail: 2, pulse: 3, headlight: 4, taillight: 5};
export const FLAG = {live: 1, selected: 2, head: 4};

function smooth(e0, e1, x) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

class InstanceList {
    constructor() {
        this.data = new Float32Array(STRIDE * 2048);
        this.count = 0;
    }

    push(x, y, hx, hy, halfLen, halfWidth, rgb, alpha, kind, flags, morph) {
        if ((this.count + 1) * STRIDE > this.data.length) {
            const grown = new Float32Array(this.data.length * 2);
            grown.set(this.data);
            this.data = grown;
        }
        const d = this.data, o = this.count * STRIDE;
        d[o] = x;
        d[o + 1] = y;
        d[o + 2] = hx;
        d[o + 3] = hy;
        d[o + 4] = halfLen;
        d[o + 5] = halfWidth;
        d[o + 6] = rgb[0];
        d[o + 7] = rgb[1];
        d[o + 8] = rgb[2];
        d[o + 9] = alpha;
        d[o + 10] = kind;
        d[o + 11] = flags;
        d[o + 12] = morph;
        d[o + 13] = 0;
        this.count++;
    }
}

export class TrainLook {
    constructor() {
        this.pulse = new InstanceList();
        this.trail = new InstanceList();
        this.body = new InstanceList();
        this.light = new InstanceList();
        this.p = {x: 0, y: 0, hx: 1, hy: 0};
        this.q = {x: 0, y: 0};
        this.pts = new Float64Array(TRAIL_POINTS * 2);
    }

    get lists() {
        return [this.pulse, this.trail, this.body, this.light];
    }

    // Per-frame parameters from the camera
    begin(map, refX, refY, underground, timeSec) {
        for (const l of this.lists) {
            l.count = 0;
        }
        const z = map.getZoom();
        this.refX = refX;
        this.refY = refY;
        this.worldPx = 512 * Math.pow(2, z);
        this.mpp = EARTH * LAT_COS / this.worldPx;            // metres per CSS pixel
        this.unfold = smooth(10.6, 13.4, z);                    // 0 = point, 1 = real length
        this.halfWidth = 1.9 + 2.9 * smooth(10, 16.5, z);
        this.lightK = 0.55 + 0.45 * smooth(11, 14, z);           // calmer headlights far out
        this.pulseK = 1 - smooth(10.6, 12.4, z);
        this.trailSec = 34 - 26 * smooth(11, 15.5, z);
        this.glow = 1.7 + 1.6 * smooth(11, 15, z);              // headlight radius in half-widths
        this.underground = underground;
        this.time = timeSec;
        const b = map.getBounds();
        const pad = 0.25;
        const x0 = mercX(b.getWest()), x1 = mercX(b.getEast());
        const y0 = mercY(b.getNorth()), y1 = mercY(b.getSouth());
        const mx = (x1 - x0) * pad, my = (y1 - y0) * pad;
        this.view = [x0 - mx, y0 - my, x1 + mx, y1 + my];
    }

    // Adds one train. Returns false when it is off screen (only its head is computed).
    // out receives head and tail positions (mercator) for hit testing.
    add(line, s, dir, live, alpha, speed, selected, out, phase) {
        const p = this.p, q = this.q;
        line.point(s, q);
        out[0] = q.x;
        out[1] = q.y;
        out[2] = q.x;
        out[3] = q.y;
        const v = this.view;
        if (q.x < v[0] || q.x > v[2] || q.y < v[1] || q.y > v[3]) {
            return false;
        }
        const tunnel = line.ug.length > 0 && line.underground(s);
        // Surface view dims trains in tunnels; underground view does the opposite
        const view = this.underground ? (tunnel ? 1 : 0.16) : (tunnel ? 0.45 : 1);
        const shine = this.underground ? (tunnel ? 1 : 0) : (tunnel ? 0.25 : 1);
        alpha *= view;
        const rgb = line.rgb, hw = this.halfWidth;
        const flags = (live ? FLAG.live : 0) | (selected ? FLAG.selected : 0);
        const lengthM = Math.min(line.cars * line.carLen * this.unfold, line.length);
        const lengthPx = lengthM / this.mpp;
        const rx = this.refX, ry = this.refY;
        // Cars separate once each is clearly longer than it is wide
        const split = smooth(1.3, 1.9, line.carLen / this.mpp / (2 * hw));
        // The timetable position is the middle of the train (stopped trains sit centred on the
        // platform); keep the whole body on the track at termini
        s += dir * lengthM / 2;
        const lo = Math.min(s, s - dir * lengthM), hi = Math.max(s, s - dir * lengthM);
        if (lo < 0) {
            s -= lo;
        } else if (hi > line.length) {
            s -= hi - line.length;
        }
        line.point(s, q);
        out[0] = q.x;
        out[1] = q.y;

        // Body
        if (lengthPx <= hw * 2.4) {
            line.at(s - dir * lengthM / 2, dir, p);
            this.body.push(p.x - rx, p.y - ry, p.hx, p.hy, Math.max(hw, lengthPx / 2), hw, rgb, alpha,
                KIND.capsule, flags | FLAG.head, 0);
        } else {
            const cars = split > 0.01;
            const n = cars ? line.cars : Math.max(2, Math.min(line.cars, Math.ceil(lengthPx / 26)));
            const segM = lengthM / n, segPx = segM / this.mpp;
            const gapPx = cars ? 1.6 * split : 0;
            const halfLen = cars ? Math.max(1, segPx / 2 - gapPx / 2) : segPx / 2 + hw * 0.5;
            for (let i = 0; i < n; i++) {
                line.at(s - dir * (i + 0.5) * segM, dir, p);
                this.body.push(p.x - rx, p.y - ry, p.hx, p.hy, halfLen, hw, rgb, alpha,
                    cars ? KIND.car : KIND.capsule, flags | (i === 0 ? FLAG.head : 0), split);
            }
        }
        line.point(s - dir * lengthM, q);
        out[2] = q.x;
        out[3] = q.y;

        // Lights: live trains breathe gently
        if (shine > 0) {
            const breathe = live ? 0.75 + 0.25 * Math.sin(this.time * 2.4 + phase) : 0.85;
            line.point(s, q);
            const glow = hw * (this.glow + split);
            this.light.push(q.x - rx, q.y - ry, 1, 0, glow, glow,
                rgb, alpha * shine * breathe * this.lightK, KIND.headlight, 0, 0);
            if (lengthPx > 18) {
                line.point(s - dir * lengthM, q);
                const r = hw * 1.15;
                this.light.push(q.x - rx, q.y - ry, 1, 0, r, r, rgb, alpha * shine * 0.75 * smooth(18, 44, lengthPx),
                    KIND.taillight, 0, 0);
            }
        }

        // Light trail along the track behind the train
        if (shine > 0 && speed > 1.5) {
            const trailM = Math.min(speed * this.trailSec, 3000);
            const start = s - dir * lengthM, pts = this.pts, K = TRAIL_POINTS - 1;
            for (let k = 0; k <= K; k++) {
                line.point(start - dir * trailM * k / K, q);
                pts[k * 2] = q.x;
                pts[k * 2 + 1] = q.y;
            }
            for (let k = 0; k < K; k++) {
                const ax = pts[k * 2], ay = pts[k * 2 + 1], bx = pts[k * 2 + 2], by = pts[k * 2 + 3];
                const dx = ax - bx, dy = ay - by, len = Math.hypot(dx, dy);
                const lenPx = len * this.worldPx;
                if (lenPx < 0.5) {
                    break;
                }
                const f = 1 - k / K;
                this.trail.push((ax + bx) / 2 - rx, (ay + by) / 2 - ry, dx / len, dy / len, lenPx / 2 + 0.5,
                    hw * (0.3 + 0.45 * f), rgb, alpha * shine * 0.4 * Math.pow(f, 1.6), KIND.trail, 0, 0);
            }
        }

        // City pulse: overlapping glows show where trains are dense
        if (this.pulseK > 0.01) {
            this.pulse.push(out[0] - rx, out[1] - ry, 1, 0, 22, 22, rgb, 0.065 * this.pulseK * alpha * Math.max(shine, 0.3),
                KIND.pulse, 0, 0);
        }
        return true;
    }
}

function mercX(lng) {
    return (lng + 180) / 360;
}

function mercY(lat) {
    const s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

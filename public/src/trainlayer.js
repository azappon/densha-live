// MapLibre custom WebGL2 layer drawing trains as instanced, track-aligned shapes.
// One draw call per frame; instance kinds (see trainlook.js) select the shape:
//   0 glowing capsule, 1 car body, 2 trail segment, 3 pulse glow, 4 headlight, 5 tail light.
// Glows write colour with zero alpha, which adds light under premultiplied blending.

export const STRIDE = 14; // x, y, hx, hy, halfLen, halfWidth, r, g, b, alpha, kind, flags, morph, spare

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_posdir;
layout(location = 2) in vec2 a_size;
layout(location = 3) in vec4 a_color;
layout(location = 4) in vec4 a_style;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_step;
uniform float u_pr;
out vec2 v_local;
out vec2 v_half;
out vec4 v_color;
out vec4 v_style;
void main() {
    vec4 c0 = u_matrix * vec4(a_posdir.xy, 0.0, 1.0);
    vec4 c1 = u_matrix * vec4(a_posdir.xy + a_posdir.zw * u_step, 0.0, 1.0);
    vec2 s0 = c0.xy / c0.w;
    vec2 s1 = c1.xy / c1.w;
    vec2 dir = (s1 - s0) * u_viewport;
    float len = length(dir);
    dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float kind = a_style.x;
    vec2 half_ = a_size * u_pr;
    float pad = kind < 1.5 ? 9.0 * u_pr : (kind < 2.5 ? 1.0 * u_pr : 0.0);
    vec2 local = a_corner * (half_ + pad);
    vec2 px = dir * local.x + nrm * local.y;
    gl_Position = vec4(s0 + px * 2.0 / u_viewport, 0.0, 1.0);
    v_local = local;
    v_half = half_;
    v_color = a_color;
    v_style = a_style;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_half;
in vec4 v_color;
in vec4 v_style;
uniform float u_pr;
out vec4 fragColor;
float sdBox(vec2 p, vec2 h, float r) {
    vec2 q = abs(p) - h + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
    float kind = v_style.x;
    float flags = v_style.y;
    float morph = v_style.z;
    float aa = 0.8 * u_pr;
    vec3 col = v_color.rgb;
    float a = v_color.a;
    if (kind > 2.5) {
        float r = length(v_local) / v_half.x;
        if (r > 1.0) {
            discard;
        }
        if (kind < 3.5) {
            float i = (1.0 - r) * (1.0 - r) * a;
            fragColor = vec4(col * i, 0.0);
            return;
        }
        float core = 1.0 - smoothstep(0.0, 0.24, r);
        float glow = exp(-r * r * 7.0);
        vec3 lc = kind < 4.5 ? mix(col, vec3(1.0, 0.97, 0.9), 0.8) : vec3(1.0, 0.24, 0.2);
        fragColor = vec4(lc * (glow * 0.55 + core) * a, core * a * 0.85);
        return;
    }
    if (kind > 1.5) {
        float d = sdBox(v_local, v_half, v_half.y);
        float m = 1.0 - smoothstep(-aa, aa, d);
        float along = clamp(0.5 + v_local.x / (2.0 * max(v_half.x, 1.0)), 0.0, 1.0);
        fragColor = vec4(col * m * a * mix(0.7, 1.0, along), 0.0);
        return;
    }
    bool selected = mod(floor(flags / 2.0), 2.0) > 0.5;
    bool head = mod(floor(flags / 4.0), 2.0) > 0.5;
    float rad = mix(v_half.y, v_half.y * 0.42, morph);
    float d = sdBox(v_local, v_half, rad);
    float body = 1.0 - smoothstep(-aa, aa, d);
    float across = abs(v_local.y) / v_half.y;
    // Car look: deep line-colour body with a lit roof stripe
    float roof = 1.0 - smoothstep(0.28, 0.42, across);
    vec3 car = mix(col * 0.42, mix(col, vec3(1.0), 0.18), roof);
    // Capsule look: line colour with a continuous hot core (seamless across segments)
    vec3 cap = mix(col, vec3(1.0), (1.0 - smoothstep(0.0, 0.7, across)) * 0.4);
    vec4 res = vec4(mix(cap, car, morph) * body, body);
    float outside = 1.0 - body;
    // Dark rim keeps neighbouring cars apart (cars only, so capsule pieces join seamlessly)
    res += vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(0.0, 1.5 * u_pr, d)) * outside * 0.7 * morph) * (1.0 - res.a);
    float halo = head ? exp(-max(d, 0.0) / (3.5 * u_pr)) * outside * (1.0 - morph) * 0.5 : 0.0;
    float ring = selected ? exp(-max(d, 0.0) / (3.0 * u_pr)) * outside : 0.0;
    res.rgb += col * halo + vec3(1.0) * ring * 0.9;
    fragColor = res * a;
}`;

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh));
    }
    return sh;
}

export class TrainLayer {
    constructor() {
        this.id = 'trains';
        this.type = 'custom';
        this.renderingMode = '2d';
        this.data = new Float32Array(STRIDE * 4096);
        this.count = 0;
        this.refX = 0;
        this.refY = 0;
    }

    setReference(x, y) {
        this.refX = x;
        this.refY = y;
    }

    // lists: instance lists drawn in order (later ones on top)
    setLists(lists) {
        let total = 0;
        for (const l of lists) {
            total += l.count;
        }
        if (this.data.length < total * STRIDE) {
            this.data = new Float32Array(Math.max(total * STRIDE, this.data.length * 2));
        }
        let o = 0;
        for (const l of lists) {
            this.data.set(l.data.subarray(0, l.count * STRIDE), o);
            o += l.count * STRIDE;
        }
        this.count = total;
        this.dirty = true;
    }

    onAdd(map, gl) {
        this.map = map;
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(prog));
        }
        this.program = prog;
        this.uniforms = {};
        for (const name of ['u_matrix', 'u_viewport', 'u_step', 'u_pr']) {
            this.uniforms[name] = gl.getUniformLocation(prog, name);
        }
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        this.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.inst = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
        this.capacity = 0;
        const bytes = STRIDE * 4;
        const attr = (loc, size, offset) => {
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offset * 4);
            gl.vertexAttribDivisor(loc, 1);
        };
        attr(1, 4, 0);
        attr(2, 2, 4);
        attr(3, 4, 6);
        attr(4, 4, 10);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    render(gl, args) {
        if (!this.count) {
            return;
        }
        const m = (args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix) ||
            (args && args.modelViewProjectionMatrix) || args;
        // Relative-to-centre: fold the reference point into the matrix so
        // instance coordinates stay small enough for float32 precision
        const rx = this.refX, ry = this.refY;
        const mat = new Float32Array(16);
        for (let i = 0; i < 16; i++) {
            mat[i] = m[i];
        }
        mat[12] = m[0] * rx + m[4] * ry + m[12];
        mat[13] = m[1] * rx + m[5] * ry + m[13];
        mat[14] = m[2] * rx + m[6] * ry + m[14];
        mat[15] = m[3] * rx + m[7] * ry + m[15];

        const pr = window.devicePixelRatio || 1;
        const worldPx = 512 * Math.pow(2, this.map.getZoom());

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
        const needed = this.count * STRIDE * 4;
        if (needed > this.capacity) {
            this.capacity = Math.max(needed, this.capacity * 2, 8192 * STRIDE * 4);
            gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
            this.dirty = true;
        }
        if (this.dirty) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * STRIDE);
            this.dirty = false;
        }
        const u = this.uniforms;
        gl.uniformMatrix4fv(u.u_matrix, false, mat);
        gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.uniform1f(u.u_step, 8 / worldPx);
        gl.uniform1f(u.u_pr, pr);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.CULL_FACE);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    onRemove(map, gl) {
        gl.deleteBuffer(this.quad);
        gl.deleteBuffer(this.inst);
        gl.deleteVertexArray(this.vao);
        gl.deleteProgram(this.program);
    }
}

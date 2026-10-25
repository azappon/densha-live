// MapLibre custom WebGL2 layer that draws thousands of trains as instanced,
// track-aligned capsules. Positions are uploaded every animation frame.

export const STRIDE = 10; // x, y, hx, hy, r, g, b, alpha, kind, selected

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_posdir;
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec2 a_state;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform vec2 u_half;
uniform float u_step;
uniform float u_pad;
out vec2 v_local;
out vec2 v_half;
out vec4 v_color;
out vec2 v_state;
void main() {
    vec4 c0 = u_matrix * vec4(a_posdir.xy, 0.0, 1.0);
    vec4 c1 = u_matrix * vec4(a_posdir.xy + a_posdir.zw * u_step, 0.0, 1.0);
    vec2 s0 = c0.xy / c0.w;
    vec2 s1 = c1.xy / c1.w;
    vec2 dir = (s1 - s0) * u_viewport;
    float len = length(dir);
    dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float sel = a_state.y;
    vec2 half_ = u_half * (1.0 + 0.3 * sel);
    vec2 local = a_corner * (half_ + u_pad * (1.0 + sel));
    vec2 px = dir * local.x + nrm * local.y;
    gl_Position = vec4(s0 + px * 2.0 / u_viewport, 0.0, 1.0);
    v_local = local;
    v_half = half_;
    v_color = a_color;
    v_state = a_state;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_half;
in vec4 v_color;
in vec2 v_state;
uniform float u_pr;
uniform float u_time;
uniform vec3 u_outline;
uniform vec3 u_ink;
out vec4 fragColor;
float sdCapsule(vec2 p, vec2 h) {
    float r = h.y;
    vec2 q = abs(p) - h + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
    float d = sdCapsule(v_local, v_half);
    float aa = 0.9 * u_pr;
    float kind = v_state.x;
    float sel = v_state.y;
    float ow = 1.4 * u_pr;
    float body = 1.0 - smoothstep(-aa, aa, d);
    float inner = 1.0 - smoothstep(-aa, aa, d + ow);
    vec3 col = mix(u_outline, v_color.rgb, inner);
    // Nose dot shows direction of travel
    vec2 nose = vec2(v_half.x - v_half.y, 0.0);
    float nd = length(v_local - nose) - v_half.y * 0.42;
    float noseMask = (1.0 - smoothstep(-aa, aa, nd)) * step(2.6 * u_pr, v_half.y) * inner;
    col = mix(col, u_ink, noseMask * 0.9);
    float alpha = body;
    // Soft shadow beneath every train
    float shadow = (1.0 - smoothstep(0.0, 4.0 * u_pr, d)) * 0.22 * (1.0 - body);
    vec3 shadowCol = vec3(0.0);
    // Live trains breathe a faint halo
    float pulse = 0.0;
    if (kind > 0.5) {
        float ph = fract(u_time * 0.5);
        float ring = abs(d - ph * 7.0 * u_pr) ;
        pulse = (1.0 - smoothstep(0.0, 1.6 * u_pr, ring)) * (1.0 - ph) * 0.55 * (1.0 - body);
    }
    // Selected train gets a solid ring
    float ringSel = 0.0;
    if (sel > 0.5) {
        ringSel = (1.0 - smoothstep(0.0, aa, abs(d - 4.0 * u_pr) - 1.4 * u_pr)) * (1.0 - body);
    }
    vec4 outCol = vec4(col * alpha, alpha);
    outCol += vec4(shadowCol, shadow) * (1.0 - outCol.a);
    outCol += vec4(v_color.rgb * pulse, pulse) * (1.0 - outCol.a);
    outCol = mix(outCol, vec4(v_color.rgb, 1.0), ringSel);
    fragColor = outCol * v_color.a;
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

// Train marker size (CSS px, half length / half width) by zoom
function markerHalfSize(zoom) {
    const stops = [[8, 2.6, 2.6], [10, 3.4, 3.0], [12, 6, 3.6], [13.5, 10, 4.6], [15, 16, 6], [17, 24, 7.5]];
    if (zoom <= stops[0][0]) {
        return [stops[0][1], stops[0][2]];
    }
    for (let i = 1; i < stops.length; i++) {
        if (zoom <= stops[i][0]) {
            const [z0, l0, w0] = stops[i - 1], [z1, l1, w1] = stops[i];
            const t = (zoom - z0) / (z1 - z0);
            return [l0 + (l1 - l0) * t, w0 + (w1 - w0) * t];
        }
    }
    const last = stops[stops.length - 1];
    return [last[1], last[2]];
}

export class TrainLayer {
    constructor() {
        this.id = 'trains';
        this.type = 'custom';
        this.renderingMode = '2d';
        this.data = new Float32Array(STRIDE * 1024);
        this.count = 0;
        this.refX = 0;
        this.refY = 0;
        this.outline = [1, 1, 1];
        this.ink = [1, 1, 1];
        this.t0 = performance.now();
    }

    setTheme(dark) {
        this.outline = dark ? [0.08, 0.09, 0.11] : [1, 1, 1];
        this.ink = dark ? [0.95, 0.96, 0.98] : [1, 1, 1];
    }

    setReference(x, y) {
        this.refX = x;
        this.refY = y;
    }

    setData(data, count) {
        this.data = data;
        this.count = count;
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
        for (const name of ['u_matrix', 'u_viewport', 'u_half', 'u_step', 'u_pad', 'u_pr', 'u_time', 'u_outline', 'u_ink']) {
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
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, bytes, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, bytes, 16);
        gl.vertexAttribDivisor(2, 1);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 2, gl.FLOAT, false, bytes, 32);
        gl.vertexAttribDivisor(3, 1);
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

        const map = this.map;
        const pr = window.devicePixelRatio || 1;
        const zoom = map.getZoom();
        const [hl, hw] = markerHalfSize(zoom);
        const worldPx = 512 * Math.pow(2, zoom);

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
        const needed = this.count * STRIDE * 4;
        if (needed > this.capacity) {
            this.capacity = Math.max(needed, this.capacity * 2, 4096 * STRIDE * 4);
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
        gl.uniform2f(u.u_half, hl * pr, hw * pr);
        gl.uniform1f(u.u_step, 8 / worldPx);
        gl.uniform1f(u.u_pad, 7 * pr);
        gl.uniform1f(u.u_pr, pr);
        gl.uniform1f(u.u_time, (performance.now() - this.t0) / 1000);
        gl.uniform3fv(u.u_outline, this.outline);
        gl.uniform3fv(u.u_ink, this.ink);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
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

/*!
 * Aether for the web: a WebGL2 port of five Aether scenes, drawn as a calm,
 * slowly dissolving page background with scroll parallax.
 * https://github.com/jtalbott22/wallpaper (MIT)
 *
 * Usage: <canvas id="aether-bg" aria-hidden="true"></canvas> + this script.
 * The canvas is shown once the first frame is drawn; without WebGL2 nothing
 * happens and the page keeps its normal background. It follows the page's
 * --paper colour, so it works with light and dark themes, renders a single
 * still frame under prefers-reduced-motion, caps itself at 30 fps, and
 * lowers its resolution on slow devices.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('aether-bg');
  if (!canvas || !window.WebGL2RenderingContext) return;

  var gl, FLOAT_RT, F16, F32, vao, programs, engine, raf = 0;
  var reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var darkMQ = window.matchMedia('(prefers-color-scheme: dark)');

  // ---------------------------------------------------------------- random
  function rng(seed) {
    var a = seed >>> 0;
    function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    next.uniform = function (lo, hi) { return lo + (hi - lo) * next(); };
    next.choice = function (arr) { return arr[Math.floor(next() * arr.length) % arr.length]; };
    next.sign = function () { return next() < 0.5 ? -1 : 1; };
    next.bits = function () { return Math.floor(next() * 2147483647); };
    return next;
  }
  function smooth(x) { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); }

  // A value that glides between random waypoints, so nothing ever loops.
  function Drift(r, lo, hi, period, start, waypoints) {
    this.r = r; this.lo = lo; this.hi = hi; this.period = period || [15, 40]; this.wps = waypoints;
    this.a = start !== undefined ? start : this.pick();
    this.b = this.pick();
    this.u = 0; this.dur = r.uniform(this.period[0], this.period[1]);
    this.value = this.a;
  }
  Drift.prototype.pick = function () {
    return this.wps ? this.r.choice(this.wps) : this.r.uniform(this.lo, this.hi);
  };
  Drift.prototype.update = function (dt) {
    this.u += dt / this.dur;
    if (this.u >= 1) {
      this.a = this.b; this.b = this.pick(); this.u = 0;
      this.dur = this.r.uniform(this.period[0], this.period[1]);
    }
    var s = smooth(this.u), a = this.a, b = this.b;
    if (Array.isArray(a)) this.value = a.map(function (x, i) { return x + (b[i] - x) * s; });
    else this.value = a + (b - a) * s;
    return this.value;
  };

  // --------------------------------------------------------------- palettes
  // The same curated gradients as Aether, biased towards the site's teal.
  var PALETTES = {
    abyss:    ['#000005', '#021a3a', '#035e7b', '#11b5a4', '#9ff7e0', '#ffffff'],
    aurora:   ['#01030a', '#0b2a3c', '#087f5b', '#63e6be', '#d0bfff', '#ffffff'],
    glacier:  ['#000308', '#0a2540', '#1971c2', '#74c0fc', '#e7f5ff', '#ffffff'],
    opal:     ['#05040a', '#23395b', '#406e8e', '#8ea8c3', '#cbf7ed', '#ffffff'],
    tidepool: ['#000204', '#06263a', '#1b6c8c', '#e9a03b', '#fbe3b0', '#ffffff'],
    reef:     ['#020006', '#1d0b3a', '#0f6f8f', '#2ec4b6', '#ff9f1c', '#fff1d6'],
    verdant:  ['#000400', '#0b2a14', '#2b8a3e', '#a9e34b', '#f4fce3', '#ffffff'],
    nebula:   ['#020008', '#2a0a4a', '#7b2cbf', '#e0529c', '#ffb86b', '#fff4e0']
  };
  var PAL_NAMES = Object.keys(PALETTES);
  var PAL_WEIGHT = { abyss: 3, aurora: 3, glacier: 2, opal: 2, tidepool: 2, reef: 2, verdant: 1, nebula: 1 };
  function pickPalette(r) {
    var total = 0, k;
    for (k in PAL_WEIGHT) total += PAL_WEIGHT[k];
    var x = r() * total;
    for (k in PAL_WEIGHT) { x -= PAL_WEIGHT[k]; if (x <= 0) return k; }
    return PAL_NAMES[0];
  }
  function palette(name) {
    var out = [];
    PALETTES[name].forEach(function (h) {
      for (var i = 1; i < 7; i += 2) out.push(Math.pow(parseInt(h.substr(i, 2), 16) / 255, 2.2));
    });
    return out;
  }

  // ------------------------------------------------------------------ GLSL
  var HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
  var FULL_VS = HEAD +
    'out vec2 vUv;\n' +
    'void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));' +
    ' vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n';

  var COMMON = [
    'const float PI = 3.14159265359;',
    'const float TAU = 6.28318530718;',
    'uint pcg(uint v) { uint st = v * 747796405u + 2891336453u;',
    '  uint w = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u; return (w >> 22u) ^ w; }',
    'float rnd(inout uint s) { s = pcg(s); return float(s) * (1.0 / 4294967296.0); }',
    'float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z); }',
    'vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }',
    'vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }',
    // Simplex 3D noise (Ashima Arts / Stefan Gustavson, MIT)
    'float snoise(vec3 v) {',
    '  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);',
    '  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);',
    '  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g;',
    '  vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);',
    '  vec3 x1 = x0 - i1 + C.xxx; vec3 x2 = x0 - i2 + C.yyy; vec3 x3 = x0 - D.yyy;',
    '  i = mod289(i);',
    '  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0))',
    '           + i.x + vec4(0.0, i1.x, i2.x, 1.0));',
    '  float n_ = 0.142857142857; vec3 ns = n_ * D.wyz - D.xzx;',
    '  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);',
    '  vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);',
    '  vec4 x = x_ * ns.x + ns.yyyy; vec4 y = y_ * ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);',
    '  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);',
    '  vec4 s0 = floor(b0) * 2.0 + 1.0; vec4 s1 = floor(b1) * 2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));',
    '  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;',
    '  vec3 p0 = vec3(a0.xy, h.x); vec3 p1 = vec3(a0.zw, h.y); vec3 p2 = vec3(a1.xy, h.z); vec3 p3 = vec3(a1.zw, h.w);',
    '  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));',
    '  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;',
    '  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0); m = m * m;',
    '  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3))); }',
    'float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }',
    'float vfbm(vec2 p, int oct) { float a = 0.5, s = 0.0; mat2 r = mat2(0.8, 0.6, -0.6, 0.8);',
    '  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise(p); p = r * p * 2.03 + 17.1; a *= 0.5; }',
    '  return s; }',
    'vec3 safe(vec3 c) { return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : min(c, vec3(256.0)); }',
    'mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }',
    ''
  ].join('\n');

  var PAL = [
    'uniform vec3 uPal[6];',
    'vec3 pal(float x) { x = clamp(x, 0.0, 1.0) * 5.0; int i = min(int(x), 4); float f = x - float(i);',
    '  f = f * f * (3.0 - 2.0 * f); return mix(uPal[i], uPal[i + 1], f); }',
    ''
  ].join('\n');

  function frag(body, withPal) {
    return HEAD + COMMON + (withPal ? PAL : '') + 'in vec2 vUv;\nout vec4 fragColor;\n' + body;
  }

  // ------------------------------------------------------------- GL helpers
  function Program(vs, fs) {
    var p = gl.createProgram();
    [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].forEach(function (pair) {
      var s = gl.createShader(pair[0]);
      gl.shaderSource(s, pair[1]);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost())
        throw new Error('aether-bg shader: ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    });
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
      throw new Error('aether-bg link: ' + gl.getProgramInfoLog(p));
    this.p = p;
    this.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      this.u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
  }
  Program.prototype.use = function (vals) {
    gl.useProgram(this.p);
    if (vals) this.set(vals);
    return this;
  };
  Program.prototype.set = function (vals) {
    for (var k in vals) {
      var u = this.u[k];
      if (!u) continue;
      var v = vals[k];
      switch (u.type) {
        case gl.FLOAT: if (u.size > 1) gl.uniform1fv(u.loc, v); else gl.uniform1f(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.INT_VEC2: gl.uniform2iv(u.loc, v); break;
        case gl.UNSIGNED_INT: gl.uniform1ui(u.loc, v >>> 0); break;
        default: gl.uniform1i(u.loc, v); break;   // int, bool, samplers
      }
    }
    return this;
  };
  function program(key, fs, vs) {
    if (!programs[key]) programs[key] = new Program(vs || FULL_VS, fs);
    return programs[key];
  }

  function Target(w, h, fmt, filter, wrap) {
    this.w = w; this.h = h;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.i, w, h, 0, fmt.f, fmt.t, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    this.ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  Target.prototype.bind = function () {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
  };
  Target.prototype.release = function () {
    gl.deleteFramebuffer(this.fbo);
    gl.deleteTexture(this.tex);
  };
  function tex(unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex || t);
    return unit;
  }
  function fullscreen() { gl.drawArrays(gl.TRIANGLES, 0, 3); }

  // ------------------------------------------------------------ scene base
  function Scene(r, w, h) {
    this.r = r; this.w = w; this.h = h; this.t = 0; this.aspect = w / h;
    this.palName = pickPalette(r);
    this.pal = palette(this.palName);
    this.targets = [];
    this.out = this.keep(new Target(w, h, F16));
  }
  Scene.prototype.keep = function (t) { this.targets.push(t); return t; };
  Scene.prototype.update = function (dt) { this.t += dt; this.step(dt); };
  Scene.prototype.render = function () { this.draw(); return this.out; };
  Scene.prototype.release = function () { this.targets.forEach(function (t) { t.release(); }); };
  Scene.prototype.step = function () {};
  function extend(Ctor, name, weight, setup) {
    Ctor.prototype = Object.create(Scene.prototype);
    Ctor.prototype.constructor = Ctor;
    Ctor.sceneName = name;
    Ctor.weight = weight;
    return Ctor;
  }

  // ---------------------------------------------------------------- Nebula
  var NEBULA_FS = frag([
    'uniform float uTime, uAspect, uScale, uWarp, uRot, uStarDensity;',
    'uniform vec2 uDrift;',
    'float stars(vec2 p, float dens) {',
    '  vec2 i = floor(p), f = fract(p); float h = hash12(i); if (h > dens) return 0.0;',
    '  vec2 c = vec2(hash12(i + 3.1), hash12(i + 7.7)) * 0.8 + 0.1; float d = length(f - c);',
    '  float tw = 0.6 + 0.4 * sin(uTime * (0.5 + 2.0 * hash12(i + 1.3)) + h * 50.0);',
    '  return exp(-d * d * 900.0) * tw * (0.3 + 2.0 * hash12(i + 9.1)); }',
    'void main() {',
    '  vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);',
    '  vec2 p = rot2(uRot) * uv * uScale + uDrift; float t = uTime * 0.015;',
    '  vec2 q = vec2(vfbm(p + vec2(0.0, t), 5), vfbm(p + vec2(5.2, 1.3) - t, 5));',
    '  vec2 r = vec2(vfbm(p + uWarp * q + vec2(1.7, 9.2) + 0.15 * t, 5), vfbm(p + uWarp * q + vec2(8.3, 2.8) + 0.126 * t, 5));',
    '  float f = vfbm(p + uWarp * r, 5);',
    '  float dens = smoothstep(0.35, 1.05, f * f * 1.6 + 0.25 * length(q));',
    '  float x = clamp(dens * 0.75 + 0.25 * r.x, 0.0, 1.0);',
    '  vec3 gas = pal(x * 0.9) * (0.03 + 0.75 * dens * dens);',
    '  float dust = smoothstep(0.45, 0.75, vfbm(p * 1.8 + 3.0 * r + 11.0, 4)); gas *= 1.0 - 0.7 * dust;',
    '  gas += pal(0.92) * pow(smoothstep(0.7, 1.0, f * dens + 0.2), 4.0) * 0.5;',
    '  vec2 sp = uv * 220.0 + uDrift * 40.0;',
    '  float st = stars(sp, uStarDensity) + 0.6 * stars(sp * 0.55 + 13.0, uStarDensity * 0.8);',
    '  fragColor = vec4(gas + vec3(0.85, 0.9, 1.0) * st * (1.0 - 0.8 * dens), 1.0); }'
  ].join('\n'), true);

  var Nebula = extend(function Nebula(r, w, h) {
    Scene.call(this, r, w, h);
    this.scale = new Drift(r, 1.4, 2.6, [25, 50]);
    this.warp = new Drift(r, 3.0, 5.0, [25, 50]);
    this.rotSpeed = r.sign() * r.uniform(0.004, 0.012);
    this.vel = [r.uniform(-0.02, 0.02), r.uniform(-0.02, 0.02)];
    this.origin = [r.uniform(-50, 50), r.uniform(-50, 50)];
    this.stars = r.uniform(0.04, 0.09);
    this.duration = [55, 90];
  }, 'Nebula', 0.6);
  Nebula.prototype.step = function (dt) { this.scale.update(dt); this.warp.update(dt); };
  Nebula.prototype.draw = function () {
    this.out.bind();
    program('nebula', NEBULA_FS).use({
      uTime: this.t, uAspect: this.aspect, uScale: this.scale.value, uWarp: this.warp.value,
      uRot: this.t * this.rotSpeed, uStarDensity: this.stars, uPal: this.pal,
      uDrift: [this.origin[0] + this.vel[0] * this.t, this.origin[1] + this.vel[1] * this.t]
    });
    fullscreen();
  };

  // ----------------------------------------------------------------- Julia
  var JULIA_FS = frag([
    'uniform vec2 uC;',
    'uniform float uZoom, uRot, uAspect, uPx, uTrapR, uInterior;',
    'uniform int uMaxIter;',
    'vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }',
    'vec3 sampleAt(vec2 uv) {',
    '  vec2 z = rot2(uRot) * uv * uZoom; vec2 dz = vec2(1.0, 0.0);',
    '  float trap = 1e9, m2 = 0.0; int i;',
    '  for (i = 0; i < uMaxIter; i++) {',
    '    dz = 2.0 * cmul(z, dz); z = cmul(z, z) + uC; m2 = dot(z, z);',
    '    trap = min(trap, abs(length(z) - uTrapR)); if (m2 > 1024.0) break; }',
    '  if (i >= uMaxIter) { float g = exp(-trap * 6.0); return pal(0.25 + 0.5 * g) * (0.04 + 0.5 * g * g) * uInterior; }',
    '  float sn = float(i) - log2(log2(m2)) + 4.0;',
    '  float d = 0.5 * sqrt(m2) * log(m2) / max(length(dz), 1e-9);',
    '  float edge = exp(-d / (uPx * 2.5)); float halo = exp(-d / (uPx * 10.0));',
    '  float band = 1.0 - exp(-sn * 0.035);',
    '  vec3 col = pal(0.12 + 0.55 * band) * (0.12 + 0.35 * band);',
    '  col += pal(0.55 + 0.35 * band) * halo * 0.35; col += pal(0.9) * edge * 0.9; return col; }',
    'void main() {',
    '  vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0); vec2 o = vec2(0.25, -0.25) * uPx / uZoom;',
    '  fragColor = vec4((sampleAt(uv + o) + sampleAt(uv - o)) * 0.5, 1.0); }'
  ].join('\n'), true);

  var Julia = extend(function Julia(r, w, h) {
    Scene.call(this, r, w, h);
    this.path = r.choice(['cardioid', 'cardioid', 'cardioid', 'bulb']);
    this.theta = r.uniform(0, Math.PI * 2);
    this.omega = r.sign() * r.uniform(0.006, 0.014);
    this.radial = new Drift(r, 0.975, 1.012, [12, 30]);
    this.zoom = new Drift(r, 2.4, 3.4, [20, 45]);
    this.rotSpeed = r.sign() * r.uniform(0.006, 0.02);
    this.trap = new Drift(r, 0.2, 1.0, [20, 40]);
    this.interior = r.uniform(0.25, 0.55);
    this.duration = [40, 70];
  }, 'Julia', 0.9);
  Julia.prototype.c = function () {
    var th = this.theta, k = this.radial.value;
    if (this.path === 'cardioid') {
      var cx = 0.5 * Math.cos(th) - 0.25 * Math.cos(2 * th), cy = 0.5 * Math.sin(th) - 0.25 * Math.sin(2 * th);
      return [0.25 + (cx - 0.25) * k, cy * k];
    }
    return [-1 + 0.25 * k * Math.cos(th), 0.25 * k * Math.sin(th)];
  };
  Julia.prototype.step = function (dt) {
    this.radial.update(dt); this.zoom.update(dt); this.trap.update(dt);
    this.theta += this.omega * dt;
  };
  Julia.prototype.draw = function () {
    this.out.bind();
    var z = this.zoom.value;
    program('julia', JULIA_FS).use({
      uC: this.c(), uZoom: z, uRot: this.t * this.rotSpeed, uAspect: this.aspect, uPx: z / this.h,
      uTrapR: this.trap.value, uInterior: this.interior, uMaxIter: 140, uPal: this.pal
    });
    fullscreen();
  };

  // -------------------------------------------------------------- Reaction
  var REGIMES = {
    coral: [0.0545, 0.062], mitosis: [0.0367, 0.0649], worms: [0.046, 0.063], maze: [0.029, 0.057],
    holes: [0.039, 0.058], solitons: [0.030, 0.062], spirals: [0.014, 0.045], fingerprint: [0.037, 0.060],
    pulsing: [0.025, 0.060]
  };
  var RD_INIT_FS = frag([
    'uniform vec2 uSize; uniform float uSeed; uniform int uMode;',
    'void main() {',
    '  vec2 p = floor(gl_FragCoord.xy); vec2 uv = p / uSize; vec2 c = (p - uSize * 0.5) / uSize.y; float b = 0.0;',
    '  if (uMode == 0) { float n = snoise(vec3(uv * vec2(uSize.x / uSize.y, 1.0) * 9.0, uSeed)); b = n > 0.45 ? 0.7 : 0.0; }',
    '  else if (uMode == 1) { b = abs(length(c) - 0.28) < 0.012 ? 0.7 : 0.0; }',
    '  else { b = length(c) < 0.04 ? 0.7 : 0.0; if (hash12(p + uSeed) > 0.9993) b = 0.7; }',
    '  fragColor = vec4(1.0, b, 0.0, 0.0); }'
  ].join('\n'));
  var RD_STEP_FS = frag([
    'uniform sampler2D uSrc; uniform vec2 uFK, uFK2; uniform float uVarScale, uTime; uniform vec4 uSeedPt;',
    'void main() {',
    '  ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uSrc, 0);',
    '  #define S(dx, dy) texelFetch(uSrc, (p + ivec2(dx, dy) + sz) % sz, 0).xy',
    '  vec2 c = S(0, 0);',
    '  vec2 lap = -c + 0.2 * (S(1, 0) + S(-1, 0) + S(0, 1) + S(0, -1)) + 0.05 * (S(1, 1) + S(-1, 1) + S(1, -1) + S(-1, -1));',
    '  vec2 q = vec2(p) / float(sz.y) * uVarScale;',
    '  float m = smoothstep(-0.35, 0.35, snoise(vec3(q, uTime * 0.01))); vec2 fk = mix(uFK, uFK2, m);',
    '  float a = c.x, b = c.y; float abb = a * b * b;',
    '  a += (lap.x - abb + fk.x * (1.0 - a)); b += (0.5 * lap.y + abb - (fk.y + fk.x) * b);',
    '  if (uSeedPt.w > 0.5) { vec2 d = vec2(p) - uSeedPt.xy; if (dot(d, d) < uSeedPt.z * uSeedPt.z) { b = max(b, 0.6); a = min(a, 0.4); } }',
    '  fragColor = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 0.0); }'
  ].join('\n'));
  var RD_SHOW_FS = frag([
    'uniform sampler2D uState; uniform vec3 uLight; uniform float uRelief;',
    'float B(ivec2 p, ivec2 sz) { return texelFetch(uState, clamp(p, ivec2(0), sz - 1), 0).y; }',
    'void main() {',
    '  ivec2 sz = textureSize(uState, 0); ivec2 p = ivec2(vUv * vec2(sz));',
    '  float b = B(p, sz), bl = B(p - ivec2(1, 0), sz), br = B(p + ivec2(1, 0), sz);',
    '  float bd = B(p - ivec2(0, 1), sz), bu = B(p + ivec2(0, 1), sz);',
    '  vec3 n = normalize(vec3((bl - br) * uRelief, (bd - bu) * uRelief, 1.0)); vec3 L = normalize(uLight);',
    '  float diff = max(dot(n, L), 0.0); vec3 H = normalize(L + vec3(0, 0, 1));',
    '  float spec = pow(max(dot(n, H), 0.0), 60.0); float x = smoothstep(0.05, 0.42, b);',
    '  vec3 col = pal(0.04 + 0.8 * x) * (0.12 + diff) + pal(0.97) * spec * (0.25 + 0.9 * x);',
    '  col += pal(0.85) * pow(x, 6.0) * 0.6;',
    '  fragColor = vec4(col * 0.6, 1.0); }'
  ].join('\n'), true);

  var Reaction = extend(function Reaction(r, w, h) {
    Scene.call(this, r, w, h);
    this.a = this.keep(new Target(w, h, F32, gl.NEAREST));
    this.b = this.keep(new Target(w, h, F32, gl.NEAREST));
    var names = Object.keys(REGIMES).sort(function () { return r() - 0.5; });
    var wps = names.map(function (n) { return REGIMES[n]; });
    this.fk = new Drift(r, 0, 0, [30, 60], wps[0], wps);
    this.fk2 = new Drift(r, 0, 0, [30, 60], wps[1], wps);
    this.varScale = r.uniform(0.8, 2.0);
    this.relief = r.uniform(5, 9);
    this.lightSpeed = r.sign() * r.uniform(0.05, 0.12);
    this.nextSeed = r.uniform(6, 14);
    this.duration = [60, 100];
    this.b.bind();
    program('rd.init', RD_INIT_FS).use({ uSize: [w, h], uSeed: r.uniform(0, 1000), uMode: r.choice([0, 0, 0, 1, 2]) });
    fullscreen();
    this.swap();
  }, 'Reaction', 1.0);
  Reaction.prototype.swap = function () { var t = this.a; this.a = this.b; this.b = t; };
  Reaction.prototype.step = function (dt) {
    this.fk.update(dt); this.fk2.update(dt);
    var seed = [0, 0, 0, 0];
    if (this.t > this.nextSeed) {
      this.nextSeed = this.t + this.r.uniform(7, 16);
      seed = [this.r.uniform(0, this.w), this.r.uniform(0, this.h), this.r.uniform(3, 7), 1];
    }
    var n = Math.max(1, Math.round(12 * Math.min(2, dt * 30)));
    var p = program('rd.step', RD_STEP_FS).use({ uFK: this.fk.value, uFK2: this.fk2.value, uVarScale: this.varScale, uTime: this.t });
    for (var i = 0; i < n; i++) {
      this.b.bind();
      p.set({ uSrc: tex(0, this.a), uSeedPt: i === 0 ? seed : [0, 0, 0, 0] });
      fullscreen();
      this.swap();
    }
  };
  Reaction.prototype.draw = function () {
    this.out.bind();
    var la = this.t * this.lightSpeed;
    program('rd.show', RD_SHOW_FS).use({
      uState: tex(0, this.a), uLight: [Math.cos(la), Math.sin(la), 0.9], uRelief: this.relief, uPal: this.pal
    });
    fullscreen();
  };

  // -------------------------------------------------------------- Physarum
  var PH_INIT_FS = frag([
    'uniform vec2 uSize; uniform uint uSeed; uniform int uPattern, uSpecies; uniform int uAW;',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy); uint i = uint(c.y * uAW + c.x);',
    '  uint s = pcg(i * 2654435761u + uSeed); float sp = float(int(i) % uSpecies);',
    '  vec2 ctr = uSize * 0.5; float R = min(uSize.x, uSize.y); vec2 p; float h;',
    '  if (uPattern == 0) { p = vec2(rnd(s), rnd(s)) * uSize; h = rnd(s) * TAU; }',
    '  else if (uPattern == 1) { float a = rnd(s) * TAU, r = sqrt(rnd(s)) * R * 0.12; p = ctr + r * vec2(cos(a), sin(a)); h = a; }',
    '  else if (uPattern == 2) { float a = rnd(s) * TAU, r = R * (0.36 + 0.04 * rnd(s)); p = ctr + r * vec2(cos(a), sin(a)); h = a + PI; }',
    '  else { float a = (sp + rnd(s)) / float(uSpecies) * TAU, r = sqrt(rnd(s)) * R * 0.42; p = ctr + r * vec2(cos(a), sin(a)); h = rnd(s) * TAU; }',
    '  fragColor = vec4(p, h, sp); }'
  ].join('\n'));
  var PH_AGENT_FS = frag([
    'uniform sampler2D uAgents, uTrail; uniform vec2 uSize; uniform uint uSeed, uFrame; uniform int uAW;',
    'uniform vec4 uSA, uRA, uSD, uSpeed; uniform float uRepel, uStepScale;',
    'float sense(vec2 p, vec4 mask) { return dot(texture(uTrail, p / uSize), mask); }',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uAgents, c, 0);',
    '  int s = int(a.w + 0.5); vec4 sel = vec4(equal(ivec4(s), ivec4(0, 1, 2, 3)));',
    '  vec4 mask = mix(vec4(-uRepel, -uRepel, -uRepel, 0.0), vec4(1.0), sel);',
    '  float sa = dot(uSA, sel), ra = dot(uRA, sel), sd = dot(uSD, sel), spd = dot(uSpeed, sel);',
    '  vec2 pos = a.xy; float h = a.z;',
    '  float f = sense(pos + sd * vec2(cos(h), sin(h)), mask);',
    '  float l = sense(pos + sd * vec2(cos(h + sa), sin(h + sa)), mask);',
    '  float r = sense(pos + sd * vec2(cos(h - sa), sin(h - sa)), mask);',
    '  uint seed = pcg(uint(c.y * uAW + c.x) ^ (uFrame * 2654435761u) ^ uSeed); float rn = rnd(seed);',
    '  if (f >= l && f >= r) {} else if (f < l && f < r) { h += (rn - 0.5) * 2.0 * ra; }',
    '  else if (l > r) { h += ra * (0.7 + 0.3 * rn); } else { h -= ra * (0.7 + 0.3 * rn); }',
    '  h = mod(h, TAU); pos = mod(pos + spd * uStepScale * vec2(cos(h), sin(h)), uSize);',
    '  fragColor = vec4(pos, h, a.w); }'
  ].join('\n'));
  var PH_DEPOSIT_VS = HEAD + [
    'uniform sampler2D uAgents; uniform int uAW; uniform vec2 uSize;',
    'flat out int vS;',
    'void main() {',
    '  vec4 a = texelFetch(uAgents, ivec2(gl_VertexID % uAW, gl_VertexID / uAW), 0);',
    '  vS = int(a.w + 0.5); gl_Position = vec4((floor(a.xy) + 0.5) / uSize * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = 1.0; }'
  ].join('\n');
  var PH_DEPOSIT_FS = HEAD + [
    'flat in int vS; uniform float uDeposit; out vec4 fragColor;',
    'void main() { fragColor = vec4(equal(ivec4(vS), ivec4(0, 1, 2, 3))) * uDeposit; }'
  ].join('\n');
  var PH_DIFFUSE_FS = frag([
    'uniform sampler2D uSrc; uniform float uDiffuse, uDecay;',
    'void main() {',
    '  ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uSrc, 0); vec4 sum = vec4(0.0);',
    '  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) sum += texelFetch(uSrc, (p + ivec2(x, y) + sz) % sz, 0);',
    '  vec4 c = texelFetch(uSrc, p, 0);',
    '  fragColor = min(mix(c, sum / 9.0, uDiffuse) * uDecay, vec4(60.0)); }'
  ].join('\n'));
  var PH_SHOW_FS = frag([
    'uniform sampler2D uTrail; uniform int uSpecies; uniform vec3 uHue; uniform float uGain; uniform vec2 uTexel;',
    'void main() {',
    '  vec4 t = texture(uTrail, vUv) * uGain;',
    '  float tl = dot(texture(uTrail, vUv - uTexel).rgb, vec3(1.0)); float tr = dot(texture(uTrail, vUv + uTexel).rgb, vec3(1.0));',
    '  float light = clamp(1.0 + (tr - tl) * 0.04 * uGain, 0.6, 1.5); vec3 col = vec3(0.0);',
    '  for (int s = 0; s < 3; s++) { if (s >= uSpecies) break;',
    '    float v = dot(t, vec4(equal(ivec4(s), ivec4(0, 1, 2, 3)))); float x = 1.0 - exp(-v * 0.55);',
    '    col += pal(x * uHue[s]) * (0.2 + 1.3 * x * x * x); }',
    '  fragColor = vec4(col * light * 0.6, 1.0); }'
  ].join('\n'), true);

  var Physarum = extend(function Physarum(r, w, h) {
    Scene.call(this, r, w, h);
    this.species = r.choice([1, 1, 2, 3, 3]);
    this.aw = 256;
    this.ah = Math.max(64, Math.min(1024, Math.round(w * h * 0.45 / this.aw)));
    this.count = this.aw * this.ah;
    this.scale = h / 540;
    this.agA = this.keep(new Target(this.aw, this.ah, F32, gl.NEAREST));
    this.agB = this.keep(new Target(this.aw, this.ah, F32, gl.NEAREST));
    this.trA = this.keep(new Target(w, h, F16, gl.LINEAR, gl.REPEAT));
    this.trB = this.keep(new Target(w, h, F16, gl.LINEAR, gl.REPEAT));
    this.frame = 0;
    this.seed = r.bits();
    var D = function (lo, hi) { return [0, 1, 2].map(function () { return new Drift(r, lo, hi, [20, 50]); }); };
    this.sa = D(15, 60); this.ra = D(12, 50); this.sd = D(5, 17); this.sp = D(0.8, 1.6);
    this.decay = new Drift(r, 0.86, 0.94, [25, 60]);
    this.diffuse = r.uniform(0.3, 0.9);
    this.repel = r.uniform(0.4, 1.2);
    var hues = [r.uniform(0.78, 0.9), r.uniform(0.5, 0.65), r.uniform(0.66, 0.78)].sort(function () { return r() - 0.5; });
    this.hues = this.species > 1 ? hues : [0.92, 0.92, 0.92];
    this.duration = [50, 85];
    this.agB.bind();
    program('ph.init', PH_INIT_FS).use({
      uSize: [w, h], uSeed: this.seed, uPattern: r.choice(this.species > 1 ? [0, 1, 2, 2, 3] : [0, 1, 2, 2]),
      uSpecies: this.species, uAW: this.aw
    });
    fullscreen();
    var t = this.agA; this.agA = this.agB; this.agB = t;
  }, 'Physarum', 1.1);
  Physarum.prototype.vec = function (ds, f) { return [ds[0].value * f, ds[1].value * f, ds[2].value * f, 0]; };
  Physarum.prototype.step = function (dt) {
    [this.sa, this.ra, this.sd, this.sp].forEach(function (g) { g.forEach(function (d) { d.update(dt); }); });
    this.decay.update(dt);
    var deg = Math.PI / 180, t;
    // move agents
    this.agB.bind();
    program('ph.agent', PH_AGENT_FS).use({
      uAgents: tex(0, this.agA), uTrail: tex(1, this.trA), uSize: [this.w, this.h], uSeed: this.seed,
      uFrame: this.frame, uAW: this.aw, uSA: this.vec(this.sa, deg), uRA: this.vec(this.ra, deg),
      uSD: this.vec(this.sd, this.scale), uSpeed: this.vec(this.sp, 1), uRepel: this.repel,
      uStepScale: this.scale * Math.min(2, dt * 30)
    });
    fullscreen();
    t = this.agA; this.agA = this.agB; this.agB = t;
    // deposit
    this.trA.bind();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    program('ph.deposit', PH_DEPOSIT_FS, PH_DEPOSIT_VS).use({ uAgents: tex(0, this.agA), uAW: this.aw, uSize: [this.w, this.h], uDeposit: 1 });
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
    // diffuse + decay
    this.trB.bind();
    program('ph.diffuse', PH_DIFFUSE_FS).use({ uSrc: tex(0, this.trA), uDiffuse: this.diffuse, uDecay: Math.pow(this.decay.value, dt * 30) });
    fullscreen();
    t = this.trA; this.trA = this.trB; this.trB = t;
    this.frame++;
  };
  Physarum.prototype.draw = function () {
    this.out.bind();
    program('ph.show', PH_SHOW_FS).use({
      uTrail: tex(0, this.trA), uSpecies: this.species, uHue: this.hues, uPal: this.pal,
      uGain: 0.35 / Math.max(0.5, (1 - this.decay.value) * 20), uTexel: [1 / this.w, 1 / this.h]
    });
    fullscreen();
  };

  // ------------------------------------------------------------- Attractor
  function clifford(p, x, y) { return [Math.sin(p[0] * y) + p[2] * Math.cos(p[0] * x), Math.sin(p[1] * x) + p[3] * Math.cos(p[1] * y)]; }
  function dejong(p, x, y) { return [Math.sin(p[0] * y) - Math.cos(p[1] * x), Math.sin(p[2] * x) - Math.cos(p[3] * y)]; }
  function frameOf(kind, p, n) {
    n = n || 2500;
    var f = kind === 0 ? clifford : dejong, x = 0.1, y = 0.1, cells = new Set();
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var i = 0; i < n; i++) {
      var q = f(p, x, y); x = q[0]; y = q[1];
      if (i > 50) {
        cells.add(Math.trunc(x * 10) * 1000 + Math.trunc(y * 10));
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return [cells.size / n, (x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0, 0.2) / 2];
  }
  function interesting(kind, p, n) { var r = frameOf(kind, p, n)[0]; return r > 0.14 && r < 0.42; }

  var AT_VS = HEAD + COMMON + [
    'uniform int uType, uSym; uniform vec4 uP; uniform float uScale, uRot; uniform vec2 uCenter, uSize;',
    'uniform uint uSeed, uFrame;',
    'vec2 mapf(vec2 p) {',
    '  if (uType == 0) return vec2(sin(uP.x * p.y) + uP.z * cos(uP.x * p.x), sin(uP.y * p.x) + uP.w * cos(uP.y * p.y));',
    '  return vec2(sin(uP.x * p.y) - cos(uP.y * p.x), sin(uP.z * p.x) - cos(uP.w * p.y)); }',
    'void main() {',
    '  uint s = pcg(uint(gl_VertexID) * 747796405u ^ uFrame * 2891336453u ^ uSeed);',
    '  vec2 p = vec2(rnd(s), rnd(s)) * 2.0 - 1.0; int n = 18 + int(rnd(s) * 10.0);',
    '  for (int k = 0; k < 28; k++) { if (k >= n) break; p = mapf(p); }',
    '  vec2 v = p; if (uSym > 1) v = rot2(TAU * floor(rnd(s) * float(uSym)) / float(uSym)) * v;',
    '  v = rot2(uRot) * (v - uCenter) * uScale;',
    '  vec2 px = v * 0.5 * uSize.y + uSize * 0.5;',
    '  gl_Position = vec4(px / uSize * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = 1.0; }'
  ].join('\n');
  var AT_PLOT_FS = HEAD + 'out vec4 fragColor;\nvoid main() { fragColor = vec4(1.0, 0.0, 0.0, 1.0); }';
  var ZERO_FS = HEAD + 'out vec4 fragColor;\nvoid main() { fragColor = vec4(0.0); }';
  var AT_SHOW_FS = frag([
    'uniform sampler2D uCount; uniform float uRef, uGlow;',
    'float C(ivec2 p, ivec2 sz) { return texelFetch(uCount, clamp(p, ivec2(0), sz - 1), 0).x; }',
    'void main() {',
    '  ivec2 sz = textureSize(uCount, 0); ivec2 p = ivec2(vUv * vec2(sz));',
    '  float cs = C(p, sz) * 4.0 + C(p + ivec2(1, 0), sz) + C(p - ivec2(1, 0), sz) + C(p + ivec2(0, 1), sz) + C(p - ivec2(0, 1), sz);',
    '  cs /= 8.0; float v = clamp(log(1.0 + cs) / log(1.0 + uRef), 0.0, 1.2);',
    '  fragColor = vec4(pal(clamp(v * 0.95, 0.0, 1.0)) * (0.15 + v * v * uGlow), 1.0); }'
  ].join('\n'), true);

  var Attractor = extend(function Attractor(r, w, h) {
    Scene.call(this, r, w, h);
    this.kind = r.choice([0, 0, 1]);
    this.sym = r.choice([1, 1, 1, 1, 2, 3, 4, 6]);
    this.n = Math.max(1 << 16, Math.min(1 << 19, Math.round(w * h * 0.7)));
    this.density = this.keep(new Target(w, h, F16, gl.NEAREST));
    this.seed = r.bits();
    this.frame = 0;
    this.pCur = this.pick();
    this.pNext = this.neighbour(this.pCur);
    this.fCur = frameOf(this.kind, this.pCur).slice(1);
    this.fNext = frameOf(this.kind, this.pNext).slice(1);
    this.u = 0;
    this.leg = r.uniform(14, 26);
    this.keepD = new Drift(r, 0.88, 0.95, [20, 40]);
    this.rotSpeed = r.sign() * r.uniform(0.004, 0.015);
    this.zoom = new Drift(r, 0.92, 1.15, [20, 40]);
    this.expected = 1;
    this.duration = [40, 70];
  }, 'Attractor', 1.0);
  Attractor.prototype.pick = function () {
    var r = this.r;
    for (var i = 0; i < 200; i++) {
      var p = this.kind === 0
        ? [r.uniform(-2.2, 2.2), r.uniform(-2.2, 2.2), r.uniform(-1.4, 1.4), r.uniform(-1.4, 1.4)]
        : [r.uniform(-3, 3), r.uniform(-3, 3), r.uniform(-3, 3), r.uniform(-3, 3)];
      if (interesting(this.kind, p)) return p;
    }
    return [-1.4, 1.6, 1.0, 0.7];
  };
  Attractor.prototype.neighbour = function (p) {
    var r = this.r, steps = [0.45, 0.3, 0.18, 0.1];
    for (var s = 0; s < steps.length; s++) {
      for (var i = 0; i < 12; i++) {
        var q = p.map(function (x) { return x + r.uniform(-steps[s], steps[s]); });
        var mid = p.map(function (x, j) { return (x + q[j]) / 2; });
        if (interesting(this.kind, q, 1200) && interesting(this.kind, mid, 1200)) return q;
      }
    }
    return this.pick();
  };
  Attractor.prototype.step = function (dt) {
    this.u = Math.min(1, this.u + dt / this.leg);
    if (this.u >= 1) {
      this.pCur = this.pNext; this.fCur = this.fNext;
      this.pNext = this.neighbour(this.pCur);
      this.fNext = frameOf(this.kind, this.pNext).slice(1);
      this.u = 0; this.leg = this.r.uniform(14, 26);
    }
    var e = smooth(this.u), a = this.pCur, b = this.pNext, fa = this.fCur, fb = this.fNext;
    var p = a.map(function (x, i) { return x + (b[i] - x) * e; });
    var cx = fa[0] + (fb[0] - fa[0]) * e, cy = fa[1] + (fb[1] - fa[1]) * e, ext = fa[2] + (fb[2] - fa[2]) * e;
    this.keepD.update(dt); this.zoom.update(dt);
    if (this.sym > 1) { ext = Math.hypot(Math.abs(cx) + ext, Math.abs(cy) + ext) * 0.98; cx = 0; cy = 0; }
    var keep = Math.pow(this.keepD.value, dt * 30);
    this.density.bind();
    gl.enable(gl.BLEND);
    // fade what is there ...
    gl.blendFunc(gl.ZERO, gl.CONSTANT_ALPHA);
    gl.blendColor(0, 0, 0, keep);
    program('zero', ZERO_FS).use();
    fullscreen();
    // ... and pile new points on top
    gl.blendFunc(gl.ONE, gl.ONE);
    var n = Math.round(this.n * Math.min(2, dt * 30));
    program('at.plot', AT_PLOT_FS, AT_VS).use({
      uType: this.kind, uSym: this.sym, uP: p, uScale: 0.86 / ext * this.zoom.value, uCenter: [cx, cy],
      uRot: this.t * this.rotSpeed, uSize: [this.w, this.h], uSeed: this.seed, uFrame: this.frame
    });
    gl.drawArrays(gl.POINTS, 0, n);
    gl.disable(gl.BLEND);
    this.frame++;
    this.expected = n / (this.w * this.h) / Math.max(0.02, 1 - keep);
  };
  Attractor.prototype.draw = function () {
    this.out.bind();
    program('at.show', AT_SHOW_FS).use({ uCount: tex(0, this.density), uRef: Math.max(4, this.expected * 4), uGlow: 1.15, uPal: this.pal });
    fullscreen();
  };

  // ---------------------------------------------------------------- engine
  var DISSOLVE_FS = frag([
    'uniform sampler2D uA, uB; uniform float uP, uSeed, uAspect;',
    'void main() {',
    '  vec3 a = safe(texture(uA, vUv).rgb), b = safe(texture(uB, vUv).rgb);',
    '  float n = vfbm(vUv * vec2(uAspect, 1.0) * 1.7 + uSeed, 5); n = clamp((n - 0.2) / 0.6, 0.0, 1.0);',
    '  const float w = 0.22; float t = uP * (1.0 + 2.0 * w) - w; float m = smoothstep(n - w, n + w, t);',
    '  fragColor = vec4(mix(a, b, m) * (1.0 - 0.18 * sin(uP * PI)), 1.0); }'
  ].join('\n'));
  var FINAL_FS = frag([
    'uniform sampler2D uSrc; uniform float uZoom, uExposure, uStrength, uDark, uTime; uniform vec2 uShift; uniform vec3 uPaper;',
    'vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    'void main() {',
    '  vec2 uv = vec2((vUv.x - 0.5) / uZoom + 0.5, vUv.y / uZoom) + uShift;',
    '  vec3 col = safe(texture(uSrc, uv).rgb) * uExposure;',
    '  vec2 v = vUv - 0.5; col *= 1.0 - dot(v, v) * 0.55;',
    '  vec3 g = pow(aces(col), vec3(1.0 / 2.2));',
    // dark theme: the glow lights up the paper (screen blend)
    '  vec3 dark = 1.0 - (1.0 - uPaper) * (1.0 - g * uStrength);',
    // light theme: the same shapes as soft tints on the paper
    '  float m = max(g.r, max(g.g, g.b)); vec3 hue = g / max(m, 1e-3);',
    '  hue = mix(hue, vec3(dot(hue, vec3(0.2126, 0.7152, 0.0722))), 0.25);',
    '  vec3 light = uPaper * mix(vec3(1.0), hue * 0.9, clamp(m * uStrength, 0.0, 1.0));',
    '  vec3 o = mix(light, dark, uDark);',
    '  float n = hash12(gl_FragCoord.xy + fract(uTime) * 97.0) + hash12(gl_FragCoord.yx * 1.37 + 11.0) - 1.0;',
    '  fragColor = vec4(o + n / 255.0, 1.0); }'
  ].join('\n'));

  var TRANSITION = 7;
  // ?aether=physarum shows only that scene (handy for screenshots)
  var FORCED = (/[?&]aether=([a-z]+)/i.exec(location.search) || [])[1];
  FORCED = FORCED ? FORCED.toLowerCase() : null;

  function Engine(w, h, opts) {
    this.w = w; this.h = h;
    this.opts = opts;
    this.r = rng((Math.random() * 4294967296) >>> 0);
    this.scenes = [Nebula, Julia];
    if (FLOAT_RT) this.scenes.push(Reaction, Physarum, Attractor);
    this.history = [];
    this.comp = new Target(w, h, F16);
    this.cur = null; this.nxt = null; this.trans = 0; this.time = 0;
  }
  Engine.prototype.pickClass = function (first) {
    var recent = this.history.slice(-Math.min(2, this.scenes.length - 1));
    var opts = this.scenes.filter(function (c) { return recent.indexOf(c.sceneName) < 0 && !(first && c === Nebula); });
    if (this.opts.still) opts = [Nebula, Julia];
    var forced = this.scenes.filter(function (c) { return c.sceneName.toLowerCase() === FORCED; });
    if (forced.length) return forced[0];
    var total = opts.reduce(function (s, c) { return s + c.weight; }, 0), x = this.r() * total;
    for (var i = 0; i < opts.length; i++) { x -= opts[i].weight; if (x <= 0) return opts[i]; }
    return opts[opts.length - 1];
  };
  Engine.prototype.newScene = function () {
    var C = this.pickClass(!this.history.length);
    var s = new C(rng(this.r.bits()), this.w, this.h);
    s.lifetime = this.r.uniform(s.duration[0], s.duration[1]);
    this.history.push(C.sceneName);
    return s;
  };
  Engine.prototype.frame = function (dt) {
    this.time += dt;
    if (!this.cur) this.cur = this.newScene();
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);
    this.cur.update(dt);
    if (!this.nxt && this.cur.t >= this.cur.lifetime && !this.opts.still && !FORCED) { this.nxt = this.newScene(); this.trans = 0; }
    if (this.nxt) { this.nxt.update(dt); this.trans += dt / TRANSITION; }
    var src = this.cur.render();
    if (this.nxt) {
      var b = this.nxt.render();
      this.comp.bind();
      program('dissolve', DISSOLVE_FS).use({
        uA: tex(0, src), uB: tex(1, b), uP: smooth(this.trans), uSeed: (this.history.length * 13.7) % 100, uAspect: this.w / this.h
      });
      fullscreen();
      src = this.comp;
      if (this.trans >= 1) { this.cur.release(); this.cur = this.nxt; this.nxt = null; }
    }
    this.src = src;
  };
  Engine.prototype.present = function (view) {
    if (!this.src) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.bindVertexArray(vao);
    program('final', FINAL_FS).use({
      uSrc: tex(0, this.src), uZoom: view.zoom, uShift: view.shift, uExposure: view.exposure * view.fade,
      uStrength: view.strength, uDark: view.dark, uPaper: view.paper, uTime: this.time
    });
    fullscreen();
  };
  Engine.prototype.release = function () {
    if (this.cur) this.cur.release();
    if (this.nxt) this.nxt.release();
    this.comp.release();
  };

  // ------------------------------------------------------------------ page
  var ZOOM = 1.2;                         // how much bigger the field is than the window
  var view = { zoom: ZOOM, shift: [0, 0], exposure: 1.25, fade: 0, strength: 0, dark: 1, paper: [0, 0, 0] };
  var target = { dark: 1, paper: [0, 0, 0] };
  var scroll = 0, pointerX = 0, pointerS = 0;
  var quality = 1, slowFor = 0, ema = 1 / 30, last = 0, still = false, size = [0, 0], gaveUp = false;

  function readTheme() {
    var hex = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    var c = m ? [0, 2, 4].map(function (i) { return parseInt(m[1].substr(i, 2), 16) / 255; }) : [1, 1, 1];
    var lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    target.paper = c;
    target.dark = lum < 0.4 ? 1 : 0;
  }
  function strengthFor(dark) { return dark ? 0.32 : 0.44; }

  // Brightness level, 0 (off) to 1.5, saved per visitor. A page control can
  // change it live with: dispatchEvent(new CustomEvent('aether-level', {detail: 0.8}))
  // data-level-default="0.2" sets the level for visitors who haven't chosen one.
  var LEVEL_KEY = canvas.getAttribute('data-level-key') || 'aether-level';
  var LEVEL_DEFAULT = parseFloat(canvas.getAttribute('data-level-default'));
  if (!isFinite(LEVEL_DEFAULT)) LEVEL_DEFAULT = 1;
  function readLevel() {
    try {
      var v = parseFloat(localStorage.getItem(LEVEL_KEY));
      if (isFinite(v)) return Math.min(1.5, Math.max(0, v));
    } catch (e) {}
    return Math.min(1.5, Math.max(0, LEVEL_DEFAULT));
  }
  var level = readLevel();
  view.level = level;

  function cssSize() { return [window.innerWidth, Math.max(window.innerHeight, document.documentElement.clientHeight)]; }
  function simSize(css) {
    var k = Math.min(1, Math.sqrt(520000 / (css[0] * css[1]))) * quality;
    return [Math.max(160, Math.round(css[0] * k)), Math.max(120, Math.round(css[1] * k))];
  }

  function build() {
    if (engine) engine.release();
    size = cssSize();
    var s = simSize(size);
    canvas.width = s[0]; canvas.height = s[1];
    engine = new Engine(s[0], s[1], { still: still });
    view.fade = 0;
  }

  function updateView(dt) {
    var k = Math.min(1, dt * 6);
    view.dark += (target.dark - view.dark) * Math.min(1, dt * 5);
    for (var i = 0; i < 3; i++) view.paper[i] += (target.paper[i] - view.paper[i]) * Math.min(1, dt * 5);
    view.level += (level - view.level) * Math.min(1, dt * 6);
    view.strength = (strengthFor(1) * view.dark + strengthFor(0) * (1 - view.dark)) * view.level;
    var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    var prog = Math.min(1, Math.max(0, window.scrollY / max));
    scroll += (prog - scroll) * k;
    pointerS += (pointerX - pointerS) * Math.min(1, dt * 1.5);
    var slack = 1 - 1 / ZOOM;
    view.shift = [pointerS * slack * 0.25, slack * (1 - scroll)];
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = (now - last) / 1000;
    if (dt < 1 / 30 - 0.004) return;      // 30 fps is plenty for slow drift
    last = now;
    dt = Math.min(dt, 0.1);
    ema += (dt - ema) * 0.05;
    engine.frame(dt);
    view.fade = Math.min(1, view.fade + dt / 2.5);
    updateView(dt);
    engine.present(view);
    if (!canvas.classList.contains('on')) canvas.classList.add('on');
    // turned off: fade out, then stop drawing entirely
    if (level === 0 && view.level < 0.01) {
      cancelAnimationFrame(raf); raf = 0;
      canvas.classList.remove('on');
      return;
    }
    // too slow? drop the resolution a notch (and give up animating at the bottom)
    slowFor = ema > 0.05 ? slowFor + dt : 0;
    if (slowFor > 4) {
      slowFor = 0; ema = 1 / 30;
      if (quality > 0.45) { quality *= 0.8; build(); }
      else { cancelAnimationFrame(raf); raf = 0; gaveUp = true; }
    }
  }

  function renderStill() {
    // one calm, fully developed frame for people who prefer reduced motion
    for (var i = 0; i < 2; i++) engine.frame(1 / 30);
    view.fade = 1;
    view.dark = target.dark; view.paper = target.paper.slice();
    view.level = level;
    view.strength = strengthFor(view.dark ? 1 : 0) * level;
    view.shift = [0, (1 - 1 / ZOOM) * 0.5];
    engine.present(view);
    canvas.classList.toggle('on', level > 0);
  }

  function run() {
    if (raf || gaveUp || !engine) return;
    canvas.classList.add('on');
    raf = requestAnimationFrame(function (t) { last = t; frame(t); });
  }

  function setLevel(v) {
    v = Math.min(1.5, Math.max(0, +v || 0));
    level = v;
    if (!engine) return;
    if (still) { renderStill(); return; }
    if (v > 0) run();
  }
  window.addEventListener('aether-level', function (e) { setLevel(e.detail); });
  // keep other open tabs in step
  window.addEventListener('storage', function (e) { if (e.key === LEVEL_KEY) setLevel(readLevel()); });

  function start() {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) return false;
    programs = {};
    vao = gl.createVertexArray();
    FLOAT_RT = !!gl.getExtension('EXT_color_buffer_float');
    F32 = { i: gl.RGBA32F, f: gl.RGBA, t: gl.FLOAT };
    F16 = FLOAT_RT ? { i: gl.RGBA16F, f: gl.RGBA, t: gl.HALF_FLOAT } : { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE };
    if (FLOAT_RT) {
      var probe = new Target(4, 4, F16), probe32 = new Target(4, 4, F32, gl.NEAREST);
      FLOAT_RT = probe.ok && probe32.ok;
      probe.release(); probe32.release();
      if (!FLOAT_RT) F16 = { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE };
    }
    still = reduceMQ.matches;
    readTheme();
    view.dark = target.dark; view.paper = target.paper.slice();
    try {
      build();
      if (still) renderStill();
      else if (level > 0) run();
      document.documentElement.classList.add('aether-ready');
    } catch (e) {
      if (window.console) console.warn(e);
      canvas.classList.remove('on');
      return false;
    }
    return true;
  }

  // theme changes: the site's toggle sets data-theme; the OS can change too
  function onTheme() {
    readTheme();
    if (still && engine) renderStill();
  }
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  if (darkMQ.addEventListener) darkMQ.addEventListener('change', onTheme);

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!engine) return;
      var now = cssSize();
      // ignore the mobile address bar sliding in and out
      if (now[0] === size[0] && Math.abs(now[1] - size[1]) < size[1] * 0.2) return;
      build();
      if (still) renderStill();
    }, 300);
  });
  window.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'mouse') pointerX = (e.clientX / window.innerWidth) * 2 - 1;
  }, { passive: true });

  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    cancelAnimationFrame(raf); raf = 0; engine = null;
    canvas.classList.remove('on');
  });
  canvas.addEventListener('webglcontextrestored', function () { start(); });

  start();
})();

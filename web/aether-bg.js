/*!
 * Aether for the web: a WebGL2 port of all ten Aether scenes, drawn as a
 * calm, slowly dissolving page background with scroll parallax. A page
 * background shows the original five; data-scenes="all" shows all ten.
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
  // Phones and tablets: their GPU watchdog resets the GPU when a single frame's
  // work runs long, so heavy scenes use fewer particles and fewer ray steps there.
  var MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
  var PCAP = MOBILE ? 0.5 : 1;
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
  // A shader program. Compiling and linking are only started here; the result
  // is checked when the program is first used. With KHR_parallel_shader_compile
  // the driver compiles in the background meanwhile, so a scene's shaders can
  // be prepared before it starts instead of freezing the frame it starts in.
  var PARALLEL = null;
  function Program(vs, fs) {
    var p = gl.createProgram();
    this.shaders = [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].map(function (pair) {
      var s = gl.createShader(pair[0]);
      gl.shaderSource(s, pair[1]);
      gl.compileShader(s);
      gl.attachShader(p, s);
      return s;
    });
    gl.linkProgram(p);
    this.p = p;
    this.u = null;
  }
  // true once the driver has finished (without the extension: assume so)
  Program.prototype.done = function () {
    return !!this.u || !PARALLEL || gl.getProgramParameter(this.p, PARALLEL.COMPLETION_STATUS_KHR);
  };
  Program.prototype.finish = function () {
    var p = this.p;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      var log = this.shaders.map(function (s) { return gl.getShaderInfoLog(s); }).join(' ');
      throw new Error('aether-bg shader: ' + (log.trim() || gl.getProgramInfoLog(p)));
    }
    this.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      this.u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
  };
  Program.prototype.use = function (vals) {
    if (!this.u) this.finish();
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
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
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
  function extend(Ctor, name, weight, key) {
    Ctor.prototype = Object.create(Scene.prototype);
    Ctor.prototype.constructor = Ctor;
    Ctor.sceneName = name;
    Ctor.key = key || name.toLowerCase();
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
    'uniform float uZoom, uRot, uAspect, uPx, uTrapR, uInterior, uAA;',
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
    '  if (uAA < 0.5) { fragColor = vec4((sampleAt(uv + o) + sampleAt(uv - o)) * 0.5, 1.0); return; }',
    '  float px = uPx / uZoom;',   // rotated-grid supersampling
    '  fragColor = vec4((sampleAt(uv + vec2(0.125, 0.375) * px) + sampleAt(uv + vec2(-0.375, 0.125) * px)',
    '    + sampleAt(uv + vec2(0.375, -0.125) * px) + sampleAt(uv + vec2(-0.125, -0.375) * px)) * 0.25, 1.0); }'
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
      uTrapR: this.trap.value, uInterior: this.interior, uMaxIter: RAY ? 220 : 140, uPal: this.pal, uAA: RAY ? 1 : 0
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
    'uniform sampler2D uSrc; uniform vec2 uFK, uFK2; uniform float uVarScale, uTime, uAniso; uniform vec4 uSeedPt;',
    'vec2 bil(sampler2D t, vec2 x, ivec2 sz) { ivec2 i = ivec2(floor(x)); vec2 f = x - floor(x);',
    '  vec2 a = texelFetch(t, (i + sz) % sz, 0).xy, b = texelFetch(t, (i + ivec2(1, 0) + sz) % sz, 0).xy;',
    '  vec2 c = texelFetch(t, (i + ivec2(0, 1) + sz) % sz, 0).xy, e = texelFetch(t, (i + ivec2(1, 1) + sz) % sz, 0).xy;',
    '  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y); }',
    'void main() {',
    '  ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uSrc, 0);',
    '  #define S(dx, dy) texelFetch(uSrc, (p + ivec2(dx, dy) + sz) % sz, 0).xy',
    '  vec2 c = S(0, 0);',
    '  vec2 lap = -c + 0.2 * (S(1, 0) + S(-1, 0) + S(0, 1) + S(0, -1)) + 0.05 * (S(1, 1) + S(-1, 1) + S(1, -1) + S(-1, -1));',
    '  vec2 q = vec2(p) / float(sz.y) * uVarScale;',
    '  if (uAniso > 0.0) { float th = PI * snoise(vec3(q * 0.7, uTime * 0.015 + 7.0)); vec2 d = vec2(cos(th), sin(th));',
    '    vec2 dxx = S(1, 0) + S(-1, 0) - 2.0 * c, dyy = S(0, 1) + S(0, -1) - 2.0 * c;',
    '    vec2 dss = bil(uSrc, vec2(p) + d, sz) + bil(uSrc, vec2(p) - d, sz) - 2.0 * c;',
    '    lap = mix(lap, 0.15 * (dxx + dyy) + 0.3 * dss, 0.7 * uAniso); }',
    '  float m = smoothstep(-0.35, 0.35, snoise(vec3(q, uTime * 0.01))); vec2 fk = mix(uFK, uFK2, m);',
    '  float a = c.x, b = c.y; float abb = a * b * b;',
    '  a += (lap.x - abb + fk.x * (1.0 - a)); b += (0.5 * lap.y + abb - (fk.y + fk.x) * b);',
    '  if (uSeedPt.w > 0.5) { vec2 d = vec2(p) - uSeedPt.xy; if (dot(d, d) < uSeedPt.z * uSeedPt.z) { b = max(b, 0.6); a = min(a, 0.4); } }',
    '  fragColor = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 0.0); }'
  ].join('\n'));
  var RD_SHOW_FS = frag([
    'uniform sampler2D uState; uniform vec3 uLight; uniform float uRelief, uShadow;',
    'float B(ivec2 p, ivec2 sz) { return texelFetch(uState, clamp(p, ivec2(0), sz - 1), 0).y; }',
    'void main() {',
    '  ivec2 sz = textureSize(uState, 0); ivec2 p = ivec2(vUv * vec2(sz));',
    '  float b = B(p, sz), bl = B(p - ivec2(1, 0), sz), br = B(p + ivec2(1, 0), sz);',
    '  float bd = B(p - ivec2(0, 1), sz), bu = B(p + ivec2(0, 1), sz);',
    '  vec3 n = normalize(vec3((bl - br) * uRelief, (bd - bu) * uRelief, 1.0)); vec3 L = normalize(uLight);',
    '  float diff = max(dot(n, L), 0.0); vec3 H = normalize(L + vec3(0, 0, 1));',
    '  float spec = pow(max(dot(n, H), 0.0), 60.0); float x = smoothstep(0.05, 0.42, b);',
    '  float sh = 1.0;',
    '  if (uShadow > 0.5) { vec2 dir = normalize(uLight.xy); float h0 = b * uRelief;',   // march towards the light over the surface
    '    for (int k = 1; k <= 20; k++) { float t = float(k) * 1.5; float hq = B(ivec2(vec2(p) + dir * t), sz) * uRelief;',
    '      sh = min(sh, clamp(1.0 - (hq - h0 - t * 0.3) * 1.5, 0.0, 1.0)); }',
    '    sh = 0.4 + 0.6 * sh; }',
    '  vec3 col = pal(0.04 + 0.8 * x) * (0.12 + diff * sh) + pal(0.97) * spec * sh * (0.25 + 0.9 * x);',
    '  col += pal(0.85) * pow(x, 6.0) * 0.25;',
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
    this.aniso = r() < 0.4 ? 1 : 0;
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
    var p = program('rd.step', RD_STEP_FS).use({ uFK: this.fk.value, uFK2: this.fk2.value, uVarScale: this.varScale, uTime: this.t, uAniso: this.aniso });
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
      uState: tex(0, this.a), uLight: [Math.cos(la), Math.sin(la), 0.9], uRelief: this.relief, uPal: this.pal, uShadow: RAY ? 1 : 0
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

  // ===================================================== particle helpers
  // The Linux scenes keep particles in shader storage buffers and move them
  // with compute shaders. WebGL2 has neither, so here a particle lives in one
  // texel of float textures, a fragment shader moves it, and a vertex shader
  // reads it back by gl_VertexID to draw it as a point.
  var PW = 512;   // particle textures are PW texels wide

  var PARTICLE_GLSL = [
    'vec3 randSphere(inout uint s) { float z = rnd(s) * 2.0 - 1.0; float a = rnd(s) * TAU;',
    '  float r = sqrt(max(0.0, 1.0 - z * z)); return vec3(r * cos(a), r * sin(a), z); }',
    'vec2 randGauss(inout uint s) { float u1 = max(1e-7, rnd(s)), u2 = rnd(s); float r = sqrt(-2.0 * log(u1));',
    '  return r * vec2(cos(TAU * u2), sin(TAU * u2)); }',
    'vec3 snoise3(vec3 x) { return vec3(snoise(x), snoise(vec3(x.y - 19.1, x.z + 33.4, x.x + 47.2)),',
    '  snoise(vec3(x.z + 74.2, x.x - 124.5, x.y + 99.4))); }',
    'vec3 curlNoise(vec3 p) { const float e = 0.1; vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);',
    '  vec3 px0 = snoise3(p - dx), px1 = snoise3(p + dx), py0 = snoise3(p - dy), py1 = snoise3(p + dy);',
    '  vec3 pz0 = snoise3(p - dz), pz1 = snoise3(p + dz);',
    '  return vec3((py1.z - py0.z) - (pz1.y - pz0.y), (pz1.x - pz0.x) - (px1.z - px0.z), (px1.y - px0.y) - (py1.x - py0.x)) / (2.0 * e); }',
    'uniform int uPW;',
    'ivec2 cellOf(int i) { return ivec2(i % uPW, i / uPW); }',
    'uint indexOf(ivec2 c) { return uint(c.y * uPW + c.x); }',
    ''
  ].join('\n');

  // fragment shader writing two float targets at once (position + velocity)
  function fragMRT(body) {
    return HEAD + COMMON + PARTICLE_GLSL +
      'in vec2 vUv;\nlayout(location = 0) out vec4 outA;\nlayout(location = 1) out vec4 outB;\n' + body;
  }
  function vertP(body) { return HEAD + COMMON + PAL + PARTICLE_GLSL + body; }
  var POINT_FS = HEAD + 'in vec3 vCol;\nout vec4 fragColor;\nvoid main() { fragColor = vec4(vCol, 1.0); }';
  var GLOW_FS = HEAD + 'in vec3 vCol;\nout vec4 fragColor;\n' +
    'void main() { vec2 d = gl_PointCoord * 2.0 - 1.0; fragColor = vec4(vCol * exp(-dot(d, d) * 2.0), 1.0); }';

  // n RGBA32F textures behind one framebuffer, for particle state
  function State(w, h, n) {
    this.w = w; this.h = h; this.tex = [];
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    var bufs = [];
    for (var i = 0; i < n; i++) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, F32.i, w, h, 0, F32.f, F32.t, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      this.tex.push(t);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
    this.ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  }
  State.prototype.bind = Target.prototype.bind;
  State.prototype.release = function () {
    gl.deleteFramebuffer(this.fbo);
    this.tex.forEach(function (t) { gl.deleteTexture(t); });
  };

  // a scene whose particles live in a pair of ping-ponged States
  function particles(scene, wanted, attachments) {
    var rows = Math.max(16, Math.round(wanted / PW));
    scene.count = PW * rows;
    scene.ph = rows;
    scene.src = scene.keep(new State(PW, rows, attachments));
    scene.dst = scene.keep(new State(PW, rows, attachments));
  }
  function flip(scene) { var t = scene.src; scene.src = scene.dst; scene.dst = t; }

  // multiply what is in the scene's output by keep (trails), at any frame rate
  Scene.prototype.fade = function (keep) {
    this.out.bind();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.CONSTANT_ALPHA);
    gl.blendColor(0, 0, 0, Math.pow(keep, (this.dt || 1 / 30) * 30));
    program('zero', ZERO_FS).use();
    fullscreen();
    gl.blendFunc(gl.ONE, gl.ONE);   // and leave blending on for additive points
  };
  Scene.prototype.points = function (p, n) {
    gl.drawArrays(gl.POINTS, 0, n);
    gl.disable(gl.BLEND);
  };

  // column-major camera matrices, as in aether/scenes/base.py
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(e, t) {
    var fx = t[0] - e[0], fy = t[1] - e[1], fz = t[2] - e[2], fl = Math.hypot(fx, fy, fz);
    fx /= fl; fy /= fl; fz /= fl;
    var sx = fy * 0 - fz * 1, sy = fz * 0 - fx * 0, sz = fx * 1 - fy * 0, sl = Math.hypot(sx, sy, sz);
    sx /= sl; sy /= sl; sz /= sl;
    var ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
    return [sx, ux, -fx, 0, sy, uy, -fy, 0, sz, uz, -fz, 0,
      -(sx * e[0] + sy * e[1] + sz * e[2]), -(ux * e[0] + uy * e[1] + uz * e[2]), fx * e[0] + fy * e[1] + fz * e[2], 1];
  }
  function matmul(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      var s = 0;
      for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function orbitCamera(t, radius, height, speed, aspect, fov, target) {
    target = target || [0, 0, 0];
    var a = t * speed;
    var eye = [target[0] + radius * Math.cos(a), target[1] + height, target[2] + radius * Math.sin(a)];
    return matmul(perspective(fov, aspect, 0.05, 100), lookAt(eye, target));
  }
  // one colour from a palette, linear RGB (for the CPU side of Ink)
  function palSample(name, x) {
    var stops = PALETTES[name], n = stops.length - 1;
    x = Math.min(Math.max(x, 0), 1) * n;
    var i = Math.min(Math.floor(x), n - 1), f = x - i;
    f = f * f * (3 - 2 * f);
    return [1, 3, 5].map(function (k) {
      var a = parseInt(stops[i].substr(k, 2), 16), b = parseInt(stops[i + 1].substr(k, 2), 16);
      return Math.pow((a + (b - a) * f) / 255, 2.2);
    });
  }

  // ------------------------------------------------------------------ Silk
  var SILK_SPAWN = [
    'uniform uint uSeed; uniform int uShape; uniform float uRadius;',
    'vec3 spawn(inout uint s) {',
    '  if (uShape == 0) return randSphere(s) * uRadius * pow(rnd(s), 0.33);',
    '  if (uShape == 1) { float a = rnd(s) * TAU; vec2 g = randGauss(s) * 0.18 * uRadius;',
    '    vec3 c = vec3(cos(a), 0.0, sin(a)) * uRadius * 0.75; return c + vec3(cos(a) * g.x, g.y, sin(a) * g.x); }',
    '  if (uShape == 2) { float side = rnd(s) < 0.5 ? -1.0 : 1.0;',
    '    return vec3(side * uRadius * 0.55, 0.0, 0.0) + randSphere(s) * uRadius * 0.45 * pow(rnd(s), 0.33); }',
    '  float a = rnd(s) * TAU, r = sqrt(rnd(s)) * uRadius;',
    '  return vec3(cos(a) * r, (rnd(s) - 0.5) * 0.08 * uRadius, sin(a) * r); }',
    ''
  ].join('\n');
  var SILK_INIT_FS = fragMRT(SILK_SPAWN + [
    'void main() {',
    '  uint i = indexOf(ivec2(gl_FragCoord.xy)); uint s = pcg(i * 9781u + uSeed);',
    '  vec3 p = spawn(s); float life = mix(3.0, 11.0, rnd(s));',
    '  outA = vec4(p, rnd(s) * life); outB = vec4(0.0, 0.0, 0.0, life); }'
  ].join('\n'));
  var SILK_STEP_FS = fragMRT(SILK_SPAWN + [
    'uniform sampler2D uA, uB; uniform float uDt, uTime, uScale, uSpeed, uEvo, uSwirl;',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uA, c, 0), b = texelFetch(uB, c, 0);',
    '  vec3 x = a.xyz;',
    '  vec3 v = curlNoise(x * uScale + vec3(0.0, uTime * uEvo, uTime * uEvo * 0.37)) * uSpeed;',
    '  v += uSwirl * vec3(-x.z, 0.0, x.x);',
    '  v -= x * smoothstep(uRadius * 0.8, uRadius * 1.4, length(x)) * 1.2;',
    '  x += v * uDt; a.w += uDt;',
    '  if (a.w > b.w) { uint s = pcg(indexOf(c) * 7919u + uSeed + uint(uTime * 60.0) * 131u);',
    '    x = spawn(s); a.w = 0.0; b.w = mix(3.0, 11.0, rnd(s)); v = vec3(0.0); }',
    '  outA = vec4(x, a.w); outB = vec4(mix(b.xyz, v, 0.5), b.w); }'
  ].join('\n'));
  var SILK_VS = vertP([
    'uniform sampler2D uA, uB; uniform mat4 uMVP; uniform float uIntensity, uPointSize, uColorMode, uTime, uSpeed;',
    'out vec3 vCol;',
    'void main() {',
    '  ivec2 c = cellOf(gl_VertexID); vec4 a = texelFetch(uA, c, 0), b = texelFetch(uB, c, 0);',
    '  gl_Position = uMVP * vec4(a.xyz, 1.0);',
    '  float fade = smoothstep(0.0, 0.8, a.w) * smoothstep(b.w, b.w - 1.5, a.w);',
    '  float c1 = clamp(0.25 + length(b.xyz) / max(uSpeed, 1e-3) * 0.45, 0.0, 1.0);',
    '  float c2 = clamp(0.5 + 0.45 * snoise(a.xyz * 0.6 + uTime * 0.02), 0.0, 1.0);',
    '  float depth = clamp(1.6 - gl_Position.w * 0.25, 0.25, 1.4);',
    '  vCol = pal(0.35 + 0.65 * mix(c1, c2, uColorMode)) * uIntensity * fade * depth;',
    '  gl_PointSize = uPointSize; }'
  ].join('\n'));

  var Silk = extend(function Silk(r, w, h) {
    Scene.call(this, r, w, h);
    particles(this, Math.min((1 << 18) * PCAP, Math.max((1 << 16) * PCAP, w * h * 0.25)), 2);
    this.shape = r.choice([0, 0, 1, 2, 3]);
    this.radius = 1.6;
    this.seed = r.bits();
    this.scale = new Drift(r, 0.35, 1.1, [20, 45]);
    this.speed = new Drift(r, 0.35, 0.8, [15, 35]);
    this.swirl = new Drift(r, -0.35, 0.35, [25, 60]);
    this.evo = r.uniform(0.03, 0.07);
    this.trail = new Drift(r, 0.88, 0.95, [20, 50]);
    this.colorMode = new Drift(r, 0, 1, [25, 60]);
    this.camR = new Drift(r, 3.6, 5.2, [25, 50]);
    this.camH = new Drift(r, -1.5, 2.2, [25, 50]);
    this.camSpeed = r.sign() * r.uniform(0.03, 0.06);
    this.duration = [50, 90];
    this.src.bind();
    program('silk.init', SILK_INIT_FS).use({ uPW: PW, uSeed: this.seed, uShape: this.shape, uRadius: this.radius });
    fullscreen();
  }, 'Silk', 1.1, 'silk');
  Silk.prototype.step = function (dt) {
    this.dt = dt;
    [this.scale, this.speed, this.swirl, this.trail, this.colorMode, this.camR, this.camH].forEach(function (d) { d.update(dt); });
    this.dst.bind();
    program('silk.step', SILK_STEP_FS).use({
      uA: tex(0, this.src.tex[0]), uB: tex(1, this.src.tex[1]), uPW: PW, uSeed: this.seed, uShape: this.shape,
      uRadius: this.radius, uDt: Math.min(dt, 0.1), uTime: this.t, uScale: this.scale.value, uSpeed: this.speed.value,
      uEvo: this.evo, uSwirl: this.swirl.value
    });
    fullscreen();
    flip(this);
  };
  Silk.prototype.draw = function () {
    this.fade(this.trail.value);
    var area = this.w * this.h / (1280 * 720);
    program('silk.draw', POINT_FS, SILK_VS).use({
      uA: tex(0, this.src.tex[0]), uB: tex(1, this.src.tex[1]), uPW: PW, uPal: this.pal,
      uMVP: orbitCamera(this.t, this.camR.value, this.camH.value, this.camSpeed, this.aspect, 0.85),
      uIntensity: 0.011 * area * (1 - this.trail.value) / 0.08 * (262144 / this.count),
      uPointSize: Math.max(1, this.h / 720), uColorMode: this.colorMode.value, uTime: this.t, uSpeed: this.speed.value
    });
    this.points(null, this.count);
  };

  // ----------------------------------------------------------------- Chaos
  // name: [glsl derivative, time scale, centre, world units per attractor unit]
  var CHAOS = [
    ['Lorenz', 'vec3(10.0 * (p.y - p.x), p.x * (28.0 - p.z) - p.y, p.x * p.y - 2.6666667 * p.z)', 0.35, [0, 0, 24.93], 0.0377],
    ['Aizawa', 'vec3((p.z - 0.7) * p.x - 3.5 * p.y, 3.5 * p.x + (p.z - 0.7) * p.y, 0.6 + 0.95 * p.z - p.z * p.z * p.z / 3.0 - (p.x * p.x + p.y * p.y) * (1.0 + 0.25 * p.z) + 0.1 * p.z * p.x * p.x * p.x)', 1.2, [-0.039, -0.231, 0.771], 0.7423],
    ['Thomas', 'vec3(sin(p.y) - 0.208186 * p.x, sin(p.z) - 0.208186 * p.y, sin(p.x) - 0.208186 * p.z)', 4.0, [1.353, 1.353, 1.353], 0.3855],
    ['Halvorsen', 'vec3(-1.89 * p.x - 4.0 * p.y - 4.0 * p.z - p.y * p.y, -1.89 * p.y - 4.0 * p.z - 4.0 * p.x - p.z * p.z, -1.89 * p.z - 4.0 * p.x - 4.0 * p.y - p.x * p.x)', 0.6, [-2.91, -2.91, -2.91], 0.1029],
    ['Dadras', 'vec3(p.y - 3.0 * p.x + 2.7 * p.y * p.z, 1.7 * p.y - p.x * p.z + p.z, 2.0 * p.x * p.y - 9.0 * p.z)', 0.7, [-1.243, -1.986, 0.817], 0.0568],
    ['Rossler', 'vec3(-p.y - p.z, p.x + 0.2 * p.y, 0.2 + p.z * (p.x - 5.7))', 2.2, [1.164, -1.471, 11.309], 0.0841],
    ['Chen', 'vec3(35.0 * (p.y - p.x), -7.0 * p.x - p.x * p.z + 28.0 * p.y, p.x * p.y - 3.0 * p.z)', 0.253, [-0.563, -0.777, 28.752], 0.0318],
    ['Four-Wing', 'vec3(0.2 * p.x + p.y * p.z, 0.01 * p.x - 0.4 * p.y - p.x * p.z, -p.z - p.x * p.y)', 12.8, [0.305, -0.47, 0.301], 0.3295],
    ['Sprott B', 'vec3(0.4 * p.y * p.z, p.x - p.y, 1.2 - p.x * p.y)', 4.83, [-0.444, -0.219, -0.441], 0.1358]
  ];
  var CHAOS_FIELD = CHAOS.map(function (s, i) { return 'vec3 f' + i + '(vec3 p) { return ' + s[1] + '; }'; }).join('\n') + [
    '',
    'vec3 fsys(int k, vec3 p) {',
    CHAOS.map(function (s, i) { return '  if (k == ' + i + ') return f' + i + '(p);'; }).join('\n'),
    '  return vec3(0.0); }',
    'uniform int uSA, uSB; uniform vec4 uCenA, uCenB; uniform float uTsA, uTsB, uMix;',
    'vec3 worldVel(vec3 w) {',
    '  vec3 va = vec3(0.0), vb = vec3(0.0);',
    '  if (uMix < 0.999) va = fsys(uSA, w / uCenA.w + uCenA.xyz) * uCenA.w * uTsA;',
    '  if (uMix > 0.001) vb = fsys(uSB, w / uCenB.w + uCenB.xyz) * uCenB.w * uTsB;',
    '  vec3 v = mix(va, vb, uMix); float sp = length(v);',
    '  return sp > 3.5 ? v * (3.5 / sp) : v; }',
    ''
  ].join('\n');
  var CHAOS_INIT_FS = fragMRT([
    'uniform uint uSeed;',
    'void main() { uint s = pcg(indexOf(ivec2(gl_FragCoord.xy)) * 2654435761u + uSeed);',
    '  outA = vec4(randSphere(s) * 0.6 * pow(rnd(s), 0.33), rnd(s)); outB = vec4(0.0); }'
  ].join('\n'));
  var CHAOS_STEP_FS = fragMRT(CHAOS_FIELD + [
    'uniform sampler2D uA, uB; uniform uint uSeed, uFrame, uN; uniform float uDt; uniform int uSub;',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uA, c, 0), b = texelFetch(uB, c, 0);',
    '  vec3 w = a.xyz, v = vec3(0.0); float h = uDt / float(uSub);',
    '  for (int k = 0; k < 4; k++) { if (k >= uSub) break;',
    '    vec3 k1 = worldVel(w); vec3 k2 = worldVel(w + k1 * h * 0.5); v = k2; w += k2 * h; }',
    '  if (any(isnan(w)) || length(w) > 3.6) {',
    // re-seed next to a random other particle so it rejoins the flow
    '    uint s = pcg(indexOf(c) * 7919u + uFrame * 104729u + uSeed); uint j = uint(rnd(s) * float(uN)) % uN;',
    '    w = texelFetch(uA, cellOf(int(j)), 0).xyz + randSphere(s) * 0.02; v = vec3(0.0); }',
    '  outA = vec4(w, a.w); outB = vec4(mix(b.xyz, v, 0.3), 0.0); }'
  ].join('\n'));
  var CHAOS_VS = vertP([
    'uniform sampler2D uA, uB; uniform mat4 uMVP; uniform float uIntensity, uSize, uSpeedRef, uHueSpread;',
    'out vec3 vCol;',
    'void main() {',
    '  ivec2 c = cellOf(gl_VertexID); vec4 a = texelFetch(uA, c, 0), b = texelFetch(uB, c, 0);',
    '  gl_Position = uMVP * vec4(a.xyz, 1.0);',
    '  float spd = clamp(length(b.xyz) / uSpeedRef, 0.0, 1.5);',
    '  float x = 0.4 + 0.35 * spd + (a.w - 0.5) * uHueSpread;',
    '  float depth = clamp(1.8 - gl_Position.w * 0.22, 0.3, 1.5);',
    '  vCol = pal(clamp(x, 0.25, 0.86)) * uIntensity * depth; gl_PointSize = uSize; }'
  ].join('\n'));

  var Chaos = extend(function Chaos(r, w, h) {
    Scene.call(this, r, w, h);
    particles(this, Math.min((1 << 17) * PCAP, Math.max((1 << 15) * PCAP, w * h * 0.12)), 2);
    this.order = CHAOS.map(function (s, i) { return i; }).sort(function () { return r() - 0.5; });
    this.idx = 0;
    this.a = this.b = this.order[0];
    this.mix = 0;
    this.morph = -1;
    this.nextMorph = r.uniform(30, 45);
    this.speed = r.uniform(0.8, 1.1);
    this.trail = new Drift(r, 0.86, 0.93, [20, 45]);
    this.camR = new Drift(r, 3.2, 4.4, [25, 50]);
    this.camH = new Drift(r, -1.0, 2.0, [25, 50]);
    this.camSpeed = r.sign() * r.uniform(0.04, 0.07);
    this.hueSpread = r.uniform(0.05, 0.3);
    this.frame = 0;
    this.seed = r.bits();
    this.duration = [50, 90];
    this.src.bind();
    program('chaos.init', CHAOS_INIT_FS).use({ uPW: PW, uSeed: this.seed });
    fullscreen();
    this.warm = 90;   // settle onto the attractor over the first frames (never all in one GPU job)
  }, 'Chaos', 1.0, 'chaos');
  Chaos.prototype.integrate = function (dt) {
    var A = CHAOS[this.a], B = CHAOS[this.b];
    this.dst.bind();
    program('chaos.step', CHAOS_STEP_FS).use({
      uA: tex(0, this.src.tex[0]), uB: tex(1, this.src.tex[1]), uPW: PW, uN: this.count, uSeed: this.seed, uFrame: this.frame,
      uSA: this.a, uSB: this.b, uCenA: A[3].concat(A[4] * 1.5), uCenB: B[3].concat(B[4] * 1.5),
      uTsA: A[2], uTsB: B[2], uMix: this.mix, uDt: Math.min(dt, 0.07) * 0.5 * this.speed, uSub: 3
    });
    fullscreen();
    flip(this);
    this.frame++;
  };
  Chaos.prototype.step = function (dt) {
    this.dt = dt;
    this.trail.update(dt); this.camR.update(dt); this.camH.update(dt);
    if (this.morph < 0 && this.t > this.nextMorph) {
      this.idx = (this.idx + 1) % this.order.length;
      this.b = this.order[this.idx];
      this.morph = 0;
    }
    if (this.morph >= 0) {
      this.morph += dt / 12;
      var u = Math.min(1, this.morph);
      this.mix = smooth(u);
      if (u >= 1) { this.a = this.b; this.mix = 0; this.morph = -1; this.nextMorph = this.t + this.r.uniform(28, 45); }
    }
    if (this.warm > 0) { var k = Math.min(this.warm, 6); this.warm -= k; for (var i = 0; i < k; i++) this.integrate(1 / 15); }
    this.integrate(dt);
  };
  Chaos.prototype.draw = function () {
    this.fade(this.trail.value);
    var area = this.w * this.h / (1280 * 720);
    program('chaos.draw', POINT_FS, CHAOS_VS).use({
      uA: tex(0, this.src.tex[0]), uB: tex(1, this.src.tex[1]), uPW: PW, uPal: this.pal,
      uMVP: orbitCamera(this.t, this.camR.value, this.camH.value, this.camSpeed, this.aspect, 0.85),
      uIntensity: 0.015 * area * (1 - this.trail.value) / 0.1 * (131072 / this.count),
      uSize: Math.max(1, this.h / 720), uSpeedRef: 1.6, uHueSpread: this.hueSpread
    });
    this.points(null, this.count);
  };

  // ---------------------------------------------------------------- Galaxy
  var GAL_CORES = 'uniform int uNG; uniform vec4 uCore[3], uCoreV[3], uNormal[3], uDisk[3]; uniform float uEps;\n';
  var GAL_INIT_FS = fragMRT(GAL_CORES + [
    'uniform uint uSeed;',
    'void main() {',
    '  uint s = pcg(indexOf(ivec2(gl_FragCoord.xy)) * 2246822519u + uSeed);',
    // stars in proportion to mass
    '  float tot = 0.0; for (int k = 0; k < 3; k++) if (k < uNG) tot += uCore[k].w;',
    '  float pick = rnd(s) * tot, acc = 0.0; int g = 0;',
    '  for (int k = 0; k < 3; k++) { if (k >= uNG) break; acc += uCore[k].w; if (pick <= acc) { g = k; break; } }',
    '  vec3 n = normalize(uNormal[g].xyz);',
    '  vec3 t1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0))); vec3 t2 = cross(n, t1);',
    '  float M = uCore[g].w, sl = uDisk[g].x * sqrt(M);',
    '  float r = min(-log(max(1e-4, rnd(s))) * sl + 0.08, uDisk[g].y * sqrt(M));',
    '  float a = rnd(s) * TAU;',
    // two-armed spiral density wave: bias angles toward the arms
    '  a += 0.6 * sin(2.0 * a - r * 3.0) * step(0.35, rnd(s));',
    '  vec3 radial = cos(a) * t1 + sin(a) * t2;',
    '  vec3 p = uCore[g].xyz + radial * r + n * randGauss(s).x * 0.04 * (1.0 + r * 0.3);',
    '  float vc = sqrt(M * r * r / pow(r * r + uEps * uEps, 1.5));',
    '  vec3 v = uCoreV[g].xyz + cross(n, radial) * uNormal[g].w * vc;',
    '  float bright = 0.5 + 0.5 * exp(-r / sl) + (rnd(s) < 0.02 ? 2.0 : 0.0);',
    '  outA = vec4(p, float(g)); outB = vec4(v, bright); }'
  ].join('\n'));
  var GAL_STEP_FS = fragMRT(GAL_CORES + [
    'uniform sampler2D uA, uB; uniform float uDt; uniform int uSub;',
    'vec3 accel(vec3 p) { vec3 a = vec3(0.0);',
    '  for (int g = 0; g < 3; g++) { if (g >= uNG) break; vec3 d = uCore[g].xyz - p; float r2 = dot(d, d) + uEps * uEps;',
    '    a += uCore[g].w * d * inversesqrt(r2 * r2 * r2); }',
    '  return a; }',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uA, c, 0), b = texelFetch(uB, c, 0);',
    '  vec3 p = a.xyz, v = b.xyz; float h = uDt / float(uSub);',
    '  for (int k = 0; k < 4; k++) { if (k >= uSub) break; v += accel(p) * h; p += v * h; }',
    '  outA = vec4(p, a.w); outB = vec4(v, b.w); }'
  ].join('\n'));
  var GAL_VS = vertP([
    'uniform sampler2D uA, uB; uniform mat4 uMVP; uniform float uIntensity, uSize; uniform vec3 uHue;',
    'out vec3 vCol;',
    'void main() {',
    '  ivec2 c = cellOf(gl_VertexID); vec4 a = texelFetch(uA, c, 0), b = texelFetch(uB, c, 0);',
    '  gl_Position = uMVP * vec4(a.xyz, 1.0);',
    '  int g = int(a.w + 0.5); float h = g == 0 ? uHue.x : g == 1 ? uHue.y : uHue.z;',
    '  vec3 col = mix(pal(h), pal(0.97), clamp((b.w - 1.0) * 0.5, 0.0, 1.0));',
    '  float depth = clamp(2.2 - gl_Position.w * 0.12, 0.3, 1.6);',
    '  vCol = col * uIntensity * b.w * depth; gl_PointSize = uSize * (b.w > 1.8 ? 2.0 : 1.0); }'
  ].join('\n'));

  function randUnit(r) {
    var z = r.uniform(-1, 1), a = r.uniform(0, Math.PI * 2), s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), s * Math.sin(a), z];
  }
  var Galaxy = extend(function Galaxy(r, w, h) {
    Scene.call(this, r, w, h);
    particles(this, Math.min((1 << 18) * PCAP, Math.max((1 << 16) * PCAP, w * h * 0.25)), 2);
    this.ng = r.choice([2, 2, 2, 3]);
    this.eps = 0.12;
    var masses = [1];
    for (var k = 1; k < this.ng; k++) masses.push(r.uniform(0.35, 1));
    // a near-parabolic encounter in the xz-plane
    var D = r.uniform(3.6, 4.6), bimp = r.uniform(0.9, 1.6), cores = [];
    if (this.ng === 2) {
      var m1 = masses[0], m2 = masses[1], mt = m1 + m2;
      var v = Math.sqrt(2 * mt / Math.hypot(D, bimp)) * r.uniform(0.75, 0.95);
      cores.push([[-D * m2 / mt, 0, -bimp * m2 / mt], [v * m2 / mt, 0, 0], m1]);
      cores.push([[D * m1 / mt, 0, bimp * m1 / mt], [-v * m1 / mt, 0, 0], m2]);
    } else {
      for (k = 0; k < 3; k++) {
        var a = k * Math.PI * 2 / 3 + r.uniform(-0.3, 0.3);
        var pos = [Math.cos(a) * D * 0.8, r.uniform(-0.4, 0.4), Math.sin(a) * D * 0.8];
        var sp = r.uniform(0.25, 0.4);
        cores.push([pos, [-Math.sin(a) * sp - pos[0] * 0.06, 0, Math.cos(a) * sp - pos[2] * 0.06], masses[k]]);
      }
      var tot = 0, px = 0, pz = 0;
      cores.forEach(function (c) { tot += c[2]; px += c[1][0] * c[2]; pz += c[1][2] * c[2]; });
      cores.forEach(function (c) { c[1] = [c[1][0] - px / tot, 0, c[1][2] - pz / tot]; });
    }
    this.cores = cores;
    this.normals = [];
    for (k = 0; k < this.ng; k++) {
      var n = randUnit(r);
      if (r() < 0.5) n = [n[0] * 0.4, 1, n[2] * 0.4];   // mostly face-on to the orbital plane
      this.normals.push([n[0], n[1], n[2], r.sign()]);
    }
    this.disks = [];
    for (k = 0; k < this.ng; k++) this.disks.push([r.uniform(0.28, 0.42), r.uniform(1.6, 2.2), 0, 0]);
    this.hues = [r.uniform(0.55, 0.7), r.uniform(0.75, 0.9), r.uniform(0.62, 0.8)].sort(function () { return r() - 0.5; });
    this.timeScale = r.uniform(0.11, 0.15);
    this.camR = new Drift(r, 8, 11, [25, 50]);
    this.camH = new Drift(r, 2, 6.5, [25, 50]);
    this.camSpeed = r.sign() * r.uniform(0.02, 0.04);
    this.trail = r.uniform(0.45, 0.65);
    this.duration = [70, 110];
    this.src.bind();
    program('gal.init', GAL_INIT_FS).use(this.coreUniforms({ uPW: PW, uSeed: r.bits() }));
    fullscreen();
  }, 'Galaxy', 0.9, 'galaxy');
  Galaxy.prototype.coreUniforms = function (u) {
    function flat(list, f) { var o = []; for (var i = 0; i < 3; i++) o = o.concat(i < list.length ? f(list[i]) : [0, 0, 0, 0]); return o; }
    u.uNG = this.ng; u.uEps = this.eps;
    u.uCore = flat(this.cores, function (c) { return c[0].concat(c[2]); });
    u.uCoreV = flat(this.cores, function (c) { return c[1].concat(0); });
    u.uNormal = flat(this.normals, function (n) { return n; });
    u.uDisk = flat(this.disks, function (d) { return d; });
    return u;
  };
  Galaxy.prototype.advanceCores = function (h) {
    // mutual gravity between the cores (softened), leapfrog
    var cs = this.cores, soft = 0.25;
    var acc = cs.map(function (a, i) {
      var ax = 0, ay = 0, az = 0;
      cs.forEach(function (b, j) {
        if (i === j) return;
        var dx = b[0][0] - a[0][0], dy = b[0][1] - a[0][1], dz = b[0][2] - a[0][2];
        var r2 = dx * dx + dy * dy + dz * dz + soft * soft, f = b[2] / (r2 * Math.sqrt(r2));
        ax += dx * f; ay += dy * f; az += dz * f;
      });
      return [ax, ay, az];
    });
    cs.forEach(function (c, i) {
      for (var k = 0; k < 3; k++) { c[1][k] += acc[i][k] * h; c[0][k] += c[1][k] * h; }
    });
  };
  Galaxy.prototype.step = function (dt) {
    this.dt = dt;
    this.camR.update(dt); this.camH.update(dt);
    var sim = Math.min(dt, 0.07) * this.timeScale * 2, sub = 4;
    for (var i = 0; i < sub; i++) this.advanceCores(sim / sub);
    this.dst.bind();
    program('gal.step', GAL_STEP_FS).use(this.coreUniforms({
      uA: tex(0, this.src.tex[0]), uB: tex(1, this.src.tex[1]), uPW: PW, uDt: sim, uSub: sub
    }));
    fullscreen();
    flip(this);
  };
  Galaxy.prototype.draw = function () {
    this.fade(this.trail);
    var mt = 0, com = [0, 0, 0];
    this.cores.forEach(function (c) { mt += c[2]; for (var k = 0; k < 3; k++) com[k] += c[0][k] * c[2]; });
    com = com.map(function (x) { return x / mt; });
    var area = this.w * this.h / (1280 * 720);
    program('gal.draw', GLOW_FS, GAL_VS).use({
      uA: tex(0, this.src.tex[0]), uB: tex(1, this.src.tex[1]), uPW: PW, uPal: this.pal, uHue: this.hues,
      uMVP: orbitCamera(this.t, this.camR.value, this.camH.value, this.camSpeed, this.aspect, 0.8, com),
      uIntensity: 0.22 * area * (1 - this.trail) / 0.45 * (262144 / this.count), uSize: Math.max(1, this.h / 700)
    });
    this.points(null, this.count);
  };

  // ------------------------------------------------------------------- Ink
  var INK_SPLAT_FS = frag([
    'uniform sampler2D uSrc; uniform vec4 uPts[6], uCols[6]; uniform int uN, uDye; uniform float uAspect;',
    'void main() { vec4 c = texture(uSrc, vUv);',
    '  for (int i = 0; i < 6; i++) { if (i >= uN) break;',
    '    vec2 d = vUv - uPts[i].xy; d = d - floor(d + 0.5); d.x *= uAspect;',   // wrap-aware
    '    float g = exp(-dot(d, d) / uCols[i].a);',
    '    if (uDye == 1) c.rgb += uCols[i].rgb * g; else c.xy += uPts[i].zw * g; }',
    '  fragColor = c; }'
  ].join('\n'));
  var INK_ADVECT_FS = frag([
    'uniform sampler2D uVel, uSrc; uniform vec2 uVelTexel; uniform float uDt, uDissipation;',
    'void main() { vec2 v = texture(uVel, vUv).xy;',
    '  fragColor = texture(uSrc, vUv - uDt * v * uVelTexel) / (1.0 + uDissipation * uDt); }'
  ].join('\n'));
  var INK_NB = 'vec4 nb(sampler2D t) { return vec4(texture(t, vUv - vec2(uTexel.x, 0)).x, texture(t, vUv + vec2(uTexel.x, 0)).x,' +
    ' texture(t, vUv + vec2(0, uTexel.y)).x, texture(t, vUv - vec2(0, uTexel.y)).x); }\n';   // L R T B
  var INK_CURL_FS = frag([
    'uniform sampler2D uVel; uniform vec2 uTexel;',
    'void main() {',
    '  float L = texture(uVel, vUv - vec2(uTexel.x, 0)).y, R = texture(uVel, vUv + vec2(uTexel.x, 0)).y;',
    '  float T = texture(uVel, vUv + vec2(0, uTexel.y)).x, B = texture(uVel, vUv - vec2(0, uTexel.y)).x;',
    '  fragColor = vec4(0.5 * (R - L - T + B), 0, 0, 1); }'
  ].join('\n'));
  var INK_VORT_FS = frag([
    'uniform sampler2D uVel, uCurl; uniform vec2 uTexel; uniform float uCurlStrength, uDt;',
    INK_NB,
    'void main() { vec4 n = nb(uCurl); float C = texture(uCurl, vUv).x;',
    '  vec2 f = 0.5 * vec2(abs(n.z) - abs(n.w), abs(n.y) - abs(n.x)); f /= length(f) + 1e-4;',
    '  f *= uCurlStrength * C; f.y *= -1.0;',
    '  fragColor = vec4(clamp(texture(uVel, vUv).xy + f * uDt, -1000.0, 1000.0), 0, 1); }'
  ].join('\n'));
  var INK_DIV_FS = frag([
    'uniform sampler2D uVel; uniform vec2 uTexel;',
    'void main() {',
    '  float L = texture(uVel, vUv - vec2(uTexel.x, 0)).x, R = texture(uVel, vUv + vec2(uTexel.x, 0)).x;',
    '  float T = texture(uVel, vUv + vec2(0, uTexel.y)).y, B = texture(uVel, vUv - vec2(0, uTexel.y)).y;',
    '  fragColor = vec4(0.5 * (R - L + T - B), 0, 0, 1); }'
  ].join('\n'));
  var INK_PRESSURE_FS = frag([
    'uniform sampler2D uP, uDiv; uniform vec2 uTexel;', INK_NB,
    'void main() { vec4 n = nb(uP); fragColor = vec4((n.x + n.y + n.z + n.w - texture(uDiv, vUv).x) * 0.25, 0, 0, 1); }'
  ].join('\n'));
  var INK_GRAD_FS = frag([
    'uniform sampler2D uP, uVel; uniform vec2 uTexel;', INK_NB,
    'void main() { vec4 n = nb(uP); fragColor = vec4(texture(uVel, vUv).xy - vec2(n.y - n.x, n.z - n.w) * 0.5, 0, 1); }'
  ].join('\n'));
  var INK_SCALE_FS = frag('uniform sampler2D uSrc; uniform float uK;\nvoid main() { fragColor = texture(uSrc, vUv) * uK; }');
  var INK_SHOW_FS = frag([
    'uniform sampler2D uDye; uniform vec2 uTexel; uniform float uShade;',
    'float lum(vec2 o) { return dot(texture(uDye, vUv + o).rgb, vec3(0.33)); }',
    'void main() { vec3 c = texture(uDye, vUv).rgb;',
    '  float l = lum(-vec2(uTexel.x, 0)), r = lum(vec2(uTexel.x, 0)), d = lum(-vec2(0, uTexel.y)), u = lum(vec2(0, uTexel.y));',
    '  vec3 n = normalize(vec3((l - r) * uShade, (d - u) * uShade, 1.0));',
    '  float diff = clamp(dot(n, normalize(vec3(-0.4, 0.6, 0.8))) * 1.15, 0.55, 1.3);',
    // soft-clip so dense ink saturates gracefully instead of blowing out
    '  c = c / (1.0 + 0.2 * dot(c, vec3(0.33)));',
    '  fragColor = vec4(c * diff * 1.8, 1.0); }'
  ].join('\n'));

  function Brush(r) {
    this.x = r(); this.y = r();
    this.speed = r.uniform(0.07, 0.13);
    this.heading = r.uniform(0, Math.PI * 2);
    this.turn = new Drift(r, -0.9, 0.9, [3, 9]);
    this.hue = new Drift(r, 0.55, 0.9, [10, 25]);
    this.on = new Drift(r, 0, 1, [4, 12]);
    this.vx = this.vy = 0;
  }
  Brush.prototype.update = function (dt) {
    this.turn.update(dt); this.hue.update(dt); this.on.update(dt);
    this.heading += this.turn.value * dt;
    this.vx = Math.cos(this.heading) * this.speed;
    this.vy = Math.sin(this.heading) * this.speed;
    this.x = ((this.x + this.vx * dt) % 1 + 1) % 1;
    this.y = ((this.y + this.vy * dt) % 1 + 1) % 1;
  };
  function Pair(scene, w, h, filter) {
    this.src = scene.keep(new Target(w, h, F16, filter, gl.REPEAT));
    this.dst = scene.keep(new Target(w, h, F16, filter, gl.REPEAT));
  }
  Pair.prototype.swap = function () { var t = this.src; this.src = this.dst; this.dst = t; };

  var Ink = extend(function Ink(r, w, h) {
    Scene.call(this, r, w, h);
    this.vw = Math.max(32, w >> 2); this.vh = Math.max(32, h >> 2);
    this.vel = new Pair(this, this.vw, this.vh, gl.LINEAR);
    this.dye = new Pair(this, w, h, gl.LINEAR);
    this.prs = new Pair(this, this.vw, this.vh, gl.LINEAR);
    this.div = this.keep(new Target(this.vw, this.vh, F16, gl.NEAREST, gl.REPEAT));
    this.curl = this.keep(new Target(this.vw, this.vh, F16, gl.NEAREST, gl.REPEAT));
    var n = r.choice([2, 3, 3, 4]);
    this.brushes = [];
    for (var i = 0; i < n; i++) this.brushes.push(new Brush(r));
    this.curlStrength = r.uniform(6, 14);
    this.dyeFade = new Drift(r, 0.16, 0.28, [20, 40]);
    this.velFade = r.uniform(0.25, 0.5);
    this.force = r.uniform(140, 220);
    this.nextPuff = r.uniform(5, 12);
    this.duration = [50, 90];
  }, 'Ink', 0.75, 'ink');
  Ink.prototype.pass = function (key, fs, dst, u) {
    dst.bind();
    program(key, fs).use(u);
    fullscreen();
  };
  Ink.prototype.step = function (dt) {
    dt = Math.min(dt, 1 / 20);
    this.dyeFade.update(dt);
    var pts = [], cols = [], self = this;
    this.brushes.forEach(function (b) {
      b.update(dt);
      var on = Math.max(0, (b.on.value - 0.25) / 0.75);
      if (on <= 0.01) return;
      var col = palSample(self.palName, b.hue.value), k = on * dt * 4, f = self.vw * self.force * on * dt;
      pts.push(b.x, b.y, b.vx * f, b.vy * f);
      cols.push(col[0] * k, col[1] * k, col[2] * k, 0.00008 + 0.00012 * on);
    });
    if (this.t > this.nextPuff) {
      this.nextPuff = this.t + this.r.uniform(8, 18);
      var a = this.r.uniform(0, Math.PI * 2), col = palSample(this.palName, this.r.uniform(0.6, 1)), m = this.vw * 0.6;
      pts.push(this.r(), this.r(), Math.cos(a) * m, Math.sin(a) * m);
      cols.push(col[0] * 1.2, col[1] * 1.2, col[2] * 1.2, 0.0015);
    }
    var vt = [1 / this.vw, 1 / this.vh], np = pts.length / 4;
    if (np) {
      while (pts.length < 24) { pts.push(0); cols.push(0); }
      [this.vel, this.dye].forEach(function (pp, dye) {
        self.pass('ink.splat', INK_SPLAT_FS, pp.dst, { uSrc: tex(0, pp.src), uN: np, uDye: dye, uAspect: self.aspect, uPts: pts, uCols: cols });
        pp.swap();
      });
    }
    // vorticity confinement
    this.pass('ink.curl', INK_CURL_FS, this.curl, { uVel: tex(0, this.vel.src), uTexel: vt });
    this.pass('ink.vort', INK_VORT_FS, this.vel.dst, { uVel: tex(0, this.vel.src), uCurl: tex(1, this.curl), uTexel: vt, uCurlStrength: this.curlStrength, uDt: dt });
    this.vel.swap();
    // projection: make the flow divergence-free
    this.pass('ink.div', INK_DIV_FS, this.div, { uVel: tex(0, this.vel.src), uTexel: vt });
    this.pass('ink.scale', INK_SCALE_FS, this.prs.dst, { uSrc: tex(0, this.prs.src), uK: 0.8 });
    this.prs.swap();
    var p = program('ink.pressure', INK_PRESSURE_FS).use({ uDiv: tex(1, this.div), uTexel: vt });
    for (var i = 0; i < 20; i++) {
      this.prs.dst.bind();
      p.set({ uP: tex(0, this.prs.src) });
      fullscreen();
      this.prs.swap();
    }
    this.pass('ink.grad', INK_GRAD_FS, this.vel.dst, { uP: tex(0, this.prs.src), uVel: tex(1, this.vel.src), uTexel: vt });
    this.vel.swap();
    // advection (velocity in sim texels per second)
    this.pass('ink.advect', INK_ADVECT_FS, this.vel.dst, { uVel: tex(0, this.vel.src), uSrc: tex(1, this.vel.src), uVelTexel: vt, uDt: dt, uDissipation: this.velFade });
    this.vel.swap();
    this.pass('ink.advect', INK_ADVECT_FS, this.dye.dst, { uVel: tex(0, this.vel.src), uSrc: tex(1, this.dye.src), uVelTexel: vt, uDt: dt, uDissipation: this.dyeFade.value });
    this.dye.swap();
  };
  Ink.prototype.draw = function () {
    this.pass('ink.show', INK_SHOW_FS, this.out, { uDye: tex(0, this.dye.src), uTexel: [1 / this.w, 1 / this.h], uShade: 6 });
  };

  // --------------------------------------------------------- Particle Life
  // 4096 particles, every pair checked each step, as on Linux; species is index % K
  var LIFE_W = 64;
  var LIFE_INIT_FS = frag([
    'uniform uint uSeed; uniform int uMode; uniform vec2 uWorld;',
    'void main() { ivec2 c = ivec2(gl_FragCoord.xy); uint s = pcg(uint(c.y * ' + LIFE_W + ' + c.x) * 2654435761u + uSeed);',
    '  vec2 p; if (uMode == 0) p = vec2(rnd(s), rnd(s)) * uWorld;',
    '  else { float a = rnd(s) * TAU, r = sqrt(rnd(s)) * 0.3; p = uWorld * 0.5 + r * vec2(cos(a), sin(a)); }',
    '  fragColor = vec4(p, 0.0, 0.0); }'
  ].join('\n'));
  var LIFE_STEP_FS = frag([
    'uniform sampler2D uSrc; uniform float uM[36]; uniform int uN, uK; uniform uint uFrame;',
    'uniform float uRmax, uBeta, uFriction, uForce, uDt, uTemp; uniform vec2 uWorld;',
    'vec2 randGauss(inout uint s) { float u1 = max(1e-7, rnd(s)), u2 = rnd(s); float r = sqrt(-2.0 * log(u1));',
    '  return r * vec2(cos(TAU * u2), sin(TAU * u2)); }',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy); int i = c.y * ' + LIFE_W + ' + c.x; vec4 me = texelFetch(uSrc, c, 0);',
    '  int row = (i % uK) * uK; vec2 acc = vec2(0.0); float r2max = uRmax * uRmax;',
    '  for (int j = 0; j < 4096; j++) { if (j >= uN) break;',
    '    vec2 d = texelFetch(uSrc, ivec2(j % ' + LIFE_W + ', j / ' + LIFE_W + '), 0).xy - me.xy;',
    '    d -= uWorld * floor(d / uWorld + 0.5); float r2 = dot(d, d);',
    '    if (r2 > 1e-10 && r2 < r2max) { float r = sqrt(r2), x = r / uRmax;',
    '      float f = x < uBeta ? x / uBeta - 1.0 : uM[row + j % uK] * (1.0 - abs(2.0 * x - 1.0 - uBeta) / (1.0 - uBeta));',
    '      acc += d / r * f; } }',
    '  acc *= uRmax * uForce;',
    '  uint s = pcg(uint(i) * 9781u + uFrame * 6271u); acc += randGauss(s) * uTemp;',
    '  vec2 v = me.zw * uFriction + acc * uDt;',
    '  fragColor = vec4(mod(me.xy + v * uDt, uWorld), v); }'
  ].join('\n'));
  var LIFE_VS = HEAD + COMMON + PAL + [
    'uniform sampler2D uSrc; uniform vec2 uWorld; uniform float uSize, uIntensity, uHues[8]; uniform int uK;',
    'out vec3 vCol;',
    'void main() {',
    '  vec4 p = texelFetch(uSrc, ivec2(gl_VertexID % ' + LIFE_W + ', gl_VertexID / ' + LIFE_W + '), 0);',
    '  gl_Position = vec4(p.xy / uWorld * 2.0 - 1.0, 0.0, 1.0);',
    '  vCol = pal(uHues[gl_VertexID % uK]) * uIntensity * (0.8 + 0.6 * clamp(length(p.zw) * 4.0, 0.0, 1.0));',
    '  gl_PointSize = uSize; }'
  ].join('\n');
  var LIFE_FS = HEAD + 'in vec3 vCol;\nout vec4 fragColor;\nvoid main() { vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d);\n' +
    '  fragColor = vec4(vCol * (exp(-r2 * 3.5) + 0.6 * exp(-r2 * 18.0)), 1.0); }';

  var Life = extend(function Life(r, w, h) {
    Scene.call(this, r, w, h);
    this.k = r.choice([3, 4, 4, 5, 5, 6]);
    this.n = MOBILE ? 2048 : 4096;
    this.world = [this.aspect, 1];
    this.a = this.keep(new Target(LIFE_W, this.n / LIFE_W, F32, gl.NEAREST));
    this.b = this.keep(new Target(LIFE_W, this.n / LIFE_W, F32, gl.NEAREST));
    this.mat = [];
    for (var i = 0; i < this.k * this.k; i++) this.mat.push(new Drift(r, -1, 1, [25, 70]));
    this.temp = new Drift(r, 0, 0.6, [15, 40], 0);
    this.rmax = r.uniform(0.09, 0.115);
    this.beta = 0.3;
    this.force = r.uniform(8, 12);
    this.trail = r.uniform(0.55, 0.75);
    this.frame = 0;
    var hues = [];
    for (i = 0; i < this.k; i++) hues.push(0.42 + 0.53 * i / Math.max(1, this.k - 1));
    hues.sort(function () { return r() - 0.5; });
    while (hues.length < 8) hues.push(0.8);
    this.hues = hues;
    this.heatAt = r.uniform(25, 50);
    this.duration = [50, 90];
    this.a.bind();
    program('life.init', LIFE_INIT_FS).use({ uSeed: r.bits(), uMode: r.choice([0, 0, 1]), uWorld: this.world });
    fullscreen();
  }, 'Particle Life', 1.0, 'life');
  Life.prototype.step = function (dt) {
    this.dt = dt;
    this.mat.forEach(function (m) { m.update(dt); });
    var T = this.temp;
    T.update(dt);
    if (this.t > this.heatAt) {
      // an occasional heat wave melts the structures before they re-form
      T.a = T.value; T.b = this.r.uniform(0.8, 1.2); T.u = 0; T.dur = this.r.uniform(5, 9);
      this.heatAt = this.t + this.r.uniform(35, 60);
    } else if (T.u > 0.98 && T.value > 0.75) {
      T.a = T.value; T.b = 0; T.u = 0; T.dur = this.r.uniform(8, 14);
    }
    var simDt = 0.02 * Math.min(2, dt * 30) * 0.8;
    var m = this.mat.map(function (d) { return d.value; });
    while (m.length < 36) m.push(0);
    var p = program('life.step', LIFE_STEP_FS).use({
      uM: m, uN: this.n, uK: this.k, uFrame: this.frame, uRmax: this.rmax, uBeta: this.beta,
      uFriction: Math.pow(0.5, simDt / 0.04), uForce: this.force, uDt: simDt, uTemp: T.value * 2, uWorld: this.world
    });
    for (var i = 0; i < 2; i++) {
      this.b.bind();
      p.set({ uSrc: tex(0, this.a) });
      fullscreen();
      var t = this.a; this.a = this.b; this.b = t;
    }
    this.frame++;
  };
  Life.prototype.draw = function () {
    this.fade(this.trail);
    program('life.draw', LIFE_FS, LIFE_VS).use({
      uSrc: tex(0, this.a), uWorld: this.world, uSize: Math.max(3, this.h * 0.0085),
      uIntensity: 0.27 * (1 - this.trail) / 0.35, uK: this.k, uHues: this.hues, uPal: this.pal
    });
    this.points(null, this.n);
  };

  // ============================================================== Cymatics
  // Sand on a vibrating plate (Chladni, 1787; the physics behind a steelpan
  // note). Grains are thrown about where the plate moves and come to rest on
  // the nodal lines, where it doesn't. The plate glides from one mode to the
  // next, so the figure dissolves and redraws itself.
  function besselJ(n, x) {   // (1/2π)∫ cos(nτ − x sin τ) dτ, exact enough for x < 30
    var s = 0, N = 64;
    for (var i = 0; i < N; i++) { var t = i * 2 * Math.PI / N; s += Math.cos(n * t - x * Math.sin(t)); }
    return s / N;
  }
  var BESSEL_ZEROS = {};
  function besselZero(n, k) {   // k-th positive zero of J_n
    var key = n + ':' + k;
    if (BESSEL_ZEROS[key]) return BESSEL_ZEROS[key];
    var found = 0, x = 0.5, prev = besselJ(n, x);
    while (x < 40) {
      var nx = x + 0.05, v = besselJ(n, nx);
      if (prev * v < 0) {
        var lo = x, hi = nx;
        for (var i = 0; i < 40; i++) { var m = (lo + hi) / 2; if (besselJ(n, lo) * besselJ(n, m) <= 0) hi = m; else lo = m; }
        if (++found === k) return (BESSEL_ZEROS[key] = (lo + hi) / 2);
      }
      x = nx; prev = v;
    }
    return 10;
  }
  var CY_MODE = [
    'uniform vec4 uModeA, uModeB; uniform float uMix; uniform int uShape; uniform vec2 uWorld;',
    'float besselJ(float n, float x) { float s = 0.0; for (int i = 0; i < 28; i++) { float t = float(i) * TAU / 28.0;',
    '  s += cos(n * t - x * sin(t)); } return s / 28.0; }',
    // uShape 0: rectangular plate, u = cos(nπx)cos(mπy) ± cos(mπx)cos(nπy)
    // uShape 1: circular membrane (a drum, or one note of a pan), u = J_n(k r) cos(nθ + φ)
    'float plate(vec4 m, vec2 p) {',
    '  if (uShape == 0) { vec2 q = p / uWorld;',
    '    return cos(m.x * PI * q.x) * cos(m.y * PI * q.y) + m.w * cos(m.y * PI * q.x) * cos(m.x * PI * q.y); }',
    '  vec2 c = (p - uWorld * 0.5) / 0.47; float r = length(c);',
    '  if (r > 1.0) return 0.0;',
    '  return 2.2 * besselJ(m.x, m.y * r) * cos(m.x * atan(c.y, c.x) + m.z); }',
    'float field(vec2 p) { return mix(plate(uModeA, p), plate(uModeB, p), uMix); }',
    ''
  ].join('\n');
  var CY_FIELD_FS = frag(CY_MODE + 'void main() { fragColor = vec4(field(vUv * uWorld), 0.0, 0.0, 1.0); }');
  var CY_INIT_FS = fragMRT([
    'uniform uint uSeed; uniform vec2 uWorld;',
    'void main() { uint s = pcg(indexOf(ivec2(gl_FragCoord.xy)) * 747796405u + uSeed);',
    '  outA = vec4(vec2(rnd(s), rnd(s)) * uWorld, 0.0, 0.0); outB = vec4(0.0); }'
  ].join('\n'));
  var CY_STEP_FS = fragMRT([
    'uniform sampler2D uA, uField; uniform vec2 uWorld; uniform uint uSeed, uFrame; uniform int uShape;',
    'uniform float uKick, uDrift;',
    'float U(vec2 p) { return texture(uField, p / uWorld).r; }',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uA, c, 0); vec2 p = a.xy;',
    '  uint s = pcg(indexOf(c) * 9781u + uFrame * 6271u + uSeed);',
    '  float u = U(p), A = abs(u); const float e = 0.004;',
    '  vec2 g = vec2(U(p + vec2(e, 0.0)) * U(p + vec2(e, 0.0)) - U(p - vec2(e, 0.0)) * U(p - vec2(e, 0.0)),',
    '                U(p + vec2(0.0, e)) * U(p + vec2(0.0, e)) - U(p - vec2(0.0, e)) * U(p - vec2(0.0, e))) / (2.0 * e);',
    // thrown about in proportion to the local amplitude, sliding down towards the nodes
    '  p += randGauss(s) * uKick * A - g * uDrift;',
    '  if (uShape == 0) { p = abs(p); p = uWorld - abs(uWorld - p); }',
    '  else { vec2 d = p - uWorld * 0.5; float r = length(d); if (r > 0.47) p = uWorld * 0.5 + d / r * (0.94 - r); }',
    '  outA = vec4(p, A, 0.0); outB = vec4(0.0); }'
  ].join('\n'));
  var CY_SPLAT_VS = HEAD + [
    'uniform sampler2D uA; uniform int uPW; uniform vec2 uWorld;',
    'void main() { vec4 a = texelFetch(uA, ivec2(gl_VertexID % uPW, gl_VertexID / uPW), 0);',
    '  gl_Position = vec4(a.xy / uWorld * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = 1.0; }'
  ].join('\n');
  var CY_SPLAT_FS = HEAD + 'out vec4 fragColor;\nvoid main() { fragColor = vec4(1.0); }';
  var CY_SHOW_FS = frag([
    'uniform sampler2D uCount, uField; uniform float uRef; uniform int uShape; uniform vec2 uWorld;',
    'void main() {',
    '  float n = texture(uCount, vUv).r; float v = clamp(log(1.0 + n) / log(1.0 + uRef), 0.0, 1.3);',
    '  float u = texture(uField, vUv).r; vec2 p = vUv * uWorld;',
    '  float plateMask = 1.0;',
    '  if (uShape == 1) { float r = length(p - uWorld * 0.5) / 0.47; plateMask = smoothstep(1.02, 0.98, r);',
    '    plateMask += 0.25 * exp(-pow((r - 1.0) * 60.0, 2.0)); }',
    // the plate itself: a faint sheen where it moves
    '  vec3 col = pal(0.18) * (0.05 + 0.10 * abs(u)) * plateMask;',
    '  col += pal(0.35 + 0.6 * v) * v * v * 1.1;',
    '  fragColor = vec4(col, 1.0); }'
  ].join('\n'), true);

  var Cymatics = extend(function Cymatics(r, w, h) {
    Scene.call(this, r, w, h);
    particles(this, Math.min((1 << 18) * PCAP, Math.max((1 << 16) * PCAP, w * h * 0.16)), 2);
    this.world = [this.aspect, 1];
    this.shape = r() < 0.55 ? 0 : 1;
    this.fw = Math.max(64, w >> 1); this.fh = Math.max(64, h >> 1);
    this.field = this.keep(new Target(this.fw, this.fh, F16, gl.LINEAR));
    this.count2 = this.keep(new Target(w, h, F16, gl.NEAREST));
    this.seed = r.bits();
    this.frame = 0;
    this.modeA = this.pickMode(null); this.modeB = this.modeA;
    this.mix = 0; this.gliding = -1;
    this.nextMode = r.uniform(9, 14);
    this.duration = [55, 90];
    this.src.bind();
    program('cy.init', CY_INIT_FS).use({ uPW: PW, uSeed: this.seed, uWorld: this.world });
    fullscreen();
  }, 'Cymatics', 1.0, 'cymatics');
  Cymatics.prototype.pickMode = function (prev) {
    var r = this.r;
    for (var tries = 0; tries < 50; tries++) {
      var m;
      if (this.shape === 0) {
        var n = 1 + Math.floor(r() * 8), k = 1 + Math.floor(r() * 9);
        if (n === k) continue;
        if (prev && Math.abs(n - prev.n) + Math.abs(k - prev.m) > 4) continue;
        m = { n: n, m: k, sign: r.sign(), v: [n, k, 0, r.sign()] };
      } else {
        var a = 1 + Math.floor(r() * 7), z = 2 + Math.floor(r() * 4);
        if (prev && Math.abs(a - prev.n) + Math.abs(z - prev.m) > 3) continue;
        var kz = besselZero(a, z);
        m = { n: a, m: z, k: kz, v: [a, kz, r.uniform(0, Math.PI * 2), 0] };
      }
      if (prev && m.n === prev.n && m.m === prev.m) continue;
      return m;
    }
    return this.shape === 0 ? { n: 2, m: 5, sign: -1, v: [2, 5, 0, -1] } : { n: 2, m: 2, k: besselZero(2, 2), v: [2, besselZero(2, 2), 0, 0] };
  };
  // relative frequency of a mode: n² + m² for the plate, the Bessel zero for the membrane
  Cymatics.prototype.freq = function (m) { return this.shape === 0 ? m.n * m.n + m.m * m.m : m.k; };
  Cymatics.prototype.step = function (dt) {
    this.dt = dt;
    if (this.gliding < 0 && this.t > this.nextMode) {
      this.modeB = this.pickMode(this.modeA);
      this.gliding = 0;
    }
    if (this.gliding >= 0) {
      this.gliding += dt / 2.5;
      this.mix = smooth(Math.min(1, this.gliding));
      if (this.gliding >= 1) { this.modeA = this.modeB; this.mix = 0; this.gliding = -1; this.nextMode = this.t + this.r.uniform(9, 15); }
    }
    var modes = { uModeA: this.modeA.v, uModeB: this.modeB.v, uMix: this.mix, uShape: this.shape, uWorld: this.world };
    this.field.bind();
    program('cy.field', CY_FIELD_FS).use(modes);
    fullscreen();
    var k = Math.min(2, dt * 30);
    this.dst.bind();
    program('cy.step', CY_STEP_FS).use({
      uA: tex(0, this.src.tex[0]), uField: tex(1, this.field), uPW: PW, uWorld: this.world, uSeed: this.seed,
      uFrame: this.frame, uShape: this.shape, uKick: 0.0045 * k, uDrift: 0.0006 * k
    });
    fullscreen();
    flip(this);
    this.frame++;
  };
  Cymatics.prototype.draw = function () {
    this.count2.bind();
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    program('cy.splat', CY_SPLAT_FS, CY_SPLAT_VS).use({ uA: tex(0, this.src.tex[0]), uPW: PW, uWorld: this.world });
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
    var area = this.shape === 0 ? this.w * this.h : Math.PI * Math.pow(0.47 * this.h, 2);
    this.out.bind();
    program('cy.show', CY_SHOW_FS).use({
      uCount: tex(0, this.count2), uField: tex(1, this.field), uRef: this.count / area * 5, uShape: this.shape,
      uWorld: this.world, uPal: this.pal
    });
    fullscreen();
  };

  // ================================================================ Turing
  // Jonathan McCabe's multi-scale Turing patterns (2010). One substance, and
  // at every pixel several activator/inhibitor pairs (a small blur against a
  // larger one) at different scales. The scale whose two blurs agree most
  // wins, and pushes the value up or down. Each scale has a colour, and a
  // pixel's colour drifts towards the colour of the scale that keeps winning.
  var TU_STEP_FS = frag([
    'uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uRA[5], uRI[5], uStep[5], uW[5]; uniform vec3 uCol[5];',
    'uniform int uN;',
    'float disc(vec2 uv, float r) {',   // mean over a disc of radius r texels, from the mip level that suits it
    '  float lod = log2(max(1.0, r * 0.55)); vec2 px = uTexel * r;',
    '  float s = 2.0 * textureLod(uSrc, uv, lod).r;',
    '  for (int i = 0; i < 6; i++) { float a = float(i) * TAU / 6.0 + 0.3; s += textureLod(uSrc, uv + vec2(cos(a), sin(a)) * px * 0.5, lod).r; }',
    '  for (int i = 0; i < 8; i++) { float a = float(i) * TAU / 8.0; s += textureLod(uSrc, uv + vec2(cos(a), sin(a)) * px * 0.92, lod).r; }',
    '  return s / 16.0; }',
    'void main() {',
    '  vec2 uv = vUv; vec4 c = textureLod(uSrc, uv, 0.0);',
    '  float best = 1e9, push = 0.0; int win = 0;',
    '  for (int i = 0; i < 5; i++) { if (i >= uN) break;',
    '    float d = disc(uv, uRA[i]) - disc(uv, uRI[i]); float v = abs(d) * uW[i];',
    '    if (v < best) { best = v; push = sign(d) * uStep[i]; win = i; } }',
    '  float v = clamp(c.r + push, -1.0, 1.0);',
    '  vec3 col = mix(c.gba, uCol[win], 0.04);',
    '  fragColor = vec4(v, col); }'
  ].join('\n'));
  var TU_INIT_FS = frag([
    'uniform float uSeed;',
    'void main() { vec2 p = gl_FragCoord.xy; fragColor = vec4(hash12(p + uSeed) * 2.0 - 1.0, 0.0, 0.0, 0.0); }'
  ].join('\n'));
  var TU_SHOW_FS = frag([
    'uniform sampler2D uSrc; uniform vec2 uTexel; uniform vec3 uLight; uniform float uShadow;',
    'void main() {',
    '  vec4 c = texture(uSrc, vUv); float v = 0.5 + 0.5 * c.r;',
    '  float l = texture(uSrc, vUv - vec2(uTexel.x, 0.0)).r, r = texture(uSrc, vUv + vec2(uTexel.x, 0.0)).r;',
    '  float d = texture(uSrc, vUv - vec2(0.0, uTexel.y)).r, u = texture(uSrc, vUv + vec2(0.0, uTexel.y)).r;',
    '  vec3 n = normalize(vec3((l - r) * 2.0, (d - u) * 2.0, 1.0));',
    '  float sh = 1.0;',
    '  if (uShadow > 0.5) { vec2 dir = normalize(uLight.xy); float h0 = v * 6.0;',
    '    for (int k = 1; k <= 20; k++) { float t = float(k) * 2.0; float hq = (0.5 + 0.5 * texture(uSrc, vUv + dir * t * uTexel).r) * 6.0;',
    '      sh = min(sh, clamp(1.0 - (hq - h0 - t * 0.25), 0.0, 1.0)); }',
    '    sh = 0.35 + 0.65 * sh; }',
    '  float light = (0.55 + 0.6 * max(dot(n, normalize(uLight)), 0.0)) * sh;',
    '  vec3 col = c.gba * (0.08 + 1.1 * v * v) * light;',
    '  fragColor = vec4(col * 0.75, 1.0); }'
  ].join('\n'));

  function mipTarget(w, h) {
    var t = new Target(w, h, F16, gl.LINEAR, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }
  var Turing = extend(function Turing(r, w, h) {
    Scene.call(this, r, w, h);
    var k = Math.min(1, Math.sqrt(0.45e6 / (w * h)));
    this.tw = Math.max(128, Math.round(w * k)); this.th = Math.max(96, Math.round(h * k));
    this.a = this.keep(mipTarget(this.tw, this.th));
    this.b = this.keep(mipTarget(this.tw, this.th));
    // McCabe's example scales (for a 1024 px field): activators 100, 20, 10, 5, 1 against inhibitors twice as wide
    var u = this.th / 1024, base = r.choice([[100, 20, 10, 5, 1], [80, 40, 16, 6, 2], [120, 50, 22, 9, 3]]);
    this.ra = base.map(function (x) { return Math.max(1.2, x * u * r.uniform(0.85, 1.15)); });
    this.ratio = r.uniform(1.8, 2.6);
    this.steps = [0.05, 0.04, 0.03, 0.02, 0.01].map(function (x) { return x * r.uniform(0.8, 1.2); });
    this.weights = [1, 1, 1, 1, 1].map(function () { return r.uniform(0.85, 1.15); });
    var pal = this.pal, cols = [];
    for (var i = 0; i < 5; i++) {
      var x = 0.3 + 0.65 * ((i * 0.37 + r()) % 1);
      var j = Math.min(4, Math.floor(x * 5)), f = x * 5 - j;
      for (var ch = 0; ch < 3; ch++) cols.push(pal[j * 3 + ch] + (pal[(j + 1) * 3 + ch] - pal[j * 3 + ch]) * f);
    }
    this.cols = cols;
    this.breathe = new Drift(r, 0.9, 1.12, [20, 45]);
    this.lightSpeed = r.sign() * r.uniform(0.05, 0.1);
    this.duration = [55, 90];
    this.a.bind();
    program('tu.init', TU_INIT_FS).use({ uSeed: r.uniform(0, 1000) });
    fullscreen();
    gl.bindTexture(gl.TEXTURE_2D, this.a.tex); gl.generateMipmap(gl.TEXTURE_2D);
  }, 'Turing', 1.0, 'turing');
  Turing.prototype.step = function (dt) {
    this.breathe.update(dt);
    var k = this.breathe.value, ratio = this.ratio;
    var p = program('tu.step', TU_STEP_FS).use({
      uTexel: [1 / this.tw, 1 / this.th], uN: 5, uStep: this.steps, uW: this.weights, uCol: this.cols,
      uRA: this.ra.map(function (x) { return x * k; }), uRI: this.ra.map(function (x) { return x * k * ratio; })
    });
    var n = this.t < 3 ? 3 : 1;   // settle the noise quickly, then evolve at a calm pace
    for (var i = 0; i < n; i++) {
      this.b.bind();
      p.set({ uSrc: tex(0, this.a) });
      fullscreen();
      gl.bindTexture(gl.TEXTURE_2D, this.b.tex); gl.generateMipmap(gl.TEXTURE_2D);
      var t = this.a; this.a = this.b; this.b = t;
    }
  };
  Turing.prototype.draw = function () {
    this.out.bind();
    var la = this.t * this.lightSpeed;
    program('tu.show', TU_SHOW_FS).use({ uSrc: tex(0, this.a), uTexel: [1 / this.tw, 1 / this.th], uLight: [Math.cos(la), Math.sin(la), 1.2], uShadow: RAY ? 1 : 0 });
    fullscreen();
  };

  // =========================================================== Free Energy
  // Karl Friston's "primordial soup" ("Life as we know it", 2013): particles
  // that each carry a Lorenz attractor as their internal chemistry, pulled
  // together by neighbours whose chemistry is in step with theirs. They
  // self-assemble into a body, and a Markov blanket forms: an inner core
  // that only touches the outside world through a boundary layer.
  // Colours: inner core, blanket (the boundary), and the outside.
  var SOUP_W = 64;
  var SOUP_INIT_FS = fragMRT([
    'uniform uint uSeed; uniform vec2 uWorld;',
    'void main() { uint s = pcg(indexOf(ivec2(gl_FragCoord.xy)) * 2654435761u + uSeed);',
    '  vec2 p = uWorld * 0.5 + (vec2(rnd(s), rnd(s)) - 0.5) * uWorld * vec2(0.8, 0.85);',
    '  vec3 l = vec3(rnd(s) * 30.0 - 15.0, rnd(s) * 40.0 - 20.0, rnd(s) * 30.0 + 10.0);',
    '  outA = vec4(p, 0.0, 0.0); outB = vec4(l, 0.0); }'
  ].join('\n'));
  var SOUP_STEP_FS = fragMRT([
    'uniform sampler2D uA, uB; uniform int uN; uniform vec2 uWorld; uniform float uDt, uR0, uR, uAttract, uCouple, uTempo;',
    'vec3 lorenz(vec3 x) { return vec3(10.0 * (x.y - x.x), x.x * (28.0 - x.z) - x.y, x.x * x.y - 2.6666667 * x.z); }',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uA, c, 0), b = texelFetch(uB, c, 0);',
    '  vec2 p = a.xy, v = a.zw; vec3 x = b.xyz; int me = indexOf(c) == 0u ? 0 : int(indexOf(c));',
    '  vec2 f = vec2(0.0), dirSum = vec2(0.0); vec3 pull = vec3(0.0); float wsum = 0.0, n = 0.0;',
    '  for (int j = 0; j < 4096; j++) { if (j >= uN) break; if (j == me) continue;',
    '    ivec2 cj = ivec2(j % ' + SOUP_W + ', j / ' + SOUP_W + '); vec2 d = texelFetch(uA, cj, 0).xy - p; float r = length(d);',
    '    if (r < 1e-6) continue; vec2 dh = d / r;',
    '    if (r > uR) continue;',   // a faint long-range pull, so the clumps merge into one body
    '    vec3 xj = texelFetch(uB, cj, 0).xyz;',
    '    float w = 1.0 - r / uR;',
    // chemistry in step attracts, out of step repels; everything repels up close
    '    float sim = exp(-dot(xj - x, xj - x) / 300.0);',
    '    if (r < uR0) f -= dh * 1.5 * (uR0 - r) / (r + 0.002); else f += dh * uAttract * (sim - 0.3) * w;',
    '    pull += (xj - x) * w; dirSum += dh * w; wsum += w; n += 1.0; }',
    '  f -= (p - uWorld * 0.5) * 0.4;',                                // a weak pull to the middle
    '  float fl = length(f); if (fl > 60.0) f *= 60.0 / fl;',
    '  v = v * 0.86 + f * uDt; float vl = length(v); if (vl > 1.5) v *= 1.5 / vl; p += v * uDt;',
    '  p = clamp(p, vec2(0.01), uWorld - 0.01);',
    '  x += (lorenz(x) * uTempo + pull * uCouple / max(1.0, wsum)) * uDt;',
    '  if (any(isnan(x)) || length(x) > 200.0) x = vec3(1.0, 1.0, 25.0);',             // internal dynamics, coupled to the neighbours
    '  float asym = wsum > 0.0 ? length(dirSum) / wsum : 1.0;',          // near 1 at an edge, near 0 deep inside
    '  outA = vec4(p, v); outB = vec4(x, min(n, 30.0) + min(asym, 0.99)); }'
  ].join('\n').replace('int me = indexOf(c) == 0u ? 0 : int(indexOf(c));', 'int me = int(indexOf(c));'));
  var SOUP_VS = HEAD + COMMON + PAL + [
    'uniform sampler2D uA, uB; uniform vec2 uWorld; uniform float uSize, uIntensity;',
    'out vec3 vCol;',
    'void main() {',
    '  ivec2 c = ivec2(gl_VertexID % ' + SOUP_W + ', gl_VertexID / ' + SOUP_W + '); vec4 a = texelFetch(uA, c, 0), b = texelFetch(uB, c, 0);',
    '  gl_Position = vec4(a.xy / uWorld * 2.0 - 1.0, 0.0, 1.0);',
    '  float n = floor(b.w), asym = fract(b.w);',
    '  float inner = smoothstep(5.0, 9.0, n) * smoothstep(0.45, 0.25, asym);',
    '  float blanket = smoothstep(2.0, 5.0, n) * (1.0 - inner);',
    '  float shimmer = 0.75 + 0.25 * sin(b.x * 0.25);',
    '  vec3 col = pal(0.3) * 0.3;',                                     // outside: dim
    '  col = mix(col, pal(0.9) * 1.1, blanket);',                        // the blanket: bright
    '  col = mix(col, pal(0.45 + 0.15 * sin(b.z * 0.2)) * 0.5, inner);', // inside: deeper, shimmering with its chemistry
    '  vCol = col * shimmer * uIntensity;',
    '  gl_PointSize = uSize * (1.0 + 0.6 * blanket); }'
  ].join('\n');

  var Soup = extend(function Soup(r, w, h) {
    Scene.call(this, r, w, h);
    this.n = MOBILE ? 1024 : 2048;   // every pair is checked: a quarter of the work on phones
    this.world = [this.aspect, 1];
    this.src = this.keep(new State(SOUP_W, this.n / SOUP_W, 2));
    this.dst = this.keep(new State(SOUP_W, this.n / SOUP_W, 2));
    this.attract = r.uniform(1.0, 1.6);
    this.couple = r.uniform(0.9, 1.6);
    this.tempo = r.uniform(0.5, 0.9);
    this.r0 = 0.016; this.rr = 0.12;
    this.trail = r.uniform(0.55, 0.7);
    this.duration = [55, 90];
    this.src.bind();
    program('soup.init', SOUP_INIT_FS).use({ uPW: SOUP_W, uSeed: r.bits(), uWorld: this.world });
    fullscreen();
    this.warm = 40;   // extra steps spread over the first frames
  }, 'Free Energy', 0.9, 'soup');
  Soup.prototype.step = function (dt) {
    this.dt = dt;
    var p = program('soup.step', SOUP_STEP_FS).use({
      uPW: SOUP_W, uN: this.n, uWorld: this.world, uDt: 0.016 * Math.min(2, dt * 30), uR0: this.r0, uR: this.rr,
      uAttract: this.attract, uCouple: this.couple, uTempo: this.tempo
    });
    var extra = Math.min(this.warm, MOBILE ? 1 : 3);
    this.warm -= extra;
    for (var i = 0; i < 2 + 2 * extra; i++) {
      this.dst.bind();
      p.set({ uA: tex(0, this.src.tex[0]), uB: tex(1, this.src.tex[1]) });
      fullscreen();
      flip(this);
    }
  };
  Soup.prototype.draw = function () {
    this.fade(this.trail);
    program('soup.draw', GLOW_FS, SOUP_VS).use({
      uA: tex(0, this.src.tex[0]), uB: tex(1, this.src.tex[1]), uWorld: this.world, uPal: this.pal,
      uSize: Math.max(2, this.h * 0.0055), uIntensity: 0.3 * (1 - this.trail) / 0.4
    });
    this.points(null, this.n);
  };

  // ================================================================ Cosmos
  // A particle universe: gravity alone turns an almost even scatter of
  // matter into the cosmic web of filaments, walls, voids and halos. Gravity
  // is solved on a grid (particle-mesh): splat the mass, solve Poisson's
  // equation for the potential, and move every particle down its slope.
  var CO_INIT_FS = fragMRT([
    'uniform uint uSeed; uniform vec2 uWorld; uniform vec4 uModes[24]; uniform float uAmp; uniform int uNX; uniform int uN;',
    'vec2 gradPsi(vec2 q) { vec2 g = vec2(0.0);',   // a periodic random field from a handful of plane waves
    '  for (int i = 0; i < 24; i++) { vec4 m = uModes[i]; g += m.z * m.xy * cos(dot(m.xy, q) + m.w); } return g; }',
    'void main() {',
    '  int i = int(indexOf(ivec2(gl_FragCoord.xy))); uint s = pcg(uint(i) * 2246822519u + uSeed);',
    '  int nx = uNX, ny = (uN + nx - 1) / nx;',
    '  vec2 q = (vec2(float(i % nx), float(i / nx)) + 0.5 + (vec2(rnd(s), rnd(s)) - 0.5) * 0.6) / vec2(float(nx), float(ny)) * uWorld;',
    '  vec2 d = gradPsi(q) * uAmp;',   // Zel'dovich: displacement and velocity both follow the gradient of the field
    '  outA = vec4(mod(q + d, uWorld), d * 0.6); outB = vec4(0.0); }'
  ].join('\n'));
  var CO_SPLAT_VS = HEAD + [
    'uniform sampler2D uA; uniform int uPW; uniform vec2 uWorld; uniform float uSize;',
    'void main() { vec4 a = texelFetch(uA, ivec2(gl_VertexID % uPW, gl_VertexID / uPW), 0);',
    '  gl_Position = vec4(a.xy / uWorld * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = uSize; }'
  ].join('\n');
  var ONE_FS = HEAD + 'uniform float uMass;\nout vec4 fragColor;\nvoid main() { fragColor = vec4(uMass, 0.0, 0.0, 1.0); }';
  var CO_JACOBI_FS = frag([
    'uniform sampler2D uPhi, uRho; uniform float uG, uH2;',
    'void main() { ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uPhi, 0);',
    '  #define P(dx, dy) texelFetch(uPhi, (p + ivec2(dx, dy) + sz) % sz, 0).r',
    '  float src = uG * (texelFetch(uRho, p, 0).r - 1.0);',
    '  fragColor = vec4((P(1, 0) + P(-1, 0) + P(0, 1) + P(0, -1) - uH2 * src) * 0.25, 0.0, 0.0, 1.0); }'
  ].join('\n'));
  var CO_ACCEL_FS = frag([
    'uniform sampler2D uPhi; uniform float uInvH;',
    'void main() { ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uPhi, 0);',
    '  #define P(dx, dy) texelFetch(uPhi, (p + ivec2(dx, dy) + sz) % sz, 0).r',
    // also remove the mean potential slowly so the solve never drifts
    '  fragColor = vec4(-(P(1, 0) - P(-1, 0)) * 0.5 * uInvH, -(P(0, 1) - P(0, -1)) * 0.5 * uInvH, 0.0, 1.0); }'
  ].join('\n'));
  var CO_STEP_FS = fragMRT([
    'uniform sampler2D uA, uAcc; uniform vec2 uWorld; uniform float uDt, uDrag;',
    'void main() { ivec2 c = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uA, c, 0);',
    '  vec2 acc = texture(uAcc, a.xy / uWorld).xy;',
    '  vec2 v = a.zw * (1.0 - uDrag * uDt) + acc * uDt; vec2 p = mod(a.xy + v * uDt, uWorld);',
    '  outA = vec4(p, v); outB = vec4(0.0); }'
  ].join('\n'));
  var CO_SHOW_FS = frag([
    'uniform sampler2D uCount; uniform float uRef; uniform vec2 uTexel;',
    'float C(vec2 o) { return texture(uCount, vUv + o * uTexel).r; }',
    'void main() {',
    '  float n = C(vec2(0.0)) * 0.4 + (C(vec2(1, 0)) + C(vec2(-1, 0)) + C(vec2(0, 1)) + C(vec2(0, -1))) * 0.1',
    '    + (C(vec2(1, 1)) + C(vec2(-1, 1)) + C(vec2(1, -1)) + C(vec2(-1, -1))) * 0.05;',
    '  float v = clamp(log(1.0 + n) / log(1.0 + uRef), 0.0, 1.4);',
    '  vec3 col = pal(clamp(0.15 + 0.8 * v, 0.0, 1.0)) * (0.03 + 0.5 * v + 0.7 * v * v);',
    '  col += pal(0.98) * pow(max(v - 0.85, 0.0), 2.0) * 3.0;',       // halos burn white
    '  fragColor = vec4(col, 1.0); }'
  ].join('\n'), true);

  var Cosmos = extend(function Cosmos(r, w, h) {
    Scene.call(this, r, w, h);
    particles(this, Math.min((1 << 18) * PCAP, Math.max((1 << 16) * PCAP, w * h * 0.2)), 2);
    this.world = [this.aspect, 1];
    this.gh = 160; this.gw = Math.round(160 * this.aspect);
    this.rho = this.keep(new Target(this.gw, this.gh, F16, gl.NEAREST, gl.REPEAT));
    this.phiA = this.keep(new Target(this.gw, this.gh, F32, gl.NEAREST, gl.REPEAT));
    this.phiB = this.keep(new Target(this.gw, this.gh, F32, gl.NEAREST, gl.REPEAT));
    this.acc = this.keep(new Target(this.gw, this.gh, F16, gl.LINEAR, gl.REPEAT));
    this.dens = this.keep(new Target(w, h, F16, gl.LINEAR));
    // a red spectrum of plane waves: most power on large scales, periodic in the world
    var modes = [], L = this.world;
    for (var i = 0; i < 24; i++) {
      var kx = Math.round(r.uniform(-16, 16)), ky = Math.round(r.uniform(-12, 12));
      if (!kx && !ky) kx = 1;
      var k = [kx * 2 * Math.PI / L[0], ky * 2 * Math.PI / L[1]], kk = Math.hypot(k[0], k[1]);
      modes.push(k[0], k[1], Math.pow(kk, -1.7), r.uniform(0, Math.PI * 2));
    }
    this.G = r.uniform(0.35, 0.55);
    this.drag = r.uniform(0.25, 0.45);
    this.duration = [60, 95];
    var nx = Math.round(Math.sqrt(this.count * this.aspect));
    this.src.bind();
    program('co.init', CO_INIT_FS).use({ uPW: PW, uSeed: r.bits(), uWorld: this.world, uModes: modes, uAmp: r.uniform(0.12, 0.2), uNX: nx, uN: this.count });
    fullscreen();
  }, 'Cosmos', 1.0, 'cosmos');
  Cosmos.prototype.step = function (dt) {
    this.dt = dt;
    // mass onto the grid: mean density 1
    this.rho.bind();
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    program('co.splat', ONE_FS, CO_SPLAT_VS).use({ uA: tex(0, this.src.tex[0]), uPW: PW, uWorld: this.world, uSize: 1, uMass: this.gw * this.gh / this.count });
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
    // Poisson: ∇²φ = G(ρ − 1), warm-started from last frame's φ
    var grow = smooth(Math.min(1, this.t / 80)), h = 1 / this.gh;
    var jp = program('co.jacobi', CO_JACOBI_FS).use({ uRho: tex(1, this.rho), uG: this.G * (0.25 + 0.75 * grow), uH2: h * h });
    for (var i = 0; i < 30; i++) {
      this.phiB.bind();
      jp.set({ uPhi: tex(0, this.phiA) });
      fullscreen();
      var t = this.phiA; this.phiA = this.phiB; this.phiB = t;
    }
    this.acc.bind();
    program('co.accel', CO_ACCEL_FS).use({ uPhi: tex(0, this.phiA), uInvH: this.gh });
    fullscreen();
    this.dst.bind();
    program('co.step', CO_STEP_FS).use({
      uA: tex(0, this.src.tex[0]), uAcc: tex(1, this.acc), uWorld: this.world, uDt: Math.min(dt, 0.05) * 0.35, uDrag: this.drag
    });
    fullscreen();
    flip(this);
  };
  Cosmos.prototype.draw = function () {
    this.dens.bind();
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    program('co.splat', ONE_FS, CO_SPLAT_VS).use({ uA: tex(0, this.src.tex[0]), uPW: PW, uWorld: this.world, uSize: 1, uMass: 1 });
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
    this.out.bind();
    program('co.show', CO_SHOW_FS).use({ uCount: tex(0, this.dens), uRef: this.count / (this.w * this.h) * 25, uTexel: [1 / this.w, 1 / this.h], uPal: this.pal });
    fullscreen();
  };

  // ================================================================ Liquid
  // A particle fluid in a tank, solved the way production fluid tools do
  // (FLIP/PIC): particles carry the water, a grid enforces that it can't be
  // squeezed. Each step: particles to grid, gravity, pressure solve so the
  // flow is divergence-free, grid back to particles. The tank tilts slowly.
  var LQ_P2G_VS = HEAD + [
    'uniform sampler2D uA; uniform int uPW; uniform vec2 uGrid;',
    'flat out vec2 vG; flat out vec2 vV;',
    'void main() { vec4 a = texelFetch(uA, ivec2(gl_VertexID % uPW, gl_VertexID / uPW), 0);',
    '  vG = a.xy; vV = a.zw; gl_Position = vec4(a.xy / uGrid * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = 2.0; }'
  ].join('\n');
  var LQ_P2G_FS = HEAD + [
    'flat in vec2 vG; flat in vec2 vV; out vec4 fragColor;',
    'void main() { vec2 d = abs(gl_FragCoord.xy - vG); float w = max(0.0, 1.0 - d.x) * max(0.0, 1.0 - d.y);',
    '  fragColor = vec4(vV * w, w, 0.0); }'
  ].join('\n');
  var LQ_FORCES_FS = frag([
    'uniform sampler2D uSum; uniform vec2 uGravity; uniform float uDt;',
    'void main() { ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uSum, 0); vec4 s = texelFetch(uSum, p, 0);',
    '  vec2 v = s.z > 1e-4 ? s.xy / s.z : vec2(0.0); vec2 old = v;',
    '  if (s.z > 0.05) v += uGravity * uDt;',
    '  if (p.x == 0 || p.x == sz.x - 1) v.x = 0.0; if (p.y == 0 || p.y == sz.y - 1) v.y = 0.0;',
    '  fragColor = vec4(v, old); }'   // new velocity, and the one before forces (for FLIP)
  ].join('\n'));
  var LQ_DIV_FS = frag([
    'uniform sampler2D uVel, uSum; uniform float uRest, uPush;',
    'void main() { ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uVel, 0);',
    '  #define V(dx, dy) texelFetch(uVel, clamp(p + ivec2(dx, dy), ivec2(0), sz - 1), 0).xy',
    '  float w = texelFetch(uSum, p, 0).z; float d = 0.0;',
    '  if (w > 0.05) d = 0.5 * (V(1, 0).x - V(-1, 0).x + V(0, 1).y - V(0, -1).y) - uPush * max(0.0, w - uRest);',
    '  fragColor = vec4(d, w, 0.0, 1.0); }'
  ].join('\n'));
  var LQ_JACOBI_FS = frag([
    'uniform sampler2D uP, uDiv;',
    'void main() { ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uP, 0); vec2 dw = texelFetch(uDiv, p, 0).xy;',
    '  if (dw.y <= 0.05) { fragColor = vec4(0.0); return; }',   // air: free surface, p = 0
    '  #define P(dx, dy) texelFetch(uP, clamp(p + ivec2(dx, dy), ivec2(0), sz - 1), 0).r',
    '  fragColor = vec4((P(1, 0) + P(-1, 0) + P(0, 1) + P(0, -1) - dw.x) * 0.25, 0.0, 0.0, 1.0); }'
  ].join('\n'));
  var LQ_PROJECT_FS = frag([
    'uniform sampler2D uP, uVel;',
    'void main() { ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(uP, 0); vec4 v = texelFetch(uVel, p, 0);',
    '  #define P(dx, dy) texelFetch(uP, clamp(p + ivec2(dx, dy), ivec2(0), sz - 1), 0).r',
    '  v.xy -= 0.5 * vec2(P(1, 0) - P(-1, 0), P(0, 1) - P(0, -1));',
    '  if (p.x == 0 || p.x == sz.x - 1) v.x = 0.0; if (p.y == 0 || p.y == sz.y - 1) v.y = 0.0;',
    '  fragColor = v; }'
  ].join('\n'));
  var LQ_G2P_FS = fragMRT([
    'uniform sampler2D uA, uVel; uniform vec2 uGrid; uniform float uDt, uFlip; uniform uint uSeed, uFrame;',
    'void main() { ivec2 c = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uA, c, 0);',
    '  vec4 g = texture(uVel, a.xy / uGrid);',   // xy: velocity after the solve, zw: before forces
    '  vec2 v = mix(g.xy, a.zw + (g.xy - g.zw), uFlip);',
    '  uint s = pcg(indexOf(c) * 9781u + uFrame * 6271u + uSeed);',
    '  vec2 p = a.xy + g.xy * uDt + (vec2(rnd(s), rnd(s)) - 0.5) * 0.01;',
    '  p = clamp(p, vec2(1.01), uGrid - 1.01);',
    '  outA = vec4(p, v); outB = vec4(0.0); }'
  ].join('\n'));
  var LQ_DRAW_VS = HEAD + COMMON + PAL + [
    'uniform sampler2D uA; uniform int uPW; uniform vec2 uGrid; uniform float uSize, uFast, uIntensity;',
    'out vec3 vCol;',
    'void main() { vec4 a = texelFetch(uA, ivec2(gl_VertexID % uPW, gl_VertexID / uPW), 0);',
    '  float s = clamp(length(a.zw) / uFast, 0.0, 1.0);',
    '  vCol = (pal(0.3 + 0.6 * s) + pal(0.98) * pow(s, 4.0) * 0.8) * uIntensity * (0.5 + 0.8 * s);',
    '  gl_Position = vec4(a.xy / uGrid * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = uSize; }'
  ].join('\n');
  var LQ_INIT_FS = fragMRT([
    'uniform uint uSeed; uniform vec2 uGrid; uniform int uLayout, uN;',
    'void main() { int i = int(indexOf(ivec2(gl_FragCoord.xy))); uint s = pcg(uint(i) * 2654435761u + uSeed);',
    '  vec2 box = uLayout == 2 ? vec2(0.5, 0.42) : vec2(0.42, 0.85); vec2 o = uLayout == 0 ? vec2(0.0) : uLayout == 1 ? vec2(1.0 - box.x, 0.0) : vec2(0.25, 0.4);',
    '  vec2 q = (o + vec2(rnd(s), rnd(s)) * box) * (uGrid - 2.2) + 1.1;',
    '  outA = vec4(q, 0.0, 0.0); outB = vec4(0.0); }'
  ].join('\n'));

  var Liquid = extend(function Liquid(r, w, h) {
    Scene.call(this, r, w, h);
    this.gh = 72; this.gw = Math.round(72 * this.aspect);
    this.grid = [this.gw, this.gh];
    particles(this, this.gw * this.gh * 2.3, 2);
    this.sum = this.keep(new Target(this.gw, this.gh, F16, gl.NEAREST));
    this.vel = this.keep(new Target(this.gw, this.gh, F16, gl.LINEAR));
    this.vel2 = this.keep(new Target(this.gw, this.gh, F16, gl.LINEAR));
    this.div = this.keep(new Target(this.gw, this.gh, F16, gl.NEAREST));
    this.pA = this.keep(new Target(this.gw, this.gh, F16, gl.NEAREST));
    this.pB = this.keep(new Target(this.gw, this.gh, F16, gl.NEAREST));
    this.rock = r.uniform(0.25, 0.4); this.rockRate = r.uniform(0.35, 0.6);
    this.g = r.uniform(55, 75);
    this.seed = r.bits(); this.frame = 0;
    this.layout = r.choice([0, 1, 2]);   // dam break left, dam break right, a slab dropped in the middle
    this.duration = [55, 90];
    this.src.bind();
    program('lq.init', LQ_INIT_FS).use({ uPW: PW, uSeed: this.seed, uGrid: this.grid, uLayout: this.layout, uN: this.count });
    fullscreen();
  }, 'Liquid', 0.9, 'liquid');
  Liquid.prototype.substep = function (dt, gravity) {
    var G = this.grid;
    this.sum.bind();
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    program('lq.p2g', LQ_P2G_FS, LQ_P2G_VS).use({ uA: tex(0, this.src.tex[0]), uPW: PW, uGrid: G });
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
    this.vel.bind();
    program('lq.forces', LQ_FORCES_FS).use({ uSum: tex(0, this.sum), uGravity: gravity, uDt: dt });
    fullscreen();
    this.div.bind();
    program('lq.div', LQ_DIV_FS).use({ uVel: tex(0, this.vel), uSum: tex(1, this.sum), uRest: 7.0, uPush: 0.5 });
    fullscreen();
    var jp = program('lq.jacobi', LQ_JACOBI_FS).use({ uDiv: tex(1, this.div) });
    for (var i = 0; i < 40; i++) {
      this.pB.bind();
      jp.set({ uP: tex(0, this.pA) });
      fullscreen();
      var t = this.pA; this.pA = this.pB; this.pB = t;
    }
    this.vel2.bind();
    program('lq.project', LQ_PROJECT_FS).use({ uP: tex(0, this.pA), uVel: tex(1, this.vel) });
    fullscreen();
    this.dst.bind();
    program('lq.g2p', LQ_G2P_FS).use({
      uA: tex(0, this.src.tex[0]), uVel: tex(1, this.vel2), uPW: PW, uGrid: G, uDt: dt, uFlip: 0.93, uSeed: this.seed, uFrame: this.frame
    });
    fullscreen();
    flip(this);
    this.frame++;
  };
  Liquid.prototype.step = function (dt) {
    this.dt = dt;
    // rock the tank: a sideways push that swells and fades
    var a = this.rock * Math.sin(this.t * this.rockRate * 2 * Math.PI) * (0.6 + 0.4 * Math.sin(this.t * 0.11));
    var gravity = [Math.sin(a) * this.g, -Math.cos(a) * this.g];
    var h = Math.min(dt, 1 / 20) / 2;
    for (var i = 0; i < 2; i++) this.substep(h, gravity);
  };
  Liquid.prototype.draw = function () {
    this.fade(0.45);
    var cell = this.h / this.gh;
    program('lq.draw', GLOW_FS, LQ_DRAW_VS).use({
      uA: tex(0, this.src.tex[0]), uPW: PW, uGrid: this.grid, uSize: Math.max(2, cell * 0.55), uFast: this.g * 0.45,
      uIntensity: 0.32, uPal: this.pal
    });
    this.points(null, this.count);
  };

  // ================================================================== math
  // What each scene computes, shown when it starts and on request ("?").
  // Plain HTML: <i> for variables, <sup>/<sub>, and a few Unicode symbols.
  function num(x, d) { return (+x).toFixed(d === undefined ? 3 : d).replace(/^-/, '−'); }
  var CHAOS_EQ = {
    Lorenz: 'ẋ = 10(<i>y</i> − <i>x</i>)<br>ẏ = <i>x</i>(28 − <i>z</i>) − <i>y</i><br>ż = <i>xy</i> − 8⁄3 <i>z</i>',
    Aizawa: 'ẋ = (<i>z</i> − 0.7)<i>x</i> − 3.5<i>y</i><br>ẏ = 3.5<i>x</i> + (<i>z</i> − 0.7)<i>y</i><br>ż = 0.6 + 0.95<i>z</i> − <i>z</i><sup>3</sup>⁄3 − (<i>x</i><sup>2</sup> + <i>y</i><sup>2</sup>)(1 + 0.25<i>z</i>) + 0.1<i>zx</i><sup>3</sup>',
    Thomas: 'ẋ = sin <i>y</i> − <i>bx</i><br>ẏ = sin <i>z</i> − <i>by</i><br>ż = sin <i>x</i> − <i>bz</i>, &nbsp;<i>b</i> = 0.208186',
    Halvorsen: 'ẋ = −1.89<i>x</i> − 4<i>y</i> − 4<i>z</i> − <i>y</i><sup>2</sup><br>ẏ = −1.89<i>y</i> − 4<i>z</i> − 4<i>x</i> − <i>z</i><sup>2</sup><br>ż = −1.89<i>z</i> − 4<i>x</i> − 4<i>y</i> − <i>x</i><sup>2</sup>',
    Dadras: 'ẋ = <i>y</i> − 3<i>x</i> + 2.7<i>yz</i><br>ẏ = 1.7<i>y</i> − <i>xz</i> + <i>z</i><br>ż = 2<i>xy</i> − 9<i>z</i>',
    Rossler: 'ẋ = −<i>y</i> − <i>z</i><br>ẏ = <i>x</i> + 0.2<i>y</i><br>ż = 0.2 + <i>z</i>(<i>x</i> − 5.7)',
    Chen: 'ẋ = 35(<i>y</i> − <i>x</i>)<br>ẏ = −7<i>x</i> − <i>xz</i> + 28<i>y</i><br>ż = <i>xy</i> − 3<i>z</i>',
    'Four-Wing': 'ẋ = 0.2<i>x</i> + <i>yz</i><br>ẏ = 0.01<i>x</i> − 0.4<i>y</i> − <i>xz</i><br>ż = −<i>z</i> − <i>xy</i>',
    'Sprott B': 'ẋ = 0.4<i>yz</i><br>ẏ = <i>x</i> − <i>y</i><br>ż = 1.2 − <i>xy</i>'
  };
  var MATH = {
    nebula: function () { return {
      about: 'Fractal noise bent by more fractal noise, folded twice. Every wisp is a value of one function.',
      eq: '<i>f</i>(<b>p</b>) = fbm(<b>p</b> + 4<b>r</b>)<br><b>r</b> = fbm<sub>2</sub>(<b>p</b> + 4<b>q</b>), &nbsp;<b>q</b> = fbm<sub>2</sub>(<b>p</b>)<br>fbm(<b>p</b>) = Σ<sub><i>k</i></sub> 2<sup>−<i>k</i></sup> noise(2<sup><i>k</i></sup><b>p</b>)',
      credit: 'Domain warping, after Inigo Quilez' }; },
    julia: function (s) { var c = s.c(); return {
      about: 'Every pixel is a starting point z. Iterate; colour by how fast it escapes. The parameter c glides along the edge of the Mandelbrot set.',
      eq: '<i>z</i><sub><i>n</i>+1</sub> = <i>z</i><sub><i>n</i></sub><sup>2</sup> + <i>c</i><br><i>c</i> = ' + num(c[0]) + (c[1] < 0 ? ' − ' : ' + ') + num(Math.abs(c[1])) + '<i>i</i><br>distance ≈ |<i>z</i>| ln|<i>z</i>| ⁄ |<i>z</i>′|',
      credit: 'Gaston Julia, 1918' }; },
    reaction: function (s) { var fk = s.fk.value; return {
      about: 'Two chemicals: B feeds on A and reproduces; A is refilled, B is removed. Spots, stripes and mazes appear from almost nothing.' + (s.aniso ? ' Here diffusion runs faster along a flowing direction field, so the patterns stream.' : ''),
      eq: '∂<i>A</i>⁄∂<i>t</i> = <i>D<sub>A</sub></i>∇<sup>2</sup><i>A</i> − <i>AB</i><sup>2</sup> + <i>f</i>(1 − <i>A</i>)<br>∂<i>B</i>⁄∂<i>t</i> = <i>D<sub>B</sub></i>∇<sup>2</sup><i>B</i> + <i>AB</i><sup>2</sup> − (<i>k</i> + <i>f</i>)<i>B</i><br><i>D<sub>A</sub></i> = 1, <i>D<sub>B</sub></i> = 0.5, <i>f</i> = ' + num(fk[0], 4) + ', <i>k</i> = ' + num(fk[1], 4) +
        (s.aniso ? '<br>∇<sup>2</sup> → 0.4∇<sup>2</sup> + 1.2 ∂<sup>2</sup>⁄∂<i>s</i><sup>2</sup> &nbsp;(along <b>s</b>(<i>x</i>, <i>t</i>))' : ''),
      credit: 'Gray–Scott model; rendering after Karl Sims' }; },
    physarum: function (s) { return {
      about: 'Half a million agents, each with three sensors. They turn towards the strongest scent, move, and leave scent behind, which spreads and fades: a slime mould solving transport networks.',
      eq: 'turn towards max{<i>T</i>(<b>x</b> + <i>d</i><b>ĥ</b><sub>θ</sub>), <i>T</i>(<b>x</b> + <i>d</i><b>ĥ</b><sub>θ±α</sub>)}<br><b>x</b> ← <b>x</b> + <i>v</i><b>ĥ</b><sub>θ</sub>, &nbsp;<i>T</i>(<b>x</b>) += 1<br><i>T</i> ← λ · blur(<i>T</i>)',
      credit: 'Jeff Jones, 2010 (' + s.count.toLocaleString() + ' agents here)' }; },
    attractor: function (s) { var p = s.pCur; var cl = s.kind === 0; return {
      about: 'One point, hopped millions of times through the same map. Where it lands most often glows brightest.',
      eq: cl ? '<i>x</i>′ = sin(<i>ay</i>) + <i>c</i> cos(<i>ax</i>)<br><i>y</i>′ = sin(<i>bx</i>) + <i>d</i> cos(<i>by</i>)' : '<i>x</i>′ = sin(<i>ay</i>) − cos(<i>bx</i>)<br><i>y</i>′ = sin(<i>cx</i>) − cos(<i>dy</i>)',
      credit: (cl ? 'Clifford Pickover' : 'Peter de Jong') + ' map, <i>a</i> = ' + num(p[0], 2) + ', <i>b</i> = ' + num(p[1], 2) + ', <i>c</i> = ' + num(p[2], 2) + ', <i>d</i> = ' + num(p[3], 2) }; },
    silk: function (s) { return {
      about: 'A quarter of a million particles ride the curl of a 3D noise field. A curl never converges, so the threads braid but never bunch up.',
      eq: '<b>v</b> = ∇ × <b>ψ</b>(<b>x</b>, <i>t</i>), &nbsp;∇·<b>v</b> = 0<br><b>x</b> ← <b>x</b> + <b>v</b> Δ<i>t</i>',
      credit: 'Curl noise, after Robert Bridson, 2007' }; },
    chaos: function (s) { var n = CHAOS[s.mix < 0.5 ? s.a : s.b][0]; return {
      about: 'A hundred thousand particles follow the same three equations. Nearby paths fly apart, yet all of them stay on one shape: a strange attractor. Every half minute the equations are blended into another system.',
      eq: CHAOS_EQ[n] || '', credit: n + ' system' }; },
    galaxy: function (s) { return {
      about: 'Two or three galaxies on a close pass. Each star feels only the galactic cores, as in the classic simulations that first explained tidal tails.',
      eq: '<b>ẍ</b><sub><i>i</i></sub> = Σ<sub><i>g</i></sub> <i>M<sub>g</sub></i>(<b>x</b><sub><i>g</i></sub> − <b>x</b><sub><i>i</i></sub>) ⁄ (|<b>x</b><sub><i>g</i></sub> − <b>x</b><sub><i>i</i></sub>|<sup>2</sup> + ε<sup>2</sup>)<sup>3⁄2</sup>',
      credit: 'Toomre &amp; Toomre, 1972 (' + s.ng + ' cores)' }; },
    ink: function (s) { return {
      about: 'Water you can’t squeeze, stirred by unseen brushes that bleed ink into it.',
      eq: '∂<b>u</b>⁄∂<i>t</i> + (<b>u</b>·∇)<b>u</b> = −∇<i>p</i> + <b>f</b> + ε(<b>N</b> × <b>ω</b>)<br>∇·<b>u</b> = 0, &nbsp;∂<i>c</i>⁄∂<i>t</i> + <b>u</b>·∇<i>c</i> = 0',
      credit: 'Navier–Stokes; Jos Stam’s stable fluids, 1999' }; },
    life: function (s) { return {
      about: 'Species that attract or repel each other, and not symmetrically. Cells, worms and chasers emerge; the rules slowly mutate.',
      eq: '<b>a</b><sub><i>i</i></sub> = Σ<sub><i>j</i></sub> <i>F</i>(<i>r<sub>ij</sub></i>⁄<i>r</i><sub>max</sub>) <b>r̂</b><sub><i>ij</i></sub><br><i>F</i>(<i>x</i>) = <i>x</i>⁄β − 1 &nbsp;(<i>x</i> &lt; β)<br><i>F</i>(<i>x</i>) = <i>M<sub>s<sub>i</sub>s<sub>j</sub></sub></i>(1 − |2<i>x</i> − 1 − β|⁄(1 − β)) &nbsp;(β ≤ <i>x</i> &lt; 1)',
      credit: 'Particle Life, ' + s.k + ' species, β = 0.3' }; },
    cymatics: function (s) { var m = s.gliding >= 0 ? s.modeB : s.modeA, rect = s.shape === 0; return {
      about: 'Sand on a vibrating ' + (rect ? 'plate' : 'drum (one note of a steelpan behaves much like it)') + '. Grains are thrown off wherever it moves and settle where it stands still: the nodal lines.',
      eq: rect ? '<i>u</i>(<i>x</i>, <i>y</i>) = cos(<i>n</i>π<i>x</i>) cos(<i>m</i>π<i>y</i>) ' + (m.sign > 0 ? '+' : '−') + ' cos(<i>m</i>π<i>x</i>) cos(<i>n</i>π<i>y</i>)<br><i>n</i> = ' + m.n + ', <i>m</i> = ' + m.m + ', &nbsp;<i>f</i> ∝ <i>n</i><sup>2</sup> + <i>m</i><sup>2</sup> = ' + (m.n * m.n + m.m * m.m)
                : '<i>u</i>(<i>r</i>, θ) = <i>J<sub>n</sub></i>(<i>k<sub>nm</sub> r</i>) cos(<i>n</i>θ)<br><i>n</i> = ' + m.n + ', <i>k</i> = ' + num(m.k, 2) + ' (zero ' + m.m + ' of <i>J</i><sub>' + m.n + '</sub>), &nbsp;<i>f</i> ∝ <i>k</i>',
      credit: 'Grains: <b>x</b> ← <b>x</b> + σ|<i>u</i>|<b>ξ</b> − η∇<i>u</i><sup>2</sup> &nbsp;· Chladni, 1787' }; },
    turing: function (s) { return {
      about: 'One substance, and at every pixel five activator–inhibitor pairs of different sizes. The pair that agrees best wins and nudges the pixel up or down, so patterns nest inside patterns.',
      eq: '<i>a<sub>s</sub></i> = ⟨<i>v</i>⟩<sub><i>r<sub>s</sub></i></sub>, &nbsp;<i>h<sub>s</sub></i> = ⟨<i>v</i>⟩<sub><i>R<sub>s</sub></i></sub>, &nbsp;<i>R<sub>s</sub></i> ≈ ' + num(s.ratio, 1) + '<i>r<sub>s</sub></i><br><i>s</i>* = argmin<sub><i>s</i></sub> |<i>a<sub>s</sub></i> − <i>h<sub>s</sub></i>|<br><i>v</i> ← <i>v</i> + δ<sub><i>s</i>*</sub> sign(<i>a</i><sub><i>s</i>*</sub> − <i>h</i><sub><i>s</i>*</sub>)',
      credit: 'Multi-scale Turing patterns, Jonathan McCabe, 2010' }; },
    soup: function () { return {
      about: 'A primordial soup. Each particle carries its own chaotic chemistry; particles in step attract. Bodies self-assemble, each wrapped in a Markov blanket (the bright ring): the inside only meets the outside through it. Systems like this can be read as minimising free energy.',
      eq: 'ẋ = σ(<i>y</i> − <i>x</i>), ẏ = <i>x</i>(ρ − <i>z</i>) − <i>y</i>, ż = <i>xy</i> − β<i>z</i> &nbsp;(+ coupling to neighbours)<br><i>F</i> = 𝔼<sub><i>q</i></sub>[ln <i>q</i>(ψ) − ln <i>p</i>(<i>s</i>, ψ)] ≥ −ln <i>p</i>(<i>s</i>)',
      credit: 'After Karl Friston, “Life as we know it”, 2013' }; },
    cosmos: function (s) { return {
      about: 'Matter spread almost evenly, and gravity. Small ripples grow into filaments, walls and voids, and halos where the filaments meet: the cosmic web.',
      eq: '∇<sup>2</sup>φ = 4π<i>G</i>(ρ − ρ̄)<br><b>ẍ</b> = −∇φ − <i>H</i><b>ẋ</b><br><b>x</b>(0) = <b>q</b> + ∇ψ(<b>q</b>) &nbsp;(Zel’dovich)',
      credit: 'Particle-mesh gravity, ' + s.count.toLocaleString() + ' particles' }; },
    liquid: function (s) { return {
      about: 'Particles carry the water; a grid makes sure it can’t be squeezed. The tank tilts and the water sloshes.',
      eq: '∂<b>u</b>⁄∂<i>t</i> + (<b>u</b>·∇)<b>u</b> = −∇<i>p</i>⁄ρ + <b>g</b>, &nbsp;∇·<b>u</b> = 0<br><b>u</b><sub><i>p</i></sub> ← α(<b>u</b><sub><i>p</i></sub> + Δ<b>u</b><sub>grid</sub>) + (1 − α)<b>u</b><sub>grid</sub>, &nbsp;α = 0.93',
      credit: 'FLIP/PIC, Brackbill 1986; Zhu &amp; Bridson 2005' }; },
    bulb: function (s) { return {
      about: 'A 3D cousin of the Mandelbrot set, drawn by ray marching: each ray steps forward by a distance that is guaranteed safe until it touches the surface, then marches towards the light for soft shadows.',
      eq: '<b>z</b> ↦ <b>z</b><sup><i>n</i></sup> + <b>c</b>, &nbsp;(<i>r</i>, θ, φ)<sup><i>n</i></sup> = (<i>r<sup>n</sup></i>, <i>n</i>θ, <i>n</i>φ), &nbsp;<i>n</i> = ' + num(s.power.value, 2) + '<br>DE(<b>c</b>) = ½ <i>r</i> ln <i>r</i> ⁄ <i>r</i>′<br><i>t</i> ← <i>t</i> + DE(<b>o</b> + <i>t</i><b>d</b>)',
      credit: 'Mandelbulb, White &amp; Nylander, 2009' }; }
  };

  // ============================================================ Mandelbulb
  // A 3D fractal, ray-marched: each pixel's ray steps forward by a safe
  // distance from the distance estimator until it touches the surface; then
  // a second march towards the light gives soft shadows. Frames are blended
  // with a sub-pixel jitter, which smooths edges over time.
  var BULB_FS = frag([
    'uniform vec3 uEye, uTarget, uLightDir; uniform float uPower, uAspect, uFov; uniform vec2 uJitter; uniform int uSteps, uShadowSteps;',
    'float de(vec3 p, out float trap) { vec3 z = p; float dr = 1.0, r = 0.0; trap = 1e9;',
    '  for (int i = 0; i < 8; i++) { r = length(z); if (r > 2.0) break;',
    '    float th = acos(clamp(z.z / r, -1.0, 1.0)) * uPower, ph = atan(z.y, z.x) * uPower;',
    '    dr = pow(r, uPower - 1.0) * uPower * dr + 1.0;',
    '    z = pow(r, uPower) * vec3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th)) + p; trap = min(trap, dot(z, z)); }',
    '  return 0.5 * log(r) * r / dr; }',
    'float de0(vec3 p) { float t; return de(p, t); }',
    'vec3 normalAt(vec3 p, float e) { vec2 k = vec2(1.0, -1.0);',
    '  return normalize(k.xyy * de0(p + k.xyy * e) + k.yyx * de0(p + k.yyx * e) + k.yxy * de0(p + k.yxy * e) + k.xxx * de0(p + k.xxx * e)); }',
    'float softShadow(vec3 ro, vec3 rd) { float res = 1.0, t = 0.01;',
    '  for (int i = 0; i < 28; i++) { if (i >= uShadowSteps) break; float h = de0(ro + rd * t); res = min(res, 8.0 * h / t); t += clamp(h, 0.006, 0.12); if (res < 0.01 || t > 2.5) break; }',
    '  return clamp(res, 0.0, 1.0); }',
    'void main() {',
    '  vec2 uv = (vUv - 0.5 + uJitter) * vec2(uAspect, 1.0);',
    '  vec3 f = normalize(uTarget - uEye), r = normalize(cross(f, vec3(0.0, 1.0, 0.0))), u = cross(r, f);',
    '  vec3 rd = normalize(f + uFov * (uv.x * r + uv.y * u)), ro = uEye;',
    '  float b = dot(ro, rd), c = dot(ro, ro) - 1.44, disc = b * b - c; vec3 col = vec3(0.0); float glow = 0.0;',
    '  if (disc > 0.0) {',
    '    float t = max(0.0, -b - sqrt(disc)), tmax = -b + sqrt(disc), trap = 0.0; bool hit = false; int i;',
    '    for (i = 0; i < 150; i++) { if (i >= uSteps) break; vec3 p = ro + rd * t; float d = de(p, trap); glow += exp(-d * 30.0) * 0.01;',
    '      if (d < 0.0005 * t) { hit = true; break; } t += d * 0.9; if (t > tmax) break; }',
    '    if (hit) { vec3 p = ro + rd * t; vec3 n = normalAt(p, 0.0004 * t); vec3 L = normalize(uLightDir);',
    '      float diff = max(dot(n, L), 0.0), sh = softShadow(p + n * 0.003, L), ao = 1.0 - float(i) / float(uSteps);',
    '      float spec = pow(max(dot(reflect(-L, n), -rd), 0.0), 40.0);',
    '      vec3 base = pal(0.2 + 0.75 * clamp(sqrt(trap) * 0.75, 0.0, 1.0));',
    '      col = base * (0.04 + 1.2 * diff * sh) * ao * ao + pal(0.98) * spec * sh * 0.7 + base * 0.15 * max(n.y, 0.0) * ao; } }',
    '  col += pal(0.6) * glow * 0.3;',
    '  fragColor = vec4(col, 1.0); }'
  ].join('\n'), true);
  var Bulb = extend(function Bulb(r, w, h) {
    Scene.call(this, r, w, h);
    this.power = new Drift(r, 5.5, 9.5, [18, 40]);
    this.camR = new Drift(r, 2.5, 3.1, [20, 40]);
    this.camH = new Drift(r, -0.8, 1.0, [20, 40]);
    this.camSpeed = r.sign() * r.uniform(0.05, 0.09);
    this.frame = 0;
    this.duration = [50, 85];
  }, 'Mandelbulb', 0.9, 'bulb');
  Bulb.prototype.step = function (dt) { this.dt = dt; this.power.update(dt); this.camR.update(dt); this.camH.update(dt); };
  Bulb.prototype.draw = function () {
    var a = this.t * this.camSpeed, R = this.camR.value, k = this.frame++ % 4;
    var jit = [[0.125, 0.375], [-0.375, 0.125], [0.375, -0.125], [-0.125, -0.375]][k];
    this.out.bind();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);   // blend over the last frames
    gl.blendColor(0, 0, 0, this.frame < 3 ? 1 : 0.4);
    program('bulb', BULB_FS).use({
      uEye: [R * Math.cos(a), this.camH.value, R * Math.sin(a)], uTarget: [0, 0, 0], uLightDir: [Math.cos(a + 1.2), 0.9, Math.sin(a + 1.2)],
      uPower: this.power.value, uAspect: this.aspect, uFov: 0.85, uSteps: MOBILE ? 72 : 150, uShadowSteps: MOBILE ? 12 : 28, uJitter: [jit[0] / this.h, jit[1] / this.h], uPal: this.pal
    });
    fullscreen();
    gl.disable(gl.BLEND);
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
    'uniform float uGrade, uBloom, uSharpen; uniform vec2 uSrcTexel;',
    'vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    'void main() {',
    '  vec2 uv = vec2((vUv.x - 0.5) / uZoom + 0.5, vUv.y / uZoom) + uShift;',
    '  vec3 col = safe(texture(uSrc, uv).rgb) * uExposure;',
    // the richer wallpaper look: unsharp mask for detail, then a soft bloom from the mip chain
    '  if (uGrade > 0.5) {',
    '    vec3 nb = safe(textureLod(uSrc, uv + vec2(uSrcTexel.x, 0.0), 0.0).rgb + textureLod(uSrc, uv - vec2(uSrcTexel.x, 0.0), 0.0).rgb',
    '      + textureLod(uSrc, uv + vec2(0.0, uSrcTexel.y), 0.0).rgb + textureLod(uSrc, uv - vec2(0.0, uSrcTexel.y), 0.0).rgb) * 0.25 * uExposure;',
    '    col = max(col + (col - nb) * uSharpen, 0.0);',
    '    vec3 bloom = safe(textureLod(uSrc, uv, 2.0).rgb) * 0.4 + safe(textureLod(uSrc, uv, 4.0).rgb) * 0.35 + safe(textureLod(uSrc, uv, 6.0).rgb) * 0.25;',
    '    col += bloom * uExposure * uBloom; }',
    '  vec2 v = vUv - 0.5; col *= 1.0 - dot(v, v) * 0.55;',
    '  vec3 g = pow(aces(col), vec3(1.0 / 2.2));',
    // more colour, more contrast and a true black, so scenes don't look washed out
    '  if (uGrade > 0.5) { float l = dot(g, vec3(0.2126, 0.7152, 0.0722)); g = clamp(mix(vec3(l), g, 1.18), 0.0, 1.0);',
    '    g = mix(g, g * g * (3.0 - 2.0 * g), 0.28); g = max(g - 0.008, 0.0) / 0.992; }',
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

  // FXAA (Timothy Lottes), run on the finished frame for wallpaper hosts
  var FXAA_FS = frag([
    'uniform sampler2D uSrc; uniform vec2 uTexel;',
    'float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }',
    'void main() {',
    '  vec3 nw = texture(uSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb, ne = texture(uSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;',
    '  vec3 sw = texture(uSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb, se = texture(uSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;',
    '  vec3 m = texture(uSrc, vUv).rgb;',
    '  float lNW = lum(nw), lNE = lum(ne), lSW = lum(sw), lSE = lum(se), lM = lum(m);',
    '  float lo = min(lM, min(min(lNW, lNE), min(lSW, lSE))), hi = max(lM, max(max(lNW, lNE), max(lSW, lSE)));',
    '  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));',
    '  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);',
    '  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * uTexel;',
    '  vec3 a = 0.5 * (texture(uSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);',
    '  vec3 b = a * 0.5 + 0.25 * (texture(uSrc, vUv - dir * 0.5).rgb + texture(uSrc, vUv + dir * 0.5).rgb);',
    '  float lb = lum(b); fragColor = vec4((lb < lo || lb > hi) ? a : b, 1.0); }'
  ].join('\n'));

  // ------------------------------------------------- shaders per scene
  // Every program a scene uses, as [key, fragment, vertex]. The engine compiles
  // these in the background before the scene starts (see Engine.prepare).
  var ZERO = ['zero', ZERO_FS];
  Nebula.shaders = [['nebula', NEBULA_FS]];
  Julia.shaders = [['julia', JULIA_FS]];
  Reaction.shaders = [['rd.init', RD_INIT_FS], ['rd.step', RD_STEP_FS], ['rd.show', RD_SHOW_FS]];
  Physarum.shaders = [['ph.init', PH_INIT_FS], ['ph.agent', PH_AGENT_FS], ['ph.deposit', PH_DEPOSIT_FS, PH_DEPOSIT_VS],
    ['ph.diffuse', PH_DIFFUSE_FS], ['ph.show', PH_SHOW_FS]];
  Attractor.shaders = [ZERO, ['at.plot', AT_PLOT_FS, AT_VS], ['at.show', AT_SHOW_FS]];
  Silk.shaders = [ZERO, ['silk.init', SILK_INIT_FS], ['silk.step', SILK_STEP_FS], ['silk.draw', POINT_FS, SILK_VS]];
  Chaos.shaders = [ZERO, ['chaos.init', CHAOS_INIT_FS], ['chaos.step', CHAOS_STEP_FS], ['chaos.draw', POINT_FS, CHAOS_VS]];
  Galaxy.shaders = [ZERO, ['gal.init', GAL_INIT_FS], ['gal.step', GAL_STEP_FS], ['gal.draw', GLOW_FS, GAL_VS]];
  Ink.shaders = [['ink.splat', INK_SPLAT_FS], ['ink.curl', INK_CURL_FS], ['ink.vort', INK_VORT_FS], ['ink.div', INK_DIV_FS],
    ['ink.scale', INK_SCALE_FS], ['ink.pressure', INK_PRESSURE_FS], ['ink.grad', INK_GRAD_FS], ['ink.advect', INK_ADVECT_FS],
    ['ink.show', INK_SHOW_FS]];
  Life.shaders = [ZERO, ['life.init', LIFE_INIT_FS], ['life.step', LIFE_STEP_FS], ['life.draw', LIFE_FS, LIFE_VS]];
  Cymatics.shaders = [['cy.init', CY_INIT_FS], ['cy.field', CY_FIELD_FS], ['cy.step', CY_STEP_FS],
    ['cy.splat', CY_SPLAT_FS, CY_SPLAT_VS], ['cy.show', CY_SHOW_FS]];
  Turing.shaders = [['tu.init', TU_INIT_FS], ['tu.step', TU_STEP_FS], ['tu.show', TU_SHOW_FS]];
  Soup.shaders = [ZERO, ['soup.init', SOUP_INIT_FS], ['soup.step', SOUP_STEP_FS], ['soup.draw', GLOW_FS, SOUP_VS]];
  Cosmos.shaders = [['co.init', CO_INIT_FS], ['co.splat', ONE_FS, CO_SPLAT_VS], ['co.jacobi', CO_JACOBI_FS],
    ['co.accel', CO_ACCEL_FS], ['co.step', CO_STEP_FS], ['co.show', CO_SHOW_FS]];
  Liquid.shaders = [ZERO, ['lq.init', LQ_INIT_FS], ['lq.p2g', LQ_P2G_FS, LQ_P2G_VS], ['lq.forces', LQ_FORCES_FS],
    ['lq.div', LQ_DIV_FS], ['lq.jacobi', LQ_JACOBI_FS], ['lq.project', LQ_PROJECT_FS], ['lq.g2p', LQ_G2P_FS],
    ['lq.draw', GLOW_FS, LQ_DRAW_VS]];
  Bulb.shaders = [['bulb', BULB_FS]];
  var ENGINE_SHADERS = [['dissolve', DISSOLVE_FS], ['final', FINAL_FS], ['fxaa', FXAA_FS]];

  var TRANSITION = 7;
  // data-scenes="all" on the canvas adds the newer scenes (Silk, Chaos,
  // Galaxy, Ink, Particle Life, Cymatics, Turing, Free Energy, Cosmos,
  // Liquid) to the rotation; the default stays the original five, which
  // suit a page background.
  var ALL_SCENES = canvas.getAttribute('data-scenes') === 'all';
  // ?aether=physarum shows only that scene (handy for screenshots); the keys
  // are nebula, julia, reaction, physarum, attractor, silk, chaos, galaxy, ink,
  // life, cymatics, turing, soup, cosmos, liquid
  // scenes left out of the rotation: ?skip=turing,bulb, or an 'aether-skip'
  // event (an array of keys, or a comma-separated string). Picking a skipped
  // scene by hand still works; if every scene is skipped the list is ignored.
  var SKIP = {};
  function parseSkip(v) {
    var out = {};
    (Array.isArray(v) ? v : String(v || '').split(',')).forEach(function (k) {
      k = String(k).trim().toLowerCase(); if (k) out[k] = true;
    });
    return out;
  }
  SKIP = parseSkip((/[?&]skip=([a-z,]*)/i.exec(location.search) || [])[1]);
  var FORCED = (/[?&]aether=([a-z]+)/i.exec(location.search) || [])[1];
  FORCED = FORCED ? FORCED.toLowerCase() : null;

  function Engine(w, h, opts) {
    this.w = w; this.h = h;
    this.opts = opts;
    this.r = rng((Math.random() * 4294967296) >>> 0);
    this.scenes = [Nebula, Julia];
    if (FLOAT_RT) this.scenes.push(Reaction, Physarum, Attractor);
    var extra = FLOAT_RT ? [Silk, Chaos, Galaxy, Ink, Life, Cymatics, Turing, Soup, Cosmos, Liquid] : [];
    if (RAY) extra.push(Bulb);   // ray marching only where the GPU has room for it
    if (ALL_SCENES) this.scenes = this.scenes.concat(extra);
    this.known = this.scenes.concat(ALL_SCENES ? [] : extra).concat(RAY ? [] : [Bulb]);
    this.history = [];
    this.hold = !!FORCED;
    this.comp = null;
    this.cur = null; this.nxt = null; this.trans = 0; this.time = 0;
    this.want = null; this.queue = [];
    this.prepare({ shaders: ENGINE_SHADERS });
  }
  // Start compiling a scene's shaders without waiting for them. With
  // KHR_parallel_shader_compile the driver does it in the background; without
  // it they are compiled one per frame, so no single frame takes the whole hit.
  var LEAD = 5;   // seconds before a scene ends that the next one starts preparing
  Engine.prototype.prepare = function (C) {
    var list = C.shaders || [];
    for (var i = 0; i < list.length; i++) {
      var k = list[i];
      if (programs[k[0]]) continue;
      if (PARALLEL) programs[k[0]] = new Program(k[2] || FULL_VS, k[1]);
      else this.queue.push(k);
    }
  };
  Engine.prototype.ready = function (C) {
    return (C.shaders || []).every(function (k) { return programs[k[0]] && programs[k[0]].done(); });
  };
  Engine.prototype.compileQueued = function () {
    var k = this.queue.shift();
    if (k && !programs[k[0]]) { programs[k[0]] = new Program(k[2] || FULL_VS, k[1]); programs[k[0]].finish(); }
  };
  // ask for scene class C (or a random one): it starts once its shaders are ready;
  // now = as soon as possible, otherwise when the current scene's time is up
  Engine.prototype.request = function (C, now) {
    this.want = C || this.pickClass(false);
    this.wantNow = !!now;
    this.wantSince = this.time;
    this.prepare(this.want);
  };
  // the dissolve itself
  Engine.prototype.begin = function (C) {
    if (this.nxt) { this.cur.release(); this.cur = this.nxt; }
    this.nxt = this.newScene(C); this.trans = 0;
  };
  Engine.prototype.pickClass = function (first) {
    var recent = this.history.slice(-Math.min(2, this.scenes.length - 1));
    var allowed = this.scenes.filter(function (c) { return !SKIP[c.key]; });
    if (!allowed.length) allowed = this.scenes;
    var opts = allowed.filter(function (c) { return recent.indexOf(c.sceneName) < 0 && !(first && c === Nebula); });
    if (!opts.length) opts = allowed;
    if (this.opts.still) opts = [Nebula, Julia];
    var forced = this.known.filter(function (c) { return c.key === FORCED; });
    if (forced.length && !this.history.length) return forced[0];
    var total = opts.reduce(function (s, c) { return s + c.weight; }, 0), x = this.r() * total;
    for (var i = 0; i < opts.length; i++) { x -= opts[i].weight; if (x <= 0) return opts[i]; }
    return opts[opts.length - 1];
  };
  Engine.prototype.newScene = function (C) {
    C = C || this.pickClass(!this.history.length);
    var sz = this.opts.sizeFor ? this.opts.sizeFor(C) : [this.w, this.h];
    var s = new C(rng(this.r.bits()), sz[0], sz[1]);
    s.lifetime = this.r.uniform(s.duration[0], s.duration[1]);
    s.cls = C;
    this.history.push(C.sceneName);
    if (this.opts.onScene) this.opts.onScene(s, 'start');   // announces aether-scene (key, name, math)
    return s;
  };
  // dissolve into scene class C (or a random one) as soon as its shaders are ready
  Engine.prototype.goTo = function (C) {
    if (!this.cur) { this.cur = this.newScene(C); return; }
    this.request(C, true);
  };
  // move on early (a struggling scene hands over), the same way
  Engine.prototype.skip = function () {
    if (this.nxt || this.want || !this.cur || this.opts.still) return false;
    this.request(this.hold ? this.cur.cls : null, true);
    return true;
  };
  Engine.prototype.showing = function () { var s = this.nxt || this.cur; return s ? s.cls : null; };
  Engine.prototype.showingScene = function () { return this.nxt || this.cur; };
  Engine.prototype.frame = function (dt) {
    this.time += dt;
    if (!this.cur) this.cur = this.newScene();
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);
    // On phones, while dissolving, the outgoing scene steps every other frame so
    // the two scenes never both run at full cost (the GPU watchdog resets the GPU
    // when a frame's work runs too long).
    if (MOBILE && this.nxt) { this.skipOdd = !this.skipOdd; if (!this.skipOdd) this.cur.update(dt * 2); }
    else this.cur.update(dt);
    this.compileQueued();
    // pick the next scene a little early and let its shaders compile meanwhile
    var auto = !this.opts.still && !this.hold;
    if (auto && !this.want && !this.nxt && this.cur.t >= this.cur.lifetime - LEAD) this.request(null, false);
    if (this.want && (this.wantNow || (auto && !this.nxt && this.cur.t >= this.cur.lifetime)) &&
        (this.ready(this.want) || this.time - this.wantSince > 8)) {
      var C = this.want; this.want = null; this.begin(C);
    }
    if (this.nxt) { this.nxt.update(dt); this.trans += dt / TRANSITION; }
    var src = this.cur.render();
    if (this.nxt) {
      var b = this.nxt.render();
      // scenes can differ in resolution; compose at the larger of the two
      var cw = Math.max(this.cur.w, this.nxt.w), ch = Math.max(this.cur.h, this.nxt.h);
      if (!this.comp || this.comp.w !== cw || this.comp.h !== ch) {
        if (this.comp) this.comp.release();
        this.comp = new Target(cw, ch, F16);
      }
      this.comp.bind();
      program('dissolve', DISSOLVE_FS).use({
        uA: tex(0, src), uB: tex(1, b), uP: smooth(this.trans), uSeed: (this.history.length * 13.7) % 100, uAspect: cw / ch
      });
      fullscreen();
      src = this.comp;
      if (this.trans >= 1) { this.cur.release(); this.cur = this.nxt; this.nxt = null; }
    }
    this.src = src;
  };
  Engine.prototype.present = function (view) {
    if (!this.src) return;
    gl.bindVertexArray(vao);
    var src = this.src, W = canvas.width, H = canvas.height;
    if (view.grade) {   // a mip chain of the frame, for bloom (and clean downsampling when supersampled)
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    if (view.aa) {
      if (!this.ldr || this.ldr.w !== W || this.ldr.h !== H) {
        if (this.ldr) this.ldr.release();
        this.ldr = new Target(W, H, { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE }, gl.LINEAR);
      }
      this.ldr.bind();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
    }
    program('final', FINAL_FS).use({
      uSrc: tex(0, src), uZoom: view.zoom, uShift: view.shift, uExposure: view.exposure * view.fade,
      uStrength: view.strength, uDark: view.dark, uPaper: view.paper, uTime: this.time,
      uGrade: view.grade ? 1 : 0, uBloom: 0.16, uSharpen: src.w < W ? 0.45 : 0.25, uSrcTexel: [1 / src.w, 1 / src.h]
    });
    fullscreen();
    if (view.aa) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      program('fxaa', FXAA_FS).use({ uSrc: tex(0, this.ldr), uTexel: [1 / W, 1 / H] });
      fullscreen();
    }
  };
  Engine.prototype.release = function () {
    if (this.cur) this.cur.release();
    if (this.nxt) this.nxt.release();
    if (this.comp) this.comp.release();
    if (this.ldr) this.ldr.release();
  };

  // ------------------------------------------------------------------ page
  // how much bigger the field is than the window; data-parallax="0" turns
  // the scroll and mouse parallax off and shows the whole field, centred
  var PARALLAX = canvas.getAttribute('data-parallax') !== '0';
  var ZOOM = PARALLAX ? 1.2 : 1;
  var view = { zoom: ZOOM, shift: [0, 0], exposure: 1.25, fade: 0, strength: 0, dark: 1, paper: [0, 0, 0], grade: false, aa: false };
  var target = { dark: 1, paper: [0, 0, 0] };
  var scroll = 0, pointerX = 0, pointerS = 0;
  // interactive look-around (Aether.look): zoom >= 1 around a centre in field coordinates
  var look = { zoom: 1, cx: 0.5, cy: 0.5 }, lookS = { zoom: 1, cx: 0.5, cy: 0.5 };
  var paused = false, speed = 1, steps = 0;
  var quality = 1, slowFor = 0, ema = 1 / 30, last = 0, still = false, size = [0, 0], gaveUp = false;

  function readTheme() {
    var hex = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    var c = m ? [0, 2, 4].map(function (i) { return parseInt(m[1].substr(i, 2), 16) / 255; }) : [1, 1, 1];
    var lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    target.paper = c;
    target.dark = lum < 0.4 ? 1 : 0;
  }
  // data-strength="1" on the canvas overrides the base strength (for a
  // full-screen wallpaper rather than a page background)
  var STRENGTH = parseFloat(canvas.getAttribute('data-strength'));
  function strengthFor(dark) { return isFinite(STRENGTH) ? STRENGTH : dark ? 0.32 : 0.44; }

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
  // data-pixels sets the simulation pixel budget (default about 0.5 megapixels)
  var PIXELS = parseFloat(canvas.getAttribute('data-pixels')) || 520000;
  function simSize(css) {
    var k = Math.min(1, Math.sqrt(PIXELS / (css[0] * css[1]))) * quality;
    return [Math.max(160, Math.round(css[0] * k)), Math.max(120, Math.round(css[1] * k))];
  }

  // ?quality=saver|balanced|high|max (or data-quality on the canvas) is for
  // desktop wallpaper hosts: each scene gets its own resolution, which rises
  // while the frame rate holds and drops as soon as frames are missed, and
  // the high presets draw at 60 fps. The budgets are remembered per scene.
  // Without it the page keeps its fixed budget and only steps down.
  var QUALITY = ((/[?&]quality=([a-z]+)/i.exec(location.search) || [])[1] || canvas.getAttribute('data-quality') || '').toLowerCase();
  var PRESET = {
    saver:    { start: 0.35e6, max: 0.6e6, fps: 30 },
    balanced: { start: 0.9e6,  max: 1.4e6, fps: 30 },
    high:     { start: 1.6e6,  max: 4.2e6, fps: 60 },
    max:      { start: 2.2e6,  max: 1e9,   fps: 60 }
  }[QUALITY] || null;
  var FPS = PRESET ? PRESET.fps : 30, MIN_PX = 0.2e6;
  // ?fps=20 (or an 'aether-fps' event with a number, 0 to lift it) caps the
  // frame rate below the preset's, for example on battery
  var BASE_FPS = FPS;
  function capFps(v) { v = parseFloat(v); FPS = v > 0 ? Math.min(BASE_FPS, Math.max(10, v)) : BASE_FPS; }
  capFps((/[?&]fps=([0-9.]+)/.exec(location.search) || [])[1]);
  window.addEventListener('aether-fps', function (e) { capFps(e.detail); });
  // wallpaper hosts get the richer grade (bloom, sharpening, contrast) and FXAA;
  // the 60 fps presets also get ray marching (shadows, the Mandelbulb, more samples)
  var GRADE = !!PRESET || canvas.getAttribute('data-grade') === 'rich';
  var RAY = !!PRESET && PRESET.fps >= 60;
  function deviceArea() { var c = cssSize(), d = Math.min(2, window.devicePixelRatio || 1); return c[0] * c[1] * d * d; }
  function sizeAt(px) {
    var c = cssSize(), k = Math.sqrt(px / (c[0] * c[1]));
    return [Math.max(160, Math.round(c[0] * k)), Math.max(120, Math.round(c[1] * k))];
  }
  var adapt = {
    store: 'aether-budget-' + QUALITY, budgets: {}, frames: 0, misses: 0, time: 0, key: null, grew: false, clean: true,
    load: function () { try { this.budgets = JSON.parse(localStorage.getItem(this.store) || '{}') || {}; } catch (e) { this.budgets = {}; } },
    save: function () { try { localStorage.setItem(this.store, JSON.stringify(this.budgets)); } catch (e) {} },
    maxPx: function () { return Math.min(PRESET.max, deviceArea()); },
    budget: function (key) {
      var b = this.budgets[key];
      return Math.max(MIN_PX, Math.min(this.maxPx(), isFinite(b) && b > 0 ? b : PRESET.start));
    },
    set: function (key, px, why) {
      px = Math.max(MIN_PX, Math.min(this.maxPx(), px));
      if (Math.abs(px - this.budget(key)) < 1e4) return;
      this.budgets[key] = Math.round(px);
      this.save();
      emit('aether-quality', { scene: key, pixels: Math.round(px), why: why });
    },
    reset: function () { this.frames = 0; this.misses = 0; this.time = 0; },
    // called once per drawn frame with the real time since the last one
    track: function (dt) {
      if (!engine || !engine.cur) return;
      if (dt > 0.5 || engine.nxt) { this.reset(); return; }   // a pause, or a dissolve drawing two scenes
      var s = engine.cur, key = s.constructor.key;
      if (key !== this.key) { this.key = key; this.grew = false; this.clean = true; this.reset(); }
      this.frames++; this.time += dt;
      if (dt > 1.6 / FPS) this.misses++;
      if (this.time < 3) return;
      var rate = this.misses / this.frames, b = this.budget(key);
      if (rate > 0.25) {             // badly behind: smaller next time, and hand over now
        this.set(key, b * 0.6, 'stutter');
        this.clean = false;
        engine.skip();
      } else if (rate > 0.05) {      // a few dropped frames: smaller next time
        this.set(key, b * 0.8, 'dropped frames');
        this.clean = false;
      } else if (rate < 0.01 && this.clean && !this.grew && s.t > 12) {
        this.set(key, b * 1.4, 'smooth');   // steady for a while: try sharper next time
        this.grew = true;
      }
      this.reset();
    }
  };
  if (PRESET) adapt.load();
  view.grade = GRADE; view.aa = !!PRESET;

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) {}
    // native hosts: WKWebView (macOS) and WebView2 (Windows)
    try { window.webkit.messageHandlers.aether.postMessage({ event: name, detail: detail }); } catch (e) {}
    try { window.chrome.webview.postMessage({ event: name, detail: detail }); } catch (e) {}
  }
  // a scene began, or someone asked what is showing: name, key and its math
  function announce(s, why) {
    if (!s) return;
    var C = s.constructor, m = MATH[C.key];
    var info = { key: C.key, name: C.sceneName, why: why, width: s.w, height: s.h };
    if (m) { try { var d = m(s); info.math = d.eq; info.about = d.about; info.credit = d.credit; } catch (e) {} }
    emit('aether-scene', info);
  }
  window.addEventListener('aether-show-math', function () { if (engine) announce(engine.showingScene(), 'ask'); });

  function build() {
    // a rebuild (resize, slow GPU) keeps the scene that was showing
    var keep = engine ? { hold: engine.hold, cls: engine.showing() } : null;
    if (engine) engine.release();
    size = cssSize();
    var opts = { still: still, onScene: announce };
    if (PRESET) {
      var c = sizeAt(Math.min(adapt.maxPx(), 8.3e6));
      canvas.width = c[0]; canvas.height = c[1];
      opts.sizeFor = function (C) { return sizeAt(adapt.budget(C.key)); };
      engine = new Engine(c[0], c[1], opts);
    } else {
      var s = simSize(size);
      canvas.width = s[0]; canvas.height = s[1];
      engine = new Engine(s[0], s[1], opts);
    }
    if (keep && !still) { engine.hold = keep.hold; if (keep.cls) engine.cur = engine.newScene(keep.cls); }
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
    view.shift = PARALLAX ? [pointerS * slack * 0.25, slack * (1 - scroll)] : [0, 0];
    var j = Math.min(1, dt * 10);
    lookS.zoom += (look.zoom - lookS.zoom) * j; lookS.cx += (look.cx - lookS.cx) * j; lookS.cy += (look.cy - lookS.cy) * j;
    if (!PARALLAX) {
      view.zoom = lookS.zoom;
      view.shift = [lookS.cx - 0.5, lookS.cy - 0.5 / lookS.zoom];
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = (now - last) / 1000;
    if (dt < 1 / FPS - 0.004) return;     // 30 fps is plenty for slow drift; the high presets run at 60
    last = now;
    if (PRESET) adapt.track(dt);
    dt = Math.min(dt, 0.1);
    ema += (dt - ema) * 0.05;
    if (!paused) {
      // faster than real time runs extra whole steps, so the simulations stay stable
      if (speed <= 1) engine.frame(dt * speed);
      else for (steps += Math.min(speed, MOBILE ? 2 : 4); steps >= 1; steps--) engine.frame(dt);
    }
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
    if (PRESET) return;   // the adaptive presets handle this per scene
    slowFor = ema > 0.05 * Math.max(1, speed) ? slowFor + dt : 0;
    if (slowFor > 4) {
      slowFor = 0; ema = 1 / 30;
      if (quality > 0.45) { quality *= 0.8; build(); }
      else { cancelAnimationFrame(raf); raf = 0; gaveUp = true; }
    }
  }

  // ---- control API, for pages that let people play with it (see aether.html)
  function clampLook() {
    look.zoom = Math.min(6, Math.max(1, look.zoom));
    var hw = 0.5 / look.zoom;
    look.cx = Math.min(1 - hw, Math.max(hw, look.cx));
    look.cy = Math.min(1 - hw, Math.max(hw, look.cy));
  }
  function findClass(key) {
    if (!engine) return null;
    key = String(key || '').toLowerCase();
    return engine.known.filter(function (c) { return c.key === key; })[0] || null;
  }
  function setSkip(v) {
    SKIP = parseSkip(v);
    // the scene on screen was just left out: move on, unless someone is holding it
    var c = engine && engine.showing();
    // a scene picked early (its shaders compiling) that is now left out: pick again
    if (engine && engine.want && SKIP[engine.want.key] && !engine.wantNow) engine.want = null;
    if (c && SKIP[c.key] && !engine.hold && !still) { engine.goTo(); run(); }
  }
  window.addEventListener('aether-skip', function (e) { setSkip(e.detail); });

  window.Aether = {
    // keys left out of the rotation; pass an array to change them
    skip: function (v) { if (v !== undefined) setSkip(v); return Object.keys(SKIP); },
    scenes: function () { return engine ? engine.known.map(function (c) { return { key: c.key, name: c.sceneName }; }) : []; },
    scene: function () { var c = engine && engine.showing(); return c ? { key: c.key, name: c.sceneName } : null; },
    // show one scene now; it stays unless hold is false
    show: function (key, hold) {
      var C = findClass(key);
      if (!C || still) return false;
      engine.hold = hold !== false;
      engine.goTo(C); run();
      return true;
    },
    next: function () { if (engine && !still) { engine.goTo(); run(); } },
    // hold: keep the current scene instead of moving on every minute or so
    hold: function (v) { if (engine) { if (v !== undefined) engine.hold = !!v; return engine.hold; } return false; },
    pause: function (v) { if (v !== undefined) paused = !!v; return paused; },
    speed: function (v) { if (v !== undefined) speed = Math.min(4, Math.max(0.1, +v || 1)); return speed; },
    // zoom in around a point of the screen (0-1 from the top left), or pan by a screen fraction
    zoomAt: function (factor, sx, sy) {
      var z0 = look.zoom;
      var fx = look.cx + (sx - 0.5) / z0, fy = look.cy + (0.5 - sy) / z0;
      look.zoom = z0 * factor; clampLook();
      look.cx = fx - (sx - 0.5) / look.zoom; look.cy = fy - (0.5 - sy) / look.zoom; clampLook();
      return look.zoom;
    },
    pan: function (dx, dy) { look.cx -= dx / look.zoom; look.cy += dy / look.zoom; clampLook(); },
    resetView: function () { look.zoom = 1; look.cx = look.cy = 0.5; },
    zoom: function () { return look.zoom; },
    // a PNG data URL of the current frame
    snapshot: function () {
      if (!engine) return null;
      engine.present(view);
      return canvas.toDataURL('image/png');
    }
  };

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
    PARALLEL = gl.getExtension('KHR_parallel_shader_compile');
    F32 = { i: gl.RGBA32F, f: gl.RGBA, t: gl.FLOAT };
    F16 = FLOAT_RT ? { i: gl.RGBA16F, f: gl.RGBA, t: gl.HALF_FLOAT } : { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE };
    if (FLOAT_RT) {
      var probe = new Target(4, 4, F16), probe32 = new Target(4, 4, F32, gl.NEAREST);
      FLOAT_RT = probe.ok && probe32.ok;
      probe.release(); probe32.release();
      if (!FLOAT_RT) F16 = { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE };
    }
    still = reduceMQ.matches;
    // data-reduced-motion="pause": start paused (with a play control) instead of a still frame
    if (still && canvas.getAttribute('data-reduced-motion') === 'pause') { still = false; paused = true; }
    readTheme();
    view.dark = target.dark; view.paper = target.paper.slice();
    try {
      build();
      if (still) renderStill();
      else {
        if (paused) for (var i = 0; i < 3; i++) engine.frame(1 / 30);
        if (level > 0) run();
      }
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

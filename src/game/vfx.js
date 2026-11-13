// Visual effects: CPU-simulated instanced particles (alpha + additive pools), ambient motes,
// sword trail ribbon, static glow sprites and looping emitters (fire, mist).
import * as THREE from 'three';
import { G, shared, U_LIGHT } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_FOG } from '../shaders/common.js';
import { LAYER_TRANS } from '../core/gfx.js';
import { biomeWeights } from '../world/worldgen.js';
import { BIOME } from '../world/layout.js';

export const P = { SOFT: 0, SPARK: 1, LEAF: 2, RING: 3, SMOKE: 4, PETAL: 5, DROP: 6, STAR: 7, BFLY: 8, STREAK: 9 };

const PVERT = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_FOG}
in vec3 aPos;
in vec4 aParams;   // size, rotation, type, alpha
in vec4 aColor;    // rgb, flutter
out vec2 vQ;
out vec4 vColor;
out vec2 vTypeSeed;
out float vFog;
out vec3 vFogCol;
void main() {
  float size = aParams.x;
  vec2 c = position.xy;
  vQ = c * 2.0;
  float type = aParams.z;
  // leaves and petals tumble: squash one axis
  if (aColor.a > 0.0) c.x *= cos(uTime * 5.0 * aColor.a + aParams.y * 9.0);
  if (type > 8.5) c.x *= 0.035;                                   // rain streak: long and thin
  c = rot2(aParams.y) * c;
  vec3 wpos = aPos;
  if (type > 7.5 && type < 8.5) {                                 // butterflies meander
    float sd = aParams.y * 40.0;
    wpos += vec3(sin(uTime * 1.1 + sd), sin(uTime * 2.3 + sd * 0.43) * 0.35, cos(uTime * 0.9 + sd * 0.57)) * 0.9;
  }
  vec4 vc;
  if (aColor.a < -0.5) vc = viewMatrix * vec4(wpos + vec3(c.x, 0.0, c.y) * size, 1.0);     // flat on the ground / water
  else { vc = viewMatrix * vec4(wpos, 1.0); vc.xy += c * size; }
  vColor = vec4(aColor.rgb, aParams.w);
  vTypeSeed = vec2(type, fract(aParams.y * 3.71));
  vec3 dir;
  vFog = fogAmount(aPos, dir);
  vFogCol = fogColorDir(dir);
  gl_Position = projectionMatrix * vc;
}
`;

const PFRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
uniform sampler2D uNoiseTex;
uniform float uAdditive;
in vec2 vQ;
in vec4 vColor;
in vec2 vTypeSeed;
in float vFog;
in vec3 vFogCol;
out vec4 fragColor;
void main() {
  float r = length(vQ);
  int type = int(vTypeSeed.x + 0.5);
  float a = 0.0;
  vec3 col = vColor.rgb;
  if (type == 0) { a = pow(max(1.0 - r, 0.0), 1.6); }
  else if (type == 1) { a = pow(max(1.0 - r, 0.0), 3.0) + pow(max(1.0 - abs(vQ.x) * 6.0, 0.0), 2.0) * max(1.0 - abs(vQ.y), 0.0) * 0.7; }
  else if (type == 2) { float w = 0.42 * (1.0 - vQ.y * vQ.y); a = smoothstep(0.03, -0.03, abs(vQ.x) - w) * step(abs(vQ.y), 0.98); col *= 0.8 + 0.3 * smoothstep(-0.2, 0.2, vQ.x); }
  else if (type == 3) { a = smoothstep(0.16, 0.0, abs(r - 0.78)) * (0.6 + 0.4 * texture(uNoiseTex, vQ * 0.7 + vTypeSeed.y).r); }
  else if (type == 4) { float n = texture(uNoiseTex, vQ * 0.22 + vTypeSeed.y).r; a = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.7) * (0.55 + 0.45 * n); }
  else if (type == 5) { float w = 0.62 * sqrt(max(1.0 - vQ.y * vQ.y, 0.0)) * (0.7 + 0.3 * vQ.y); a = smoothstep(0.04, -0.04, abs(vQ.x) - w); col *= 0.85 + 0.25 * (vQ.y * 0.5 + 0.5); }
  else if (type == 6) { a = smoothstep(1.0, 0.7, r); }
  else if (type == 8) {
    vec2 q = vec2(abs(vQ.x), vQ.y);
    float up = length((q - vec2(0.46, 0.26)) / vec2(0.5, 0.56)), lo = length((q - vec2(0.34, -0.4)) / vec2(0.36, 0.42));
    float wing = min(up, lo);
    a = smoothstep(1.0, 0.9, wing);
    col *= mix(0.25, 1.0, smoothstep(1.0, 0.62, wing)) * (0.85 + 0.3 * step(0.5, fract(wing * 2.5)));
    a = max(a, smoothstep(0.07, 0.03, q.x) * step(abs(vQ.y), 0.6));
  }
  else if (type == 9) { a = (1.0 - abs(vQ.x)) * (1.0 - abs(vQ.y)) * 0.55; }
  else { float s = max(1.0 - abs(vQ.x) * 7.0, 0.0) * max(1.0 - abs(vQ.y), 0.0) + max(1.0 - abs(vQ.y) * 7.0, 0.0) * max(1.0 - abs(vQ.x), 0.0); a = s + pow(max(1.0 - r, 0.0), 4.0); }
  a *= vColor.a;
  if (a < 0.004) discard;
  if (uAdditive > 0.5) {
    fragColor = vec4(col * a * (1.0 - vFog), 1.0);
  } else {
    vec3 lit = col * (uAmbSky * 0.9 + uLightColor * 0.55);
    fragColor = vec4(mix(lit, vFogCol, vFog), a);
  }
}
`;

class Pool {
  constructor(scene, max, additive) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3); this.par = new Float32Array(max * 4); this.col = new Float32Array(max * 4);
    // sim state
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max); this.size1 = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max);
    this.alpha = new Float32Array(max); this.spin = new Float32Array(max); this.wind = new Float32Array(max); this.fadeIn = new Float32Array(max);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3); this.aPar = new THREE.InstancedBufferAttribute(this.par, 4); this.aCol = new THREE.InstancedBufferAttribute(this.col, 4);
    for (const a of [this.aPos, this.aPar, this.aCol]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aPos', this.aPos); g.setAttribute('aParams', this.aPar); g.setAttribute('aColor', this.aCol);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...shared(...U_LIGHT, 'uNoiseTex'), uAdditive: { value: additive ? 1 : 0 } },
      vertexShader: PVERT, fragmentShader: PFRAG, glslVersion: THREE.GLSL3, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false; this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = additive ? 31 : 30;
    this.mesh.layers.set(LAYER_TRANS);
    this.geo = g;
    scene.add(this.mesh);
  }
  spawn(x, y, z, vx, vy, vz, o) {
    if (this.n >= this.max) return -1;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = 0; this.maxLife[i] = o.life || 1;
    this.size0[i] = o.size || 0.2; this.size1[i] = o.size1 !== undefined ? o.size1 : this.size0[i];
    this.grav[i] = o.gravity || 0; this.drag[i] = o.drag || 0; this.alpha[i] = o.alpha !== undefined ? o.alpha : 1;
    this.spin[i] = o.spin || 0; this.wind[i] = o.wind || 0; this.fadeIn[i] = o.fadeIn || 0.08;
    this.par[i * 4 + 1] = o.rot !== undefined ? o.rot : Math.random() * 6.283; this.par[i * 4 + 2] = o.type || 0;
    const c = o.color;
    this.col[i * 4] = c[0]; this.col[i * 4 + 1] = c[1]; this.col[i * 4 + 2] = c[2]; this.col[i * 4 + 3] = o.flutter || 0;
    return i;
  }
  kill(i) {
    const j = --this.n;
    if (i === j) return;
    for (let k = 0; k < 3; k++) { this.pos[i * 3 + k] = this.pos[j * 3 + k]; this.vel[i * 3 + k] = this.vel[j * 3 + k]; }
    for (let k = 0; k < 4; k++) { this.par[i * 4 + k] = this.par[j * 4 + k]; this.col[i * 4 + k] = this.col[j * 4 + k]; }
    for (const a of [this.life, this.maxLife, this.size0, this.size1, this.grav, this.drag, this.alpha, this.spin, this.wind, this.fadeIn]) a[i] = a[j];
  }
  update(dt, wx, wz) {
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dt;
      const t = this.life[i] / this.maxLife[i];
      if (t >= 1) { this.kill(i); i--; continue; }
      const d = Math.exp(-this.drag[i] * dt);
      const o = i * 3;
      this.vel[o] = this.vel[o] * d + wx * this.wind[i] * dt; this.vel[o + 1] = this.vel[o + 1] * d - this.grav[i] * dt; this.vel[o + 2] = this.vel[o + 2] * d + wz * this.wind[i] * dt;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
      const p = i * 4;
      this.par[p] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      this.par[p + 1] += this.spin[i] * dt;
      const fi = Math.min(1, this.life[i] / this.fadeIn[i]);
      this.par[p + 3] = this.alpha[i] * fi * (1 - t * t);
    }
    this.geo.instanceCount = this.n;
    if (this.n > 0) {
      // only upload the live range
      for (const [a, k] of [[this.aPos, 3], [this.aPar, 4], [this.aCol, 4]]) { a.clearUpdateRanges(); a.addUpdateRange(0, this.n * k); a.needsUpdate = true; }
    }
    this.mesh.visible = this.n > 0;
  }
}

const _bc = new THREE.Vector3();
const hex = (h, k = 1) => { const c = new THREE.Color(h); return [c.r * k, c.g * k, c.b * k]; };
const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;

const GLOW_VERT = /* glsl */`
${GLSL_UNIFORMS}
in vec3 aPos;
in vec4 aCol;   // rgb, size
in float aKind; // 0 always, 1 night only
out vec2 vQ; out vec3 vCol;
void main() {
  float k = aKind > 0.5 ? smoothstep(0.2, 0.7, uNight) : 0.55 + 0.45 * uNight;
  float flick = 0.88 + 0.12 * sin(uTime * 7.0 + aPos.x * 3.1 + aPos.z * 1.7) * step(0.5, aKind);
  vec4 vc = viewMatrix * vec4(aPos, 1.0);
  float dist = -vc.z;
  float fade = smoothstep(260.0, 60.0, dist);
  vc.xy += position.xy * aCol.a * (1.0 + dist * 0.012);
  vQ = position.xy * 2.0; vCol = aCol.rgb * k * flick * fade;
  gl_Position = projectionMatrix * vc;
  if (k * fade < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const GLOW_FRAG = /* glsl */`
in vec2 vQ; in vec3 vCol; out vec4 fragColor;
void main() { float r = length(vQ); float a = pow(max(1.0 - r, 0.0), 2.4); fragColor = vec4(vCol * a, 1.0); }
`;

export class VFX {
  constructor(game) {
    this.game = game;
    const scene = game.gfx.scene;
    this.alpha = new Pool(scene, 1800, false);
    this.add = new Pool(scene, 1800, true);
    this.emitters = [];
    this.ambientT = 0;
    this._bw = new Float32Array(8);
    this._initTrail(scene);
    this.glows = [];
  }

  // ------------------------------------------------------------ generic bursts
  dust(x, y, z, n = 4) {
    for (let i = 0; i < n; i++) this.alpha.spawn(x + rnd(0.3), y + 0.1, z + rnd(0.3), rnd(1.2), 0.5 + Math.random() * 0.8, rnd(1.2), { life: 0.5 + Math.random() * 0.4, size: 0.25, size1: 0.9, color: [0.75, 0.72, 0.62], type: P.SMOKE, alpha: 0.38, drag: 2.5 });
  }
  sparks(x, y, z, color = 0xffe9b0, n = 10, speed = 6) {
    const c = hex(color, 3);
    for (let i = 0; i < n; i++) this.add.spawn(x, y, z, rnd(speed), Math.random() * speed * 0.8, rnd(speed), { life: 0.25 + Math.random() * 0.3, size: 0.22, size1: 0.02, color: c, type: P.SPARK, gravity: 14, drag: 2 });
  }
  hit(x, y, z, color = 0xffffff, big = false) {
    const c = hex(color, 4);
    this.add.spawn(x, y, z, 0, 0, 0, { life: 0.16, size: big ? 1.6 : 1.0, size1: big ? 3.6 : 2.3, color: c, type: P.STAR, rot: Math.random() * 3 });
    this.add.spawn(x, y, z, 0, 0, 0, { life: 0.28, size: 0.5, size1: big ? 3.4 : 2.2, color: hex(color, 1.5), type: P.RING });
    this.sparks(x, y, z, color, big ? 16 : 8, big ? 9 : 6);
  }
  poof(x, y, z, color = 0xffffff, n = 12, scale = 1) {
    const c = hex(color);
    for (let i = 0; i < n; i++) this.alpha.spawn(x + rnd(0.3 * scale), y + rnd(0.3 * scale), z + rnd(0.3 * scale), rnd(2.4 * scale), Math.random() * 2.2 * scale, rnd(2.4 * scale), { life: 0.6 + Math.random() * 0.5, size: 0.4 * scale, size1: 1.4 * scale, color: c, type: P.SMOKE, alpha: 0.6, drag: 3 });
    this.sparks(x, y, z, color, 8, 4);
  }
  splash(x, y, z, k = 1) {
    for (let i = 0; i < 14 * k + 4; i++) this.alpha.spawn(x + rnd(0.3), y + 0.05, z + rnd(0.3), rnd(2.2 * k), 2.5 + Math.random() * 3.5 * k, rnd(2.2 * k), { life: 0.6 + Math.random() * 0.3, size: 0.09, size1: 0.05, color: [0.85, 0.95, 1.0], type: P.DROP, gravity: 13, alpha: 0.9 });
    this.ripple(x, y, z, 1 + k);
  }
  ripple(x, y, z, s = 1) {
    this.rings.push({ x, y: y + 0.03, z, t: 0, life: 1.2, s });
  }
  heal(x, y, z) {
    for (let i = 0; i < 16; i++) this.add.spawn(x + rnd(0.5), y + Math.random() * 1.2, z + rnd(0.5), 0, 1.2 + Math.random(), 0, { life: 0.9, size: 0.18, size1: 0.02, color: [0.5, 2.4, 0.9], type: P.STAR });
  }
  orbBurst(x, y, z, color = 0x8fe9ff) {
    const c = hex(color, 3);
    for (let i = 0; i < 26; i++) { const a = Math.random() * 6.28, b = Math.random() * 3.14, s = 2 + Math.random() * 4; this.add.spawn(x, y, z, Math.cos(a) * Math.sin(b) * s, Math.cos(b) * s, Math.sin(a) * Math.sin(b) * s, { life: 0.7 + Math.random() * 0.5, size: 0.3, size1: 0.02, color: c, type: P.STAR, drag: 2.5 }); }
    this.add.spawn(x, y, z, 0, 0, 0, { life: 0.5, size: 0.6, size1: 5, color: hex(color, 1.6), type: P.RING });
  }
  windBurst(x, y, z) {
    for (let i = 0; i < 3; i++) this.add.spawn(x, y + 0.2 + i * 0.5, z, 0, 0, 0, { life: 0.55 + i * 0.12, size: 1, size1: 11 - i * 2, color: [0.5, 1.6, 1.3], type: P.RING });
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * 6.28, r = 0.6 + Math.random() * 3.4;
      this.alpha.spawn(x + Math.cos(a) * r, y + Math.random(), z + Math.sin(a) * r, -Math.sin(a) * 7, 4 + Math.random() * 7, Math.cos(a) * 7, { life: 1.0 + Math.random() * 0.8, size: 0.2, color: [0.35, 0.75, 0.25], type: P.LEAF, flutter: 1 + Math.random(), drag: 1.2, spin: rnd(4) });
    }
    for (let i = 0; i < 20; i++) this.add.spawn(x + rnd(2.5), y + Math.random() * 2, z + rnd(2.5), 0, 6 + Math.random() * 8, 0, { life: 0.8, size: 0.5, size1: 0.1, color: [0.4, 1.5, 1.2], type: P.SOFT, alpha: 0.6 });
  }
  fireBurst(x, y, z, n = 14) {
    for (let i = 0; i < n; i++) this.add.spawn(x + rnd(0.4), y + rnd(0.4), z + rnd(0.4), rnd(3), 1 + Math.random() * 3, rnd(3), { life: 0.4 + Math.random() * 0.4, size: 0.9, size1: 0.1, color: [2.6, 1.0 + Math.random() * 0.6, 0.2], type: P.SOFT, drag: 2 });
  }

  // ------------------------------------------------------------ emitters
  addFire(pos, scale = 1) { const e = { kind: 'fire', pos: pos.clone(), scale, acc: 0, on: true }; this.emitters.push(e); return e; }
  addMist(pos, scale = 1) { const e = { kind: 'mist', pos: pos.clone(), scale, acc: 0, on: true }; this.emitters.push(e); return e; }
  addColumn(pos, color, height = 30) { const e = { kind: 'column', pos: pos.clone(), color: hex(color, 1.4), height, acc: 0, on: true }; this.emitters.push(e); return e; }
  addSmoke(pos) { const e = { kind: 'smoke', pos: pos.clone(), acc: 0, on: true }; this.emitters.push(e); return e; }

  // ------------------------------------------------------------ glow sprites
  setGlows(list) {
    // list: [{pos, color, size, night}]
    if (this.glowMesh) { this.game.gfx.scene.remove(this.glowMesh); this.glowMesh.geometry.dispose(); }
    const n = list.length;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), kind = new Float32Array(n);
    list.forEach((l, i) => { pos.set([l.pos.x, l.pos.y, l.pos.z], i * 3); const c = hex(l.color, l.intensity || 1); col.set([c[0], c[1], c[2], l.size || 2], i * 4); kind[i] = l.night ? 1 : 0; });
    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3)); g.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 4)); g.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
    g.instanceCount = n; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: shared(...U_LIGHT), vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.frustumCulled = false; m.matrixAutoUpdate = false; m.renderOrder = 29; m.layers.set(LAYER_TRANS);
    this.game.gfx.scene.add(m);
    this.glowMesh = m;
  }

  // ------------------------------------------------------------ sword trail
  _initTrail(scene) {
    const N = 64;
    this.trailN = N; this.trailPts = []; this.trailOn = false; this.trailFade = 0;
    const g = new THREE.BufferGeometry();
    this.trailPos = new Float32Array(N * 2 * 3); this.trailA = new Float32Array(N * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(this.trailA, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.55, 1.0, 1.35) } },
      vertexShader: 'in float aA; out float vA; out float vS; void main(){ vA = aA; vS = float(gl_VertexID % 2); gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; in float vA; in float vS; out vec4 fragColor; void main(){ float e = pow(vS, 2.2); float a = vA * vA; fragColor = vec4(uColor * a * (0.08 + 0.92 * e) + vec3(1.0) * a * pow(vS, 9.0) * 0.9, 1.0); }',
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.trail = new THREE.Mesh(g, mat);
    this.trail.frustumCulled = false; this.trail.matrixAutoUpdate = false; this.trail.renderOrder = 32; this.trail.layers.set(LAYER_TRANS); this.trail.visible = false;
    scene.add(this.trail);
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3();
    // water rings
    this.rings = [];
  }
  startTrail(owner) { this.trailOwner = owner; this.trailOn = true; this.trailPts.length = 0; }
  endTrail() { this.trailOn = false; }
  _updateTrail(dt) {
    const o = this.trailOwner;
    if (this.trailOn && o && o.action !== 'attack') this.trailOn = false;      // interrupted swings must not leave the ribbon on
    if (this.trailOn && o && o.sword) {
      o.sword.updateWorldMatrix(true, false);
      const ty = o.trailY || [0.25, 1.5];
      this._a.set(0, ty[0], 0).applyMatrix4(o.sword.matrixWorld);
      this._b.set(0, ty[1], 0).applyMatrix4(o.sword.matrixWorld);
      // a fast swing covers a wide angle per frame: fill the gap with in-between blades so the arc stays round
      const prev = this.trailPts[0];
      if (prev) {
        const d0 = prev.b.clone().sub(prev.a), d1 = this._b.clone().sub(this._a);
        const l0 = d0.length(), l1 = d1.length();
        const ang = d0.angleTo(d1);
        const sub = Math.min(6, Math.floor(ang / 0.12));
        if (sub > 0 && l0 > 1e-4 && l1 > 1e-4) {
          const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion().setFromUnitVectors(d0.clone().normalize(), d1.clone().normalize()), q = new THREE.Quaternion();
          for (let k = 1; k <= sub; k++) {
            const f = k / (sub + 1);
            const a = prev.a.clone().lerp(this._a, f);
            const dir = d0.clone().normalize().applyQuaternion(q.copy(q0).slerp(q1, f)).multiplyScalar(l0 + (l1 - l0) * f);
            this.trailPts.unshift({ a, b: a.clone().add(dir), t: prev.t * (1 - f) });
          }
        }
      }
      this.trailPts.unshift({ a: this._a.clone(), b: this._b.clone(), t: 0 });
      while (this.trailPts.length > this.trailN) this.trailPts.pop();
    }
    for (const p of this.trailPts) p.t += dt;
    while (this.trailPts.length && this.trailPts[this.trailPts.length - 1].t > 0.22) this.trailPts.pop();
    const n = this.trailPts.length;
    this.trail.visible = n > 1;
    if (n < 2) return;
    for (let i = 0; i < this.trailN; i++) {
      const p = this.trailPts[Math.min(i, n - 1)];
      this.trailPos.set([p.a.x, p.a.y, p.a.z, p.b.x, p.b.y, p.b.z], i * 6);
      const al = i < n ? Math.max(0, 1 - p.t / 0.22) : 0;
      this.trailA[i * 2] = al; this.trailA[i * 2 + 1] = al;
    }
    this.trail.geometry.attributes.position.needsUpdate = true; this.trail.geometry.attributes.aA.needsUpdate = true;
  }

  // ------------------------------------------------------------ ambient motes around the camera
  _ambient(dt, cam) {
    this.ambientT += dt;
    if (this.ambientT < 0.05) return;
    const steps = Math.min(4, Math.floor(this.ambientT / 0.05)); this.ambientT = 0;
    const w = this.game.world, night = G.uNight.value;
    for (let s = 0; s < steps; s++) {
      const a = Math.random() * 6.283, r = 3 + Math.random() * 24;
      const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
      const h = w.heightAt(x, z);
      if (w.waterAt(x, z) > h + 0.2) continue;
      biomeWeights(x, z, h, this._bw);
      const bw = this._bw, k = Math.random();
      if (h > 300) { // snow
        this.alpha.spawn(x, cam.y + 6 + Math.random() * 6, z, rnd(0.5), -1.4, rnd(0.5), { life: 6, size: 0.07, color: [1, 1, 1], type: P.SOFT, alpha: 0.9, wind: 1.5 });
      } else if (bw[BIOME.SAKURA] > 0.4 && k < 0.8) {
        this.alpha.spawn(x, h + 3 + Math.random() * 5, z, rnd(0.4), -0.7 - Math.random() * 0.5, rnd(0.4), { life: 7, size: 0.11, color: [0.98, 0.62, 0.74], type: P.PETAL, flutter: 0.6 + Math.random(), spin: rnd(2), wind: 1.2, alpha: 0.95 });
      } else if (bw[BIOME.AUTUMN] > 0.4 && k < 0.6) {
        this.alpha.spawn(x, h + 3 + Math.random() * 5, z, rnd(0.4), -0.9 - Math.random() * 0.5, rnd(0.4), { life: 6, size: 0.14, color: k < 0.3 ? [0.9, 0.4, 0.08] : [0.85, 0.62, 0.1], type: P.LEAF, flutter: 0.6 + Math.random(), spin: rnd(3), wind: 1.2 });
      } else if (bw[BIOME.FOREST] > 0.4 && k < 0.3) {
        this.alpha.spawn(x, h + 4 + Math.random() * 6, z, rnd(0.4), -0.9, rnd(0.4), { life: 7, size: 0.13, color: [0.3, 0.55, 0.15], type: P.LEAF, flutter: 0.5 + Math.random(), spin: rnd(3), wind: 1.0 });
      } else if (night > 0.5 && k < 0.55 && h < 200) {   // fireflies
        this.add.spawn(x, h + 0.4 + Math.random() * 1.8, z, rnd(0.4), rnd(0.2), rnd(0.4), { life: 3 + Math.random() * 3, size: 0.16, color: [1.6, 2.6, 0.5], type: P.SOFT, wind: 0.2, fadeIn: 0.8, drag: 0.3 });
      } else if (night < 0.4 && k < 0.5 && r < 16 && !(this.rainK > 0.2) && w.maskAt(x, z, 3) > 0.35) {   // butterflies over the flowers
        const pal = [[1.0, 0.95, 0.85], [1.0, 0.8, 0.2], [0.55, 0.75, 1.0], [1.0, 0.55, 0.2], [0.9, 0.6, 0.95]][(Math.random() * 5) | 0];
        this.alpha.spawn(x, h + 0.7 + Math.random() * 0.9, z, rnd(0.25), 0, rnd(0.25), { life: 9 + Math.random() * 5, size: 0.17, color: pal, type: P.BFLY, flutter: 2.4 + Math.random(), rot: rnd(0.25), fadeIn: 0.7, alpha: 1 });
      } else if (night < 0.5 && k < 0.35) {             // drifting seeds / pollen
        this.alpha.spawn(x, h + 0.5 + Math.random() * 2.5, z, rnd(0.3), 0.1 + Math.random() * 0.25, rnd(0.3), { life: 6 + Math.random() * 3, size: 0.05, color: [1.0, 1.0, 0.9], type: P.SOFT, alpha: 0.75, wind: 1.6, fadeIn: 0.8 });
      }
    }
  }

  // rain around the camera; k = 0..1
  _rain(dt, k, cam, wx, wz) {
    this.rainK = k;
    if (k < 0.02) return;
    const w = this.game.world;
    this._rainAcc = (this._rainAcc || 0) + dt * 1100 * k;
    while (this._rainAcc > 1) {
      this._rainAcc -= 1;
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 15;
      this.alpha.spawn(cam.x + Math.cos(a) * r, cam.y + 2 + Math.random() * 9, cam.z + Math.sin(a) * r, wx * 2.5, -25, wz * 2.5, { life: 0.5, size: 1.15, color: [0.8, 0.9, 1.0], type: P.STREAK, rot: -wx * 0.09, alpha: 0.5, fadeIn: 0.03 });
    }
    this._splAcc = (this._splAcc || 0) + dt * 70 * k;
    while (this._splAcc > 1) {
      this._splAcc -= 1;
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 12, x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
      const y = Math.max(w.heightAt(x, z), w.waterAt(x, z)) + 0.04;
      this.alpha.spawn(x, y, z, 0, 0, 0, { life: 0.35, size: 0.05, size1: 0.45, color: [0.9, 0.96, 1], type: P.RING, alpha: 0.5, rot: 0, flutter: -1 });
    }
  }

  _initBirds() {
    const N = 16;
    const g = new THREE.InstancedBufferGeometry();
    // two wing triangles + a small body, x = span
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0.22, 0, 0, -0.2, -1, 0, -0.05, 0, 0, 0.22, 1, 0, -0.05, 0, 0, -0.2]), 3));
    const d = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) { const f = (i / 5) | 0; d.set([f * 2.1 + (i % 5) * 0.06 + Math.random() * 0.03, 60 + f * 45 + (i % 5) * 4, 55 + f * 22 + (i % 5) * 2.2, 5.5 + f * 1.5], i * 4); }
    g.setAttribute('aBird', new THREE.InstancedBufferAttribute(d, 4));
    g.instanceCount = N; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.birdC = { value: new THREE.Vector3() };
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...shared(...U_LIGHT), uCenter: this.birdC },
      vertexShader: `${GLSL_UNIFORMS}
        uniform vec3 uCenter; in vec4 aBird; out float vShade;
        void main() {
          float ang = uTime * aBird.w / aBird.y + aBird.x * 3.0;
          vec3 c = uCenter + vec3(cos(ang) * aBird.y, aBird.z + sin(uTime * 0.3 + aBird.x) * 4.0, sin(ang) * aBird.y);
          vec3 fwd = vec3(-sin(ang), 0.0, cos(ang)), side = vec3(cos(ang), 0.0, sin(ang));
          float flap = sin(uTime * 7.5 + aBird.x * 31.0) * 0.55 * smoothstep(-0.2, 0.3, sin(uTime * 0.7 + aBird.x * 9.0));
          vec3 p = c + (side * position.x + fwd * position.z + vec3(0.0, abs(position.x) * flap, 0.0)) * 0.95 - side * 0.35;
          vShade = 0.5 + 0.5 * abs(position.x);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `${GLSL_UNIFORMS}
        in float vShade; out vec4 fragColor;
        void main() { fragColor = vec4(mix(vec3(0.05, 0.05, 0.07), uFogColor, 0.25) * (0.6 + 0.4 * vShade) * (1.0 - uNight * 0.7), 1.0); }`,
      glslVersion: THREE.GLSL3, side: THREE.DoubleSide,
    });
    this.birds = new THREE.Mesh(g, mat);
    this.birds.frustumCulled = false; this.birds.matrixAutoUpdate = false;
    this.game.gfx.scene.add(this.birds);
  }

  update(dt) {
    const g = this.game, cam = g.gfx.camera.position;
    if (!this.birds) this._initBirds();
    this.birdC.value.lerp(_bc.set(cam.x, g.world.heightAt(cam.x, cam.z), cam.z), Math.min(1, dt * 0.25));
    this.birds.visible = !(this.rainK > 0.3) && G.uNight.value < 0.7;
    const wind = G.uWind.value;
    const wx = wind.x * wind.z * 1.6, wz = wind.y * wind.z * 1.6;
    this._ambient(dt, cam);
    this._rain(dt, g.rain || 0, cam, wx, wz);
    // emitters
    for (const e of this.emitters) {
      if (!e.on) continue;
      const d2 = (e.pos.x - cam.x) ** 2 + (e.pos.z - cam.z) ** 2;
      if (d2 > 140 * 140) continue;
      e.acc += dt;
      if (e.kind === 'fire') {
        while (e.acc > 0.035) {
          e.acc -= 0.035;
          const s = e.scale;
          this.add.spawn(e.pos.x + rnd(0.22 * s), e.pos.y + 0.15, e.pos.z + rnd(0.22 * s), rnd(0.3), 1.6 + Math.random() * 1.4, rnd(0.3), { life: 0.5 + Math.random() * 0.35, size: 0.75 * s, size1: 0.1, color: [2.4, 0.9 + Math.random() * 0.7, 0.15], type: P.SOFT, wind: 0.5 });
          if (Math.random() < 0.12) this.add.spawn(e.pos.x, e.pos.y + 0.5, e.pos.z, rnd(1), 2.5 + Math.random() * 2, rnd(1), { life: 1.2, size: 0.07, color: [3, 1.6, 0.4], type: P.SOFT, wind: 1.5 });
          if (Math.random() < 0.1) this.alpha.spawn(e.pos.x, e.pos.y + 1.2, e.pos.z, rnd(0.2), 1.3, rnd(0.2), { life: 2.2, size: 0.5, size1: 1.6, color: [0.25, 0.25, 0.27], type: P.SMOKE, alpha: 0.3, wind: 1.2 });
        }
      } else if (e.kind === 'mist') {
        while (e.acc > 0.06) {
          e.acc -= 0.06;
          const s = e.scale;
          this.alpha.spawn(e.pos.x + rnd(3 * s), e.pos.y + Math.random() * 1.5, e.pos.z + rnd(3 * s), rnd(1.5), 0.8 + Math.random() * 1.5, rnd(1.5), { life: 2.2 + Math.random(), size: 2 * s, size1: 5.5 * s, color: [0.92, 0.97, 1.0], type: P.SMOKE, alpha: 0.26, wind: 0.6, fadeIn: 0.5 });
        }
      } else if (e.kind === 'column') {
        while (e.acc > 0.05) {
          e.acc -= 0.05;
          this.add.spawn(e.pos.x + rnd(0.5), e.pos.y + Math.random() * 2, e.pos.z + rnd(0.5), 0, 4 + Math.random() * 6, 0, { life: 2.5, size: 0.3, size1: 0.05, color: e.color, type: P.STAR, fadeIn: 0.3 });
        }
      } else if (e.kind === 'smoke') {
        while (e.acc > 0.3) {
          e.acc -= 0.3;
          this.alpha.spawn(e.pos.x, e.pos.y, e.pos.z, rnd(0.1), 0.9, rnd(0.1), { life: 5, size: 0.5, size1: 2.4, color: [0.8, 0.8, 0.82], type: P.SMOKE, alpha: 0.28, wind: 0.9, fadeIn: 0.6 });
        }
      }
    }
    // water rings as expanding ring particles
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      if (r.t === 0) this.alpha.spawn(r.x, r.y, r.z, 0, 0, 0, { life: r.life, size: 0.3, size1: 2.6 * r.s, color: [0.95, 1, 1], type: P.RING, alpha: 0.5, rot: 0, flutter: -1 });
      r.t += dt;
      this.rings.splice(i, 1);
    }
    this.alpha.update(dt, wx, wz);
    this.add.update(dt, wx, wz);
    this._updateTrail(dt);
  }
}

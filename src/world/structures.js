// Procedural architecture: shrines, tower, village, ruins, bridges, floating islands.
// Everything is merged into a few static meshes with one stylised "building" shader.
import * as THREE from 'three';
import { shared, U_LIGHT, U_SHADOW } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_SHADOW, GLSL_FOG, GLSL_LIGHT } from '../shaders/common.js';
import { POI, LAKES, VILLAGE_HOUSES, RUIN_COTTAGES } from './layout.js';
import { mulberry32 } from './noise.js';
import { KitBuilder, kitHouse, kitTower, kitShrine, kitCamp, kitRuin } from './villagekit.js';

// material ids
export const M = { STONE: 0, WOOD: 1, PLASTER: 2, ROOF: 3, GLOW: 4, WINDOW: 5, PLAIN: 6, ROCK: 7, GRASS: 8, METAL: 9 };

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();
const _c = new THREE.Color();

export class Builder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.mat = []; this.base = new THREE.Matrix4(); }
  setBase(x, y, z, rotY = 0, scale = 1) { this.base.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, rotY, 0)), _s.set(scale, scale, scale)); return this; }
  // add any BufferGeometry with a local transform
  add(geo, { p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1], color = 0xffffff, mat = M.STONE, emis = 0, jitter = 0 } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const m = new THREE.Matrix4().compose(_p.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.set(s[0], s[1], s[2]));
    m.premultiply(this.base);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    _c.set(color);
    const v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(m); this.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); this.nrm.push(v.x, v.y, v.z);
      if (U) this.uv.push(U.getX(i), U.getY(i)); else this.uv.push(0, 0);
      const j = jitter ? 1 + (Math.sin(i * 12.9898 + this.pos.length) * 43758.5453 % 1) * jitter : 1;
      this.col.push(_c.r * j, _c.g * j, _c.b * j);
      this.mat.push(mat, emis);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }
  box(x, y, z, sx, sy, sz, o = {}) { return this.add(new THREE.BoxGeometry(sx, sy, sz), { ...o, p: [x, y, z] }); }
  cyl(x, y, z, rt, rb, h, seg = 12, o = {}) { return this.add(new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!o.open), { ...o, p: [x, y, z] }); }
  cone(x, y, z, r, h, seg = 12, o = {}) {
    const g = new THREE.ConeGeometry(r, h, seg);
    // uv in metres (around, up the slope) so roof tiles keep their size on any cone
    const U = g.attributes.uv, ku = 2 * Math.PI * r, kv = Math.hypot(r, h);
    for (let i = 0; i < U.count; i++) U.setXY(i, U.getX(i) * ku, U.getY(i) * kv);
    return this.add(g, { ...o, p: [x, y, z] });
  }
  sphere(x, y, z, r, detail = 1, o = {}) { return this.add(new THREE.IcosahedronGeometry(r, detail), { ...o, p: [x, y, z] }); }
  // gable roof prism: ridge along local x
  gable(x, y, z, w, d, h, o = {}) {
    const hw = w / 2, hd = d / 2;
    const v = [
      // two slopes
      -hw, 0, hd, hw, 0, hd, hw, h, 0, -hw, 0, hd, hw, h, 0, -hw, h, 0,
      hw, 0, -hd, -hw, 0, -hd, -hw, h, 0, hw, 0, -hd, -hw, h, 0, hw, h, 0,
      // gable ends
      -hw, 0, -hd, -hw, 0, hd, -hw, h, 0,
      hw, 0, hd, hw, 0, -hd, hw, h, 0,
      // underside
      -hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, -hd, hw, 0, hd, -hw, 0, hd,
    ];
    const sl = Math.hypot(hd, h);
    const uv = [0, 0, w, 0, w, sl, 0, 0, w, sl, 0, sl, 0, 0, w, 0, w, sl, 0, 0, w, sl, 0, sl, 0, 0, d, 0, hd, h, 0, 0, d, 0, hd, h, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return this.add(g, { ...o, p: [x, y, z] });
  }
  // lumpy rock (deformed icosahedron)
  rock(x, y, z, r, seed, o = {}) {
    const g = new THREE.IcosahedronGeometry(1, o.detail !== undefined ? o.detail : 1);
    const P = g.attributes.position;
    const rnd = mulberry32(seed * 7919 + 13);
    const k = [rnd() * 6, rnd() * 6, rnd() * 6];
    for (let i = 0; i < P.count; i++) {
      const vx = P.getX(i), vy = P.getY(i), vz = P.getZ(i);
      const d = 1 + 0.22 * Math.sin(vx * 3.1 + k[0]) * Math.cos(vy * 2.7 + k[1]) + 0.16 * Math.sin(vz * 4.3 + k[2] + vx * 2.0);
      P.setXYZ(i, vx * d, vy * d * (o.flat || 0.8), vz * d);
    }
    const flat = g.index ? g.toNonIndexed() : g; flat.computeVertexNormals(); if (flat !== g) g.dispose();
    return this.add(flat, { color: 0x77726c, mat: M.ROCK, ...o, p: [x, y, z], s: o.s || [r, r, r], r: o.r || [0, rnd() * 6, 0] });
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 2));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

const VERT = /* glsl */`
in vec3 color;
in vec2 aMat;
out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec3 vColor;
flat out vec2 vMat;
void main() {
#ifdef USE_INSTANCING
  mat4 im = instanceMatrix;
#else
  mat4 im = mat4(1.0);
#endif
  vec4 wp = modelMatrix * im * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(im) * normal);
  vUv = uv; vColor = color; vMat = aMat;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_SHADOW}
${GLSL_FOG}
${GLSL_LIGHT}
uniform sampler2D uNoiseTex;
uniform float uGlowPulse;
// hand-painted textures from the village kit, shared by every procedural structure
uniform sampler2D uTexBrick, uTexCobble, uTexWood, uTexPlaster, uTexTiles;
uniform float uUseTex;
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in vec3 vColor;
flat in vec2 vMat;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 wp = vWorldPos;
  vec3 V = normalize(cameraPosition - wp);
  int type = int(vMat.x + 0.5);
  vec3 albedo = vColor;
  vec3 emissive = vec3(0.0);
  vec3 an = abs(N);
  vec2 side = an.x > an.z ? vec2(wp.z, wp.y) : vec2(wp.x, wp.y);
  vec2 tuv = an.y > 0.72 ? wp.xz : side;
  float n1 = texture(uNoiseTex, tuv * 0.11).r;
  float n2 = texture(uNoiseTex, tuv * 0.47).g;
  float rim = 0.35;
  if (type == 0) {
    // weathered masonry: staggered blocks with dark mortar, moss creeping over the top
    vec2 buv = tuv / vec2(1.05, 0.52);
    buv.x += floor(buv.y) * 0.5;
    vec2 f = fract(buv);
    float mortar = smoothstep(0.0, 0.05, min(min(f.x, 1.0 - f.x) * 2.0, min(f.y, 1.0 - f.y)));
    float br = hash12(floor(buv));
    albedo *= (0.84 + 0.26 * br) * mix(0.66, 1.0, mortar) * (0.86 + 0.28 * n1);
    if (uUseTex > 0.5) {
      // painted ashlar on walls, cobbles on floors; the vertex colour only sets how light the stone is
      vec3 tx = an.y > 0.72 ? texture(uTexCobble, tuv * 0.3).rgb * 1.15 : texture(uTexBrick, tuv * vec2(0.3, -0.3)).rgb;
      albedo = tx * clamp(vColor / 0.33, 0.55, 1.4) * (0.9 + 0.2 * n1) * vec3(0.95, 0.98, 1.08);
    }
    float moss = smoothstep(0.52, 0.78, n1 * 0.75 + n2 * 0.3 + N.y * 0.3);
    albedo = mix(albedo, vec3(0.13, 0.25, 0.07) * (0.8 + 0.5 * n2), moss * mix(0.62, 0.42, uUseTex));
  } else if (type == 1) {
    float grain = texture(uNoiseTex, tuv * vec2(0.9, 0.07)).r;
    albedo *= 0.8 + 0.4 * grain;
    if (uUseTex > 0.5) {
      // plank grain from the kit's wood sheet (its top band), running along the height of posts
      vec3 tx = texture(uTexWood, vec2(tuv.y * 0.28, fract(tuv.x * 0.55) * 0.24 + 0.02)).rgb;
      albedo = vColor * clamp(luma(tx) / 0.115, 0.55, 1.7);
    }
  } else if (type == 2) {
    albedo *= 0.92 + 0.12 * n1;
    albedo = mix(albedo, albedo * vec3(0.8, 0.76, 0.66), smoothstep(0.6, 0.9, n2) * 0.35);
    if (uUseTex > 0.5) albedo = vColor * clamp(luma(texture(uTexPlaster, tuv * 0.3).rgb) / 0.42, 0.7, 1.25);
  } else if (type == 3 && uUseTex > 0.5) {
    // clay tiles from the kit, tinted by the roof colour (uv is in metres, v toward the ridge)
    vec3 tx = texture(uTexTiles, vec2(vUv.x, -vUv.y) * 0.42).rgb;
    albedo = vColor * (0.3 + 1.45 * luma(tx)) * 1.5;
    rim = 0.5;
  } else if (type == 3) {
    // scalloped clay tiles: rounded lower edges, the gap shows the shadowed row beneath
    vec2 su = vUv * vec2(2.6, 3.4);
    su.x += floor(su.y) * 0.5;
    vec2 f = fract(su);
    float sh = hash12(floor(su));
    float edge = 0.34 * (1.0 - cos((f.x - 0.5) * 3.1416));
    float tile = smoothstep(edge - 0.03, edge + 0.05, f.y);
    albedo *= (0.8 + 0.3 * sh) * mix(0.5, 1.0, tile) * mix(0.86, 1.0, smoothstep(edge, edge + 0.45, f.y));
    rim = 0.5;
  } else if (type == 4) {
    float pulse = 0.8 + 0.2 * sin(uTime * 2.0 + wp.y * 2.0 + wp.x);
    emissive = vColor * vMat.y * pulse;
    albedo *= 0.6;
  } else if (type == 5) {
    // window: dark glass by day, warm light at night
    float lit = smoothstep(0.25, 0.75, uNight) * step(0.2, hash12(floor(wp.xz * 0.37) + floor(wp.y * 0.5)));
    emissive = vec3(1.0, 0.62, 0.25) * 2.6 * lit;
    albedo = mix(vec3(0.07, 0.10, 0.16), vec3(0.4, 0.28, 0.12), lit);
    rim = 0.8;
  } else if (type == 7) {
    albedo *= 0.8 + 0.4 * n1;
    float moss = smoothstep(0.5, 0.8, n2 * 0.5 + N.y * 0.55);
    albedo = mix(albedo, vec3(0.14, 0.27, 0.07), moss * 0.6);
  } else if (type == 8) {
    albedo *= 0.82 + 0.36 * n1;
  }
  float shadow = getShadow(wp, N) * cloudShadow(wp);
  if (type == 9) rim = 1.4;
  vec3 col = toonShade(albedo, N, V, shadow, 1.0, rim);
  if (type == 9) {
    // polished steel: a hard highlight band and a touch of sky
    vec3 Hm = normalize(uLightDir + V);
    col += uLightColor * smoothstep(0.86, 0.93, dot(N, Hm)) * 0.9 * shadow + uAmbSky * 0.25 * pow(1.0 - max(dot(N, V), 0.0), 2.0);
  }
  col += emissive;
  col = applyFog(col, wp);
  fragColor = vec4(col, 1.0);
}
`;

let _mat = null, _depth = null;
const TEXU = { uTexBrick: { value: null }, uTexCobble: { value: null }, uTexWood: { value: null }, uTexPlaster: { value: null }, uTexTiles: { value: null }, uUseTex: { value: 0 } };
// give the procedural structures the village kit's painted textures (call once the kit has loaded)
export function setBuildingTextures(tex) {
  if (!tex || !tex['brick.jpg']) return;
  TEXU.uTexBrick.value = tex['brick.jpg']; TEXU.uTexCobble.value = tex['stone.jpg']; TEXU.uTexWood.value = tex['wood.jpg'];
  TEXU.uTexPlaster.value = tex['plaster.jpg']; TEXU.uTexTiles.value = tex['tiles.jpg'];
  TEXU.uUseTex.value = 1;
}
export function buildingMaterial() {
  if (!_mat) {
    _mat = new THREE.ShaderMaterial({
      uniforms: { ...shared(...U_LIGHT, ...U_SHADOW, 'uNoiseTex'), uGlowPulse: { value: 1 }, ...TEXU },
      vertexShader: VERT, fragmentShader: FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide,
    });
    _depth = new THREE.ShaderMaterial({
      vertexShader: 'void main(){\n#ifdef USE_INSTANCING\n gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);\n#else\n gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);\n#endif\n}',
      fragmentShader: 'void main(){}', glslVersion: THREE.GLSL3, colorWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: 3,
    });
  }
  return { main: _mat, depth: _depth };
}

export function meshFrom(builder, gfx, cast = true) {
  const mats = buildingMaterial();
  const mesh = new THREE.Mesh(builder.build(), mats.main);
  mesh.userData.shadowMat = mats.depth;
  mesh.matrixAutoUpdate = false;
  if (cast && gfx) gfx.addCaster(mesh);
  return mesh;
}

// ------------------------------------------------------------------ palettes
const STONE = 0x9a958a, STONE_D = 0x7c776e, STONE_L = 0xb9b3a4, WOODC = 0x6b4526, WOOD_D = 0x4a2f1a, PLASTERC = 0xe9dfc8;
const ROOFS = [0xa8452c, 0x2f7477, 0x3d5c96, 0xa8762c, 0x8a4f3a];
const CYAN = 0x66e0ff, GOLD = 0xffc45a;

// ------------------------------------------------------------------ pieces
function column(b, x, y, z, h, r = 0.55, broken = 0, color = STONE_L) {
  b.cyl(x, y + 0.25, z, r * 1.35, r * 1.5, 0.5, 8, { color: STONE });
  const hh = broken > 0 ? h * (0.35 + 0.5 * broken) : h;
  b.cyl(x, y + 0.5 + hh / 2, z, r * 0.9, r, hh, 10, { color });
  if (!broken) { b.cyl(x, y + 0.5 + h + 0.2, z, r * 1.5, r * 1.0, 0.4, 8, { color: STONE }); b.box(x, y + 0.5 + h + 0.55, z, r * 3.1, 0.3, r * 3.1, { color: STONE }); }
}

const GREENS = [0x2f6a25, 0x3f8030, 0x275a22];
// creeper wrapped around a column / wall in the current frame
function ivy(b, x, y, z, h, r, rnd, n = 12) {
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, yy = rnd() * rnd() * h;
    b.sphere(x + Math.cos(a) * r, y + yy, z + Math.sin(a) * r, 0.2 + rnd() * 0.22, 0, { color: GREENS[k % 3], mat: M.PLAIN, jitter: 0.2 });
  }
}
function brazier(b, x, y, z) {
  b.cyl(x, y + 0.45, z, 0.16, 0.27, 0.9, 8, { color: STONE_D });
  b.cyl(x, y + 1.0, z, 0.44, 0.2, 0.26, 10, { color: 0x4a4038, mat: M.METAL });
  b.sphere(x, y + 1.1, z, 0.2, 0, { color: 0xff9a3a, mat: M.GLOW, emis: 2.4, s: [1.6, 0.45, 1.6] });
  return new THREE.Vector3(x, y + 1.22, z).applyMatrix4(b.base);
}
function banner(b, x, y, z, color, rotY = 0) {
  const c = new THREE.Color(color).multiplyScalar(0.5).getHex();
  b.box(x, y, z, 1.05, 2.5, 0.05, { color: c, mat: M.PLASTER, r: [0, rotY, 0] });
  b.box(x, y + 1.3, z, 1.25, 0.1, 0.1, { color: WOOD_D, mat: M.WOOD, r: [0, rotY, 0] });
  b.box(x, y - 1.2, z, 1.05, 0.12, 0.07, { color: GOLD, mat: M.METAL, r: [0, rotY, 0] });
  b.add(new THREE.OctahedronGeometry(0.26, 0), { p: [x, y + 0.2, z], r: [0, rotY, 0], s: [1, 1.3, 0.25], color, mat: M.GLOW, emis: 1.6 });
}
// a tall pointed arch of wedge stones, optionally broken at the crown
function greatArch(b, span, height, broken) {
  for (const sx of [-1, 1]) { b.box(sx * span / 2, height * 0.3, 0, 1.3, height * 0.6, 1.3, { color: STONE }); b.box(sx * span / 2, height * 0.6 + 0.15, 0, 1.6, 0.3, 1.6, { color: STONE_L }); b.box(sx * span / 2, 0.2, 0, 1.8, 0.4, 1.8, { color: STONE_D }); }
  const N = 9;
  for (let i = 0; i < N; i++) {
    if (broken && (i === 4 || i === 5)) continue;
    const t = (i + 0.5) / N, a = Math.PI * t;
    const x = -Math.cos(a) * span / 2, y = height * 0.6 + Math.sin(a) * span * 0.62;
    b.box(x, y, 0, 1.0, span * 0.36, 1.1, { color: i % 2 ? STONE_L : STONE, r: [0, 0, Math.PI / 2 - a] });
  }
}

function waypointObelisk(b, x, y, z) {
  b.setBase(x, y, z);
  b.cyl(0, 0.15, 0, 2.3, 2.5, 0.3, 16, { color: STONE });
  b.cyl(0, 0.38, 0, 1.75, 1.9, 0.18, 16, { color: STONE_L });
  b.add(new THREE.TorusGeometry(1.45, 0.07, 6, 32), { p: [0, 0.5, 0], r: [Math.PI / 2, 0, 0], color: CYAN, mat: M.GLOW, emis: 3.2 });
  b.cyl(0, 1.9, 0, 0.3, 0.55, 2.9, 6, { color: STONE_D });
  b.cyl(0, 3.5, 0, 0.5, 0.3, 0.3, 6, { color: STONE });
  // floating crystal
  b.add(new THREE.OctahedronGeometry(0.42, 0), { p: [0, 4.45, 0], s: [1, 1.8, 1], color: CYAN, mat: M.GLOW, emis: 4.5 });
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; b.box(Math.cos(a) * 0.36, 2.2, Math.sin(a) * 0.36, 0.05, 1.6, 0.05, { color: CYAN, mat: M.GLOW, emis: 2.4 }); }
}

function awakeningShrine(b, x, y, z) {
  b.setBase(x, y, z);
  // tiered circular dais
  b.cyl(0, 0.15, 0, 13.2, 13.6, 0.3, 28, { color: STONE_D });
  b.cyl(0, 0.42, 0, 11.2, 11.4, 0.3, 28, { color: STONE });
  b.cyl(0, 0.72, 0, 4.6, 4.8, 0.4, 20, { color: STONE_L });
  // central resting slab with runes
  b.box(0, 1.15, 0, 2.6, 0.5, 1.5, { color: STONE_L });
  b.add(new THREE.TorusGeometry(3.6, 0.06, 6, 40), { p: [0, 0.95, 0], r: [Math.PI / 2, 0, 0], color: CYAN, mat: M.GLOW, emis: 2.4 });
  // ring of columns, some broken, with lintels
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2 + 0.31;
    const cx = Math.cos(a) * 9.6, cz = Math.sin(a) * 9.6;
    const broken = (i === 2 || i === 6) ? 0.4 : (i === 9 ? 0.75 : 0);
    column(b, cx, 0.55, cz, 6.2, 0.6, broken);
    if (!broken && i !== 1 && i !== 5 && i !== 8) {
      const a2 = (i + 1) / n * Math.PI * 2 + 0.31, mx = (cx + Math.cos(a2) * 9.6) / 2, mz = (cz + Math.sin(a2) * 9.6) / 2;
      b.box(mx, 7.95, mz, 6.3, 0.55, 1.1, { color: STONE, r: [0, -(a + a2) / 2 + Math.PI / 2, 0] });
    }
  }
  // fallen drum pieces
  b.cyl(6.2, 0.95, 3.4, 0.56, 0.56, 2.4, 10, { color: STONE_L, r: [Math.PI / 2, 0.6, 0] });
  b.cyl(-5.0, 0.95, -6.6, 0.56, 0.56, 1.7, 10, { color: STONE_L, r: [Math.PI / 2, 2.1, 0] });
  // entrance steps toward the north (-z)
  for (let i = 0; i < 4; i++) b.box(0, 0.08 + (3 - i) * 0.0, -13.9 - i * 0.7, 5.2, 0.3 - i * 0.06, 0.8, { color: STONE });
}

function trialShrine(b, x, y, z, rot, gem) {
  b.setBase(x, y, z, rot);
  b.cyl(0, 0.25, 0, 7.0, 7.4, 0.5, 8, { color: STONE_D });
  b.cyl(0, 0.65, 0, 5.8, 6.0, 0.3, 8, { color: STONE });
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    column(b, Math.cos(a) * 4.3, 0.8, Math.sin(a) * 4.3, 4.6, 0.5, 0);
  }
  b.cyl(0, 6.75, 0, 5.4, 5.8, 0.45, 8, { color: STONE });
  b.cone(0, 8.4, 0, 5.2, 2.9, 8, { color: 0x2b6d74, mat: M.ROOF });
  b.add(new THREE.OctahedronGeometry(0.34, 0), { p: [0, 10.3, 0], s: [1, 1.7, 1], color: gem, mat: M.GLOW, emis: 4 });
  // altar
  b.cyl(0, 1.1, 0, 0.9, 1.1, 0.7, 8, { color: STONE_L });
  b.add(new THREE.TorusGeometry(2.4, 0.06, 6, 32), { p: [0, 0.86, 0], r: [Math.PI / 2, 0, 0], color: gem, mat: M.GLOW, emis: 2.6 });
  // steps on the front (+z local)
  for (let i = 0; i < 3; i++) b.box(0, 0.18 + i * 0.0, 7.3 + i * 0.6, 3.6, 0.5 - i * 0.14, 0.7, { color: STONE });
  const rnd = mulberry32(Math.round(x * 7 + z * 13));
  const fl = [brazier(b, -2.7, 0.75, 6.2), brazier(b, 2.7, 0.75, 6.2)];
  banner(b, -3.04, 4.3, 3.75, gem); banner(b, 3.04, 4.3, 3.75, gem);
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; ivy(b, Math.cos(a) * 4.3, 1.2, Math.sin(a) * 4.3, 3.0, 0.56, rnd, 7); }
  return { braziers: fl };
}

function skyTower(b, x, y, z) {
  b.setBase(x, y, z);
  const H = 44, R = 5.2;
  b.cyl(0, 0.6, 0, R + 2.2, R + 3.0, 1.6, 16, { color: STONE_D });
  b.cyl(0, 1.2 + H / 2, 0, R * 0.86, R, H, 16, { color: STONE_L });
  // buttresses
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    b.box(Math.cos(a) * (R + 0.6), 7.5, Math.sin(a) * (R + 0.6), 1.5, 14, 1.3, { color: STONE, r: [0, -a, 0] });
    b.box(Math.cos(a) * (R + 0.2), 15.4, Math.sin(a) * (R + 0.2), 1.3, 2.2, 1.1, { color: STONE, r: [0, -a, 0.5] });
  }
  // resting ledges
  for (const ly of [12, 23, 34]) {
    const rr = R * (1 - (ly / H) * 0.14) + 1.5;
    b.cyl(0, ly, 0, rr, rr - 0.5, 0.55, 16, { color: STONE });
    b.add(new THREE.TorusGeometry(rr - 0.3, 0.05, 5, 32), { p: [0, ly + 0.3, 0], r: [Math.PI / 2, 0, 0], color: CYAN, mat: M.GLOW, emis: 1.8 });
  }
  // glowing slit windows
  for (let i = 0; i < 12; i++) {
    const a = i * 1.9, yy = 6 + i * 3.1, rr = R * (1 - (yy / H) * 0.14) + 0.02;
    b.box(Math.cos(a) * rr, yy, Math.sin(a) * rr, 0.25, 1.5, 0.5, { color: CYAN, mat: M.GLOW, emis: 2.2, r: [0, -a, 0] });
  }
  // top platform + parapet + beacon
  const ty = H + 1.2;
  b.cyl(0, ty + 0.3, 0, 7.4, 6.2, 0.9, 16, { color: STONE });
  for (let i = 0; i < 16; i++) {
    if (i % 4 === 0) continue;
    const a = (i + 0.5) / 16 * Math.PI * 2;
    b.box(Math.cos(a) * 7.0, ty + 1.3, Math.sin(a) * 7.0, 2.2, 1.1, 0.5, { color: STONE_L, r: [0, -a + Math.PI / 2, 0] });
  }
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; column(b, Math.cos(a) * 3.4, ty + 0.75, Math.sin(a) * 3.4, 4.2, 0.4, 0); }
  b.cyl(0, ty + 6.3, 0, 4.9, 5.3, 0.4, 12, { color: STONE });
  b.cone(0, ty + 8.2, 0, 5.0, 3.4, 12, { color: 0x2b6d74, mat: M.ROOF });
  b.cyl(0, ty + 1.2, 0, 0.9, 1.2, 0.9, 8, { color: STONE_L });
  b.add(new THREE.OctahedronGeometry(0.7, 0), { p: [0, ty + 3.2, 0], s: [1, 1.7, 1], color: CYAN, mat: M.GLOW, emis: 5 });
  return { topY: y + ty + 0.75 };
}

function house(b, x, y, z, rot, w, d, roofColor, seed) {
  const rnd = mulberry32(seed);
  b.setBase(x, y, z, rot);
  const wallH = 3.0 + rnd() * 0.5, baseH = 0.9;
  // stone foundation sunk into the ground
  b.box(0, baseH / 2 - 0.6, 0, w + 0.5, baseH + 1.2, d + 0.5, { color: STONE });
  // plaster walls
  b.box(0, baseH + wallH / 2, 0, w, wallH, d, { color: PLASTERC, mat: M.PLASTER });
  // timber frame
  const t = 0.22;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * (w / 2), baseH + wallH / 2, sz * (d / 2), t, wallH, t, { color: WOOD_D, mat: M.WOOD });
  for (const sz of [-1, 1]) {
    b.box(0, baseH + wallH - 0.1, sz * (d / 2 + 0.01), w + 0.1, t, t * 0.6, { color: WOOD_D, mat: M.WOOD });
    b.box(0, baseH + 0.1, sz * (d / 2 + 0.01), w + 0.1, t, t * 0.6, { color: WOOD_D, mat: M.WOOD });
    b.box(-w * 0.22, baseH + wallH / 2, sz * (d / 2 + 0.01), t, wallH, t * 0.6, { color: WOOD_D, mat: M.WOOD });
    b.box(w * 0.22, baseH + wallH / 2, sz * (d / 2 + 0.01), t, wallH, t * 0.6, { color: WOOD_D, mat: M.WOOD });
  }
  for (const sx of [-1, 1]) {
    b.box(sx * (w / 2 + 0.01), baseH + wallH - 0.1, 0, t * 0.6, t, d + 0.1, { color: WOOD_D, mat: M.WOOD });
    b.box(sx * (w / 2 + 0.01), baseH + wallH / 2, 0, t * 0.6, t, d + 0.1, { color: WOOD_D, mat: M.WOOD });
    b.box(sx * (w / 2 + 0.01), baseH + wallH * 0.5, 0, t * 0.6, wallH * 1.05, t, { color: WOOD_D, mat: M.WOOD, r: [0.55 * sx, 0, 0] });
  }
  // roof (ridge along x) with overhang
  const roofH = d * 0.62;
  b.gable(0, baseH + wallH, 0, w + 1.1, d + 1.5, roofH, { color: roofColor, mat: M.ROOF });
  b.box(0, baseH + wallH + roofH + 0.04, 0, w + 1.3, 0.18, 0.3, { color: WOOD_D, mat: M.WOOD });
  // gable walls
  for (const sx of [-1, 1]) {
    const g = new THREE.BufferGeometry();
    const hd = d / 2, hh = roofH * (hd / (hd + 0.75));
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -hd, 0, 0, hd, 0, hh, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    g.computeVertexNormals();
    b.add(g, { p: [sx * (w / 2 - 0.02), baseH + wallH, 0], color: PLASTERC, mat: M.PLASTER });
  }
  // door on +z
  b.box(0, baseH + 1.05, d / 2 + 0.06, 1.15, 2.1, 0.12, { color: WOODC, mat: M.WOOD });
  b.box(0, baseH + 2.2, d / 2 + 0.08, 1.5, 0.2, 0.18, { color: WOOD_D, mat: M.WOOD });
  b.box(0, baseH - 0.1, d / 2 + 0.8, 1.9, 0.3, 1.2, { color: STONE_L });
  b.sphere(0.4, baseH + 1.05, d / 2 + 0.14, 0.06, 0, { color: GOLD, mat: M.GLOW, emis: 0.6 });
  // windows
  const win = (px, py, pz, ry) => {
    b.box(px, py, pz, 0.95, 1.05, 0.1, { color: 0xffffff, mat: M.WINDOW, r: [0, ry, 0] });
    b.box(px, py, pz, 1.15, 0.12, 0.16, { color: WOOD_D, mat: M.WOOD, r: [0, ry, 0] });
    b.box(px, py, pz, 0.1, 1.15, 0.16, { color: WOOD_D, mat: M.WOOD, r: [0, ry, 0] });
    b.box(px, py - 0.62, pz, 1.3, 0.14, 0.3, { color: WOOD_D, mat: M.WOOD, r: [0, ry, 0] });
  };
  win(-w * 0.33, baseH + 1.75, d / 2 + 0.03, 0); win(w * 0.33, baseH + 1.75, d / 2 + 0.03, 0);
  win(-w * 0.25, baseH + 1.75, -d / 2 - 0.03, 0); win(w * 0.25, baseH + 1.75, -d / 2 - 0.03, 0);
  win(w / 2 + 0.03, baseH + 1.75, 0, Math.PI / 2); win(-w / 2 - 0.03, baseH + 1.75, 0, Math.PI / 2);
  // chimney
  const cx = (rnd() - 0.5) * w * 0.5;
  b.box(cx, baseH + wallH + roofH * 0.75, -d * 0.2, 0.8, roofH * 1.1, 0.8, { color: STONE_D });
  b.box(cx, baseH + wallH + roofH * 1.32, -d * 0.2, 1.0, 0.2, 1.0, { color: STONE });
  // flower box
  b.box(-w * 0.33, baseH + 1.08, d / 2 + 0.26, 1.1, 0.22, 0.3, { color: WOODC, mat: M.WOOD });
  for (let i = 0; i < 4; i++) b.sphere(-w * 0.33 - 0.4 + i * 0.27, baseH + 1.3, d / 2 + 0.26, 0.12, 0, { color: [0xff6f91, 0xffd166, 0xffffff, 0xff8fab][i], mat: M.PLAIN });
  return { chimney: [cx, baseH + wallH + roofH * 1.45, -d * 0.2], wallH, baseH, roofH };
}

// storybook dressing for a house (call right after house(): the builder base is still the house frame)
function dressHouse(b, w, d, hInfo, roofColor, seed) {
  const rnd = mulberry32(seed * 31 + 7);
  const { wallH, baseH, roofH } = hInfo;
  const SHUT = [0x2f6f6a, 0x7a3b2e, 0x3d5c96, 0x4f7a3a][seed % 4];
  // flared eaves
  for (const sz of [-1, 1]) b.box(0, baseH + wallH - 0.2, sz * (d / 2 + 1.02), w + 1.25, 0.09, 0.95, { color: roofColor, mat: M.ROOF, r: [sz * 0.42, 0, 0] });
  // porch: posts and a little roof over the door
  for (const sx of [-1, 1]) { b.box(sx * 0.95, baseH + 1.1, d / 2 + 1.35, 0.14, 2.4, 0.14, { color: WOOD_D, mat: M.WOOD }); b.box(sx * 0.95, baseH + 2.0, d / 2 + 0.95, 0.1, 0.1, 0.9, { color: WOOD_D, mat: M.WOOD, r: [0.6, 0, 0] }); }
  b.box(0, baseH + 2.42, d / 2 + 0.8, 2.5, 0.09, 1.7, { color: roofColor, mat: M.ROOF, r: [0.34, 0, 0] });
  b.box(0, baseH + 2.3, d / 2 + 1.38, 2.2, 0.12, 0.12, { color: WOOD_D, mat: M.WOOD });
  // shutters on the front windows
  for (const wx of [-w * 0.33, w * 0.33]) for (const sx of [-1, 1]) b.box(wx + sx * 0.68, baseH + 1.75, d / 2 + 0.07, 0.3, 1.02, 0.06, { color: SHUT, mat: M.WOOD });
  // dormer window in the front slope
  {
    const dx = (rnd() - 0.5) * w * 0.4, sl = (d / 2 + 0.75), fz = sl * 0.52, fy = baseH + wallH + roofH * (1 - 0.52) - 0.1;
    b.box(dx, fy + 0.35, fz - 0.25, 1.2, 1.1, 1.3, { color: PLASTERC, mat: M.PLASTER });
    b.box(dx, fy + 0.42, fz + 0.42, 0.62, 0.6, 0.06, { color: 0xffffff, mat: M.WINDOW });
    b.box(dx, fy + 0.42, fz + 0.44, 0.74, 0.07, 0.08, { color: WOOD_D, mat: M.WOOD }); b.box(dx, fy + 0.42, fz + 0.44, 0.07, 0.7, 0.08, { color: WOOD_D, mat: M.WOOD });
    const savedBase = b.base.clone();
    b.base.multiply(new THREE.Matrix4().makeTranslation(dx, fy + 0.9, fz - 0.25).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
    b.gable(0, 0, 0, 1.7, 1.55, 0.62, { color: roofColor, mat: M.ROOF });
    b.base.copy(savedBase);
  }
  // corner stones
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < 4; k++) b.box(sx * (w / 2), baseH + 0.25 + k * 0.78, sz * (d / 2), 0.36 + (k % 2) * 0.1, 0.32, 0.36 + ((k + 1) % 2) * 0.1, { color: k % 2 ? STONE_L : STONE, mat: M.PLAIN });
  // round attic windows in the gables
  for (const sx of [-1, 1]) { b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 12), { p: [sx * (w / 2 + 0.02), baseH + wallH + roofH * 0.34, 0], r: [0, 0, Math.PI / 2], color: 0xffffff, mat: M.WINDOW }); b.add(new THREE.TorusGeometry(0.36, 0.05, 5, 14), { p: [sx * (w / 2 + 0.05), baseH + wallH + roofH * 0.34, 0], r: [0, Math.PI / 2, 0], color: WOOD_D, mat: M.WOOD }); }
  // ivy creeping up one side
  const side = rnd() < 0.5 ? -1 : 1;
  for (let k = 0; k < 16; k++) {
    const u = rnd(), v = rnd() * rnd();
    b.sphere(side * (w / 2 + 0.05), baseH + 0.1 + (1 - v) * wallH * 0.95 * (0.4 + 0.6 * u), -d / 2 + 0.3 + u * d * 0.55, 0.26 + rnd() * 0.22, 0, { color: [0x2f6a25, 0x3f8030, 0x275a22][k % 3], mat: M.PLAIN, s: [0.35, 1, 1], jitter: 0.2 });
  }
  // barrels and a crate by the back corner
  const bx = -side * (w / 2 + 0.75);
  barrel(b, bx, baseH - 0.5, -d * 0.2); barrel(b, bx - side * 0.1, baseH - 0.5, -d * 0.2 + 0.85);
  b.box(bx, baseH - 0.5 + 0.38, d * 0.18, 0.76, 0.76, 0.76, { color: 0x9a6a3a, mat: M.WOOD, r: [0, 0.3, 0] });
  // hanging sign on the porch for a couple of houses
  if (seed % 3 === 0) { b.box(1.75, baseH + 2.7, d / 2 + 0.75, 0.08, 0.08, 1.2, { color: WOOD_D, mat: M.WOOD }); b.box(1.75, baseH + 2.25, d / 2 + 1.1, 0.07, 0.62, 0.8, { color: 0xd9b25a, mat: M.WOOD }); }
}

function barrel(b, x, y, z) {
  b.cyl(x, y + 0.5, z, 0.34, 0.3, 1.0, 10, { color: 0x8a5a30, mat: M.WOOD });
  for (const yy of [0.2, 0.8]) b.add(new THREE.TorusGeometry(0.345, 0.028, 4, 12), { p: [x, y + yy, z], r: [Math.PI / 2, 0, 0], color: 0x4a4038, mat: M.PLAIN });
}

function bench(b, x, y, z, rot) {
  b.setBase(x, y, z, rot);
  b.box(0, 0.48, 0, 1.8, 0.08, 0.5, { color: WOODC, mat: M.WOOD });
  b.box(0, 0.86, -0.23, 1.8, 0.4, 0.07, { color: WOODC, mat: M.WOOD, r: [-0.15, 0, 0] });
  for (const sx of [-0.75, 0.75]) { b.box(sx, 0.24, 0, 0.1, 0.48, 0.46, { color: WOOD_D, mat: M.WOOD }); b.box(sx, 0.68, -0.24, 0.08, 0.5, 0.08, { color: WOOD_D, mat: M.WOOD }); }
}

function hayCart(b, x, y, z, rot) {
  b.setBase(x, y, z, rot);
  b.box(0, 0.75, 0, 1.5, 0.12, 2.5, { color: WOODC, mat: M.WOOD });
  for (const sx of [-1, 1]) { b.box(sx * 0.75, 1.05, 0, 0.08, 0.55, 2.5, { color: WOODC, mat: M.WOOD }); b.add(new THREE.TorusGeometry(0.52, 0.06, 5, 14), { p: [sx * 0.86, 0.55, -0.35], r: [0, Math.PI / 2, 0], color: WOOD_D, mat: M.WOOD }); }
  b.box(0, 0.62, 1.9, 0.09, 0.09, 1.5, { color: WOOD_D, mat: M.WOOD, r: [0.18, 0, 0] });
  b.sphere(0, 1.3, 0, 0.9, 1, { color: 0xd9b84a, mat: M.PLAIN, s: [0.8, 0.62, 1.3], jitter: 0.15 });
  b.setBase(x + Math.cos(rot) * 2.2, y, z - Math.sin(rot) * 2.2, rot);
  b.cyl(0, 0.45, 0, 0.62, 0.62, 0.9, 12, { color: 0xd4b040, mat: M.PLAIN, r: [0, 0, Math.PI / 2] });
}

function fountain(b, x, y, z) {
  b.setBase(x, y, z);
  b.cyl(0, 0.12, 0, 3.2, 3.4, 0.24, 20, { color: STONE });
  b.add(new THREE.CylinderGeometry(2.7, 2.8, 0.8, 20, 1, true), { p: [0, 0.6, 0], color: STONE_L });
  b.add(new THREE.CylinderGeometry(2.38, 2.38, 0.8, 20, 1, true), { p: [0, 0.6, 0], color: STONE });
  b.add(new THREE.RingGeometry(2.38, 2.72, 20), { p: [0, 1.0, 0], r: [-Math.PI / 2, 0, 0], color: STONE_L });
  b.add(new THREE.CircleGeometry(2.4, 20), { p: [0, 0.78, 0], r: [-Math.PI / 2, 0, 0], color: 0x3fb4d6, mat: M.GLOW, emis: 0.55 });
  b.cyl(0, 1.5, 0, 0.3, 0.42, 2.6, 8, { color: STONE_L });
  b.cyl(0, 1.75, 0, 1.25, 0.45, 0.3, 12, { color: STONE });
  b.add(new THREE.CircleGeometry(1.15, 12), { p: [0, 1.88, 0], r: [-Math.PI / 2, 0, 0], color: 0x3fb4d6, mat: M.GLOW, emis: 0.55 });
  b.cyl(0, 2.75, 0, 0.7, 0.28, 0.24, 10, { color: STONE });
  b.add(new THREE.OctahedronGeometry(0.3, 0), { p: [0, 3.45, 0], s: [1, 1.7, 1], color: CYAN, mat: M.GLOW, emis: 4.5 });
  // four spouts arcing into the basin
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; for (let k = 0; k < 5; k++) { const t = k / 4, r = 1.15 + t * 1.0; b.sphere(Math.cos(a) * r, 1.86 - t * t * 1.0 + Math.sin(t * Math.PI) * 0.12, Math.sin(a) * r, 0.07 - t * 0.02, 0, { color: 0xbfefff, mat: M.GLOW, emis: 1.3 }); } }
}

const FLAGS = [0xd94b3d, 0xe8b23a, 0x3f7fbf, 0x6fb04a, 0xf2efe6, 0x8a4fb0];
// a sagging string of pennants from A to B (world space)
function bunting(b, A, B, sag = 1.0, seed = 0) {
  const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz, B.y - A.y);
  const hx = dx / (Math.hypot(dx, dz) || 1), hz = dz / (Math.hypot(dx, dz) || 1);
  const P = (t) => new THREE.Vector3(A.x + dx * t, A.y + (B.y - A.y) * t - sag * 4 * t * (1 - t), A.z + dz * t);
  const segs = Math.max(4, Math.round(len / 1.6));
  for (let i = 0; i < segs; i++) {
    const p0 = P(i / segs), p1 = P((i + 1) / segs), d = p1.clone().sub(p0), l = d.length();
    b.setBase((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2, Math.atan2(d.x, d.z));
    b.box(0, 0, 0, 0.03, 0.03, l, { color: 0x3a2a1c, mat: M.PLAIN, r: [-Math.atan2(d.y, Math.hypot(d.x, d.z)), 0, 0] });
  }
  b.base.identity();
  const n = Math.max(3, Math.floor(len / 0.62));
  for (let i = 1; i < n; i++) {
    const c = P(i / n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([c.x - hx * 0.19, c.y, c.z - hz * 0.19, c.x + hx * 0.19, c.y, c.z + hz * 0.19, c.x + hz * 0.04, c.y - 0.46, c.z - hx * 0.04], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    g.computeVertexNormals();
    b.add(g, { color: FLAGS[(i + seed) % FLAGS.length], mat: M.PLAIN });
  }
}

function villageGate(b, x, y, z, rot) {
  b.setBase(x, y, z, rot);
  for (const sx of [-1, 1]) {
    b.box(sx * 3.1, 1.9, 0, 1.0, 3.8, 1.0, { color: STONE });
    b.box(sx * 3.1, 3.95, 0, 1.25, 0.3, 1.25, { color: STONE_L });
    b.cone(sx * 3.1, 4.75, 0, 0.9, 1.3, 4, { color: ROOFS[0], mat: M.ROOF, r: [0, Math.PI / 4, 0] });
    b.sphere(sx * 3.1 - sx * 0.62, 3.0, 0.55, 0.16, 0, { color: 0xffb347, mat: M.GLOW, emis: 2.2 });
  }
  b.box(0, 4.3, 0, 7.4, 0.3, 0.34, { color: WOOD_D, mat: M.WOOD });
  b.box(0, 3.55, 0.02, 2.2, 1.15, 0.06, { color: 0xa8452c, mat: M.PLASTER });
  b.add(new THREE.OctahedronGeometry(0.3, 0), { p: [0, 3.6, 0.07], s: [1, 1.2, 0.2], color: GOLD, mat: M.GLOW, emis: 1.4 });
}

function lantern(b, x, y, z) {
  b.setBase(x, y, z);
  b.cyl(0, 1.4, 0, 0.07, 0.1, 2.8, 6, { color: WOOD_D, mat: M.WOOD });
  b.box(0.3, 2.7, 0, 0.7, 0.08, 0.08, { color: WOOD_D, mat: M.WOOD });
  b.box(0.6, 2.38, 0, 0.26, 0.36, 0.26, { color: 0xffb347, mat: M.GLOW, emis: 2.6 });
  b.box(0.6, 2.6, 0, 0.34, 0.07, 0.34, { color: WOOD_D, mat: M.WOOD });
  b.box(0.6, 2.17, 0, 0.3, 0.06, 0.3, { color: WOOD_D, mat: M.WOOD });
}

function well(b, x, y, z) {
  b.setBase(x, y, z);
  b.add(new THREE.CylinderGeometry(1.25, 1.35, 1.0, 12, 1, true), { p: [0, 0.5, 0], color: STONE });
  b.add(new THREE.RingGeometry(0.95, 1.3, 12), { p: [0, 1.0, 0], r: [-Math.PI / 2, 0, 0], color: STONE_L });
  b.add(new THREE.CircleGeometry(0.98, 12), { p: [0, 0.55, 0], r: [-Math.PI / 2, 0, 0], color: 0x1c4660, mat: M.PLAIN });
  for (const sx of [-1, 1]) b.box(sx * 1.15, 1.7, 0, 0.16, 2.4, 0.16, { color: WOOD_D, mat: M.WOOD });
  b.gable(0, 2.8, 0, 3.0, 2.2, 0.9, { color: ROOFS[0], mat: M.ROOF });
  b.cyl(0, 2.5, 0, 0.09, 0.09, 2.3, 6, { color: WOODC, mat: M.WOOD, r: [0, 0, Math.PI / 2] });
}

function fence(b, x0, z0, x1, z1, hAt) {
  const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / 2.2));
  const ang = Math.atan2(x1 - x0, z1 - z0);
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, y = hAt(x, z);
    b.setBase(x, y, z, ang);
    b.box(0, 0.5, 0, 0.14, 1.1, 0.14, { color: WOODC, mat: M.WOOD });
    if (i < n) {
      const x2 = x0 + (x1 - x0) * (i + 1) / n, z2 = z0 + (z1 - z0) * (i + 1) / n, y2 = hAt(x2, z2);
      const sl = Math.hypot(len / n, y2 - y), pitch = -Math.atan2(y2 - y, len / n);
      b.box(0, 0.78 + (y2 - y) / 2, len / n / 2, 0.07, 0.1, sl, { color: WOODC, mat: M.WOOD, r: [pitch, 0, 0] });
      b.box(0, 0.42 + (y2 - y) / 2, len / n / 2, 0.07, 0.1, sl, { color: WOODC, mat: M.WOOD, r: [pitch, 0, 0] });
    }
  }
}

function bridge(b, br, hAt) {
  const dx = br.bx - br.ax, dz = br.bz - br.az;
  const len = Math.hypot(dx, dz), ang = Math.atan2(dx, dz);
  const ext = 7;        // ramps reaching back onto the banks
  const mx = (br.ax + br.bx) / 2, mz = (br.az + br.bz) / 2;
  const W = br.width;
  b.setBase(mx, br.y, mz, ang);
  const total = len + ext * 2;
  // arched deck: segments along local z
  const segs = 12;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const z0 = (t0 - 0.5) * total, z1 = (t1 - 0.5) * total;
    const yA = Math.sin(t0 * Math.PI) * 1.1 - 0.75, yB = Math.sin(t1 * Math.PI) * 1.1 - 0.75;
    const sl = Math.hypot(z1 - z0, yB - yA), pitch = -Math.atan2(yB - yA, z1 - z0);
    b.box(0, (yA + yB) / 2, (z0 + z1) / 2, W, 0.5, sl + 0.05, { color: STONE, r: [pitch, 0, 0] });
    for (const sx of [-1, 1]) b.box(sx * (W / 2 - 0.15), (yA + yB) / 2 + 0.6, (z0 + z1) / 2, 0.32, 0.75, sl + 0.05, { color: STONE_L, r: [pitch, 0, 0] });
  }
  // piers
  for (const pz of [-len * 0.25, len * 0.25]) b.box(0, -3.2, pz, W * 0.8, 6.0, 1.6, { color: STONE_D });
  for (const pz of [-total / 2 + 1.5, total / 2 - 1.5]) for (const sx of [-1, 1]) {
    b.cyl(sx * (W / 2 - 0.15), 0.1, pz, 0.3, 0.36, 1.9, 6, { color: STONE });
    b.sphere(sx * (W / 2 - 0.15), 1.25, pz, 0.26, 0, { color: 0xffb347, mat: M.GLOW, emis: 1.6 });
  }
}

function ruinCluster(b, x, z, hAt, seed, radius = 12) {
  const rnd = mulberry32(seed);
  const n = 7 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = 3 + rnd() * radius;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r, py = hAt(px, pz) - 0.25;
    b.setBase(px, py, pz, rnd() * 6.28);
    const k = rnd();
    if (k < 0.45) column(b, 0, 0, 0, 4.5 + rnd() * 2.5, 0.5, rnd() < 0.6 ? 0.2 + rnd() * 0.7 : 0);
    else if (k < 0.7) { // wall fragment
      const w = 3 + rnd() * 4, h = 1.5 + rnd() * 3;
      b.box(0, h / 2, 0, w, h, 0.8, { color: STONE });
      b.box(w * 0.3, h + 0.4, 0, w * 0.35, 0.8, 0.8, { color: STONE_L });
    } else if (k < 0.85) { // fallen column
      b.cyl(0, 0.5, 0, 0.5, 0.5, 3 + rnd() * 2, 10, { color: STONE_L, r: [Math.PI / 2, 0, 0.05] });
    } else { // arch
      column(b, -1.8, 0, 0, 4.4, 0.45, 0); column(b, 1.8, 0, 0, 4.4, 0.45, 0);
      b.box(0, 5.9, 0, 5.2, 0.6, 1.1, { color: STONE });
    }
    if (rnd() < 0.7) ivy(b, 0, 0.3, 0, 3.2, 0.62, rnd, 10);
    // fallen blocks nearby
    for (let q = 0; q < 3; q++) { const bx = (rnd() - 0.5) * 4.5, bz = 1.2 + rnd() * 2.2; b.box(bx, 0.2, bz, 0.5 + rnd() * 0.7, 0.4, 0.45 + rnd() * 0.4, { color: q % 2 ? STONE_L : STONE, r: [rnd() * 0.3, rnd() * 3, rnd() * 0.3] }); }
  }
  // the heart of the ruin: a great arch on a stepped plinth
  const cy = hAt(x, z) - 0.2;
  const ay = rnd() * 6.28;
  b.setBase(x, cy, z, ay);
  b.box(0, 0.15, 0, 9.5, 0.5, 4.2, { color: STONE_D }); b.box(0, 0.45, 0, 8.3, 0.4, 3.2, { color: STONE });
  b.setBase(x, cy + 0.6, z, ay);
  greatArch(b, 5.6, 5.4, seed % 2 === 0);
  ivy(b, -2.8, 0.2, 0, 4.5, 0.85, rnd, 16); ivy(b, 2.8, 0.2, 0, 2.5, 0.85, rnd, 8);
}

function sanctum(b, x, y, z) {
  b.setBase(x, y, z);
  const R = 27;
  b.cyl(0, 0.2, 0, R + 3, R + 4, 0.7, 40, { color: STONE_D });
  b.cyl(0, 0.62, 0, R, R + 0.4, 0.3, 40, { color: STONE });
  b.add(new THREE.TorusGeometry(R - 3, 0.09, 6, 64), { p: [0, 0.8, 0], r: [Math.PI / 2, 0, 0], color: 0xff8855, mat: M.GLOW, emis: 1.8 });
  b.add(new THREE.TorusGeometry(9, 0.08, 6, 48), { p: [0, 0.8, 0], r: [Math.PI / 2, 0, 0], color: 0xff8855, mat: M.GLOW, emis: 1.8 });
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2 + 0.26;
    const cx = Math.cos(a) * (R - 1.2), cz = Math.sin(a) * (R - 1.2);
    const broken = (i === 3 || i === 7) ? 0.5 : 0;
    b.cyl(cx, 1.0, cz, 1.7, 1.9, 0.9, 8, { color: STONE });
    const h = broken ? 7 : 13;
    b.cyl(cx, 1.4 + h / 2, cz, 1.05, 1.25, h, 10, { color: STONE_L });
    if (!broken) { b.cyl(cx, 14.7, cz, 1.8, 1.2, 0.6, 8, { color: STONE }); b.add(new THREE.OctahedronGeometry(0.45, 0), { p: [cx, 16.2, cz], s: [1, 1.6, 1], color: 0xff8855, mat: M.GLOW, emis: 3.5 }); }
  }
  const flames = [];
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.52; flames.push(brazier(b, Math.cos(a) * (R - 5.5), 0.75, Math.sin(a) * (R - 5.5))); }
  // entrance gate on the south-east side (toward the road)
  const ga = Math.atan2(35, 30);
  const gx = Math.cos(ga) * (R + 1.5), gz = Math.sin(ga) * (R + 1.5);
  b.setBase(x + gx, y, z + gz, -ga + Math.PI / 2);
  column(b, -3.4, 0.4, 0, 8.5, 0.9, 0); column(b, 3.4, 0.4, 0, 8.5, 0.9, 0);
  b.box(0, 10.6, 0, 10.5, 1.1, 2.2, { color: STONE });
  b.box(0, 11.5, 0, 7.5, 0.7, 1.8, { color: STONE_L });
  for (let i = 0; i < 4; i++) b.box(0, 0.12, 3.2 + i * 0.75, 7.5, 0.5 - i * 0.1, 0.8, { color: STONE });
  // three sigil pedestals
  const ped = [];
  for (let i = 0; i < 3; i++) {
    const px = (i - 1) * 3.2, pz = 6.8;
    b.cyl(px, 0.6, pz, 0.55, 0.7, 1.2, 8, { color: STONE_L });
    const w = new THREE.Vector3(px, 1.6, pz).applyMatrix4(b.base);
    ped.push(w);
  }
  return { pedestals: ped, gate: new THREE.Vector3(x + gx, y, z + gz), braziers: flames };
}

function floatingIsland(b, x, y, z, r, seed) {
  const rnd = mulberry32(seed);
  b.setBase(x, y, z);
  // grassy cap
  const top = new THREE.CylinderGeometry(r, r * 0.92, 1.2, 14, 1);
  const P = top.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const a = Math.atan2(P.getZ(i), P.getX(i));
    const k = 1 + 0.16 * Math.sin(a * 3 + seed) + 0.09 * Math.sin(a * 7 + seed * 2);
    P.setX(i, P.getX(i) * k); P.setZ(i, P.getZ(i) * k);
  }
  top.computeVertexNormals();
  b.add(top, { p: [0, -0.6, 0], color: 0x3f8a2a, mat: M.GRASS });
  // rocky underside: stacked inverted cones
  b.add(new THREE.ConeGeometry(r * 0.97, r * 1.5, 9, 3), { p: [0, -1.2 - r * 0.75, 0], r: [Math.PI, rnd() * 3, 0], color: 0x6f6a66, mat: M.ROCK });
  for (let i = 0; i < 5; i++) {
    const a = rnd() * 6.28, rr = r * (0.35 + rnd() * 0.4);
    b.add(new THREE.ConeGeometry(r * (0.2 + rnd() * 0.22), r * (0.7 + rnd() * 0.8), 6, 1), { p: [Math.cos(a) * rr, -1.4 - r * 0.45, Math.sin(a) * rr], r: [Math.PI + (rnd() - 0.5) * 0.4, rnd() * 3, (rnd() - 0.5) * 0.4], color: 0x7d766f, mat: M.ROCK });
  }
  // surface dressing
  for (let i = 0; i < 4; i++) { const a = rnd() * 6.28, rr = r * (0.3 + rnd() * 0.5); b.rock(Math.cos(a) * rr, 0.2, Math.sin(a) * rr, 0.5 + rnd() * 1.1, seed + i); }
  // a small tree made of blobs
  if (r > 7) {
    const tx = -r * 0.3, tz = r * 0.2;
    b.cyl(tx, 1.6, tz, 0.22, 0.38, 3.4, 6, { color: WOOD_D, mat: M.WOOD });
    for (const [ox, oy, oz, rr] of [[0, 4.2, 0, 2.0], [1.2, 3.6, 0.4, 1.4], [-1.1, 3.7, -0.5, 1.5], [0.2, 5.4, 0.2, 1.2]]) b.sphere(tx + ox, oy, tz + oz, rr, 1, { color: 0xe58bb0, mat: M.PLAIN, jitter: 0.12 });
  }
}

function camp(b, x, z, hAt, seed) {
  const rnd = mulberry32(seed);
  const y = hAt(x, z);
  // palisade arcs
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2;
    if (i % 7 === 0) continue;
    const px = x + Math.cos(a) * 8.5, pz = z + Math.sin(a) * 8.5;
    b.setBase(px, hAt(px, pz) - 0.3, pz, -a);
    for (let k = -1; k <= 1; k++) b.cone(0, 1.3 + rnd() * 0.5, k * 0.5, 0.2, 3.0 + rnd(), 5, { color: WOODC, mat: M.WOOD, r: [0, 0, (rnd() - 0.5) * 0.15] });
  }
  // tents
  for (let i = 0; i < 2; i++) {
    const a = 0.8 + i * 2.4, px = x + Math.cos(a) * 4.6, pz = z + Math.sin(a) * 4.6;
    b.setBase(px, hAt(px, pz), pz, -a + Math.PI / 2);
    b.gable(0, 0, 0, 3.4, 3.0, 2.2, { color: [0x8a5a3a, 0x70614a][i], mat: M.PLASTER });
    b.cyl(0, 1.2, 0, 0.06, 0.06, 2.5, 5, { color: WOOD_D, mat: M.WOOD });
  }
  // bonfire stones + logs (the fire itself is a VFX)
  b.setBase(x, y, z);
  for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28; b.rock(Math.cos(a) * 0.95, 0.12, Math.sin(a) * 0.95, 0.28, seed + i, { detail: 0 }); }
  for (let i = 0; i < 4; i++) b.cyl(0, 0.35, 0, 0.09, 0.11, 1.3, 5, { color: WOOD_D, mat: M.WOOD, r: [0.95, i * 1.57, 0] });
  // watch post
  const px = x + 6.2, pz = z - 3.0;
  b.setBase(px, hAt(px, pz), pz);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.cyl(sx * 0.9, 2.4, sz * 0.9, 0.1, 0.13, 4.8, 5, { color: WOODC, mat: M.WOOD });
  b.box(0, 4.7, 0, 2.6, 0.18, 2.6, { color: WOODC, mat: M.WOOD });
  b.cone(0, 6.9, 0, 2.2, 1.4, 4, { color: 0x70614a, mat: M.PLASTER, r: [0, Math.PI / 4, 0] });
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.cyl(sx * 1.1, 5.5, sz * 1.1, 0.06, 0.06, 1.6, 4, { color: WOODC, mat: M.WOOD });
}

// fire-pit stones, logs and the watch post (used with the kit-built camp)
function campfirePit(b, x, z, hAt, seed) {
  const rnd = mulberry32(seed);
  b.setBase(x, hAt(x, z), z);
  for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28; b.rock(Math.cos(a) * 0.95, 0.12, Math.sin(a) * 0.95, 0.28, seed + i, { detail: 0 }); }
  for (let i = 0; i < 4; i++) b.cyl(0, 0.35, 0, 0.09, 0.11, 1.3, 5, { color: WOOD_D, mat: M.WOOD, r: [0.95, i * 1.57, 0] });
  const px = x + 6.2, pz = z - 3.0;
  b.setBase(px, hAt(px, pz), pz, rnd() * 0.6);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.cyl(sx * 0.9, 2.4, sz * 0.9, 0.1, 0.13, 4.8, 5, { color: WOODC, mat: M.WOOD });
  b.box(0, 4.7, 0, 2.6, 0.18, 2.6, { color: WOODC, mat: M.WOOD });
  b.cone(0, 6.9, 0, 2.2, 1.4, 4, { color: ROOFS[0], mat: M.ROOF, r: [0, Math.PI / 4, 0] });
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.cyl(sx * 1.1, 5.5, sz * 1.1, 0.06, 0.06, 1.6, 4, { color: WOODC, mat: M.WOOD });
}

function statue(b, x, y, z, rot) {
  b.setBase(x, y, z, rot);
  b.cyl(0, 0.3, 0, 1.7, 1.9, 0.6, 8, { color: STONE_D });
  b.cyl(0, 0.85, 0, 1.1, 1.3, 0.5, 8, { color: STONE });
  // robed figure
  b.cone(0, 2.6, 0, 0.95, 3.2, 10, { color: STONE_L });
  b.sphere(0, 4.35, 0, 0.42, 1, { color: STONE_L });
  // wings
  for (const sx of [-1, 1]) {
    b.box(sx * 0.95, 3.5, -0.25, 1.5, 0.16, 0.7, { color: STONE_L, r: [0.2, 0, sx * 0.75] });
    b.box(sx * 1.55, 4.1, -0.3, 1.1, 0.13, 0.55, { color: STONE_L, r: [0.2, 0, sx * 1.15] });
  }
  // offering bowl with a soft light
  b.cyl(0, 1.25, 0.95, 0.42, 0.25, 0.25, 8, { color: STONE });
  b.sphere(0, 1.5, 0.95, 0.2, 1, { color: GOLD, mat: M.GLOW, emis: 3.0 });
  b.add(new THREE.TorusGeometry(0.55, 0.035, 5, 24), { p: [0, 5.05, 0], r: [Math.PI / 2, 0, 0], color: GOLD, mat: M.GLOW, emis: 2.6 });
}

function windmill(b, x, y, z, rot) {
  b.setBase(x, y, z, rot);
  b.cyl(0, 0.5, 0, 4.3, 4.7, 1.6, 10, { color: STONE });
  b.cyl(0, 6.2, 0, 2.7, 4.0, 10.4, 10, { color: PLASTERC, mat: M.PLASTER });
  for (let i = 0; i < 5; i++) { const a = i / 5 * 6.28 + 0.3; b.box(Math.cos(a) * 3.35, 6.2, Math.sin(a) * 3.35, 0.2, 10.5, 0.2, { color: WOOD_D, mat: M.WOOD, r: [Math.sin(a) * 0.125, 0, -Math.cos(a) * 0.125] }); }
  b.cone(0, 13.2, 0, 3.3, 3.8, 10, { color: ROOFS[0], mat: M.ROOF });
  b.box(0, 1.9, 4.05, 1.3, 2.3, 0.2, { color: WOODC, mat: M.WOOD });
  b.box(0, 7.5, 3.25, 0.9, 1.0, 0.2, { color: 0xffffff, mat: M.WINDOW });
  b.cyl(0, 10.6, 3.1, 0.22, 0.22, 2.2, 6, { color: WOOD_D, mat: M.WOOD, r: [Math.PI / 2, 0, 0] });
  return { hub: new THREE.Vector3(0, 10.6, 4.3).applyMatrix4(b.base), rot };
}

function windmillSails() {
  const b = new Builder();
  b.cyl(0, 0, 0, 0.35, 0.35, 0.6, 8, { color: WOOD_D, mat: M.WOOD, r: [Math.PI / 2, 0, 0] });
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    const m = new THREE.Matrix4().makeRotationZ(a);
    b.base.copy(m);
    b.box(0, 3.6, 0, 0.16, 7.0, 0.14, { color: WOOD_D, mat: M.WOOD });
    b.box(0.75, 4.1, 0.03, 1.35, 5.4, 0.05, { color: 0xeadfc6, mat: M.PLASTER });
    for (let k = 0; k < 5; k++) b.box(0.75, 1.9 + k * 1.1, 0.06, 1.4, 0.07, 0.05, { color: WOODC, mat: M.WOOD });
  }
  return b;
}

// ------------------------------------------------------------------ world assembly
export function buildStructures(game) {
  const { gfx, world, collision } = game;
  const hAt = (x, z) => world.heightAt(x, z);
  const out = { waypoints: [], lanterns: [], chimneys: [], npcSpots: [], updrafts: [], meshes: [], animated: [], pedestals: [], islands: [] };
  const group = new THREE.Group();
  gfx.scene.add(group);
  const emit = (b, collide = true) => {
    const mesh = meshFrom(b, gfx, true);
    group.add(mesh); out.meshes.push(mesh);
    if (collide) collision.addMesh(mesh.geometry, mesh.matrixWorld);
    return mesh;
  };
  const emitKit = (kb) => {
    const built = kb.build(gfx);
    for (const m of built.meshes) { group.add(m); out.meshes.push(m); }
    collision.addMesh(built.collider, new THREE.Matrix4());
  };
  const addWaypoint = (id, name, x, z, b) => {
    const y = hAt(x, z);
    waypointObelisk(b, x, y - 0.1, z);
    out.waypoints.push({ id, name, pos: new THREE.Vector3(x, y, z) });
  };

  // ---- Dawn Plateau: shrine of awakening
  {
    const b = new Builder();
    const p = POI.spawn;
    awakeningShrine(b, p.x, p.y - 0.15, p.z);
    addWaypoint('plateau', 'Dawn Plateau', p.x + 17, p.z - 12, b);
    statue(b, p.x - 15, hAt(p.x - 15, p.z - 9) - 0.1, p.z - 9, 0.9);
    ruinCluster(b, p.x + 30, p.z - 60, hAt, 11, 14);
    ruinCluster(b, p.x - 70, p.z - 120, hAt, 12, 10);
    ruinCluster(b, POI.overlook.x + 10, POI.overlook.z + 26, hAt, 13, 8);
    emit(b);
    out.statues = [{ pos: new THREE.Vector3(p.x - 15, hAt(p.x - 15, p.z - 9), p.z - 9) }];
  }

  // ---- Skywatch Tower
  {
    const b = new Builder();
    const p = POI.skyTower;
    let t;
    if (game.kit) {
      const kb = new KitBuilder(game.kit);
      const y0 = p.y - 0.3;
      kb.setBase(p.x, y0, p.z, 0);
      const k = kitTower(kb);
      emitKit(kb);
      t = { topY: y0 + k.topY };
      // beacon crystal in the belfry
      b.setBase(p.x, t.topY, p.z);
      b.cyl(0, 0.45, 0, 0.5, 0.7, 0.9, 8, { color: STONE_L });
      b.add(new THREE.OctahedronGeometry(0.55, 0), { p: [0, 1.9, 0], s: [1, 1.7, 1], color: CYAN, mat: M.GLOW, emis: 5 });
      out.towerChest = new THREE.Vector3(p.x + 3.1, t.topY, p.z - 3.1);
      out.towerOrbY = k.roofTop - k.topY + 1.5;
    } else t = skyTower(b, p.x, p.y - 0.6, p.z);
    addWaypoint('tower', 'Skywatch Tower', p.x + 14, p.z + 10, b);
    emit(b);
    out.towerTop = new THREE.Vector3(p.x, t.topY, p.z);
    out.updrafts.push({ x: p.x, z: p.z, r: 9, y0: t.topY - 1, y1: t.topY + 175, strength: 13 });
  }

  // ---- Hearthvale village
  {
    const b = new Builder();
    const v = POI.village;
    const defs = VILLAGE_HOUSES;
    // houses: assembled from the hand-made village kit when it loaded, otherwise built procedurally
    const kb = game.kit ? new KitBuilder(game.kit) : null;
    defs.forEach((d, i) => {
      const hx = v.x + d[0], hz = v.z + d[1];
      const hy = hAt(hx, hz);
      let doorX = 0;
      if (kb) {
        kb.setBase(hx, hy, hz, d[2]);
        const h = kitHouse(kb, { L: d[3] >= 9 ? 10 : 8, floors: i % 3 === 1 ? 2 : 1, stone: i % 2 === 1, roof: d[5], seed: 100 + i });
        out.chimneys.push(h.chimney); doorX = h.doorX;
        b.setBase(hx, hy, hz, d[2]);
      } else {
        const h = house(b, hx, hy, hz, d[2], d[3], d[4], ROOFS[d[5]], 100 + i);
        dressHouse(b, d[3], d[4], h, ROOFS[d[5]], 100 + i);
        out.chimneys.push(new THREE.Vector3(...h.chimney).applyMatrix4(b.base));
      }
      // spot in front of the door for villagers
      const door = new THREE.Vector3(doorX, 0, (kb ? 3 : d[4] / 2) + 2.6).applyMatrix4(b.base);
      out.npcSpots.push({ pos: new THREE.Vector3(door.x, hAt(door.x, door.z), door.z), yaw: d[2] });
    });
    if (kb) {
      // a wagon by the east houses and a few stacked crates in the square
      kb.setBase(v.x + 27, hAt(v.x + 27, v.z + 4), v.z + 4, 1.9); kb.add('Prop_Wagon', {});
      kb.setBase(v.x + 15.5, hAt(v.x + 15.5, v.z - 12), v.z - 12, 0.4); kb.add('Prop_Crate', {}); kb.add('Prop_Crate', { p: [1.15, 0, 0.2], ry: 0.5 }); kb.add('Prop_Crate', { p: [0.5, 1.06, 0.1], ry: 0.2, s: [0.8, 0.8, 0.8] });
      const built = kb.build(gfx);
      for (const m of built.meshes) { group.add(m); out.meshes.push(m); }
      collision.addMesh(built.collider, new THREE.Matrix4());
    }
    well(b, v.x + 12, hAt(v.x + 12, v.z + 24) - 0.05, v.z + 24);
    // paved square with a fountain
    const pcx = v.x + 1, pcz = v.z + 2, PR = 8.4;
    let ptop = -1e9; for (let a = 0; a < 6.28; a += 0.4) for (const r of [0, 4, 8.5]) ptop = Math.max(ptop, hAt(pcx + Math.cos(a) * r, pcz + Math.sin(a) * r));
    ptop += 0.05;
    b.setBase(pcx, ptop - 0.3, pcz);
    b.cyl(0, 0, 0, PR, PR + 1.3, 0.6, 36, { color: 0xa8a294 });
    b.add(new THREE.TorusGeometry(PR - 0.5, 0.06, 5, 40), { p: [0, 0.31, 0], r: [Math.PI / 2, 0, 0], color: STONE_D, mat: M.PLAIN });
    fountain(b, pcx, ptop, pcz);
    out.fountain = new THREE.Vector3(pcx, ptop + 2.9, pcz);
    bench(b, pcx - 5.6, ptop, pcz + 3.2, 2.1); bench(b, pcx + 5.2, ptop, pcz + 4.0, -2.2); bench(b, pcx + 0.5, ptop, pcz - 6.4, 0);
    hayCart(b, v.x - 20, hAt(v.x - 20, v.z + 30), v.z + 30, 0.7);
    barrel(b.setBase(v.x + 17.5, hAt(v.x + 17.5, v.z - 6.5), v.z - 6.5), 0, 0, 0); barrel(b, 0.8, 0, 0.3);
    villageGate(b, v.x - 4, hAt(v.x - 4, v.z + 62) - 0.2, v.z + 62, 0.1);
    villageGate(b, v.x + 12, hAt(v.x + 12, v.z - 62) - 0.2, v.z - 62, -0.2);
    // festival pennants strung from poles around the square to the fountain
    const bf = new Builder();
    const mast = new THREE.Vector3(pcx, ptop + 3.9, pcz);
    const poles = [];
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + 0.55, px = pcx + Math.cos(a) * 12.5, pz = pcz + Math.sin(a) * 12.5, py = hAt(px, pz);
      b.setBase(px, py, pz);
      b.cyl(0, 2.9, 0, 0.07, 0.11, 5.8, 6, { color: WOOD_D, mat: M.WOOD });
      b.sphere(0, 5.85, 0, 0.14, 0, { color: GOLD, mat: M.GLOW, emis: 1.2 });
      poles.push(new THREE.Vector3(px, py + 5.7, pz));
    }
    poles.forEach((p, i) => { bunting(bf, p, mast, 0.9, i); bunting(bf, p, poles[(i + 1) % 6], 1.1, i + 3); });
    emit(bf, false);
    statue(b, v.x - 12, hAt(v.x - 12, v.z - 6) - 0.1, v.z - 6, 1.2);
    out.statues.push({ pos: new THREE.Vector3(v.x - 12, hAt(v.x - 12, v.z - 6), v.z - 6) });
    addWaypoint('village', 'Hearthvale', v.x + 14, v.z + 10, b);
    // lanterns around the plaza and along the roads
    const lan = [[9, -9], [-9, 10], [16, 7], [-15, -7], [2, -19], [18, 20], [-19, 22], [22, -18], [-6, 46], [38, 30]];
    for (const [lx, lz] of lan) { const x = v.x + lx, z = v.z + lz, y = hAt(x, z); lantern(b, x, y - 0.05, z); out.lanterns.push(new THREE.Vector3(x + 0.6, y + 2.38, z)); }
    // garden fences
    fence(b, v.x - 38, v.z - 4, v.x - 38, v.z + 6, hAt); fence(b, v.x - 38, v.z + 6, v.x - 36, v.z + 20, hAt);
    fence(b, v.x + 38, v.z + 10, v.x + 38, v.z + 28, hAt); fence(b, v.x + 38, v.z + 28, v.x + 22, v.z + 32, hAt);
    fence(b, v.x + 2, v.z - 40, v.x + 26, v.z - 39, hAt);
    // market stall
    b.setBase(v.x + 14, hAt(v.x + 14, v.z - 8), v.z - 8, 0.5);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.cyl(sx * 1.4, 1.2, sz * 0.9, 0.06, 0.07, 2.4, 5, { color: WOODC, mat: M.WOOD });
    b.box(0, 0.85, 0, 3.0, 0.12, 2.0, { color: WOODC, mat: M.WOOD });
    b.gable(0, 2.35, 0, 3.6, 2.6, 0.8, { color: 0xd9a441, mat: M.PLASTER });
    for (let i = 0; i < 6; i++) b.sphere(-1.0 + i * 0.4, 1.03, (i % 2) * 0.4 - 0.2, 0.15, 0, { color: [0xd94b3d, 0xe8b23a, 0x7fb04a][i % 3], mat: M.PLAIN });
    emit(b);
    // windmill (rotating sails are a separate, non-colliding mesh)
    const bw = new Builder();
    const wp = POI.windmill;
    const wm = windmill(bw, wp.x, hAt(wp.x, wp.z) - 0.3, wp.z, 2.4);
    emit(bw);
    const sails = meshFrom(windmillSails(), gfx, true);
    sails.matrixAutoUpdate = true;
    sails.position.copy(wm.hub); sails.rotation.order = 'YXZ'; sails.rotation.y = wm.rot;
    group.add(sails);
    out.animated.push((dt, t) => { sails.rotation.z = t * 0.5; });
    out.villageCenter = new THREE.Vector3(v.x, v.y, v.z);
  }

  // ---- trial shrines
  {
    const b = new Builder();
    const defs = [['shrineForest', 0x7dff8a, 0.6, 'forest', 'Verdant Shrine'], ['shrineCoast', 0x5ad2ff, -2.2, 'coast', 'Tidal Shrine'], ['shrinePeak', 0xdfefff, 2.6, 'peak', 'Frost Shrine']];
    out.shrines = [];
    for (const [key, gem, rot, id, name] of defs) {
      const p = POI[key];
      const y = hAt(p.x, p.z);
      let altarY = y + 0.9;
      if (game.kit) {
        const kb = new KitBuilder(game.kit);
        kb.setBase(p.x, y - 0.1, p.z, rot);
        const k = kitShrine(kb, 0x2b6d74);
        emitKit(kb);
        // glowing fittings on top of the kit-built chapel
        b.setBase(p.x, y - 0.1 + k.P, p.z, rot);
        b.cyl(0, 0.45, -0.4, 0.8, 1.0, 0.9, 8, { color: STONE_L });
        b.add(new THREE.TorusGeometry(1.9, 0.05, 6, 32), { p: [0, 0.06, -0.2], r: [Math.PI / 2, 0, 0], color: gem, mat: M.GLOW, emis: 2.6 });
        b.add(new THREE.OctahedronGeometry(0.34, 0), { p: [0, k.ridge - k.P + 0.75, 0], s: [1, 1.7, 1], color: gem, mat: M.GLOW, emis: 4 });
        (out.braziers = out.braziers || []).push(brazier(b, -3.45, 0, 2.55), brazier(b, 3.45, 0, 2.55));
        banner(b, -3.0, 1.75, 2.34, gem); banner(b, 3.0, 1.75, 2.34, gem);
        altarY = y - 0.1 + k.P + 0.9;
      } else {
        const ts = trialShrine(b, p.x, y - 0.2, p.z, rot, gem);
        (out.braziers = out.braziers || []).push(...ts.braziers);
      }
      out.shrines.push({ id, name, gem, pos: new THREE.Vector3(p.x - Math.sin(rot) * 0.4, altarY, p.z - Math.cos(rot) * 0.4), rot, glowY: game.kit ? y + 8.4 : y + 9.2 });
      const wx = p.x + Math.sin(rot) * 14 + Math.cos(rot) * 6, wz = p.z + Math.cos(rot) * 14 - Math.sin(rot) * 6;
      addWaypoint('wp_' + id, name, wx, wz, b);
    }
    emit(b);
  }

  // ---- Sealed Sanctum
  {
    const b = new Builder();
    const p = POI.temple;
    const s = sanctum(b, p.x, p.y - 0.25, p.z);
    out.pedestals = s.pedestals; out.sanctumGate = s.gate;
    (out.braziers = out.braziers || []).push(...s.braziers);
    out.sanctum = new THREE.Vector3(p.x, p.y + 0.5, p.z);
    addWaypoint('sanctum', 'Sealed Sanctum', s.gate.x + 14, s.gate.z + 6, b);
    emit(b);
  }

  // ---- ruins, camps, misc waypoints
  {
    const b = new Builder();
    ruinCluster(b, POI.ruinsMeadow.x, POI.ruinsMeadow.z, hAt, 21, 16);
    ruinCluster(b, POI.ruinsWest.x, POI.ruinsWest.z, hAt, 22, 14);
    ruinCluster(b, 560, 150, hAt, 23, 8);
    ruinCluster(b, -150, 520, hAt, 24, 9);
    ruinCluster(b, 900, 420, hAt, 25, 9);
    ruinCluster(b, -620, -260, hAt, 26, 10);
    if (game.kit) {
      // ruined cottages near the old ruins and along the roads
      RUIN_COTTAGES.forEach(([rx, rz], i) => {
        const kb = new KitBuilder(game.kit);
        const ry = i * 1.37, c = Math.cos(ry), sn = Math.sin(ry), by = hAt(rx, rz) - 0.1;
        kb.setBase(rx, by, rz, ry);
        kitRuin(kb, 60 + i, (lx, lz) => hAt(rx + c * lx + sn * lz, rz - sn * lx + c * lz) - by);
        emitKit(kb);
      });
    }
    addWaypoint('lake', 'Mirror Lake', 548, 118, b);
    addWaypoint('elder', 'The Elder Tree', POI.elderTree.x + 20, POI.elderTree.z + 16, b);
    addWaypoint('ember', 'Emberleaf Ridge', POI.emberCamp.x - 18, POI.emberCamp.z + 14, b);
    out.camps = [];
    for (const [key, seed] of [['campNorth', 31], ['campForest', 32], ['campEast', 33], ['emberCamp', 34], ['ruinsWest', 35]]) {
      const p = POI[key];
      const cx = key === 'ruinsWest' ? p.x + 24 : p.x, cz = key === 'ruinsWest' ? p.z + 8 : p.z;
      if (game.kit) {
        const kb = new KitBuilder(game.kit);
        kitCamp(kb, hAt, cx, cz, seed);
        emitKit(kb);
        campfirePit(b, cx, cz, hAt, seed);
      } else camp(b, cx, cz, hAt, seed);
      out.camps.push({ id: key, pos: new THREE.Vector3(cx, hAt(cx, cz), cz) });
    }
    // lake isle pavilion
    const li = POI.lakeIsle, ly = hAt(li.x, li.z);
    b.setBase(li.x, ly - 0.2, li.z);
    b.cyl(0, 0.3, 0, 4.2, 4.5, 0.6, 8, { color: STONE });
    for (let i = 0; i < 6; i++) { const a = i / 6 * 6.28; column(b, Math.cos(a) * 3.3, 0.5, Math.sin(a) * 3.3, 3.4, 0.3, 0); }
    b.setBase(li.x, ly - 0.2, li.z);
    b.cone(0, 6.0, 0, 4.6, 2.4, 8, { color: 0xb5482e, mat: M.ROOF });
    emit(b);
    out.lakeIsle = new THREE.Vector3(li.x, ly + 0.5, li.z);
  }

  // ---- bridges
  {
    const b = new Builder();
    const seen = [];
    for (const br of world.bridges) {
      const mx = (br.ax + br.bx) / 2, mz = (br.az + br.bz) / 2;
      if (seen.some((s) => Math.hypot(s[0] - mx, s[1] - mz) < 40)) continue;
      seen.push([mx, mz]);
      bridge(b, br, hAt);
    }
    if (seen.length) emit(b);
  }

  // ---- floating islands above the meadows
  {
    const b = new Builder();
    const isl = [[40, 262, 120, 15, 1], [-70, 238, 30, 10, 2], [150, 282, 10, 11, 3], [-10, 300, -110, 18, 4], [-170, 255, -120, 9, 5], [110, 330, -190, 12, 6]];
    for (const [x, y, z, r, seed] of isl) { floatingIsland(b, x, y, z, r, seed); out.islands.push({ pos: new THREE.Vector3(x, y, z), r }); }
    // sky shrine on the largest island
    b.setBase(-10, 300, -110);
    b.cyl(0, 0.2, 0, 4.5, 4.8, 0.4, 8, { color: STONE });
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.78; column(b, Math.cos(a) * 3.2, 0.3, Math.sin(a) * 3.2, 3.6, 0.35, i === 2 ? 0.5 : 0); }
    b.add(new THREE.OctahedronGeometry(0.5, 0), { p: [0, 2.6, 0], s: [1, 1.7, 1], color: GOLD, mat: M.GLOW, emis: 4.5 });
    emit(b);
  }

  // ---- scattered boulders (instanced); the big ones are solid and climbable
  {
    const rocks = world.veg.rocks;
    const mats = buildingMaterial();
    const variants = [0, 1, 2].map((v) => { const b = new Builder(); b.rock(0, 0, 0, 1, 40 + v * 7, { r: [0, 0, 0], flat: [0.8, 0.62, 1.0][v], color: [0x8a857c, 0x7d7870, 0x96908a][v] }); return b.build(); });
    const CELLR = 512;
    const buckets = new Map();
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler(), p4 = new THREE.Vector3(), s4 = new THREE.Vector3();
    for (let i = 0; i < rocks.length; i += 6) {
      const x = rocks[i], y = rocks[i + 1], z = rocks[i + 2], sc = rocks[i + 3], rot = rocks[i + 4], rr = rocks[i + 5];
      const v = Math.floor(rr * 3) % 3;
      const key = v + 10 * (Math.floor((x + 2048) / CELLR) + 100 * Math.floor((z + 2048) / CELLR));
      let bkt = buckets.get(key); if (!bkt) { bkt = { v, list: [] }; buckets.set(key, bkt); }
      e4.set((rr - 0.5) * 0.5, rot, (rr * 7 % 1 - 0.5) * 0.5);
      m4.compose(p4.set(x, y - sc * 0.22, z), q4.setFromEuler(e4), s4.set(sc, sc * (0.8 + rr * 0.4), sc));
      bkt.list.push(m4.clone());
      if (sc >= 1.35) collision.addMesh(variants[v], m4);
      else if (sc >= 0.7) game.flora._addCollider(x, z, sc * 0.62);
    }
    for (const bkt of buckets.values()) {
      const im = new THREE.InstancedMesh(variants[bkt.v], mats.main, bkt.list.length);
      bkt.list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.userData.shadowMat = mats.depth;
      im.matrixAutoUpdate = false;
      gfx.addCaster(im);
      group.add(im);
    }
  }

  collision.build();
  out.group = group;
  out.update = (dt, t) => { for (const f of out.animated) f(dt, t); };
  return out;
}

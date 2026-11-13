// Grass + flowers: instanced blades in camera-following toroidal tiles, three density LODs.
// All placement happens in the vertex shader from the world maps, so there is no per-frame CPU cost.
import * as THREE from 'three';
import { shared, U_LIGHT, U_SHADOW, U_WORLD } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_WORLD, GLSL_SHADOW, GLSL_FOG, GLSL_LIGHT, GLSL_WIND } from '../shaders/common.js';

function bladeGeometry(segments) {
  // strip of quads tapering to a point; position.x = signed half-width factor, position.y = t along blade
  const pos = [], idx = [];
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const w = 0.5 * (1 - Math.pow(t, 1.6) * 0.82);
    pos.push(-w, t, 0, w, t, 0);
  }
  pos.push(0, 1, 0);
  for (let i = 0; i < segments - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const a = (segments - 1) * 2;
  idx.push(a, a + 1, a + 2);
  return { pos: new Float32Array(pos), idx };
}

function instancedTile(base, grid, seed) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(base.pos, 3));
  g.setIndex(base.idx);
  const n = grid * grid;
  const data = new Float32Array(n * 4);
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let o = 0;
  for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) {
    data[o++] = (i + rnd()) / grid;
    data[o++] = (j + rnd()) / grid;
    data[o++] = rnd();
    data[o++] = rnd();
  }
  g.setAttribute('aData', new THREE.InstancedBufferAttribute(data, 4));
  g.instanceCount = n;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

const COMMON_VERT = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_WORLD}
${GLSL_WIND}
${GLSL_SHADOW}
${GLSL_FOG}
${GLSL_LIGHT}
uniform vec3 uCamPos;
uniform vec3 uPlayerPos;
uniform vec4 uCenters;   // xy: this LOD's centre, zw: inner (finer) LOD's centre
uniform vec4 uTile;      // x: tile size, y: inner radius (0 = none), z: outer radius, w: width scale
in vec4 aData;

// same painterly tint the terrain uses, so blades melt into the ground colour
vec3 grassTint(vec2 xz, vec3 biome) {
  float nA = textureLod(uNoiseTex, xz * 0.0045, 0.0).r;
  vec2 nB = textureLod(uNoiseTex, xz * 0.031, 0.0).rg;
  vec3 tip = biome * mix(vec3(0.82, 0.92, 0.9), vec3(1.16, 1.06, 0.86), nA);
  tip *= 0.86 + 0.3 * nB.r;
  tip = mix(tip, tip * vec3(1.25, 1.12, 0.7), smoothstep(0.55, 0.85, nB.g) * 0.35);
  return tip;
}
vec2 tilePos(out float fade) {
  vec2 c = uCenters.xy;
  vec2 xz = (fract(aData.xy - c / uTile.x) - 0.5) * uTile.x + c;
  float jit = aData.z * 0.22;
  float dOut = distance(xz, c);
  fade = 1.0 - smoothstep(uTile.z * (0.70 - jit), uTile.z * (0.98 - jit), dOut);
  if (uTile.y > 0.0) {
    float dIn = distance(xz, uCenters.zw);
    fade *= smoothstep(uTile.y * (0.70 - jit), uTile.y * (0.98 - jit), dIn);
  }
  return xz;
}
`;

const BLADE_VERT = /* glsl */`
${COMMON_VERT}
out vec3 vColor;
out vec4 vFog;
void main() {
  float fade;
  vec2 xz = tilePos(fade);
  float r1 = aData.z, r2 = aData.w, r3 = fract(r1 * 37.7 + r2 * 11.3);
  vec2 uv = worldUV(xz);
  vec4 mask = textureLod(uMaskTex, uv, 0.0);
  float dens = mask.r;
  if (fade <= 0.01 || r3 > dens * 1.08) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float gh = terrainHeight(xz);
  vec3 base = vec3(xz.x, gh, xz.y);
  vec3 tn = terrainNormalLod(xz, 0.0);
  vec4 biome = biomeTintLod(xz);

  float H = (0.17 + 0.30 * r1 * r1 + 0.10 * r2) * biome.a * mix(1.0, 1.7, clamp(uTile.w * 0.25 - 0.25, 0.0, 1.0)) * fade * smoothstep(0.0, 0.4, dens);
  float W = (0.05 + 0.04 * r3) * uTile.w;

  float gust = windGust(xz);
  float ang = r2 * 6.2832;
  vec2 rdir = vec2(cos(ang), sin(ang));
  vec2 ldir = normalize(mix(rdir, uWind.xy, 0.3 + 0.65 * gust));
  float lean = 0.22 + r3 * 0.3 + gust * 1.0 * uWind.z + sin(uTime * (2.4 + r1 * 2.2) + r2 * 40.0) * 0.07;
  // the player parts the grass
  vec2 pd = xz - uPlayerPos.xz;
  float pl = length(pd);
  float push = (1.0 - smoothstep(0.25, 1.25, pl)) * step(abs(uPlayerPos.y - gh), 1.6);
  ldir = normalize(mix(ldir, pd / max(pl, 0.01), push));
  lean += push * 1.15;

  float t = position.y;
  float a = max(lean, 0.02);
  float at = a * t;
  vec3 dir3 = vec3(ldir.x, 0.0, ldir.y);
  vec3 p = base + dir3 * ((1.0 - cos(at)) / a) * H + vec3(0.0, 1.0, 0.0) * (sin(at) / a) * H;
  vec3 toCam = normalize(uCamPos - base);
  vec3 sideCam = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 sideRnd = vec3(-rdir.y, 0.0, rdir.x);
  vec3 side = normalize(mix(sideRnd, sideCam * sign(dot(sideCam, sideRnd) + 1e-3), 0.72));
  p += side * position.x * W;

  // ---- per-vertex shading ----
  vec3 tip = grassTint(xz, biome.rgb);
  vec3 root = tip * vec3(0.30, 0.42, 0.30);
  vec3 tipC = tip * (0.88 + 0.26 * gust) * (0.88 + 0.24 * r3);
  tipC = mix(tipC, tipC * vec3(1.3, 1.12, 0.62), step(0.86, r1) * 0.6);          // occasional dry blade
  vec3 albedo = mix(root, tipC, smoothstep(0.0, 0.85, t));
  float ndl = dot(tn, uLightDir);
  float diff = smoothstep(-0.2, 0.75, ndl);
  float sh = getShadowFast(base + vec3(0.0, H * 0.6, 0.0)) * cloudShadow(base);
  float canopy = mask.b;
  vec3 light = uLightColor * diff * sh * (1.0 - canopy * 0.3) + ambientLight(tn) * mix(0.58, 1.0, t) * (1.0 - canopy * 0.4);
  vec3 col = albedo * light;
  vec3 V = normalize(uCamPos - p);
  float back = pow(max(dot(-V, uLightDir), 0.0), 3.0) * t * sh;
  col += tip * uLightColor * back * 0.75;
  col += tip * uLightColor * gust * t * t * 0.22 * sh;
  vColor = col;
  vec3 fdir;
  float f = fogAmount(p, fdir);
  vFog = vec4(fogColorDir(fdir), f);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const BLADE_FRAG = /* glsl */`
in vec3 vColor;
in vec4 vFog;
out vec4 fragColor;
void main() { fragColor = vec4(mix(vColor, vFog.rgb, vFog.a), 1.0); }
`;

const FLOWER_VERT = /* glsl */`
${COMMON_VERT}
out vec3 vColor;
out vec3 vCenterCol;
out vec4 vFog;
out vec3 vQ;     // xy: quad coords, z: petal count
void main() {
  float fade;
  vec2 xz = tilePos(fade);
  float r1 = aData.z, r2 = aData.w, r3 = fract(r1 * 37.7 + r2 * 11.3), r4 = fract(r1 * 91.3 + r2 * 53.1);
  vec2 uv = worldUV(xz);
  vec4 mask = textureLod(uMaskTex, uv, 0.0);
  // flowers gather in patches
  float ptch = textureLod(uNoiseTex, xz * 0.013, 0.0).g;
  float dens = mask.a * smoothstep(0.42, 0.62, ptch) * step(0.3, mask.r);
  if (fade <= 0.01 || r3 > dens * 1.1) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float gh = terrainHeight(xz);
  vec4 biome = biomeTintLod(xz);
  float gust = windGust(xz);
  float stem = (0.22 + 0.2 * r1) * biome.a * fade;
  vec3 base = vec3(xz.x, gh, xz.y);
  vec2 sway = uWind.xy * (gust * 0.22 * uWind.z + sin(uTime * 2.2 + r2 * 30.0) * 0.025);
  vec2 pd = xz - uPlayerPos.xz; float pl = length(pd);
  float push = (1.0 - smoothstep(0.25, 1.1, pl)) * step(abs(uPlayerPos.y - gh), 1.6);
  sway += pd / max(pl, 0.01) * push * 0.3;
  vec3 head = base + vec3(sway.x, stem * (1.0 - push * 0.5), sway.y);
  float size = (0.07 + 0.055 * r4) * uTile.w * fade;
  vec3 cr = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 cu = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // tilt the head a little towards the sky so flowers read from above too
  vec3 p = head + (cr * position.x + normalize(cu + vec3(0.0, 0.6, 0.0)) * position.y) * size;

  // palette: type chosen per patch with per-flower variation
  float kind = fract(textureLod(uNoiseTex, xz * 0.006 + 0.5, 0.0).r * 3.7 + r4 * 0.22);
  vec3 c0 = vec3(0.95, 0.93, 0.88), c1 = vec3(0.98, 0.78, 0.12), c2 = vec3(0.30, 0.45, 0.95), c3 = vec3(0.95, 0.42, 0.62), c4 = vec3(0.92, 0.16, 0.12), c5 = vec3(0.66, 0.42, 0.95);
  vec3 pc = kind < 0.24 ? c0 : (kind < 0.44 ? c1 : (kind < 0.60 ? c2 : (kind < 0.76 ? c3 : (kind < 0.88 ? c4 : c5))));
  vCenterCol = kind < 0.24 ? vec3(0.98, 0.76, 0.1) : (kind < 0.44 ? vec3(0.75, 0.38, 0.05) : vec3(1.0, 0.9, 0.5));
  float sh = getShadowFast(head) * cloudShadow(head);
  vec3 light = uLightColor * (0.55 + 0.45 * sh) * sh + ambientLight(vec3(0.0, 1.0, 0.0)) * (1.0 - mask.b * 0.4);
  vColor = pc * light * 0.82;
  vCenterCol *= light * 0.8;
  vQ = vec3(position.xy, 5.0 + floor(r1 * 3.0));
  vec3 fdir;
  float f = fogAmount(p, fdir);
  vFog = vec4(fogColorDir(fdir), f);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FLOWER_FRAG = /* glsl */`
in vec3 vColor;
in vec3 vCenterCol;
in vec4 vFog;
in vec3 vQ;
out vec4 fragColor;
void main() {
  vec2 q = vQ.xy * 2.0;
  float r = length(q);
  float th = atan(q.y, q.x);
  float petal = 0.58 + 0.42 * abs(cos(th * vQ.z * 0.5));
  float edge = fwidth(r) * 1.5;
  float a = 1.0 - smoothstep(petal - edge, petal + edge, r);
  if (a < 0.02) discard;
  vec3 col = mix(vCenterCol, vColor * (0.82 + 0.25 * r), smoothstep(0.2, 0.3, r));
  fragColor = vec4(mix(col, vFog.rgb, vFog.a), a);
}
`;

export class Grass {
  constructor(scene, quality = 2) {
    // [tile size, grid, inner radius, outer radius, width scale, segments]
    const cfg = quality >= 3
      ? [[46, 330, 0, 21, 1.0, 4], [124, 440, 21, 58, 2.1, 3], [310, 400, 58, 148, 5.0, 2]]
      : quality === 2
        ? [[44, 290, 0, 20, 1.05, 4], [120, 400, 20, 56, 2.2, 3], [300, 360, 56, 142, 5.2, 2]]
        : quality === 1
          ? [[40, 220, 0, 18, 1.25, 3], [100, 280, 18, 46, 2.7, 2], [240, 250, 46, 112, 6.0, 2]]
          : [[36, 150, 0, 16, 1.6, 3], [80, 170, 16, 36, 3.4, 2], [170, 130, 36, 78, 7.5, 1]];
    this.lods = [];
    this.group = new THREE.Group();
    this.far = cfg[2][3];
    const centers = cfg.map(() => new THREE.Vector4());
    cfg.forEach((c, i) => {
      const uniforms = {
        ...shared(...U_LIGHT, ...U_SHADOW, ...U_WORLD, 'uWind', 'uPlayerPos', 'uCamPos'),
        uCenters: { value: centers[i] },
        uTile: { value: new THREE.Vector4(c[0], c[2], c[3], c[4]) },
      };
      const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: BLADE_VERT, fragmentShader: BLADE_FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(instancedTile(bladeGeometry(c[5]), c[1], 1234 + i * 77), mat);
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.lods.push({ mesh, center: centers[i], shift: [6, 20, 58][i] });
    });
    // flowers ride on the first two LOD tiles
    const quad = { pos: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), idx: [0, 1, 2, 0, 2, 3] };
    this.flowers = [];
    const fcfg = quality >= 2 ? [[cfg[0][0], 150, 0, cfg[0][3], 1.0], [cfg[1][0], 230, cfg[0][3], cfg[1][3], 1.6]] : [[cfg[0][0], 100, 0, cfg[0][3], 1.1], [cfg[1][0], 140, cfg[0][3], cfg[1][3], 1.9]];
    fcfg.forEach((c, i) => {
      const uniforms = {
        ...shared(...U_LIGHT, ...U_SHADOW, ...U_WORLD, 'uWind', 'uPlayerPos', 'uCamPos'),
        uCenters: { value: centers[i] },
        uTile: { value: new THREE.Vector4(c[0], c[2], c[3], c[4]) },
      };
      const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: FLOWER_VERT, fragmentShader: FLOWER_FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide, alphaToCoverage: true });
      const mesh = new THREE.Mesh(instancedTile(quad, c[1], 999 + i * 31), mat);
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 6;
      this.group.add(mesh);
      this.flowers.push(mesh);
    });
    scene.add(this.group);
  }

  update(camera) {
    const e = camera.matrixWorld.elements;
    let fx = -e[8], fz = -e[10];
    const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
    const horiz = Math.min(1, l * 1.2);     // looking straight down: keep tiles centred
    let px = 0, pz = 0;
    this.lods.forEach((L, i) => {
      const cx = camera.position.x + fx * L.shift * horiz, cz = camera.position.z + fz * L.shift * horiz;
      L.center.set(cx, cz, px, pz);
      px = cx; pz = cz;
    });
  }
}

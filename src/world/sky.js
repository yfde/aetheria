// Sky: time of day, atmosphere colours, sun / moon / stars dome and raymarched volumetric clouds.
import * as THREE from 'three';
import { G, shared, U_LIGHT } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_FOG, FS_VERT, CLOUD_ALT, CLOUD_TILE } from '../shaders/common.js';
import { makeCloudMap, makeCloudVolume } from '../core/texgen.js';

const _m = new THREE.Matrix4();
const lerp = (a, b, t) => a + (b - a) * t;
const sat = (x) => Math.min(1, Math.max(0, x));
const sstep = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// Atmosphere keyframes indexed by sun elevation (sin of altitude)
const STOPS = [
  { s: -0.40, zen: [0.012, 0.022, 0.065], hor: [0.035, 0.065, 0.145], sun: [0, 0, 0], amb: [0.085, 0.13, 0.27], gnd: [0.03, 0.04, 0.07], fsun: [0.05, 0.08, 0.16], cloudLit: [0.20, 0.27, 0.46], cloudSh: [0.03, 0.045, 0.09] },
  { s: -0.12, zen: [0.03, 0.05, 0.16], hor: [0.17, 0.15, 0.27], sun: [0, 0, 0], amb: [0.15, 0.17, 0.33], gnd: [0.07, 0.06, 0.10], fsun: [0.35, 0.2, 0.25], cloudLit: [0.34, 0.26, 0.38], cloudSh: [0.06, 0.07, 0.15] },
  { s: -0.02, zen: [0.09, 0.15, 0.40], hor: [0.86, 0.46, 0.30], sun: [0.95, 0.42, 0.17], amb: [0.36, 0.31, 0.47], gnd: [0.22, 0.15, 0.13], fsun: [1.5, 0.62, 0.22], cloudLit: [1.25, 0.62, 0.36], cloudSh: [0.20, 0.17, 0.33] },
  { s: 0.10, zen: [0.12, 0.26, 0.62], hor: [0.90, 0.66, 0.46], sun: [1.55, 0.98, 0.52], amb: [0.38, 0.39, 0.56], gnd: [0.25, 0.19, 0.14], fsun: [1.6, 0.95, 0.45], cloudLit: [1.35, 0.98, 0.70], cloudSh: [0.34, 0.33, 0.50] },
  { s: 0.32, zen: [0.115, 0.32, 0.78], hor: [0.60, 0.78, 0.95], sun: [1.50, 1.36, 1.12], amb: [0.33, 0.44, 0.65], gnd: [0.23, 0.22, 0.16], fsun: [1.15, 1.05, 0.85], cloudLit: [1.22, 1.18, 1.10], cloudSh: [0.46, 0.55, 0.74] },
  { s: 1.00, zen: [0.095, 0.29, 0.80], hor: [0.56, 0.77, 0.97], sun: [1.56, 1.44, 1.22], amb: [0.33, 0.45, 0.67], gnd: [0.24, 0.23, 0.17], fsun: [1.1, 1.05, 0.9], cloudLit: [1.24, 1.22, 1.16], cloudSh: [0.48, 0.58, 0.78] },
];
const KEYS = ['zen', 'hor', 'sun', 'amb', 'gnd', 'fsun', 'cloudLit', 'cloudSh'];

function sampleStops(s, out) {
  let i = 0;
  while (i < STOPS.length - 2 && s > STOPS[i + 1].s) i++;
  const a = STOPS[i], b = STOPS[i + 1];
  const t = sstep(a.s, b.s, s);
  for (const k of KEYS) { const o = out[k]; for (let c = 0; c < 3; c++) o[c] = lerp(a[k][c], b[k][c], t); }
  return out;
}

const SKY_COMMON = /* glsl */`
uniform vec3 uSkyZenith;
uniform vec3 uSunGlow;
vec3 skyGradient(vec3 d) {
  float y = max(d.y, 0.0);
  vec3 hor = fogColorDir(d);
  float t = 1.0 - exp(-y * 3.4);
  vec3 col = mix(hor, uSkyZenith, t);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunGlow * (pow(sd, 420.0) * 0.55 + pow(sd, 36.0) * 0.16 + pow(sd, 6.0) * 0.07);
  return col;
}
`;
export { SKY_COMMON };

const DOME_VERT = /* glsl */`
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;

const DOME_FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_FOG}
${SKY_COMMON}
uniform vec3 uMoonDir;
uniform vec3 uSunDisc;
uniform sampler2D uCloudRT;
uniform sampler2D uCloudMap;
uniform sampler2D uNoiseTex;
uniform vec4 uCloudParams;
uniform vec2 uResolution;
uniform float uStarRot;
uniform vec3 uCloudLit;
in vec3 vDir;
out vec4 fragColor;

float starLayer(vec3 d, float scale, float thresh) {
  vec3 p = d * scale;
  vec3 c = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash12(c.xy + c.z * 37.17);
  float h2 = hash12(c.yz + c.x * 11.31);
  float s = step(thresh, h) * smoothstep(0.32, 0.0, length(f + (vec3(h2, fract(h2 * 7.1), fract(h * 13.7)) - 0.5) * 0.5));
  float tw = 0.7 + 0.3 * sin(uTime * (1.5 + h2 * 3.0) + h * 40.0);
  return s * tw * (0.4 + h2 * 1.4);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 col = skyGradient(d);

  // below the horizon: sink into haze
  if (d.y < 0.0) col = mix(col, uFogColor * 0.82, smoothstep(0.0, -0.35, d.y));

  // night sky
  if (uNight > 0.01) {
    float c = cos(uStarRot), s = sin(uStarRot);
    vec3 sd = vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
    float st = starLayer(sd, 210.0, 0.9955) + starLayer(sd, 120.0, 0.996) * 1.6;
    // milky way band
    float band = exp(-pow(dot(sd, normalize(vec3(0.35, 0.25, 0.9))) * 3.2, 2.0));
    float mw = texture(uNoiseTex, sd.xy * 1.3 + sd.z * 0.4).r * texture(uNoiseTex, sd.yz * 3.1).g;
    vec3 stars = vec3(0.85, 0.92, 1.0) * st * 2.2 + vec3(0.25, 0.3, 0.55) * band * mw * 1.3 + vec3(0.9, 0.95, 1.0) * starLayer(sd, 420.0, 0.99) * band * 1.2;
    col += stars * uNight * smoothstep(-0.02, 0.25, d.y);
    // aurora curtains over the northern mountains: a wavy lower edge, fading upward, striated by fine rays
    float an = smoothstep(0.1, 0.5, -d.z);
    if (an > 0.0 && d.y > 0.05) {
      float ax = atan(d.x, -d.z);
      float pres = smoothstep(0.38, 0.66, texture(uNoiseTex, vec2(ax * 0.16 + uTime * 0.002, 0.3)).r);
      float y0 = 0.12 + 0.13 * texture(uNoiseTex, vec2(ax * 0.33 + uTime * 0.004, 0.7)).g;
      float hgt = d.y - y0;
      float prof = smoothstep(0.0, 0.025, hgt) * exp(-max(hgt, 0.0) * 7.5);
      float rays = texture(uNoiseTex, vec2(ax * 3.4 + y0 * 2.0, uTime * 0.006)).r;
      rays = 0.3 + 1.5 * rays * rays;
      vec3 ac = mix(vec3(0.08, 1.0, 0.45), vec3(0.42, 0.18, 0.85), smoothstep(0.0, 0.26, hgt));
      col += ac * prof * rays * pres * an * uNight * 0.36;
    }
    // a shooting star every few seconds
    {
      float k = floor(uTime / 7.0), ph = fract(uTime / 7.0) / 0.1;
      if (ph < 1.0) {
        vec2 h = hash22(vec2(k, k * 1.7 + 3.0));
        float a0 = h.x * 6.2832;
        vec3 p0 = normalize(vec3(cos(a0) * 0.8, 0.45 + h.y * 0.5, sin(a0) * 0.8));
        vec3 vdir = normalize(cross(p0, vec3(0.3, 1.0, 0.2)) - vec3(0.0, 0.35, 0.0));
        vec3 head = normalize(p0 + vdir * ph * 0.3);
        vec3 w = d - head;
        float along = dot(w, vdir), perp = length(w - vdir * along);
        float tail = step(-0.09, along) * step(along, 0.0) * (1.0 + along / 0.09);
        col += vec3(0.9, 0.95, 1.0) * smoothstep(0.0035, 0.0, perp) * tail * sin(ph * 3.1416) * 3.0 * uNight;
      }
    }
  }

  // sun disc
  float sd = dot(d, uSunDir);
  float disc = smoothstep(0.99962, 0.99982, sd);
  col += uSunDisc * disc;

  // moon
  float md = dot(d, uMoonDir);
  if (md > 0.995) {
    float mdisc = smoothstep(0.99905, 0.9993, md);
    vec3 mx = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 my = cross(mx, uMoonDir);
    vec2 muv = vec2(dot(d, mx), dot(d, my)) / 0.043;
    float crater = texture(uNoiseTex, muv * 0.35 + 0.2).r * 0.5 + texture(uNoiseTex, muv * 0.9).b * 0.2;
    vec3 moonCol = vec3(1.0, 0.98, 0.9) * (1.15 - crater * 0.75) * (1.0 - dot(muv, muv) * 0.25);
    float nightVis = 0.25 + 0.75 * uNight;
    col = mix(col, moonCol * 2.2 * nightVis, mdisc * nightVis);
    col += vec3(0.5, 0.62, 1.0) * pow(max(md, 0.0), 900.0) * 0.5 * uNight;
  }
  col += vec3(0.35, 0.45, 0.8) * pow(max(md, 0.0), 60.0) * 0.12 * uNight;

  // high cirrus (2D)
  if (d.y > 0.01) {
    vec2 cp = (cameraPosition.xz + d.xz * (5200.0 / (d.y + 0.07))) / 26000.0 + uCloudParams.xy * 0.6;
    float ci = texture(uCloudMap, cp).b;
    ci = smoothstep(0.34, 0.72, ci) * smoothstep(0.01, 0.2, d.y) * 0.42 * (0.4 + uCloudParams.z);
    col = mix(col, uCloudLit * 0.92 + uSunGlow * pow(max(sd, 0.0), 8.0) * 0.5, ci);
  }

  // volumetric clouds (pre-rendered at low resolution)
  vec2 cuv = gl_FragCoord.xy / uResolution;
  vec2 ct = 1.2 / uResolution;
  vec4 cl = (texture(uCloudRT, cuv + ct * vec2(1.0, 0.5)) + texture(uCloudRT, cuv + ct * vec2(-0.5, 1.0)) + texture(uCloudRT, cuv + ct * vec2(-1.0, -0.5)) + texture(uCloudRT, cuv + ct * vec2(0.5, -1.0))) * 0.25;
  col = col * cl.a + cl.rgb;

  fragColor = vec4(col, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */`
precision highp sampler3D;
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_FOG}
uniform sampler2D uCloudMap;
uniform sampler3D uCloudVol;
uniform vec4 uCloudParams;     // xy scroll, z coverage
uniform vec3 uCamFwd, uCamRight, uCamUp;
uniform vec3 uCloudLit, uCloudSh, uSunGlow;
uniform float uSteps;
uniform float uFrame;
uniform sampler2D uHistory;
uniform mat4 uPrevVP;
uniform float uBlend;
in vec2 vUv;
out vec4 fragColor;

const float BASE = ${CLOUD_ALT.toFixed(1)};
const float THICK = 1050.0;
const float PLANET = 120000.0;
const float TILE = ${CLOUD_TILE.toFixed(1)};

float remap(float v, float a, float b, float c, float d) { return c + (d - c) * clamp((v - a) / (b - a), 0.0, 1.0); }

float heightFrac(vec3 p) {
  // altitude above the curved "planet" centred below the camera
  vec3 q = p - vec3(cameraPosition.x, -PLANET, cameraPosition.z);
  return (length(q) - PLANET - BASE) / THICK;
}

float cloudDensity(vec3 p, bool cheap) {
  float hf = heightFrac(p);
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  vec2 uv = p.xz / TILE + uCloudParams.xy;
  float shape = textureLod(uCloudMap, uv, 0.0).r;
  float cov = uCloudParams.z;
  float base = smoothstep(1.0 - cov - 0.03, 1.0 - cov + 0.36, shape);
  if (base <= 0.0) return 0.0;
  float topH = mix(0.22, 1.0, base * base);
  float prof = smoothstep(0.0, 0.07, hf) * (1.0 - smoothstep(topH * 0.5, topH, hf));
  float d = base * prof;
  vec3 q = p / 1700.0 + vec3(uCloudParams.x * 5.0, uTime * 0.0012, uCloudParams.y * 5.0);
  vec2 nz = textureLod(uCloudVol, q, 0.0).rg;
  d = remap(d, (1.0 - nz.r) * 0.62, 1.0, 0.0, 1.0);
  if (!cheap && d > 0.0) {
    float dn = textureLod(uCloudVol, q * 4.7 + 0.31, 0.0).g;
    d = remap(d, dn * 0.26 * (1.0 - d), 1.0, 0.0, 1.0);
  }
  return d;
}

// ray / sphere shell: returns distance to shell of given altitude (camera is inside)
float shellDist(vec3 ro, vec3 rd, float alt) {
  vec3 oc = ro - vec3(ro.x, -PLANET, ro.z);
  float R = PLANET + alt;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - R * R;
  float disc = b * b - c;
  return disc < 0.0 ? -1.0 : -b + sqrt(disc);
}

vec4 march(vec3 ro, vec3 rd);
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * ndc.x + uCamUp * ndc.y);
  vec3 ro = cameraPosition;
  if (rd.y < -0.02) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 cur = march(ro, rd);
  // temporal accumulation; clouds are far away, so reproject by rotation only
  vec4 pc = uPrevVP * vec4(rd, 0.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (uBlend > 0.0 && pc.w > 0.0 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
    cur = mix(cur, texture(uHistory, puv), uBlend);
  }
  fragColor = cur;
}

vec4 march(vec3 ro, vec3 rd) {
  float t0 = shellDist(ro, rd, BASE);
  float t1 = shellDist(ro, rd, BASE + THICK);
  if (ro.y > BASE) t0 = 0.0;
  t1 = min(t1, t0 + 14000.0);
  if (t0 < 0.0 || t1 <= t0 || t0 > 60000.0) return vec4(0.0, 0.0, 0.0, 1.0);

  float steps = uSteps;
  float dt = (t1 - t0) / steps;
  // per-pixel low-discrepancy sequence over frames: the temporal filter converges cleanly
  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803398875);
  float t = t0 + dt * jitter;

  vec3 L = uLightDir;
  float sd = dot(rd, uSunDir);
  float phase = 0.55 + 0.9 * pow(max(sd, 0.0), 6.0) + 2.2 * pow(max(sd, 0.0), 40.0);

  vec3 acc = vec3(0.0);
  float T = 1.0;
  float tAvg = 0.0, wAvg = 0.0;
  const float SIGMA = 0.021;
  for (int i = 0; i < 48; i++) {
    if (float(i) >= steps || T < 0.02) break;
    vec3 p = ro + rd * t;
    float d = cloudDensity(p, false);
    if (d > 0.001) {
      // light march
      float od = 0.0;
      float st = 55.0;
      vec3 lp = p;
      for (int j = 0; j < 4; j++) {
        lp += L * st;
        od += cloudDensity(lp, true) * st;
        st *= 1.8;
      }
      float hf = clamp(heightFrac(p), 0.0, 1.0);
      float beer = exp(-od * SIGMA * 0.55);
      float lightT = mix(beer, 0.35 * exp(-od * SIGMA * 0.14), 0.42);       // multiple-scatter-ish tail
      float powder = 1.0 - exp(-d * 6.0 - od * SIGMA * 2.0) * 0.6;
      vec3 amb = uCloudSh * (0.55 + 0.65 * hf);
      vec3 lit = uCloudLit * lightT * (0.75 + 0.5 * phase) * powder + uSunGlow * pow(max(sd, 0.0), 14.0) * lightT * 0.35;
      vec3 sc = amb + lit;
      float a = 1.0 - exp(-d * SIGMA * dt);
      acc += T * a * sc;
      tAvg += t * T * a; wAvg += T * a;
      T *= 1.0 - a;
    }
    t += dt;
  }
  // aerial perspective: distant clouds melt into the horizon haze
  if (wAvg > 0.0) {
    float dist = tAvg / wAvg;
    float f = 1.0 - exp(-dist * 0.000075);
    f = clamp(f + smoothstep(0.06, 0.0, rd.y) * 0.7, 0.0, 1.0);
    acc = mix(acc, fogColorDir(rd) * (1.0 - T), f);
  }
  return vec4(acc, T);
}
`;

export class Sky {
  constructor(scene, renderer) {
    this.time = 9.0;            // hours
    this.dayLength = 24 * 60;   // seconds for a full day (24 min)
    this.timeScale = 1;
    this.coverage = 0.46;
    this.coverageTarget = 0.46;
    this.cloudOffset = new THREE.Vector2(0.13, 0.31);
    this.windDir = new THREE.Vector2(0.8, 0.6).normalize();
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.env = { zen: [0, 0, 0], hor: [0, 0, 0], sun: [0, 0, 0], amb: [0, 0, 0], gnd: [0, 0, 0], fsun: [0, 0, 0], cloudLit: [0, 0, 0], cloudSh: [0, 0, 0] };
    this.exposure = 1;
    this.frame = 0;

    G.uCloudMap.value = makeCloudMap(512);
    this.cloudVol = makeCloudVolume(64);

    this.uniforms = {
      uSkyZenith: G.uSkyZenith,
      uSunGlow: G.uSunGlow,
      uSunDisc: { value: new THREE.Color() },
      uCloudLit: G.uCloudLit,
      uCloudSh: G.uCloudSh,
      uStarRot: { value: 0 },
      uCloudRT: { value: null },
    };

    // low-res cloud target
    this.cloudScale = 0.5;
    const mkRT = () => new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    this.cloudRTs = [mkRT(), mkRT()];
    this.cloudIdx = 0;
    this.historyValid = false;
    this.prevVP = new THREE.Matrix4();
    this.uniforms.uCloudRT.value = this.cloudRTs[0].texture;
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared(...U_LIGHT, 'uCloudMap', 'uCloudParams'),
        uCloudVol: { value: this.cloudVol },
        uCamFwd: { value: new THREE.Vector3() }, uCamRight: { value: new THREE.Vector3() }, uCamUp: { value: new THREE.Vector3() },
        uCloudLit: this.uniforms.uCloudLit, uCloudSh: this.uniforms.uCloudSh, uSunGlow: this.uniforms.uSunGlow,
        uSteps: { value: 24 }, uFrame: { value: 0 },
        uHistory: { value: null }, uPrevVP: { value: new THREE.Matrix4() }, uBlend: { value: 0 },
      },
      vertexShader: FS_VERT, fragmentShader: CLOUD_FRAG, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
    });
    this.fsScene = new THREE.Scene();
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.fsMesh = new THREE.Mesh(tri, this.cloudMat);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    // dome
    const geo = new THREE.IcosahedronGeometry(1, 4);
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: { ...shared(...U_LIGHT, 'uMoonDir', 'uCloudMap', 'uCloudParams', 'uNoiseTex', 'uResolution'), ...this.uniforms },
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, glslVersion: THREE.GLSL3,
      side: THREE.BackSide, depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth,
    });
    this.dome = new THREE.Mesh(geo, this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1000;
    this.dome.matrixAutoUpdate = false;
    scene.add(this.dome);
  }

  setSize(w, h) {
    for (const rt of this.cloudRTs) rt.setSize(Math.max(8, Math.round(w * this.cloudScale)), Math.max(8, Math.round(h * this.cloudScale)));
    this.historyValid = false;
  }

  setQuality(q) {
    this.cloudScale = q >= 2 ? 0.5 : q >= 1 ? 0.4 : 0.3;
    this.cloudMat.uniforms.uSteps.value = q >= 2 ? 30 : q >= 1 ? 22 : 14;
  }

  update(dt) {
    this.time = (this.time + dt * this.timeScale * 24 / this.dayLength) % 24;
    this.frame++;
    const t = this.time;
    // sun path: rises east (+x), culminates toward the south (+z)
    const ang = (t / 24) * Math.PI * 2 - Math.PI / 2;
    const tilt = 0.52;
    this.sunDir.set(Math.cos(ang), Math.sin(ang) * Math.cos(tilt), Math.sin(ang) * Math.sin(tilt) + 0.12).normalize();
    const mang = ang + Math.PI * 0.94;
    this.moonDir.set(Math.cos(mang) * 0.9, Math.sin(mang) * 0.82, 0.38 - Math.sin(mang) * 0.25).normalize();
    const s = this.sunDir.y;
    const e = sampleStops(s, this.env);

    const sunW = sstep(-0.07, 0.03, s);
    const moonW = sstep(-0.08, -0.2, s) * sstep(-0.02, 0.12, this.moonDir.y);
    const night = sstep(0.06, -0.22, s);
    G.uNight.value = night;
    G.uSunDir.value.copy(this.sunDir);
    G.uMoonDir.value.copy(this.moonDir);

    const L = G.uLightDir.value;
    if (s > -0.075) {
      L.copy(this.sunDir);
      G.uLightColor.value.setRGB(e.sun[0] * sunW, e.sun[1] * sunW, e.sun[2] * sunW);
      G.uShadowParams.value.y = sunW;
    } else {
      L.copy(this.moonDir);
      G.uLightColor.value.setRGB(0.20 * moonW, 0.29 * moonW, 0.52 * moonW);
      G.uShadowParams.value.y = moonW * 0.85;
    }
    // keep the light off the horizon so shadows stay sane
    if (L.y < 0.16) { L.y = 0.16; L.normalize(); }

    const cov = this.coverage;
    const overcast = sstep(0.62, 0.92, cov);
    const dim = 1 - overcast * 0.55;
    G.uLightColor.value.multiplyScalar(dim);
    G.uAmbSky.value.setRGB(e.amb[0], e.amb[1], e.amb[2]).multiplyScalar(1.0 + overcast * 0.12);
    G.uAmbGround.value.setRGB(e.gnd[0], e.gnd[1], e.gnd[2]);
    const grey = (e.hor[0] + e.hor[1] + e.hor[2]) / 3;
    G.uFogColor.value.setRGB(lerp(e.hor[0], grey * 0.9, overcast * 0.7), lerp(e.hor[1], grey * 0.94, overcast * 0.7), lerp(e.hor[2], grey, overcast * 0.7));
    G.uFogSunColor.value.setRGB(e.fsun[0], e.fsun[1], e.fsun[2]).multiplyScalar(dim);
    this.uniforms.uSkyZenith.value.setRGB(lerp(e.zen[0], grey * 0.55, overcast * 0.8), lerp(e.zen[1], grey * 0.6, overcast * 0.8), lerp(e.zen[2], grey * 0.7, overcast * 0.8));
    this.uniforms.uSunGlow.value.setRGB(e.fsun[0], e.fsun[1], e.fsun[2]).multiplyScalar(sstep(-0.12, 0.05, s) * dim);
    const discI = 34 * sstep(-0.04, 0.03, s);
    this.uniforms.uSunDisc.value.setRGB(1.0 * discI, lerp(0.55, 0.92, sstep(0, 0.3, s)) * discI, lerp(0.25, 0.75, sstep(0, 0.3, s)) * discI);
    this.uniforms.uCloudLit.value.setRGB(e.cloudLit[0], e.cloudLit[1], e.cloudLit[2]).multiplyScalar(1 - overcast * 0.35);
    this.uniforms.uCloudSh.value.setRGB(e.cloudSh[0], e.cloudSh[1], e.cloudSh[2]).multiplyScalar(1 - overcast * 0.3);
    this.uniforms.uStarRot.value = t / 24 * Math.PI * 2;

    // fog: thicker at dawn, lighter at noon, denser when overcast
    const morning = Math.exp(-Math.pow((t - 6.2) / 1.6, 2));
    G.uFogParams.value.set(0.000115 + overcast * 0.00025 + night * 0.00003, 0.00022 + morning * 0.0011 + overcast * 0.0006, 0.011, 0.97);

    // clouds drift with the wind
    this.coverage += (this.coverageTarget - this.coverage) * Math.min(1, dt * 0.05);
    const drift = dt * 0.0011 * (0.6 + G.uWind.value.z * 0.5);
    this.cloudOffset.x -= this.windDir.x * drift;
    this.cloudOffset.y -= this.windDir.y * drift;
    G.uCloudParams.value.set(this.cloudOffset.x, this.cloudOffset.y, this.coverage, 0.52 * (1 - night * 0.6));

    this.exposure = lerp(1.0, 1.55, night);
    this.night = night;
  }

  renderClouds(renderer, camera) {
    const u = this.cloudMat.uniforms;
    const th = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const e = camera.matrixWorld.elements;
    u.uCamRight.value.set(e[0], e[1], e[2]).multiplyScalar(th * camera.aspect);
    u.uCamUp.value.set(e[4], e[5], e[6]).multiplyScalar(th);
    u.uCamFwd.value.set(-e[8], -e[9], -e[10]);
    u.uFrame.value = this.frame % 64;
    const cur = this.cloudRTs[this.cloudIdx], prev = this.cloudRTs[1 - this.cloudIdx];
    u.uHistory.value = prev.texture;
    u.uPrevVP.value.copy(this.prevVP);
    u.uBlend.value = this.historyValid ? 0.92 : 0.0;
    renderer.setRenderTarget(cur);
    renderer.render(this.fsScene, camera);
    this.uniforms.uCloudRT.value = cur.texture;
    // rotation-only view-projection for next frame's reprojection
    _m.copy(camera.matrixWorldInverse); _m.elements[12] = 0; _m.elements[13] = 0; _m.elements[14] = 0;
    this.prevVP.multiplyMatrices(camera.projectionMatrix, _m);
    this.cloudIdx = 1 - this.cloudIdx;
    this.historyValid = true;
  }
}

// Water: ocean (clipmap with Gerstner swell), lakes (flat discs) and rivers (flow-mapped ribbons).
// Drawn in the second stage so it can refract the already-rendered opaque scene.
import * as THREE from 'three';
import { shared, U_LIGHT, U_SHADOW, U_WORLD, U_SKY } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_WORLD, GLSL_SHADOW, GLSL_FOG, CLOUD_ALT, CLOUD_TILE } from '../shaders/common.js';
import { SKY_COMMON } from './sky.js';
import { makeWaterNormals } from '../core/texgen.js';
import { buildGrid } from './terrain.js';
import { LAKES } from './layout.js';
import { LAYER_TRANS } from '../core/gfx.js';

const VERT = /* glsl */`
${GLSL_WORLD}
uniform float uTime;
uniform vec3 uCamPos;
#ifdef OCEAN
uniform vec3 uLevel;
uniform float uGridHalf;
#endif
#ifdef RIVER
in vec3 aFlow;
in vec2 aRuv;
out vec3 vFlow;
out vec2 vRuv;
#endif
out vec3 vWorldPos;
out vec3 vWaveN;
out float vCrest;

void gerstner(vec2 p, vec2 dir, float steep, float wl, float speed, float amp, inout vec3 disp, inout vec3 nrm) {
  float k = 6.28318 / wl;
  float a = steep / k * amp;
  dir = normalize(dir);
  float f = k * dot(dir, p) - speed * sqrt(9.8 * k) * uTime;
  float c = cos(f), s = sin(f);
  disp += vec3(dir.x * a * c, a * s, dir.y * a * c);
  nrm += vec3(-dir.x * k * a * c, 0.0, -dir.y * k * a * c);
}

void main() {
  vWaveN = vec3(0.0, 1.0, 0.0);
  vCrest = 0.0;
#ifdef OCEAN
  float cs = uLevel.x;
  vec2 wxz = uLevel.yz + position.xz * cs;
  vec2 dc = abs(wxz - uCamPos.xz);
  float d = max(dc.x, dc.y);
  float R = uGridHalf * cs;
  float k = smoothstep(R * 0.60, R * 0.84, d);
  wxz -= mod(position.xz, 2.0) * cs * k;
  float seaDepth = -terrainHeight(wxz);
  float amp = smoothstep(0.2, 9.0, seaDepth) * (1.0 - smoothstep(350.0, 900.0, distance(wxz, uCamPos.xz)));
  vec3 disp = vec3(0.0), nrm = vec3(0.0, 1.0, 0.0);
  gerstner(wxz, vec2(1.0, 0.35), 0.11, 47.0, 0.9, amp, disp, nrm);
  gerstner(wxz, vec2(0.55, -0.8), 0.10, 27.0, 0.95, amp, disp, nrm);
  gerstner(wxz, vec2(-0.35, 0.9), 0.09, 15.0, 1.0, amp, disp, nrm);
  gerstner(wxz, vec2(0.9, 0.5), 0.07, 8.3, 1.1, amp, disp, nrm);
  vec3 wp = vec3(wxz.x, 0.0, wxz.y) + disp;
  vWaveN = normalize(nrm);
  vCrest = disp.y;
#else
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
#endif
#ifdef RIVER
  vFlow = aFlow;
  vRuv = aRuv;
#endif
  vWorldPos = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_WORLD}
${GLSL_SHADOW}
${GLSL_FOG}
${SKY_COMMON}
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uWaterN;
uniform vec2 uResolution;
uniform vec2 uCamNearFar;
uniform vec3 uCloudLit, uCloudSh;
uniform vec4 uWind;
uniform mat4 projectionMatrix;
uniform float uSSR;
in vec3 vWorldPos;
in vec3 vWaveN;
in float vCrest;
#ifdef RIVER
in vec3 vFlow;
in vec2 vRuv;
#endif
out vec4 fragColor;

float linDepth(float d) {
  float n = uCamNearFar.x, f = uCamNearFar.y;
  return 2.0 * n * f / (f + n - (d * 2.0 - 1.0) * (f - n));
}

void main() {
  vec3 wp = vWorldPos;
  vec2 suv = gl_FragCoord.xy / uResolution;
  float th = terrainHeight(wp.xz);
  float depthV = wp.y - th;
  float fallK = 0.0;
#ifdef RIVER
  fallK = smoothstep(0.7, 1.2, vFlow.z);            // waterfall sections ignore the heightfield shoreline
  float rapid = clamp(vFlow.z * 2.2, 0.0, 1.0);
#endif
  if (depthV < mix(-0.25, -3.0, fallK)) discard;
#ifndef RIVER
#ifndef OCEAN
  if (waterLevel(wp.xz) < wp.y - 0.4) discard;
#endif
#endif
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // ---------- surface normal ----------
  vec2 nn;
  float flowFoam = 0.0;
#ifdef RIVER
  vec2 fdir = normalize(vFlow.xy + 1e-5);
  float speed = 2.2 + rapid * 9.0;
  float ph = fract(uTime * 0.28), ph2 = fract(ph + 0.5);
  vec2 buv = wp.xz * 0.13;
  vec3 a = texture(uWaterN, buv - fdir * ph * speed * 0.13).rgb;
  vec3 b = texture(uWaterN, buv - fdir * ph2 * speed * 0.13 + 0.47).rgb;
  float wgt = abs(1.0 - 2.0 * ph);
  vec3 fl = mix(a, b, wgt);
  nn = (fl.rg * 2.0 - 1.0) * (1.0 + rapid * 2.0);
  // streaky foam along the flow on rapids / falls
  vec2 suvF = vec2(dot(wp.xz, vec2(-fdir.y, fdir.x)) * 0.35, dot(wp.xz, fdir) * 0.045 + wp.y * 0.05 - uTime * (0.5 + rapid * 1.6));
  float streak = texture(uNoiseTex, suvF).r * 0.6 + texture(uNoiseTex, suvF * vec2(2.3, 1.7) + 0.3).g * 0.5;
  flowFoam = smoothstep(0.66 - rapid * 0.3, 0.86 - rapid * 0.2, streak) * smoothstep(0.05, 0.6, rapid) * 0.8;
#else
  vec2 w = uWind.xy;
  vec2 u1 = wp.xz * 0.045 + w * uTime * 0.012;
  vec2 u2 = wp.xz * 0.11 - vec2(w.y, -w.x) * uTime * 0.016 + 0.3;
  vec2 u3 = wp.xz * 0.37 + w * uTime * 0.035 + 0.7;
  float dfade = 1.0 / (1.0 + dist * 0.004);
  nn = (texture(uWaterN, u1).rg * 2.0 - 1.0) * 0.9 + (texture(uWaterN, u2).rg * 2.0 - 1.0) * 0.7 + (texture(uWaterN, u3).rg * 2.0 - 1.0) * 0.45 * dfade;
#endif
  float nStr = 0.16;
#ifdef OCEAN
  nStr = 0.24;
#endif
  nStr *= mix(1.0, 0.3, smoothstep(80.0, 900.0, dist));        // calm the far field (no shimmer)
  vec3 N = normalize(vec3(vWaveN.x + nn.x * nStr, 1.0, vWaveN.z + nn.y * nStr));

  // ---------- refraction ----------
  float zWater = linDepth(gl_FragCoord.z);
  float zScene = linDepth(texture(uSceneDepth, suv).r);
  float thick = max(zScene - zWater, 0.0);
  vec2 ruv = suv + N.xz * 0.05 * clamp(thick * 0.6, 0.0, 1.0) / (1.0 + dist * 0.03);
  float zR = linDepth(texture(uSceneDepth, ruv).r);
  if (zR < zWater) ruv = suv; else thick = zR - zWater;
  vec3 refr = texture(uSceneColor, ruv).rgb;

  float shadow = getShadow(wp, vec3(0.0, 1.0, 0.0)) * cloudShadow(wp);
  vec3 T = exp(-thick * vec3(0.36, 0.085, 0.06));
  vec3 skyAmb = uAmbSky * 0.75 + uLightColor * 0.22 * (0.35 + 0.65 * shadow);
  vec3 deepCol = vec3(0.012, 0.115, 0.20) * skyAmb * 1.6;
  vec3 shallowScatter = vec3(0.02, 0.26, 0.24) * skyAmb;
  vec3 scatter = mix(shallowScatter, deepCol, smoothstep(0.0, 9.0, thick));
  vec3 body = refr * T + scatter * (1.0 - T);
#ifdef OCEAN
  // light glowing through wave crests
  body += vec3(0.0, 0.16, 0.13) * uLightColor * smoothstep(0.1, 0.9, vCrest) * 0.5 * shadow;
#endif

  // ---------- reflection ----------
  vec3 Rv = reflect(-V, N);
  Rv.y = abs(Rv.y) + 0.02;
  Rv = normalize(Rv);
  vec3 refl = skyGradient(Rv);
  {
    vec2 cp = (wp.xz + Rv.xz * (${(CLOUD_ALT + 250).toFixed(1)} - wp.y) / max(Rv.y, 0.06)) / ${CLOUD_TILE.toFixed(1)} + uCloudParams.xy;
    float cov = uCloudParams.z;
    float c = smoothstep(1.0 - cov - 0.03, 1.0 - cov + 0.36, texture(uCloudMap, cp).r);
    refl = mix(refl, mix(uCloudSh, uCloudLit, 0.72), c * smoothstep(0.03, 0.2, Rv.y) * 0.85);
  }
  // screen-space reflection of the already-rendered scene (mountains, trees, bridges)
  if (uSSR > 0.5) {
    vec3 rdir = normalize(reflect(-V, normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.55))));
    rdir.y = max(rdir.y, 0.02);
    float stepLen = 1.2 + dist * 0.02;
    vec3 p = wp + rdir * (0.6 + dist * 0.01);
    float hitA = 0.0; vec2 huv = vec2(0.0);
    for (int i = 0; i < 22; i++) {
      p += rdir * stepLen;
      vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
      if (clip.w <= 0.0) break;
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
      float sd0 = texture(uSceneDepth, uv).r;
      if (sd0 < 0.99999) {
        float sz = linDepth(sd0);
        float dz = clip.w - sz;
        if (dz > 0.0 && dz < stepLen * 2.5 + sz * 0.08) {
          huv = uv;
          vec2 e = smoothstep(vec2(0.0), vec2(0.08), uv) * smoothstep(vec2(1.0), vec2(0.92), uv);
          hitA = e.x * e.y;
          break;
        }
      }
      stepLen *= 1.22;
    }
    if (hitA > 0.0) refl = mix(refl, texture(uSceneColor, huv + N.xz * 0.012).rgb, hitA * 0.9);
  }
  float fres = 0.025 + 0.975 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  fres *= 0.92;
  vec3 col = mix(body, refl, fres);

  // sun glitter
  float sd = max(dot(Rv, uLightDir), 0.0);
  float glint = pow(sd, 900.0) * 30.0 + pow(sd, 90.0) * 0.9;
  float sparkle = step(0.93, texture(uNoiseTex, wp.xz * 0.9 + uTime * 0.05).a) * pow(sd, 22.0) * 5.0;
  col += uLightColor * (glint + sparkle) * shadow;

  // ---------- foam ----------
  float fn = texture(uNoiseTex, wp.xz * 0.07 + uTime * vec2(0.012, 0.009)).r;
  float fn2 = texture(uNoiseTex, wp.xz * 0.33 - uTime * vec2(0.02, 0.014)).g;
  float shoreT = 1.0 - smoothstep(0.0, 0.85, depthV);
  float bands = sin(depthV * 9.0 + uTime * 1.5 + fn * 9.0) * 0.5 + 0.5;
  float foam = shoreT * smoothstep(0.45, 0.75, bands * 0.6 + fn2 * 0.55 + shoreT * 0.35);
  foam = max(foam, smoothstep(0.16, 0.03, depthV));
#ifdef OCEAN
  foam = max(foam, smoothstep(0.55, 1.1, vCrest + fn2 * 0.5) * 0.55 * smoothstep(0.55, 0.8, fn2 + fn * 0.4));
#endif
  foam = max(foam, flowFoam);
  foam = max(foam, fallK * (0.78 + 0.22 * fn2));
  vec3 foamCol = vec3(0.92, 0.96, 1.0) * (uAmbSky * 1.45 + uAmbGround * 0.4 + uLightColor * 0.6 * shadow);
#ifdef RIVER
  if (fallK > 0.0) {
    // falling sheets: long vertical streaks sliding down, cooler where the curtain thins
    float across = dot(wp.xz, vec2(-fdir.y, fdir.x));
    float ws = texture(uNoiseTex, vec2(across * 0.16, wp.y * 0.03 + uTime * 0.5)).r;
    float ws2 = texture(uNoiseTex, vec2(across * 0.47 + 0.3, wp.y * 0.075 + uTime * 0.85)).g;
    float sheet = smoothstep(0.3, 0.72, ws * 0.62 + ws2 * 0.46);
    foamCol = mix(foamCol, foamCol * mix(vec3(0.5, 0.74, 0.88), vec3(1.04), sheet), fallK);
  }
#endif
  col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.92);

  col = applyFog(col, wp);
  float alpha = max(smoothstep(-0.02, 0.06, depthV), fallK);
#ifdef RIVER
  alpha *= smoothstep(0.0, 0.035, vRuv.y) * smoothstep(1.0, 0.975, vRuv.y);
#endif
  fragColor = vec4(col, alpha);
}
`;

export class Water {
  constructor(scene, world, quality = 2) {
    this.normalTex = makeWaterNormals(256);
    this.uSSR = { value: quality >= 1 ? 1 : 0 };
    const baseU = () => ({
      ...shared(...U_LIGHT, ...U_SHADOW, ...U_WORLD, ...U_SKY, 'uWind', 'uCamPos', 'uSceneColor', 'uSceneDepth', 'uResolution', 'uCamNearFar'),
      uWaterN: { value: this.normalTex },
      uSSR: this.uSSR,
    });
    const mk = (defines, extra = {}) => new THREE.ShaderMaterial({
      uniforms: { ...baseU(), ...extra }, defines, vertexShader: VERT, fragmentShader: FRAG, glslVersion: THREE.GLSL3,
      transparent: true, depthWrite: true, depthTest: true,
    });
    this.group = new THREE.Group();

    // ocean clipmap
    const M = 96;
    this.M = M; this.levels = 7; this.baseCell = 2;
    const full = buildGrid(M, 0), ring = buildGrid(M, M / 4 - 3);
    this.ocean = [];
    for (let l = 0; l < this.levels; l++) {
      const uLevel = { value: new THREE.Vector3(this.baseCell * (1 << l), 0, 0) };
      const mesh = new THREE.Mesh(l === 0 ? full : ring, mk({ OCEAN: 1 }, { uLevel, uGridHalf: { value: M / 2 } }));
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
      mesh.userData.uLevel = uLevel;
      mesh.renderOrder = 10;
      mesh.layers.set(LAYER_TRANS);
      this.ocean.push(mesh); this.group.add(mesh);
    }

    // lakes
    const lakeMat = mk({});
    for (const L of LAKES) {
      const r = L.r * (1 + L.wobble) + 22;
      const g = new THREE.CircleGeometry(r, 48);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, lakeMat);
      m.position.set(L.x, L.level, L.z);
      m.updateMatrix(); m.matrixAutoUpdate = false;
      m.renderOrder = 11;
      m.layers.set(LAYER_TRANS);
      this.group.add(m);
    }

    // rivers
    const riverMat = mk({ RIVER: 1 });
    riverMat.side = THREE.DoubleSide;      // ribbons are wound facing down; falls are also seen from below
    for (const R of world.rivers) {
      const s = R.samples, n = s.length;
      const halfW = R.width / 2 + 9;
      const ACROSS = 5;
      const pos = new Float32Array(n * ACROSS * 3), flow = new Float32Array(n * ACROSS * 3), ruv = new Float32Array(n * ACROSS * 2);
      const idx = [];
      let len = 0;
      for (let i = 0; i < n; i++) {
        const a = s[Math.max(i - 1, 0)], b = s[Math.min(i + 1, n - 1)];
        let tx = b[0] - a[0], tz = b[1] - a[1];
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const drop = Math.min(3, Math.max(0, (a[2] - b[2]) / tl));      // slope of the water surface
        const st = Math.min(1, Math.max(0, (drop - 0.7) / 0.5));
        const steep = st * st * (3 - 2 * st);                           // 1 on true waterfalls only
        if (i > 0) len += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]);
        // waterfalls: narrow the sheet to the channel and lift it clear of the carved cliff
        const hwi = halfW * (1 - steep) + (R.width / 2 + 0.8) * steep;
        for (let k = 0; k < ACROSS; k++) {
          const u = k / (ACROSS - 1) * 2 - 1;
          const o = (i * ACROSS + k);
          // (the heightfield cannot hold a near-vertical face, so the sheet is pushed downstream in front of it)
          const push = steep * 3.2;
          pos[o * 3] = s[i][0] - tz * u * hwi + tx * push; pos[o * 3 + 1] = s[i][2] - 0.03 + steep * 1.2 * (1 - u * u * 0.5); pos[o * 3 + 2] = s[i][1] + tx * u * hwi + tz * push;
          flow[o * 3] = tx; flow[o * 3 + 1] = tz; flow[o * 3 + 2] = drop;
          ruv[o * 2] = u; ruv[o * 2 + 1] = i / (n - 1);
        }
        if (i < n - 1) for (let k = 0; k < ACROSS - 1; k++) {
          const p = i * ACROSS + k, q = p + ACROSS;
          idx.push(p, q, p + 1, p + 1, q, q + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 3));
      g.setAttribute('aRuv', new THREE.BufferAttribute(ruv, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, riverMat);
      m.matrixAutoUpdate = false;
      m.renderOrder = 12;
      m.layers.set(LAYER_TRANS);
      this.group.add(m);
    }
    scene.add(this.group);
  }

  update(camPos) {
    for (let l = 0; l < this.levels; l++) {
      const cs = this.baseCell * (1 << l), snap = cs * 2;
      const u = this.ocean[l].userData.uLevel.value;
      u.y = Math.floor(camPos.x / snap) * snap;
      u.z = Math.floor(camPos.z / snap) * snap;
    }
  }
}

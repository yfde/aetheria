// Terrain: geometry-clipmap rings displaced by the height texture in the vertex shader,
// with a painterly procedural surface shader.
import * as THREE from 'three';
import { shared, U_LIGHT, U_SHADOW, U_WORLD } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_WORLD, GLSL_SHADOW, GLSL_FOG, GLSL_LIGHT, GLSL_WIND } from '../shaders/common.js';

export function buildGrid(M, hole) {
  // (M+1)^2 vertices at integer coords [-M/2, M/2]; optional square hole of half-size `hole` cells
  const half = M / 2;
  const pos = new Float32Array((M + 1) * (M + 1) * 3);
  let p = 0;
  for (let j = 0; j <= M; j++) for (let i = 0; i <= M; i++) { pos[p++] = i - half; pos[p++] = 0; pos[p++] = j - half; }
  const idx = [];
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const cx = i - half + 0.5, cz = j - half + 0.5;
    if (hole > 0 && Math.max(Math.abs(cx), Math.abs(cz)) < hole) continue;
    const a = j * (M + 1) + i, b = a + 1, c = a + (M + 1), d = c + 1;
    // alternate diagonals for nicer silhouettes
    if ((i + j) & 1) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

const VERT = /* glsl */`
uniform vec3 uLevel;     // x: cell size, yz: snapped origin
uniform float uGridHalf;
uniform vec3 uCamPos;    // main camera (also valid during shadow passes)
${GLSL_WORLD}
out vec3 vWorldPos;
void main() {
  float cs = uLevel.x;
  vec2 wxz = uLevel.yz + position.xz * cs;
  vec2 dc = abs(wxz - uCamPos.xz);
  float d = max(dc.x, dc.y);
  float R = uGridHalf * cs;
  float k = smoothstep(R * 0.60, R * 0.84, d);
  vec2 odd = mod(position.xz, 2.0);
  wxz -= odd * cs * k;
  float h = terrainHeight(wxz);
  vWorldPos = vec3(wxz.x, h, wxz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
}
`;

const FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_WORLD}
${GLSL_WIND}
${GLSL_SHADOW}
${GLSL_FOG}
${GLSL_LIGHT}
uniform float uGrassFar;
in vec3 vWorldPos;
out vec4 fragColor;

void main() {
  vec3 wp = vWorldPos;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 uv = worldUV(wp.xz);

  vec4 nt = texture(uNormalTex, uv);
  vec2 nxz = nt.rg * 2.0 - 1.0;
  vec3 N = normalize(vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.0)), nxz.y));
  float cav = nt.b;
  vec4 mask = texture(uMaskTex, uv);
  vec4 biome = biomeTint(wp.xz);
  float wl = texture(uWaterTex, uv).r;
  float h = wp.y;

  // noise at several scales
  vec4 nA = texture(uNoiseTex, wp.xz * 0.0045);
  vec4 nB = texture(uNoiseTex, wp.xz * 0.031);
  vec4 nC = texture(uNoiseTex, wp.xz * 0.21);
  // triplanar-ish coordinates for steep faces
  vec3 an = abs(N);
  vec2 tuv = an.x > an.z ? vec2(wp.z, wp.y) : vec2(wp.x, wp.y);
  vec4 nR = texture(uNoiseTex, tuv * vec2(0.045, 0.07));
  vec4 nR2 = texture(uNoiseTex, tuv * vec2(0.19, 0.31) + 0.37);

  float slope = N.y;
  float fade = smoothstep(60.0, 500.0, dist);           // drop fine detail with distance

  // ---- rock: layered, sun-bleached stone with soft strata lines and vertical weathering ----
  float warpS = nA.g * 2.2 + nR.r * 0.9;
  float sy = h * 0.21 + warpS;
  float band = fract(sy);
  float bandId = hash11(floor(sy));
  float joint = smoothstep(0.0, 0.07, band) * smoothstep(1.0, 0.9, band);          // thin dark seams between layers
  vec3 rockLow = mix(vec3(0.30, 0.262, 0.215), vec3(0.385, 0.345, 0.29), nA.r);         // warm lowland stone
  vec3 rockHigh = mix(vec3(0.235, 0.25, 0.29), vec3(0.33, 0.34, 0.37), nA.r);           // cool mountain stone
  vec3 rock = mix(rockLow, rockHigh, smoothstep(70.0, 260.0, h + nA.g * 60.0));
  rock *= mix(1.0, 0.88 + 0.24 * bandId, 1.0 - fade * 0.6);
  rock *= mix(1.0, mix(0.7, 1.0, joint), 1.0 - fade);
  // stacked blocks: vertical joints offset per layer
  float bx = tuv.x * 0.2 + bandId * 17.0 + nR.g * 0.5;
  float blockId = hash11(floor(bx) + floor(sy) * 31.0);
  float vjoint = smoothstep(0.0, 0.04, fract(bx)) * smoothstep(1.0, 0.96, fract(bx));
  rock *= mix(1.0, (0.86 + 0.28 * blockId) * mix(0.76, 1.0, vjoint), 1.0 - fade);
  float streak = texture(uNoiseTex, tuv * vec2(0.35, 0.025)).r;                        // vertical water stains
  rock *= mix(1.0, 0.82 + 0.3 * streak, 1.0 - fade * 0.5);
  rock *= 0.93 + 0.14 * nR2.g * (1.0 - fade);

  // ---- soil / sand / snow ----
  vec3 dirt = vec3(0.235, 0.17, 0.105) * (0.85 + 0.3 * nC.r) * (0.9 + 0.25 * nB.g);
  vec3 pathCol = vec3(0.42, 0.33, 0.215) * (0.86 + 0.28 * nC.g) * (0.92 + 0.16 * nB.r);
  vec3 sand = vec3(0.70, 0.60, 0.40) * (0.92 + 0.14 * nB.r) + (nC.a - 0.5) * 0.03 * (1.0 - fade);
  vec3 snow = vec3(0.80, 0.86, 0.95);

  // ---- grass ground ----
  // painterly variation: broad warm/cool drift + mid-scale brush strokes
  vec3 tip = biome.rgb;
  tip *= mix(vec3(0.82, 0.92, 0.9), vec3(1.16, 1.06, 0.86), nA.r);
  tip *= 0.86 + 0.3 * nB.r;
  tip = mix(tip, tip * vec3(1.25, 1.12, 0.7), smoothstep(0.55, 0.85, nB.g) * 0.35);
  vec3 grassRoot = tip * vec3(0.30, 0.42, 0.30);
  float nearMix = smoothstep(uGrassFar * 0.4, uGrassFar, dist);
  float gust = windGust(wp.xz);
  vec3 grassCol = mix(grassRoot, tip * (0.88 + 0.26 * gust), nearMix);
  // flower speckles in the distance
  float fl = mask.a * nearMix * smoothstep(0.6, 0.9, nC.b) * (1.0 - smoothstep(250.0, 700.0, dist));
  grassCol = mix(grassCol, mix(vec3(0.75, 0.66, 0.30), vec3(0.72, 0.45, 0.55), step(0.5, nB.g)), fl * 0.55);

  // ---- weights ----
  float edgeN = (nC.r - 0.5) * 0.35 * (1.0 - fade) + (nB.g - 0.5) * 0.25;
  float rockW = smoothstep(0.80, 0.69, slope + edgeN * 0.22);
  float seaBeach = (1.0 - smoothstep(2.5, 6.0, h + nB.r * 2.0)) * (1.0 - smoothstep(0.2, 1.0, wl));
  float shoreW = 1.0 - smoothstep(wl + 0.5, wl + 2.2, h + nB.r * 1.2);
  float sandW = max(seaBeach, shoreW * 0.85);
  float snowLine = 300.0 + (nA.r - 0.5) * 110.0 + (nB.r - 0.5) * 30.0;
  float snowW = smoothstep(snowLine - 14.0, snowLine + 26.0, h) * smoothstep(0.50, 0.70, slope + edgeN * 0.3);
  float grassW = smoothstep(0.28, 0.6, mask.r + edgeN);
  float pathW = smoothstep(0.3, 0.7, mask.g + edgeN * 0.8);

  vec3 col = dirt;
  col = mix(col, sand, sandW);
  col = mix(col, grassCol, grassW * (1.0 - sandW * 0.6));
  col = mix(col, rock, rockW);
  col = mix(col, pathCol, pathW * (1.0 - rockW));
  col = mix(col, snow, snowW);
  col *= mix(1.0, 0.7, uWet * (1.0 - snowW));            // rain darkens the ground

  // broad bevelled planes on rock: perturb the normal with two scales of smooth noise + strata ledges
  vec3 Nd = N;
  if (rockW > 0.01 && fade < 0.99) {
    vec2 g = (nR.rg - 0.5) * 1.5 + (nR2.rg - 0.5) * 0.7;
    vec3 t1 = normalize(cross(N, vec3(0.0, 0.0, 1.0)));
    vec3 t2 = cross(N, t1);
    float ledge = (smoothstep(0.0, 0.12, band) - smoothstep(0.85, 1.0, band)) * 0.0 + (0.5 - band) * 0.5;
    Nd = normalize(N + (t1 * g.x + t2 * g.y + vec3(0.0, ledge, 0.0)) * rockW * (1.0 - fade) * 0.8);
  }

  // ---- water interaction ----
  float depth = wl - h;
  float wetBand = smoothstep(0.9, 0.0, h - wl) * step(h, wl + 0.9);
  col *= mix(1.0, 0.62, wetBand * (1.0 - snowW));
  float under = smoothstep(0.0, 0.25, depth);

  // ---- lighting ----
  float shadow = getShadow(wp, N) * cloudShadow(wp);
  float ndl = dot(Nd, uLightDir);
  float diffSoft = smoothstep(-0.2, 0.75, ndl);
  // rock: three painted tones
  float diffRock = smoothstep(-0.1, 0.2, ndl) * 0.6 + smoothstep(0.3, 0.6, ndl) * 0.4;
  float diff = mix(diffSoft, diffRock, rockW * (1.0 - snowW * 0.5));
  float canopy = mask.b * (1.0 - smoothstep(0.0, 0.4, rockW));
  float ao = mix(0.6, 1.0, smoothstep(0.2, 0.6, cav)) * (1.0 - canopy * 0.4);
  vec3 amb = ambientLight(Nd) * ao;
  amb += (uAmbSky * 0.28 + uAmbGround * 0.35) * rockW;                 // keep shaded cliffs readable
  vec3 light = uLightColor * diff * shadow * (1.0 - canopy * 0.3) + amb;
  vec3 c = col * light;

  // grass sheen toward the sun & snow sparkle
  float sheen = pow(1.0 - max(dot(N, V), 0.0), 4.0) * grassW * (1.0 - rockW) * nearMix;
  c += sheen * uLightColor * tip * 0.35 * shadow * (0.5 + gust);
  vec3 Hh = normalize(uLightDir + V);
  float spec = pow(max(dot(Nd, Hh), 0.0), 60.0);
  float sparkle = step(0.985, nC.a) * step(0.6, nR2.a);
  c += snowW * shadow * uLightColor * (spec * 0.3 + sparkle * spec * 5.0 * (1.0 - fade));
  c += wetBand * (1.0 - under) * spec * uLightColor * 0.5 * shadow;
  // snow picks up sky colour in shade
  c += snowW * uAmbSky * 0.12;
  // wet sheen
  c += uWet * (pow(1.0 - max(dot(N, V), 0.0), 4.0) * uAmbSky * 0.3 + spec * uLightColor * 0.2 * shadow) * (1.0 - snowW);

  // underwater: caustics + absorption (the water surface is drawn on top)
  if (depth > 0.0) {
    vec2 cu = wp.xz * 0.09;
    float c1 = texture(uNoiseTex, cu + uTime * vec2(0.02, 0.013)).b;
    float c2 = texture(uNoiseTex, cu * 1.37 - uTime * vec2(0.017, 0.022) + 0.5).b;
    float caust = pow(1.0 - abs(c1 - c2), 6.0) + pow(min(c1, c2), 3.0) * 0.5;
    float cfade = smoothstep(0.0, 0.6, depth) * exp(-depth * 0.22);
    c += col * uLightColor * caust * 0.55 * cfade * shadow * (1.0 - uNight);
    vec3 absorb = exp(-depth * vec3(0.42, 0.11, 0.07));
    c *= mix(vec3(1.0), absorb, under);
  }

  c = applyFog(c, wp);
  fragColor = vec4(c, 1.0);
}
`;

export class Terrain {
  constructor(scene, quality = 1) {
    const M = quality >= 2 ? 192 : quality >= 1 ? 128 : 96;
    this.M = M;
    this.levels = 6;
    this.baseCell = 2;
    const hole = M / 4 - 3;
    const full = buildGrid(M, 0), ring = buildGrid(M, hole);
    this.group = new THREE.Group();
    this.meshes = [];
    this.uGrassFar = { value: 110 };
    for (let l = 0; l < this.levels; l++) {
      const uLevel = { value: new THREE.Vector3(this.baseCell * (1 << l), 0, 0) };
      const uniforms = { ...shared(...U_LIGHT, ...U_SHADOW, ...U_WORLD, 'uWind', 'uCamPos'), uLevel, uGridHalf: { value: M / 2 }, uGrassFar: this.uGrassFar };
      const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, glslVersion: THREE.GLSL3 });
      const depthMat = new THREE.ShaderMaterial({
        uniforms: { ...shared(...U_WORLD, 'uCamPos'), uLevel, uGridHalf: { value: M / 2 } },
        vertexShader: VERT,
        fragmentShader: 'void main(){}',
        glslVersion: THREE.GLSL3, colorWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 2.0, polygonOffsetUnits: 4.0,
      });
      const mesh = new THREE.Mesh(l === 0 ? full : ring, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.shadowMat = depthMat;
      mesh.userData.uLevel = uLevel;
      mesh.renderOrder = -10 + l;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    scene.add(this.group);
  }

  update(camPos) {
    for (let l = 0; l < this.levels; l++) {
      const cs = this.baseCell * (1 << l);
      const snap = cs * 2;
      const u = this.meshes[l].userData.uLevel.value;
      u.y = Math.floor(camPos.x / snap) * snap;
      u.z = Math.floor(camPos.z / snap) * snap;
    }
  }
}

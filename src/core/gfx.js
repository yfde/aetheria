// Rendering pipeline: shadow atlas -> opaque HDR (MSAA) -> water/transparent stage -> post (god rays, bloom, grade, FXAA).
import * as THREE from 'three';
import { G, shared, U_LIGHT, U_SHADOW } from './globals.js';
import { CSM } from './csm.js';
import { FS_VERT, GLSL_MATH, GLSL_UNIFORMS, GLSL_SHADOW } from '../shaders/common.js';

export const LAYER_OPAQUE = 0, LAYER_TRANS = 1, LAYER_SHADOW = 2;

function fsTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
}

class FSPass {
  constructor(frag, uniforms, opts = {}) {
    this.mat = new THREE.ShaderMaterial({ uniforms, vertexShader: FS_VERT, fragmentShader: frag, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, ...opts });
    this.mesh = new THREE.Mesh(FSPass.geo || (FSPass.geo = fsTriangle()), this.mat);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.u = this.mat.uniforms;
  }
  render(renderer, target) {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, FSPass.cam || (FSPass.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)));
  }
}

const COPY_DEPTH_FRAG = /* glsl */`
uniform sampler2D tColor; uniform sampler2D tDepth;
in vec2 vUv; out vec4 fragColor;
void main() { fragColor = texture(tColor, vUv); gl_FragDepth = texture(tDepth, vUv).r; }
`;

const BLOOM_PRE_FRAG = /* glsl */`
uniform sampler2D tColor; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;
in vec2 vUv; out vec4 fragColor;
vec3 pre(vec3 c) {
  c = min(c, vec3(40.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * w;
}
void main() {
  // 4-tap box with Karis-style weighting against fireflies
  vec3 a = pre(texture(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
  vec3 b = pre(texture(tColor, vUv + uTexel * vec2( 1.0, -1.0)).rgb);
  vec3 c = pre(texture(tColor, vUv + uTexel * vec2(-1.0,  1.0)).rgb);
  vec3 d = pre(texture(tColor, vUv + uTexel * vec2( 1.0,  1.0)).rgb);
  float wa = 1.0 / (1.0 + max(a.r, max(a.g, a.b))), wb = 1.0 / (1.0 + max(b.r, max(b.g, b.b)));
  float wc = 1.0 / (1.0 + max(c.r, max(c.g, c.b))), wd = 1.0 / (1.0 + max(d.r, max(d.g, d.b)));
  fragColor = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
uniform sampler2D tColor; uniform vec2 uTexel;
in vec2 vUv; out vec4 fragColor;
void main() {
  // 13-tap downsample (Jimenez)
  vec3 A = texture(tColor, vUv + uTexel * vec2(-2.0, -2.0)).rgb, B = texture(tColor, vUv + uTexel * vec2(0.0, -2.0)).rgb, C = texture(tColor, vUv + uTexel * vec2(2.0, -2.0)).rgb;
  vec3 D = texture(tColor, vUv + uTexel * vec2(-2.0, 0.0)).rgb, E = texture(tColor, vUv).rgb, F = texture(tColor, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  vec3 Gg = texture(tColor, vUv + uTexel * vec2(-2.0, 2.0)).rgb, H = texture(tColor, vUv + uTexel * vec2(0.0, 2.0)).rgb, I = texture(tColor, vUv + uTexel * vec2(2.0, 2.0)).rgb;
  vec3 J = texture(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb, K = texture(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 L = texture(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb, M = texture(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  vec3 c = (J + K + L + M) * 0.125 + (A + C + Gg + I) * 0.03125 + (B + D + F + H) * 0.0625 + E * 0.125;
  fragColor = vec4(c, 1.0);
}
`;

const UP_FRAG = /* glsl */`
uniform sampler2D tColor; uniform sampler2D tAdd; uniform vec2 uTexel; uniform float uMix;
in vec2 vUv; out vec4 fragColor;
void main() {
  vec3 c = texture(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb * 1.0
         + texture(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c += (texture(tColor, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture(tColor, vUv + uTexel * vec2(0.0, 1.0)).rgb
      + texture(tColor, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture(tColor, vUv + uTexel * vec2(1.0, 0.0)).rgb) * 2.0;
  c += texture(tColor, vUv).rgb * 4.0;
  c /= 16.0;
  fragColor = vec4(mix(texture(tAdd, vUv).rgb, c, uMix), 1.0);
}
`;

const RAYS_FRAG = /* glsl */`
${GLSL_MATH}
uniform sampler2D tColor; uniform sampler2D tDepth;
uniform vec3 uSunScreen;     // xy: uv of the sun, z: strength
uniform vec3 uRayColor;
uniform float uAspect;
in vec2 vUv; out vec4 fragColor;
void main() {
  if (uSunScreen.z <= 0.001) { fragColor = vec4(0.0); return; }
  const int N = 36;
  vec2 delta = (uSunScreen.xy - vUv) / float(N) * 0.92;
  float jitter = ign(gl_FragCoord.xy);
  vec2 uv = vUv + delta * jitter;
  float acc = 0.0, wsum = 0.0, w = 1.0;
  for (int i = 0; i < N; i++) {
    float d = texture(tDepth, uv).r;
    vec2 q = (uv - uSunScreen.xy) * vec2(uAspect, 1.0);
    float near = exp(-dot(q, q) * 5.0);
    float sky = step(0.99999, d);
    vec3 c = texture(tColor, uv).rgb;
    float lum = min(max(c.r, max(c.g, c.b)), 6.0);
    acc += sky * (0.07 + lum * 0.22) * near * w;
    wsum += w;
    w *= 0.972;
    uv += delta;
  }
  float r = acc / wsum;
  fragColor = vec4(uRayColor * r * uSunScreen.z, 1.0);
}
`;

// Volumetric light: march the view ray through the shadow cascades, so sunlight forms shafts between
// trees, columns and clouds wherever something blocks it.
const VOL_FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_SHADOW}
uniform sampler2D tDepth;
uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform vec3 uEye; uniform float uStrength;
in vec2 vUv; out vec4 fragColor;
void main() {
  if (uStrength <= 0.001) { fragColor = vec4(0.0); return; }
  float d = texture(tDepth, vUv).r;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 wp = (uCamWorld * vec4(vp.xyz / vp.w, 1.0)).xyz;
  vec3 rd = wp - uEye;
  float dist = length(rd); rd /= max(dist, 1e-4);
  float maxD = min(dist, 110.0);
  const int N = 16;
  float dt = maxD / float(N);
  float t = dt * ign(gl_FragCoord.xy);
  float acc = 0.0;
  for (int i = 0; i < N; i++) {
    vec3 p = uEye + rd * t;
    float lit = shadowTap1(shadowCascade(t), p);
    if ((i & 3) == 0) lit *= cloudShadow(p);
    acc += lit * exp(-max(p.y - uEye.y, 0.0) * 0.02);
    t += dt;
  }
  acc = acc / float(N) * (maxD / 110.0);
  float sd = max(dot(rd, uSunDir), 0.0);
  float phase = 0.35 + 1.25 * pow(sd, 6.0);
  fragColor = vec4(uFogSunColor * acc * phase * uStrength, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */`
${GLSL_MATH}
uniform sampler2D tColor; uniform sampler2D tBloom; uniform sampler2D tRays;
uniform float uExposure; uniform float uBloom; uniform float uTime; uniform float uVignette; uniform float uSaturation;
uniform vec3 uTint; uniform float uFade; uniform float uUnderwater;
uniform sampler2D tVol; uniform vec2 uVolTexel;
uniform sampler2D tDepth; uniform sampler2D tBlurA; uniform sampler2D tBlurB;
uniform vec3 uDof;          // x: strength, y: focus distance (m)
uniform vec2 uNearFar;
in vec2 vUv; out vec4 fragColor;

// Uchimura (Gran Turismo) tone curve: keeps mid-tones linear -> saturated, anime-friendly
vec3 uchimura(vec3 x) {
  const float P = 1.0, a = 1.0, m = 0.22, l = 0.4, c = 1.33, b = 0.0;
  float l0 = ((P - m) * l) / a;
  float S0 = m + l0, S1 = m + a * l0;
  float C2 = (a * P) / (P - S1);
  float CP = -C2 / P;
  vec3 w0 = 1.0 - smoothstep(0.0, m, x);
  vec3 w2 = step(m + l0, x);
  vec3 w1 = 1.0 - w0 - w2;
  vec3 T = m * pow(x / m, vec3(c)) + b;
  vec3 S = P - (P - S1) * exp(CP * (x - S0));
  vec3 L = m + a * (x - m);
  return T * w0 + L * w1 + S * w2;
}

void main() {
  vec2 uv = vUv;
  vec3 col = texture(tColor, uv).rgb;
  if (uDof.x > 0.01) {
    // depth of field for close-ups: blur what is well behind (or right in front of) the focus plane
    float dz = texture(tDepth, uv).r;
    float n = uNearFar.x, f = uNearFar.y;
    float z = 2.0 * n * f / (f + n - (dz * 2.0 - 1.0) * (f - n));
    float coc = max(smoothstep(uDof.y * 1.35, uDof.y * 4.5, z), 1.0 - smoothstep(uDof.y * 0.25, uDof.y * 0.6, z)) * uDof.x;
    vec3 soft = mix(texture(tBlurA, uv).rgb, texture(tBlurB, uv).rgb, smoothstep(0.35, 1.0, coc));
    col = mix(col, soft, smoothstep(0.0, 0.4, coc));
  }
  vec3 bloom = texture(tBloom, uv).rgb;
  col = mix(col, bloom, uBloom);
  col += texture(tRays, uv).rgb;
  col += (texture(tVol, uv + uVolTexel * vec2(0.5, 0.5)).rgb + texture(tVol, uv + uVolTexel * vec2(-0.5, 0.5)).rgb
        + texture(tVol, uv + uVolTexel * vec2(0.5, -0.5)).rgb + texture(tVol, uv + uVolTexel * vec2(-0.5, -0.5)).rgb) * 0.25;
  col *= uExposure;
  col = uchimura(col);
  // grade
  float l = luma(col);
  col = mix(vec3(l), col, uSaturation);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);          // gentle S-curve
  col *= uTint;
  // vignette
  vec2 q = uv - 0.5;
  float v = 1.0 - dot(q, q) * uVignette;
  col *= mix(1.0, v * v, 0.9);
  col = mix(col, vec3(0.0), uFade);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) / 255.0;
  fragColor = vec4(col, luma(col));
}
`;

const FXAA_FRAG = /* glsl */`
uniform sampler2D tColor; uniform vec2 uTexel; uniform float uSharpen;
in vec2 vUv; out vec4 fragColor;
// FXAA 3.11 (quality-ish, luma in alpha)
void main() {
  vec2 p = vUv;
  vec4 M = texture(tColor, p);
  float lM = M.a;
  float lN = textureOffset(tColor, p, ivec2(0, 1)).a, lS = textureOffset(tColor, p, ivec2(0, -1)).a;
  float lE = textureOffset(tColor, p, ivec2(1, 0)).a, lW = textureOffset(tColor, p, ivec2(-1, 0)).a;
  float lMax = max(lM, max(max(lN, lS), max(lE, lW))), lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float range = lMax - lMin;
  vec3 outc;
  if (range < max(0.0312, lMax * 0.125)) {
    outc = M.rgb;
  } else {
    float lNW = textureOffset(tColor, p, ivec2(-1, 1)).a, lNE = textureOffset(tColor, p, ivec2(1, 1)).a;
    float lSW = textureOffset(tColor, p, ivec2(-1, -1)).a, lSE = textureOffset(tColor, p, ivec2(1, -1)).a;
    float lNS = lN + lS, lWE = lW + lE;
    float subpix = (2.0 * (lNS + lWE) + lNW + lNE + lSW + lSE) / 12.0;
    subpix = clamp(abs(subpix - lM) / range, 0.0, 1.0);
    subpix = smoothstep(0.0, 1.0, subpix); subpix = subpix * subpix * 0.75;
    float edgeH = abs(lNW + lSW - 2.0 * lW) + 2.0 * abs(lNS - 2.0 * lM) + abs(lNE + lSE - 2.0 * lE);
    float edgeV = abs(lNW + lNE - 2.0 * lN) + 2.0 * abs(lWE - 2.0 * lM) + abs(lSW + lSE - 2.0 * lS);
    bool horz = edgeV >= edgeH;
    float l1 = horz ? lS : lW, l2 = horz ? lN : lE;
    float g1 = l1 - lM, g2 = l2 - lM;
    bool steep1 = abs(g1) >= abs(g2);
    float gScaled = 0.25 * max(abs(g1), abs(g2));
    float stepLen = horz ? uTexel.y : uTexel.x;
    float lAvg;
    if (steep1) { stepLen = -stepLen; lAvg = 0.5 * (l1 + lM); } else { lAvg = 0.5 * (l2 + lM); }
    vec2 uvE = p;
    if (horz) uvE.y += stepLen * 0.5; else uvE.x += stepLen * 0.5;
    vec2 off = horz ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
    vec2 uv1 = uvE - off, uv2 = uvE + off;
    float e1 = texture(tColor, uv1).a - lAvg, e2 = texture(tColor, uv2).a - lAvg;
    bool r1 = abs(e1) >= gScaled, r2 = abs(e2) >= gScaled;
    for (int i = 0; i < 9; i++) {
      if (r1 && r2) break;
      float q = i < 3 ? 1.5 : (i < 6 ? 2.0 : 4.0);
      if (!r1) { uv1 -= off * q; e1 = texture(tColor, uv1).a - lAvg; r1 = abs(e1) >= gScaled; }
      if (!r2) { uv2 += off * q; e2 = texture(tColor, uv2).a - lAvg; r2 = abs(e2) >= gScaled; }
    }
    float d1 = horz ? (p.x - uv1.x) : (p.y - uv1.y), d2 = horz ? (uv2.x - p.x) : (uv2.y - p.y);
    bool dir1 = d1 < d2;
    float dMin = min(d1, d2), span = d1 + d2;
    bool okVar = ((dir1 ? e1 : e2) < 0.0) != (lM < lAvg);
    float pixOff = okVar ? (-dMin / span + 0.5) : 0.0;
    float fin = max(pixOff, subpix);
    vec2 uvF = p;
    if (horz) uvF.y += fin * stepLen; else uvF.x += fin * stepLen;
    outc = texture(tColor, uvF).rgb;
  }
  // light contrast-adaptive sharpen
  if (uSharpen > 0.0) {
    vec3 n = textureOffset(tColor, p, ivec2(0, 1)).rgb + textureOffset(tColor, p, ivec2(0, -1)).rgb + textureOffset(tColor, p, ivec2(1, 0)).rgb + textureOffset(tColor, p, ivec2(-1, 0)).rgb;
    outc = clamp(outc + (outc - n * 0.25) * uSharpen, 0.0, 1.0);
  }
  fragColor = vec4(outc, 1.0);
}
`;

export class Gfx {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 1);
    this.gl = renderer.getContext();
    this.maxSamples = this.gl.getParameter(this.gl.MAX_SAMPLES) || 4;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 9000);
    this.casters = new Set();
    this.quality = { msaa: 4, shadowTile: 2048, bloom: true, rays: true, fxaa: true };
    this.csm = new CSM(this.quality.shadowTile);
    this.renderScale = 1;
    this.width = 2; this.height = 2;
    this.exposure = 1;
    this.fade = 0;
    this.stats = { calls: 0, tris: 0 };

    this.copyPass = new FSPass(COPY_DEPTH_FRAG, { tColor: { value: null }, tDepth: { value: null } }, { depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth });
    this.prePass = new FSPass(BLOOM_PRE_FRAG, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 }, uKnee: { value: 0.55 } });
    this.downPass = new FSPass(DOWN_FRAG, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upPass = new FSPass(UP_FRAG, { tColor: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.5 } });
    this.raysPass = new FSPass(RAYS_FRAG, { tColor: { value: null }, tDepth: { value: null }, uSunScreen: { value: new THREE.Vector3() }, uRayColor: { value: new THREE.Color(1, 0.9, 0.7) }, uAspect: { value: 1 } });
    this.volPass = new FSPass(VOL_FRAG, { ...shared(...U_LIGHT, ...U_SHADOW), tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uEye: { value: new THREE.Vector3() }, uStrength: { value: 0 } });
    this.dof = 0; this.dofFocus = 3;
    this.compPass = new FSPass(COMPOSITE_FRAG, {
      tVol: { value: null }, uVolTexel: { value: new THREE.Vector2() }, tDepth: { value: null }, tBlurA: { value: null }, tBlurB: { value: null }, uDof: { value: new THREE.Vector3() }, uNearFar: G.uCamNearFar,
      tColor: { value: null }, tBloom: { value: null }, tRays: { value: null }, uExposure: { value: 1 }, uBloom: { value: 0.11 }, uTime: G.uTime,
      uVignette: { value: 0.5 }, uSaturation: { value: 1.07 }, uTint: { value: new THREE.Color(1, 1, 1) }, uFade: { value: 0 }, uUnderwater: { value: 0 },
    });
    this.fxaaPass = new FSPass(FXAA_FRAG, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uSharpen: { value: 0.22 } });
    this.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.blackTex.needsUpdate = true;
    this._sun = new THREE.Vector3();
  }

  addCaster(mesh) { mesh.layers.enable(LAYER_SHADOW); this.casters.add(mesh); }
  removeCaster(mesh) { mesh.layers.disable(LAYER_SHADOW); this.casters.delete(mesh); }

  _disposeTargets() {
    for (const k of ['rtA', 'rtB', 'rtLDR', 'rtRays', 'rtVol', 'rtHalf', 'rtQuarter']) if (this[k]) { if (this[k].depthTexture) this[k].depthTexture.dispose(); this[k].dispose(); }
    if (this.bloomChain) for (const r of this.bloomChain) r.dispose();
    if (this.bloomUp) for (const r of this.bloomUp) r.dispose();
  }

  setSize(cssW, cssH, dpr) {
    const cw = Math.max(2, Math.round(cssW * dpr)), ch = Math.max(2, Math.round(cssH * dpr));
    this.canvasW = cw; this.canvasH = ch;
    this.renderer.setSize(cw, ch, false);
    const w = Math.max(2, Math.round(cw * this.renderScale)), h = Math.max(2, Math.round(ch * this.renderScale));
    if (w === this.width && h === this.height && this.rtA) return;
    this.width = w; this.height = h;
    this._disposeTargets();
    const samples = Math.min(this.quality.msaa, this.maxSamples);
    const mk = (opts) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...opts });
    const depthA = new THREE.DepthTexture(w, h, THREE.UnsignedIntType); depthA.minFilter = depthA.magFilter = THREE.NearestFilter;
    const depthB = new THREE.DepthTexture(w, h, THREE.UnsignedIntType); depthB.minFilter = depthB.magFilter = THREE.NearestFilter;
    this.rtA = mk({ samples, depthBuffer: true, depthTexture: depthA });
    this.rtB = mk({ depthBuffer: true, depthTexture: depthB });
    this.rtLDR = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    this.rtRays = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtVol = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtHalf = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtQuarter = new THREE.WebGLRenderTarget(Math.max(2, hw >> 1), Math.max(2, hh >> 1), { type: THREE.HalfFloatType, depthBuffer: false });
    this.bloomChain = []; this.bloomUp = [];
    let bw = hw, bh = hh;
    for (let i = 0; i < 6; i++) {
      this.bloomChain.push(new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false }));
      this.bloomUp.push(new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false }));
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
    }
    G.uResolution.value.set(w, h);
    G.uSceneColor.value = this.rtA.texture;
    G.uSceneDepth.value = this.rtA.depthTexture;
    this.camera.aspect = cw / ch;
    this.camera.updateProjectionMatrix();
    G.uCamNearFar.value.set(this.camera.near, this.camera.far);
    if (this.onResize) this.onResize(w, h);
  }

  render(sky) {
    const r = this.renderer, cam = this.camera, scene = this.scene;
    r.info.reset();
    scene.updateMatrixWorld();
    cam.updateMatrixWorld();
    G.uCamPos.value.copy(cam.position);

    // 1. shadows
    this.csm.update(cam, G.uLightDir.value);
    this.csm.render(r, scene, this.casters);

    // 2. clouds (low res)
    if (sky) sky.renderClouds(r, cam);

    // 3. opaque stage
    cam.layers.set(LAYER_OPAQUE);
    r.setRenderTarget(this.rtA);
    r.clear(true, true, false);
    r.render(scene, cam);

    // 4. water + transparents on top of a copy
    this.copyPass.u.tColor.value = this.rtA.texture;
    this.copyPass.u.tDepth.value = this.rtA.depthTexture;
    this.copyPass.render(r, this.rtB);
    cam.layers.set(LAYER_TRANS);
    r.render(scene, cam);
    cam.layers.set(LAYER_OPAQUE);

    // 5. god rays
    let raysTex = this.blackTex;
    if (this.quality.rays) {
      const s = this._sun.copy(G.uSunDir.value).multiplyScalar(5000).add(cam.position).project(cam);
      const camDir = cam.getWorldDirection(new THREE.Vector3());
      const facing = camDir.dot(G.uSunDir.value);
      const onScreen = Math.max(0, 1 - Math.max(0, Math.max(Math.abs(s.x), Math.abs(s.y)) - 1) * 1.4);
      const strength = facing > 0.05 ? Math.min(1, (facing - 0.05) * 3) * onScreen * (1 - G.uNight.value) : 0;
      this.raysPass.u.uSunScreen.value.set(s.x * 0.5 + 0.5, s.y * 0.5 + 0.5, strength * 0.7);
      this.raysPass.u.uAspect.value = cam.aspect;
      this.raysPass.u.uRayColor.value.copy(G.uFogSunColor.value);
      if (strength > 0.001) {
        this.raysPass.u.tColor.value = this.rtB.texture;
        this.raysPass.u.tDepth.value = this.rtB.depthTexture;
        this.raysPass.render(r, this.rtRays);
        raysTex = this.rtRays.texture;
      }
    }

    // 5b. volumetric light shafts (half resolution)
    let volTex = this.blackTex;
    if (this.quality.rays) {
      const sunUp = Math.max(0, 1 - G.uNight.value * 1.4) * G.uShadowParams.value.y;
      const low = 1 - Math.min(1, Math.max(0, G.uSunDir.value.y));
      const v = this.volPass.u;
      v.uStrength.value = sunUp * (0.03 + 0.17 * low * low * low) * (this.volScale === undefined ? 1 : this.volScale);
      if (v.uStrength.value > 0.002) {
        v.tDepth.value = this.rtB.depthTexture;
        v.uInvProj.value.copy(cam.projectionMatrixInverse); v.uCamWorld.value.copy(cam.matrixWorld); v.uEye.value.copy(cam.position);
        this.volPass.render(r, this.rtVol);
        volTex = this.rtVol.texture;
      }
    }
    // 5c. depth of field sources (only during close-ups)
    if (this.dof > 0.01) {
      this.downPass.u.tColor.value = this.rtB.texture; this.downPass.u.uTexel.value.set(1 / this.width, 1 / this.height);
      this.downPass.render(r, this.rtHalf);
      this.downPass.u.tColor.value = this.rtHalf.texture; this.downPass.u.uTexel.value.set(1 / this.rtHalf.width, 1 / this.rtHalf.height);
      this.downPass.render(r, this.rtQuarter);
    }

    // 6. bloom
    let bloomTex = this.blackTex;
    if (this.quality.bloom) {
      const ch = this.bloomChain, up = this.bloomUp;
      this.prePass.u.tColor.value = this.rtB.texture;
      this.prePass.u.uTexel.value.set(0.5 / ch[0].width, 0.5 / ch[0].height);
      this.prePass.render(r, ch[0]);
      for (let i = 1; i < ch.length; i++) {
        this.downPass.u.tColor.value = ch[i - 1].texture;
        this.downPass.u.uTexel.value.set(1 / ch[i - 1].width, 1 / ch[i - 1].height);
        this.downPass.render(r, ch[i]);
      }
      let src = ch[ch.length - 1].texture, sw = ch[ch.length - 1].width, sh = ch[ch.length - 1].height;
      for (let i = ch.length - 2; i >= 0; i--) {
        this.upPass.u.tColor.value = src;
        this.upPass.u.tAdd.value = ch[i].texture;
        this.upPass.u.uTexel.value.set(1 / sw, 1 / sh);
        this.upPass.u.uMix.value = 0.58;
        this.upPass.render(r, up[i]);
        src = up[i].texture; sw = up[i].width; sh = up[i].height;
      }
      bloomTex = src;
    }

    // 7. composite + tonemap, then FXAA to screen
    const c = this.compPass.u;
    c.tColor.value = this.rtB.texture; c.tBloom.value = bloomTex; c.tRays.value = raysTex;
    c.tVol.value = volTex; c.uVolTexel.value.set(1 / this.rtVol.width, 1 / this.rtVol.height);
    c.tDepth.value = this.rtB.depthTexture; c.tBlurA.value = this.rtHalf.texture; c.tBlurB.value = this.rtQuarter.texture;
    c.uDof.value.set(this.dof, this.dofFocus, 0);
    c.uExposure.value = this.exposure * (sky ? sky.exposure : 1);
    c.uFade.value = this.fade;
    this.compPass.render(r, this.rtLDR);
    this.fxaaPass.u.tColor.value = this.rtLDR.texture;
    this.fxaaPass.u.uTexel.value.set(1 / this.width, 1 / this.height);
    r.setRenderTarget(null);
    r.setViewport(0, 0, this.canvasW, this.canvasH);
    this.fxaaPass.render(r, null);

    this.stats.calls = r.info.render.calls;
    this.stats.tris = r.info.render.triangles;
  }
}

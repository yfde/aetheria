// Character assets: glTF loading, cel-shaded skinned material with inverted-hull outlines.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { shared, U_LIGHT, U_SHADOW } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_SHADOW, GLSL_FOG, GLSL_LIGHT } from '../shaders/common.js';

const loader = new GLTFLoader();
const cache = new Map();

export function loadModel(url) {
  if (!cache.has(url)) cache.set(url, new Promise((res, rej) => loader.load(url, res, undefined, rej)));
  return cache.get(url);
}

const TOON_VERT = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform vec2 uResolution;
uniform float uOutlineW;
#ifdef OUTLINE
in vec3 aSmoothN;
#endif
out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
void main() {
  #include <morphinstance_vertex>
  vec3 objectNormal = normal;
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  vec3 transformed = position;
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * objectNormal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
#ifdef OUTLINE
  vec3 sn = aSmoothN;
  #ifdef USE_SKINNING
    sn = (skinMatrix * vec4(sn, 0.0)).xyz;
  #endif
  vec3 nv = normalize(mat3(viewMatrix) * mat3(modelMatrix) * sn);
  vec2 dir = normalize(nv.xy + 1e-5);
  float w = uOutlineW * min(1.0, 14.0 / max(gl_Position.w, 0.001));
  gl_Position.xy += dir * w * gl_Position.w * 2.0 / uResolution.y;
  gl_Position.z += 0.0004 * gl_Position.w;
#endif
}
`;

const TOON_FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_SHADOW}
${GLSL_FOG}
${GLSL_LIGHT}
uniform sampler2D uMap;
uniform vec3 uTint;
uniform vec3 uFlash;      // rgb added (hit flash)
uniform float uDissolve;  // 0 solid .. 1 gone
uniform float uUseMap;
uniform vec3 uEmissive;
uniform float uAlphaTest;   // > 0: cut-out
uniform vec3 uShadeTint;    // colour multiplier of the shaded side (skin keeps warm shadows)
uniform float uFlat;        // 0 normal cel shading .. 1 nearly flat (anime faces)
uniform float uUnlit;       // 1 = ignore shading (eyes)
uniform float uGain;        // brightness calibration for textures authored for unlit display
uniform float uRim;
uniform vec3 uRimGlow;     // emissive fresnel (shade enemies)
uniform float uRecolor;    // 1 = turn cyan circuit lines into gold embroidery
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
out vec4 fragColor;
void main() {
  if (uDissolve > 0.0) {
    float n = ign(gl_FragCoord.xy) * 0.6 + hash12(floor(vWorldPos.xy * 14.0) + floor(vWorldPos.z * 14.0)) * 0.4;
    if (n < uDissolve) discard;
  }
  vec3 albedo = uTint;
  float alpha = 1.0;
  if (uUseMap > 0.5) { vec4 tx = texture(uMap, vUv); albedo *= tx.rgb; alpha = tx.a; }
  if (uRecolor > 0.5) {
    float cy = clamp((min(albedo.g, albedo.b) - albedo.r) * 3.0, 0.0, 1.0);
    float vv = max(albedo.g, albedo.b);
    albedo = mix(albedo, vec3(1.0, 0.70, 0.26) * (0.22 + 0.95 * vv), cy * smoothstep(0.22, 0.55, vv));
  }
  if (uAlphaTest > 0.0) {
    alpha = clamp((alpha - uAlphaTest) / max(fwidth(alpha), 1e-3) + 0.5, 0.0, 1.0);
    if (alpha < 0.08) discard;
  } else alpha = 1.0;
#ifdef OUTLINE
  vec3 col = albedo * 0.16 * uGain * (ambientLight(vec3(0.0, 1.0, 0.0)) + uLightColor * 0.35);
  col = applyFog(col, vWorldPos);
  fragColor = vec4(col, alpha);
#else
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float shadow = getShadow(vWorldPos, N) * cloudShadow(vWorldPos);
  float ndl = dot(N, uLightDir);
  float lit = smoothstep(0.02 - uFlat * 0.45, 0.12 + uFlat * 0.25, ndl + uFlat * 0.3) * mix(shadow, 0.45 + 0.55 * shadow, uFlat * 0.6);
  lit = max(lit, uUnlit);
  // two-tone cel shading with a cool, saturated shade colour
  vec3 amb = ambientLight(mix(N, vec3(0.0, 1.0, 0.0), uFlat));
  vec3 shade = albedo * uShadeTint * (amb * 1.15 + uLightColor * 0.10);
  vec3 lightC = albedo * (uLightColor * 0.92 + amb * 0.75);
  vec3 col = mix(shade, lightC, lit) * uGain;
  // rim light, stronger on the lit side
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += (uLightColor * 0.35 + uAmbSky * 0.35) * smoothstep(0.55, 0.8, fres) * (0.25 + 0.75 * lit) * 0.55 * uRim;
  // soft specular pop
  vec3 H = normalize(uLightDir + V);
  col += uLightColor * smoothstep(0.93, 0.97, dot(N, H)) * 0.12 * lit * uRim;
  float rg = 1.0 - max(dot(N, V), 0.0);
  rg *= rg;
  // shades: near-black body, a thin burning rim and faint veins of light crawling upward
  float vein = smoothstep(0.93, 1.0, sin(vWorldPos.y * 14.0 - uTime * 2.2 + sin(vWorldPos.x * 9.0 + vWorldPos.z * 7.0) * 2.0));
  col += uEmissive + uFlash + uRimGlow * (smoothstep(0.34, 0.96, rg) * 1.7 + 0.01 + vein * 0.22);
  col = applyFog(col, vWorldPos);
  fragColor = vec4(col, alpha);
#endif
}
`;

const DEPTH_VERT = /* glsl */`
#include <common>
#include <skinning_pars_vertex>
void main() {
  #include <skinbase_vertex>
  vec3 transformed = position;
  #include <skinning_vertex>
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(transformed, 1.0);
}
`;

let depthMat = null;
export function characterDepthMaterial() {
  if (!depthMat) depthMat = new THREE.ShaderMaterial({ vertexShader: DEPTH_VERT, fragmentShader: 'void main(){}', glslVersion: THREE.GLSL3, colorWrite: false, side: THREE.DoubleSide });
  return depthMat;
}

// A set of materials sharing per-character uniforms (flash, dissolve, tint)
export function makeToonMaterials(map, opts = {}) {
  const sh = opts.shared || {};      // uniform holders shared by all materials of one character
  const uniforms = {
    ...shared(...U_LIGHT, ...U_SHADOW, 'uResolution'),
    uMap: { value: map || null },
    uUseMap: { value: map ? 1 : 0 },
    uTint: { value: opts.tint && opts.tint.isColor ? opts.tint.clone() : new THREE.Color(opts.tint !== undefined ? opts.tint : 0xffffff) },
    uFlash: sh.uFlash || { value: new THREE.Color(0, 0, 0) },
    uEmissive: sh.uEmissive || { value: new THREE.Color(0, 0, 0) },
    uDissolve: sh.uDissolve || { value: 0 },
    uOutlineW: { value: opts.outline !== undefined ? opts.outline : 1.7 },
    uAlphaTest: { value: opts.alphaTest || 0 },
    uShadeTint: { value: opts.shadeTint ? opts.shadeTint.clone() : new THREE.Color(1, 1, 1) },
    uFlat: { value: opts.flat || 0 },
    uUnlit: { value: opts.unlit || 0 },
    uGain: { value: opts.gain !== undefined ? opts.gain : 1 },
    uRim: { value: opts.rim !== undefined ? opts.rim : 1 },
    uRimGlow: { value: opts.rimGlow ? opts.rimGlow.clone() : new THREE.Color(0, 0, 0) },
    uRecolor: { value: opts.recolor ? 1 : 0 },
  };
  const main = new THREE.ShaderMaterial({ uniforms, vertexShader: TOON_VERT, fragmentShader: TOON_FRAG, glslVersion: THREE.GLSL3, side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide, alphaToCoverage: !!opts.alphaTest });
  const outline = new THREE.ShaderMaterial({ uniforms, vertexShader: TOON_VERT, fragmentShader: TOON_FRAG, glslVersion: THREE.GLSL3, side: THREE.BackSide, defines: { OUTLINE: 1 } });
  return { main, outline, uniforms };
}

// average normals of coincident vertices so the outline hull stays closed on hard edges
export function addSmoothNormals(geo) {
  if (geo.attributes.aSmoothN) return;
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  const map = new Map();
  const key = (i) => `${Math.round(pos.getX(i) * 2000)},${Math.round(pos.getY(i) * 2000)},${Math.round(pos.getZ(i) * 2000)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    let a = map.get(k);
    if (!a) { a = [0, 0, 0]; map.set(k, a); }
    a[0] += nrm.getX(i); a[1] += nrm.getY(i); a[2] += nrm.getZ(i);
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const a = map.get(key(i));
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l;
  }
  geo.setAttribute('aSmoothN', new THREE.BufferAttribute(out, 3));
}

// Build a playable/animated character instance from a loaded glTF.
// opts: { hide: [names], show: [names] (accessories), tint, scale, outline: bool }
export function createCharacter(gltf, gfx, opts = {}) {
  const root = SkeletonUtils.clone(gltf.scene);
  const group = new THREE.Group();
  group.add(root);
  const scale = opts.scale || 0.72;
  root.scale.setScalar(scale);

  let map = null;
  root.traverse((o) => { if (o.isMesh && o.material && o.material.map && !map) map = o.material.map; });
  const mats = makeToonMaterials(map, opts);
  const meshes = [], outlines = [], bones = {}, parts = {};
  const toOutline = [];
  root.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
    if (o.isMesh) {
      parts[o.name] = o;
      o.material = mats.main;
      o.userData.shadowMat = characterDepthMaterial();
      o.frustumCulled = false;
      meshes.push(o);
      toOutline.push(o);
    }
  });
  if (opts.show) {
    // accessory whitelist: hide every non-skinned mesh that is not listed
    for (const m of meshes) if (!m.isSkinnedMesh) m.visible = opts.show.includes(m.name);
  }
  if (opts.showMatch) for (const m of meshes) if (!m.isSkinnedMesh) m.visible = opts.showMatch.test(m.name);
  if (opts.hide) for (const n of opts.hide) if (parts[n]) parts[n].visible = false;
  if (opts.outline !== false) {
    for (const m of toOutline) {
      if (!m.visible) continue;
      addSmoothNormals(m.geometry);
      let ol;
      if (m.isSkinnedMesh) { ol = new THREE.SkinnedMesh(m.geometry, mats.outline); ol.bind(m.skeleton, m.bindMatrix); }
      else ol = new THREE.Mesh(m.geometry, mats.outline);
      ol.frustumCulled = false;
      ol.position.copy(m.position); ol.quaternion.copy(m.quaternion); ol.scale.copy(m.scale);
      m.parent.add(ol);
      outlines.push(ol);
    }
  }
  for (const m of meshes) if (m.visible) gfx.addCaster(m);

  const mixer = new THREE.AnimationMixer(root);
  const clips = {};
  for (const c of gltf.animations) clips[c.name] = c;

  return {
    group, root, mixer, clips, bones, parts, meshes, outlines, uniforms: mats.uniforms, scale,
    setPartVisible(name, v) {
      const p = parts[name]; if (!p || p.visible === v) return;
      p.visible = v;
      if (v) gfx.addCaster(p); else gfx.removeCaster(p);
    },
    dispose() {
      for (const m of meshes) gfx.removeCaster(m);
      mixer.stopAllAction();
      if (group.parent) group.parent.remove(group);
    },
  };
}

// Small helper around AnimationMixer: named actions with cross-fades.
export class Animator {
  constructor(char) {
    this.char = char;
    this.mixer = char.mixer;
    this.actions = {};
    this.current = null;
    this.currentName = '';
  }
  action(name) {
    if (!this.actions[name]) {
      const clip = this.char.clips[name];
      if (!clip) return null;
      this.actions[name] = this.mixer.clipAction(clip);
    }
    return this.actions[name];
  }
  // loop=true: looping; false: play once and hold the last frame
  play(name, { fade = 0.18, loop = true, speed = 1, restart = false, startAt = 0 } = {}) {
    if (this.currentName === name && !restart) { if (this.current) this.current.timeScale = speed; return this.current; }
    const a = this.action(name);
    if (!a) return null;
    a.enabled = true;
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = !loop;
    a.timeScale = speed;
    a.reset();
    if (startAt > 0) a.time = startAt;
    if (this.current && this.current !== a) a.crossFadeFrom(this.current, fade, false);
    else a.fadeIn(fade);
    a.play();
    this.current = a; this.currentName = name;
    return a;
  }
  // normalised progress of the current one-shot (0..1)
  progress() {
    const a = this.current;
    if (!a) return 1;
    return Math.min(1, a.time / a.getClip().duration);
  }
  update(dt) { this.mixer.update(dt); }
}

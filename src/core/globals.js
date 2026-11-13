// Shared uniform objects. Every material references these same {value} holders,
// so updating them once per frame updates the whole scene.
import * as THREE from 'three';

export const SHADOW_CASCADES = 4;

export const G = {
  uTime: { value: 0 },
  uLightDir: { value: new THREE.Vector3(0.4, 0.8, 0.45).normalize() },   // toward the main light (sun or moon)
  uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.45).normalize() },     // toward the real sun
  uMoonDir: { value: new THREE.Vector3(-0.4, 0.5, -0.45).normalize() },
  uLightColor: { value: new THREE.Color(2.4, 2.2, 1.9) },
  uAmbSky: { value: new THREE.Color(0.55, 0.7, 0.95) },
  uAmbGround: { value: new THREE.Color(0.35, 0.36, 0.28) },
  uFogColor: { value: new THREE.Color(0.7, 0.82, 0.95) },
  uFogSunColor: { value: new THREE.Color(1.0, 0.9, 0.7) },
  uFogParams: { value: new THREE.Vector4(0.00016, 0.006, 0.012, 0.96) },
  uWind: { value: new THREE.Vector4(0.8, 0.6, 1.0, 0.0) },
  uPlayerPos: { value: new THREE.Vector3() },
  uCamPos: { value: new THREE.Vector3() },      // main camera position (valid in every pass)
  uNight: { value: 0 },            // 0 day .. 1 night
  uWet: { value: 0 },              // rain wetness 0..1

  // shadows
  uShadowTex: { value: null },
  uShadowMat: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
  uShadowSplits: { value: new THREE.Vector4(12, 40, 130, 420) },
  uShadowParams: { value: new THREE.Vector4(1 / 4096, 1, 0, 0) },   // x: atlas texel, y: strength
  uShadowTexel: { value: new THREE.Vector4(0.01, 0.04, 0.13, 0.42) }, // world size of one texel per cascade

  // world maps
  uHeightTex: { value: null },
  uNormalTex: { value: null },
  uMaskTex: { value: null },
  uBiomeTex: { value: null },
  uWaterTex: { value: null },
  uNoiseTex: { value: null },

  // clouds
  uCloudMap: { value: null },
  uCloudParams: { value: new THREE.Vector4(0, 0, 0.5, 0.6) },       // xy: scroll offset (uv), z: coverage, w: shadow strength

  // sky colours (shared with water reflections)
  uSkyZenith: { value: new THREE.Color(0.1, 0.3, 0.8) },
  uSunGlow: { value: new THREE.Color(1, 0.9, 0.7) },
  uCloudLit: { value: new THREE.Color(1, 1, 1) },
  uCloudSh: { value: new THREE.Color(0.5, 0.6, 0.8) },

  // screen
  uResolution: { value: new THREE.Vector2(1, 1) },
  uSceneColor: { value: null },
  uSceneDepth: { value: null },
  uCamNearFar: { value: new THREE.Vector2(0.3, 9000) },
};

// pick a subset of the shared uniforms for a material
export function shared(...names) {
  const o = {};
  for (const n of names) {
    if (!G[n]) throw new Error('unknown shared uniform ' + n);
    o[n] = G[n];
  }
  return o;
}

export const U_SKY = ['uSkyZenith', 'uSunGlow', 'uCloudLit', 'uCloudSh'];
export const U_LIGHT = ['uTime', 'uLightDir', 'uSunDir', 'uLightColor', 'uAmbSky', 'uAmbGround', 'uFogColor', 'uFogSunColor', 'uFogParams', 'uNight', 'uWet'];
export const U_SHADOW = ['uShadowTex', 'uShadowMat', 'uShadowSplits', 'uShadowParams', 'uShadowTexel', 'uCloudMap', 'uCloudParams'];
export const U_WORLD = ['uHeightTex', 'uNormalTex', 'uMaskTex', 'uBiomeTex', 'uWaterTex', 'uNoiseTex'];
export const U_ALL = [...U_LIGHT, ...U_SHADOW, ...U_WORLD, 'uWind', 'uPlayerPos', 'uCamPos'];

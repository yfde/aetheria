// Shared GLSL chunks. Compose them into ShaderMaterial sources with template strings.
import { WORLD } from '../world/layout.js';

export const CLOUD_ALT = 760.0;        // cloud layer base altitude (m)
export const CLOUD_TILE = 9000.0;      // world size of one coverage-map tile (m)

export const GLSL_UNIFORMS = /* glsl */`
uniform float uTime;
uniform vec3 uLightDir;
uniform vec3 uSunDir;
uniform vec3 uLightColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform vec4 uFogParams;
uniform float uNight;
uniform float uWet;
`;

export const GLSL_MATH = /* glsl */`
#ifndef PI
#define PI 3.14159265359
#endif
float saturate1(float x) { return clamp(x, 0.0, 1.0); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
`;

// World map sampling (height / normal / masks). Works in vertex and fragment stages.
export const GLSL_WORLD = /* glsl */`
uniform highp sampler2D uHeightTex;
uniform sampler2D uNormalTex;
uniform sampler2D uMaskTex;
uniform sampler2D uBiomeTex;
uniform sampler2D uWaterTex;
uniform sampler2D uNoiseTex;
const float W_HALF = ${WORLD.half.toFixed(1)};
const float W_SIZE = ${WORLD.size.toFixed(1)};
const float W_RES = ${WORLD.res.toFixed(1)};
const float W_CELL = ${WORLD.cell.toFixed(1)};
vec2 worldUV(vec2 xz) { return ((xz + W_HALF) / W_CELL + 0.5) / W_RES; }
float terrainHeight(vec2 xz) {
  vec2 g = clamp((xz + W_HALF) / W_CELL, vec2(0.0), vec2(W_RES - 1.001));
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  float a = texelFetch(uHeightTex, i, 0).r;
  float b = texelFetch(uHeightTex, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uHeightTex, i + ivec2(0, 1), 0).r;
  float d = texelFetch(uHeightTex, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec3 terrainNormal(vec2 xz) {
  vec2 n = texture(uNormalTex, worldUV(xz)).rg * 2.0 - 1.0;
  return normalize(vec3(n.x, sqrt(max(1.0 - dot(n, n), 0.0)), n.y));
}
vec3 terrainNormalLod(vec2 xz, float lod) {
  vec2 n = textureLod(uNormalTex, worldUV(xz), lod).rg * 2.0 - 1.0;
  return normalize(vec3(n.x, sqrt(max(1.0 - dot(n, n), 0.0)), n.y));
}
vec4 biomeTint(vec2 xz) {
  vec4 b = texture(uBiomeTex, (xz + W_HALF) / W_SIZE);
  return vec4(b.rgb * b.rgb, b.a * 1.6);
}
vec4 biomeTintLod(vec2 xz) {
  vec4 b = textureLod(uBiomeTex, (xz + W_HALF) / W_SIZE, 0.0);
  return vec4(b.rgb * b.rgb, b.a * 1.6);
}
float waterLevel(vec2 xz) { return texture(uWaterTex, worldUV(xz)).r; }
`;

// Wind field shared by grass / foliage / terrain sheen.
export const GLSL_WIND = /* glsl */`
uniform vec4 uWind;   // xy: direction, z: strength, w: travelled phase
// returns gust amount 0..1 at a world position (large travelling waves + small flutter)
float windGust(vec2 xz) {
  vec2 p = xz * 0.018 - uWind.xy * uWind.w * 0.35;
  float g = textureLod(uNoiseTex, p * 0.25, 0.0).r;
  float g2 = textureLod(uNoiseTex, p * 0.9 + 0.37, 0.0).g;
  return clamp(g * 0.75 + g2 * 0.4 - 0.12, 0.0, 1.0);
}
`;

export const GLSL_SHADOW = /* glsl */`
uniform highp sampler2DShadow uShadowTex;
uniform mat4 uShadowMat[4];
uniform vec4 uShadowSplits;
uniform vec4 uShadowParams;
uniform vec4 uShadowTexel;
uniform sampler2D uCloudMap;
uniform vec4 uCloudParams;

float cloudShadow(vec3 wp) {
  vec3 L = uLightDir;
  vec2 p = wp.xz + L.xz / max(L.y, 0.12) * (${CLOUD_ALT.toFixed(1)} + 180.0 - wp.y);
  vec2 uv = p / ${CLOUD_TILE.toFixed(1)} + uCloudParams.xy;
  float c = texture(uCloudMap, uv).r;
  float cov = uCloudParams.z;
  float d = smoothstep(1.0 - cov - 0.02, 1.0 - cov + 0.3, c);
  return 1.0 - d * uCloudParams.w;
}

float shadowTap(int c, vec3 wp) {
  vec4 sc = uShadowMat[c] * vec4(wp, 1.0);
  vec2 tile = vec2(float(c & 1), float(c >> 1)) * 0.5;
  float t = uShadowParams.x;
  vec2 uv = clamp(sc.xy, tile + t * 2.0, tile + 0.5 - t * 2.0);
  if (sc.z > 1.0) return 1.0;
  float s = 0.0;
  s += texture(uShadowTex, vec3(uv + vec2(-t, -t), sc.z));
  s += texture(uShadowTex, vec3(uv + vec2( t, -t), sc.z));
  s += texture(uShadowTex, vec3(uv + vec2(-t,  t), sc.z));
  s += texture(uShadowTex, vec3(uv + vec2( t,  t), sc.z));
  s += texture(uShadowTex, vec3(uv, sc.z));
  s += texture(uShadowTex, vec3(uv + vec2(-2.0 * t, 0.0), sc.z)) * 0.5;
  s += texture(uShadowTex, vec3(uv + vec2( 2.0 * t, 0.0), sc.z)) * 0.5;
  s += texture(uShadowTex, vec3(uv + vec2(0.0, -2.0 * t), sc.z)) * 0.5;
  s += texture(uShadowTex, vec3(uv + vec2(0.0,  2.0 * t), sc.z)) * 0.5;
  return s / 7.0;
}
float shadowTap1(int c, vec3 wp) {
  vec4 sc = uShadowMat[c] * vec4(wp, 1.0);
  vec2 tile = vec2(float(c & 1), float(c >> 1)) * 0.5;
  float t = uShadowParams.x;
  vec2 uv = clamp(sc.xy, tile + t * 2.0, tile + 0.5 - t * 2.0);
  if (sc.z > 1.0) return 1.0;
  return texture(uShadowTex, vec3(uv, sc.z));
}
int shadowCascade(float dist) {
  return dist < uShadowSplits.x ? 0 : (dist < uShadowSplits.y ? 1 : (dist < uShadowSplits.z ? 2 : 3));
}
float cascadeFar(int c) { return c == 0 ? uShadowSplits.x : (c == 1 ? uShadowSplits.y : (c == 2 ? uShadowSplits.z : uShadowSplits.w)); }
float cascadeTexel(int c) { return c == 0 ? uShadowTexel.x : (c == 1 ? uShadowTexel.y : (c == 2 ? uShadowTexel.z : uShadowTexel.w)); }

// soft PCF shadow with cascade blending. n = geometric normal for offset bias.
float getShadow(vec3 wp, vec3 n) {
  float dist = distance(wp, cameraPosition);
  if (dist > uShadowSplits.w) return 1.0;
  int c = shadowCascade(dist);
  float far = cascadeFar(c);
  float texel = cascadeTexel(c);
  vec3 p = wp + n * texel * 1.6 + uLightDir * texel * 0.9;
  float s = shadowTap(c, p);
  float blend = smoothstep(far * 0.86, far, dist);
  if (blend > 0.0) {
    float s2 = 1.0;
    if (c < 3) {
      float texel2 = cascadeTexel(c + 1);
      s2 = shadowTap(c + 1, wp + n * texel2 * 1.6 + uLightDir * texel2 * 0.9);
    }
    s = mix(s, s2, blend);
  }
  return mix(1.0, s, uShadowParams.y);
}
// cheap single-tap variant for vertex shaders (grass)
float getShadowFast(vec3 wp) {
  float dist = distance(wp, cameraPosition);
  if (dist > uShadowSplits.w) return 1.0;
  int c = shadowCascade(dist);
  float far = cascadeFar(c);
  float texel = cascadeTexel(c);
  float s = shadowTap1(c, wp + vec3(0.0, texel * 2.0, 0.0) + uLightDir * texel * 1.5);
  s = mix(s, 1.0, c == 3 ? smoothstep(far * 0.86, far, dist) : 0.0);
  return mix(1.0, s, uShadowParams.y);
}
`;

export const GLSL_FOG = /* glsl */`
vec3 fogColorDir(vec3 dir) {
  float sunAmt = max(dot(dir, uSunDir), 0.0);
  float s = pow(sunAmt, 6.0) * 0.55 + pow(sunAmt, 48.0) * 0.5;
  return mix(uFogColor, uFogSunColor, clamp(s, 0.0, 1.0));
}
float fogAmount(vec3 wp, out vec3 dir) {
  vec3 v = wp - cameraPosition;
  float dist = length(v);
  dir = v / max(dist, 1e-4);
  float a = exp(-dist * uFogParams.x);
  float hf = uFogParams.z;
  float t = dir.y * hf;
  float integral = abs(t) > 1e-5 ? (1.0 - exp(-dist * t)) / t : dist;
  float hfog = uFogParams.y * exp(-hf * max(cameraPosition.y, 0.0)) * integral;
  return min(1.0 - a * exp(-hfog), uFogParams.w);
}
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 dir;
  float f = fogAmount(wp, dir);
  return mix(col, fogColorDir(dir), f);
}
`;

export const GLSL_LIGHT = /* glsl */`
vec3 ambientLight(vec3 n) {
  return mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
}
// stylised two-tone diffuse with a soft terminator
float toonRamp(float ndl, float soft) {
  return smoothstep(-soft, soft, ndl);
}
vec3 toonShade(vec3 albedo, vec3 n, vec3 v, float shadow, float ao, float rimAmt) {
  float ndl = dot(n, uLightDir);
  float lit = toonRamp(ndl - 0.08, 0.14) * shadow;
  vec3 direct = uLightColor * lit;
  vec3 amb = ambientLight(n) * ao;
  // bounce: a little warm light on shadowed undersides
  vec3 c = albedo * (direct + amb);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.5);
  float rim = fres * smoothstep(-0.3, 0.6, ndl) * rimAmt;
  c += rim * (uLightColor * 0.22 + uAmbSky * 0.3) * (0.4 + 0.6 * shadow);
  return c;
}
`;

// fullscreen triangle vertex shader
export const FS_VERT = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

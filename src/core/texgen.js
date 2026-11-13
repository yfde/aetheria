// Procedural tileable noise textures (2D + 3D) generated on the CPU at startup.
import * as THREE from 'three';

function ihash(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const mod = (a, n) => ((a % n) + n) % n;
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// periodic 2D gradient noise, [-1,1]
function pnoise2(x, y, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const g = (ix, iy, dx, dy) => {
    const a = ihash(mod(ix, per), mod(iy, per), 0, seed) * 6.2831853;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fade(fx), v = fade(fy);
  const a = g(xi, yi, fx, fy), b = g(xi + 1, yi, fx - 1, fy), c = g(xi, yi + 1, fx, fy - 1), d = g(xi + 1, yi + 1, fx - 1, fy - 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.41;
}
function pfbm2(x, y, per, oct, seed) {
  let a = 0, amp = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { a += amp * pnoise2(x * per, y * per, per, seed + i * 17); n += amp; per *= 2; amp *= 0.5; }
  return a / n;
}
// periodic 2D worley F1, [0,1]
function pworley2(x, y, per, seed) {
  x *= per; y *= per;
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j;
    const px = cx + ihash(mod(cx, per), mod(cy, per), 1, seed), py = cy + ihash(mod(cx, per), mod(cy, per), 2, seed);
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < best) best = d;
  }
  return Math.min(1, Math.sqrt(best));
}

// periodic 3D gradient noise
const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
function pnoise3(x, y, z, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
  const g = (ix, iy, iz, dx, dy, dz) => {
    const q = G3[(ihash(mod(ix, per), mod(iy, per), mod(iz, per), seed) * 12) | 0];
    return q[0] * dx + q[1] * dy + q[2] * dz;
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(g(xi, yi, zi, fx, fy, fz), g(xi + 1, yi, zi, fx - 1, fy, fz), u), l(g(xi, yi + 1, zi, fx, fy - 1, fz), g(xi + 1, yi + 1, zi, fx - 1, fy - 1, fz), u), v),
    l(l(g(xi, yi, zi + 1, fx, fy, fz - 1), g(xi + 1, yi, zi + 1, fx - 1, fy, fz - 1), u), l(g(xi, yi + 1, zi + 1, fx, fy - 1, fz - 1), g(xi + 1, yi + 1, zi + 1, fx - 1, fy - 1, fz - 1), u), v), w);
}
function pworley3(x, y, z, per, seed) {
  x *= per; y *= per; z *= per;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9;
  for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j, cz = zi + k;
    const mx = mod(cx, per), my = mod(cy, per), mz = mod(cz, per);
    const px = cx + ihash(mx, my, mz, seed), py = cy + ihash(mx, my, mz, seed + 1), pz = cz + ihash(mx, my, mz, seed + 2);
    const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d < best) best = d;
  }
  return Math.min(1, Math.sqrt(best));
}

const remap = (v, a, b, c, d) => c + (d - c) * ((v - a) / (b - a));
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// General purpose tileable 2D noise: R perlin fbm, G perlin fbm (finer), B worley (1 = cell centre), A blue-ish white noise
export function makeNoiseTexture(size = 256) {
  const d = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const u = i / size, v = j / size;
    const o = (j * size + i) * 4;
    d[o] = sat(pfbm2(u, v, 4, 5, 1) * 0.5 + 0.5) * 255;
    d[o + 1] = sat(pfbm2(u, v, 8, 4, 77) * 0.55 + 0.5) * 255;
    d[o + 2] = sat(1 - pworley2(u, v, 8, 5) * 1.25) * 255;
    d[o + 3] = ihash(i, j, 3, 9) * 255;
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

// Cloud coverage map: R = cumulus coverage (perlin-worley), G = wispy detail, B = cirrus streaks
export function makeCloudMap(size = 512) {
  const d = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const u = i / size, v = j / size;
    const o = (j * size + i) * 4;
    const pf = pfbm2(u, v, 3, 5, 31) * 0.5 + 0.5;
    const wf = (1 - pworley2(u, v, 5, 11)) * 0.6 + (1 - pworley2(u, v, 11, 13)) * 0.28 + (1 - pworley2(u, v, 23, 17)) * 0.12;
    const cov = sat(remap(pf, wf * 0.9 - 0.62, 1.0, 0.0, 1.0));
    d[o] = sat(cov * 1.15) * 255;
    d[o + 1] = sat(pfbm2(u, v, 12, 4, 51) * 0.5 + 0.5) * 255;
    // cirrus: stretched noise
    d[o + 2] = sat(pfbm2(u * 1.0, v * 1.0, 2, 3, 71) * 0.5 + 0.5) * sat(pfbm2(u, v, 16, 3, 91) * 0.8 + 0.5) * 255;
    d[o + 3] = 255;
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

// 3D cloud shape noise: R = perlin-worley base, G = worley fbm (erosion detail)
export function makeCloudVolume(size = 64) {
  const d = new Uint8Array(size * size * size * 2);
  let o = 0;
  for (let k = 0; k < size; k++) for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const u = i / size, v = j / size, w = k / size;
    let p = 0, amp = 0.5, n = 0, per = 4;
    for (let q = 0; q < 3; q++) { p += amp * pnoise3(u * per, v * per, w * per, per, 5 + q); n += amp; amp *= 0.5; per *= 2; }
    p = p / n * 0.5 + 0.5;
    const w1 = 1 - pworley3(u, v, w, 4, 21), w2 = 1 - pworley3(u, v, w, 8, 23), w3 = 1 - pworley3(u, v, w, 16, 27);
    const wfbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    const pw = sat(remap(p, wfbm - 1, 1, 0, 1));
    d[o++] = pw * 255;
    d[o++] = sat(w2 * 0.6 + w3 * 0.4) * 255;
  }
  const t = new THREE.Data3DTexture(d, size, size, size);
  t.format = THREE.RGFormat; t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}

// Tileable water normal map (RG = slope, B = height) from periodic fbm
export function makeWaterNormals(size = 256) {
  const hgt = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const u = i / size, v = j / size;
    hgt[j * size + i] = pfbm2(u, v, 4, 5, 131) + 0.35 * (1 - Math.abs(pfbm2(u + 0.37, v + 0.11, 6, 3, 151)) * 2);
  }
  const d = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const l = hgt[j * size + mod(i - 1, size)], r = hgt[j * size + mod(i + 1, size)];
    const u = hgt[mod(j - 1, size) * size + i], dn = hgt[mod(j + 1, size) * size + i];
    const o = (j * size + i) * 4;
    d[o] = sat((l - r) * 6.0 * 0.5 + 0.5) * 255;
    d[o + 1] = sat((u - dn) * 6.0 * 0.5 + 0.5) * 255;
    d[o + 2] = sat(hgt[j * size + i] * 0.5 + 0.5) * 255;
    d[o + 3] = 255;
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

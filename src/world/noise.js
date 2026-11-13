// Deterministic CPU noise used by world generation (runs in worker + main thread).
// Gradient noise with analytic derivatives, fbm variants.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// integer hash -> [0,1)
export function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const PERM = new Uint8Array(512);
const GX = new Float32Array(256);
const GY = new Float32Array(256);

export function seedNoise(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i++) {
    const a = rnd() * Math.PI * 2;
    GX[i] = Math.cos(a);
    GY[i] = Math.sin(a);
  }
}
seedNoise(1337);

// last derivative outputs (avoid allocation)
export const nd = { dx: 0, dy: 0 };

// 2D gradient noise, returns ~[-1,1]; derivatives in nd.dx / nd.dy
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const X = xi & 255, Y = yi & 255;
  const g00 = PERM[X + PERM[Y]], g10 = PERM[X + 1 + PERM[Y]];
  const g01 = PERM[X + PERM[Y + 1]], g11 = PERM[X + 1 + PERM[Y + 1]];
  const ax = GX[g00], ay = GY[g00];
  const bx = GX[g10], by = GY[g10];
  const cx = GX[g01], cy = GY[g01];
  const dx_ = GX[g11], dy_ = GY[g11];
  const va = ax * fx + ay * fy;
  const vb = bx * (fx - 1) + by * fy;
  const vc = cx * fx + cy * (fy - 1);
  const vd = dx_ * (fx - 1) + dy_ * (fy - 1);
  // quintic fade and derivative
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const k0 = va, k1 = vb - va, k2 = vc - va, k3 = va - vb - vc + vd;
  nd.dx = (ax + ux * (bx - ax) + uy * (cx - ax) + ux * uy * (ax - bx - cx + dx_) + dux * (k1 + k3 * uy)) * 1.41;
  nd.dy = (ay + ux * (by - ay) + uy * (cy - ay) + ux * uy * (ay - by - cy + dy_) + duy * (k2 + k3 * ux)) * 1.41;
  return (k0 + k1 * ux + k2 * uy + k3 * ux * uy) * 1.41;
}

// standard fbm, ~[-1,1]
export function fbm(x, y, oct = 5, lac = 2.0, gain = 0.5) {
  let a = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    a += amp * noise2(x, y);
    norm += amp;
    // rotate to hide lattice alignment
    const nx = (x * 0.8 - y * 0.6) * lac + 17.13;
    const ny = (x * 0.6 + y * 0.8) * lac - 9.71;
    x = nx; y = ny;
    amp *= gain;
  }
  return a / norm;
}

// ridged multifractal, ~[0,1]
export function ridged(x, y, oct = 5, lac = 2.0, gain = 0.5) {
  let a = 0, amp = 0.5, norm = 0, prev = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(noise2(x, y));
    n = n * n;
    a += amp * n * prev;
    norm += amp;
    prev = n;
    const nx = (x * 0.8 - y * 0.6) * lac + 31.7;
    const ny = (x * 0.6 + y * 0.8) * lac + 11.3;
    x = nx; y = ny;
    amp *= gain;
  }
  return a / norm;
}

// derivative-damped fbm ("eroded" look, after iq), ~[-1,1]
export function erodedFbm(x, y, oct = 7, damp = 1.0) {
  let a = 0, amp = 0.5, norm = 0, dx = 0, dy = 0;
  for (let i = 0; i < oct; i++) {
    const n = noise2(x, y);
    dx += nd.dx; dy += nd.dy;
    a += amp * n / (1 + damp * (dx * dx + dy * dy));
    norm += amp;
    const nx = (x * 0.8 - y * 0.6) * 2.0 + 5.3;
    const ny = (x * 0.6 + y * 0.8) * 2.0 - 3.9;
    x = nx; y = ny;
    amp *= 0.5;
  }
  return a / norm * 1.6;
}

// cellular (worley) F1 distance, ~[0,1]
export function worley(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 57);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(a, b, x) {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

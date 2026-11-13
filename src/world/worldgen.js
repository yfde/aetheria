// Procedural world generation. Pure computation on typed arrays so it can run in a worker.
import { seedNoise, noise2, fbm, ridged, erodedFbm, hash2, mulberry32, clamp, saturate, lerp, smoothstep as sm } from './noise.js';
import { WORLD, BIOME, MOUNTAINS, PLATEAU, LAKES, RIVERS, ROADS, POI, ISLETS, VILLAGE_HOUSES, RUIN_COTTAGES, sampleSpline } from './layout.js';

const N = WORLD.res, CELL = WORLD.cell, HALF = WORLD.half;
const BN = 512;            // biome tint map resolution
const MAPN = 2048;         // map image resolution

// biome tint colours (linear-ish RGB) and grass height scale
const BIOME_TINT = [
  [0.150, 0.300, 0.058, 1.00],  // MEADOW  – vivid spring green
  [0.070, 0.215, 0.060, 0.85],  // FOREST  – deep green
  [0.135, 0.330, 0.105, 0.95],  // SAKURA  – fresh, slightly teal
  [0.400, 0.300, 0.065, 1.05],  // AUTUMN  – gold
  [0.290, 0.350, 0.130, 0.70],  // BEACH   – pale dune grass
  [0.230, 0.290, 0.160, 0.55],  // ALPINE  – muted
  [0.205, 0.315, 0.065, 1.10],  // PLATEAU – yellow-green, tall
  [0.080, 0.290, 0.180, 0.90],  // MYSTIC  – teal
];

const wx2g = (x) => (x + HALF) / CELL;

// stage 1 for a band of rows; lets several workers share the most expensive part
export function macroStrip(j0, j1) {
  seedNoise(WORLD.seed);
  const out = new Float32Array((j1 - j0) * N);
  for (let j = j0; j < j1; j++) {
    const z = -HALF + j * CELL;
    for (let i = 0; i < N; i++) out[(j - j0) * N + i] = macroHeight(-HALF + i * CELL, z);
  }
  return out;
}

export function generateWorld(progress = () => {}, preH = null) {
  seedNoise(WORLD.seed);
  const H = preH || new Float32Array(N * N);
  const water = new Float32Array(N * N);     // local water surface elevation (0 = sea)
  const pathMask = new Float32Array(N * N);
  const clearMask = new Float32Array(N * N);  // POI plazas: no vegetation
  const rivDist = new Float32Array(N * N).fill(1e9);
  const rivElev = new Float32Array(N * N);
  const rivHW = new Float32Array(N * N);
  const lakeIn = new Float32Array(N * N);     // >0 inside lake influence

  // ---------- 1. macro terrain ----------
  for (let j = 0; j < N && !preH; j++) {
    const z = -HALF + j * CELL;
    for (let i = 0; i < N; i++) {
      const x = -HALF + i * CELL;
      H[j * N + i] = macroHeight(x, z);
    }
    if ((j & 63) === 0) progress(0.02 + 0.40 * j / N, 'Raising mountains');
  }

  // ---------- 2. lakes ----------
  progress(0.43, 'Filling lakes');
  for (const L of LAKES) {
    const R = L.r * (1 + L.wobble) + 140;
    forBox(L.x, L.z, R, (i, j, x, z) => {
      const dx = x - L.x, dz = z - L.z;
      const d = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);
      const rEdge = L.r * (1 + L.wobble * fbm(Math.cos(ang) * 1.3 + L.x * 0.01, Math.sin(ang) * 1.3 + L.z * 0.01, 3));
      const dd = d - rEdge;
      let target;
      if (dd < 0) {
        const t = sm(0, -rEdge * 0.6, dd);
        target = L.level - 0.25 - L.depth * Math.pow(t, 0.85) - sm(0, -10, dd) * 0.9;
      } else {
        target = L.level + Math.min(dd * 0.16, 1.6 + dd * 0.05);
      }
      if (L.island) {
        const di = Math.hypot(x - L.island.x, z - L.island.z);
        const bump = L.level + L.island.h * sm(L.island.r, L.island.r * 0.35, di) - 2.2 * sm(L.island.r * 0.9, L.island.r * 1.5, di);
        if (di < L.island.r * 1.5) target = Math.max(target, bump);
      }
      const k = 1 - sm(10, 135, dd);
      const idx = j * N + i;
      H[idx] = lerp(H[idx], target, k);
      if (dd < 16) water[idx] = Math.max(water[idx], L.level);
      if (dd < 30) lakeIn[idx] = 1;
    });
  }

  // ---------- 3. rivers ----------
  progress(0.47, 'Carving rivers');
  const riversOut = [];
  for (const R of RIVERS) {
    const s = sampleSpline(R.pts, 2.0);
    riversOut.push({ name: R.name, width: R.width, samples: s });
    const hw = R.width / 2;
    const RAD = 96;
    for (let k = 0; k < s.length; k++) {
      const [sx, sz, se] = s[k];
      forBox(sx, sz, RAD, (i, j, x, z) => {
        const d = Math.hypot(x - sx, z - sz);
        const idx = j * N + i;
        if (d < rivDist[idx]) { rivDist[idx] = d; rivElev[idx] = se; rivHW[idx] = hw; }
      });
    }
  }
  for (let idx = 0; idx < N * N; idx++) {
    const d = rivDist[idx];
    if (d > 96) continue;
    const S = rivElev[idx], hw = rivHW[idx];
    let target;
    if (d < hw) { const q = d / hw; target = S - 0.15 - 1.9 * (1 - q * q); }
    else target = S + Math.min((d - hw) * 0.2, 1.8 + (d - hw) * 0.055);
    const h0 = H[idx];
    const reach = h0 < target ? 92 : 58;
    let k = 1 - sm(hw + 4, reach, d);
    if (lakeIn[idx] > 0 && h0 < target) k *= 0.0;   // don't refill lake basins
    H[idx] = lerp(h0, target, k);
    if (d < hw + 10) water[idx] = Math.max(water[idx], S);
  }

  // ---------- 4. POI flatten stamps ----------
  progress(0.5, 'Laying foundations');
  const poiY = {};
  for (const key in POI) {
    const p = POI[key];
    if (!p.flat) { continue; }
    // average height in a small disc
    let acc = 0, cnt = 0;
    forBox(p.x, p.z, p.flat * 0.6, (i, j, x, z) => {
      if (Math.hypot(x - p.x, z - p.z) < p.flat * 0.6) { acc += H[j * N + i]; cnt++; }
    });
    let target = acc / Math.max(cnt, 1);
    if (key === 'spawn') target = Math.max(target, PLATEAU.h);
    p.y = target;
    forBox(p.x, p.z, p.flat * 2.0, (i, j, x, z) => {
      const d = Math.hypot(x - p.x, z - p.z);
      const k = 1 - sm(p.flat, p.flat * 2.0, d);
      const idx = j * N + i;
      if (rivDist[idx] < rivHW[idx] + 6 || lakeIn[idx] > 0) return;
      H[idx] = lerp(H[idx], target + (H[idx] - target) * 0.06, k);
      const cr = p.clear !== undefined ? p.clear : p.flat * 0.5;
      if (cr > 0 && d < cr * 1.2) clearMask[idx] = Math.max(clearMask[idx], 1 - sm(cr * 0.82, cr * 1.15, d));
    });
  }

  // ---------- 5. roads ----------
  progress(0.53, 'Tracing old roads');
  const roadsOut = [];
  const bridges = [];
  for (const R of ROADS) {
    const s = sampleSpline(R.pts.map((p) => [p[0], p[1]]), 2.0);
    const n = s.length;
    const hs = new Float32Array(n);
    const inRiver = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      hs[k] = sampleBilinear(H, s[k][0], s[k][1]);
      const gi = clamp(Math.round(wx2g(s[k][0])), 0, N - 1), gj = clamp(Math.round(wx2g(s[k][1])), 0, N - 1);
      const idx = gj * N + gi;
      if (rivDist[idx] < rivHW[idx] + 2.5) inRiver[k] = 1;
    }
    // bridge spans: lift road over the river channel
    for (let k = 0; k < n; k++) {
      if (inRiver[k] && (k === 0 || !inRiver[k - 1])) {
        let e = k; while (e < n - 1 && inRiver[e + 1]) e++;
        const a = Math.max(0, k - 3), b = Math.min(n - 1, e + 3);
        const ya = hs[a], yb = hs[b];
        const deck = Math.max(ya, yb) + 0.4;
        bridges.push({ ax: s[a][0], az: s[a][1], bx: s[b][0], bz: s[b][1], y: deck, width: R.width + 1.6 });
        for (let q = a; q <= b; q++) { hs[q] = deck; inRiver[q] = 2; }
        k = e;
      }
    }
    // smooth profile
    const sp = new Float32Array(n);
    const WIN = 14;
    for (let k = 0; k < n; k++) {
      let acc = 0, w = 0;
      for (let q = -WIN; q <= WIN; q++) {
        const kk = clamp(k + q, 0, n - 1);
        const ww = 1 - Math.abs(q) / (WIN + 1);
        acc += hs[kk] * ww; w += ww;
      }
      sp[k] = acc / w;
    }
    const hw = R.width / 2;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const [sx, sz] = s[k];
      pts.push([sx, sz, sp[k]]);
      if (inRiver[k]) continue;
      forBox(sx, sz, hw + 11, (i, j, x, z) => {
        const d = Math.hypot(x - sx, z - sz);
        const idx = j * N + i;
        if (rivDist[idx] < rivHW[idx] + 1.5) return;
        const kk = 1 - sm(hw + 0.5, hw + 10, d);
        if (kk > 0) H[idx] = lerp(H[idx], sp[k], Math.max(kk, 0) * 0.92);
        const pm = 1 - sm(hw - 0.4, hw + 1.3, d);
        if (pm > pathMask[idx]) pathMask[idx] = pm;
      });
    }
    roadsOut.push({ name: R.name, width: R.width, pts });
  }

  // village: clear the house footprints and wear paths from each door to the plaza
  {
    const v = POI.village;
    for (const [dx, dz, yaw, w, d] of VILLAGE_HOUSES) {
      const hx = v.x + dx, hz = v.z + dz, rr = Math.max(w, d) * 0.66;
      forBox(hx, hz, rr * 1.3, (i, j, x, z) => {
        const dd = Math.hypot(x - hx, z - hz), idx = j * N + i;
        clearMask[idx] = Math.max(clearMask[idx], 1 - sm(rr * 0.8, rr * 1.2, dd));
      });
      const doorX = hx + Math.sin(yaw) * (d / 2 + 1), doorZ = hz + Math.cos(yaw) * (d / 2 + 1);
      const steps = Math.ceil(Math.hypot(doorX - v.x, doorZ - v.z) / 1.5);
      for (let s = 0; s <= steps; s++) {
        const px = doorX + (v.x - doorX) * s / steps, pz = doorZ + (v.z - doorZ) * s / steps;
        forBox(px, pz, 3, (i, j, x, z) => {
          const idx = j * N + i, pm = 1 - sm(0.9, 2.2, Math.hypot(x - px, z - pz));
          if (pm > pathMask[idx]) pathMask[idx] = pm;
        });
      }
    }
  }

  // ruined cottages: no trees through the walls, grass worn thin
  for (const [rx, rz] of RUIN_COTTAGES) forBox(rx, rz, 10, (i, j, x, z) => {
    const idx = j * N + i;
    clearMask[idx] = Math.max(clearMask[idx], 0.45 * (1 - sm(5.5, 9.0, Math.hypot(x - rx, z - rz))));
  });

  // POI heights (after everything)
  for (const key in POI) {
    const p = POI[key];
    p.y = sampleBilinear(H, p.x, p.z);
    poiY[key] = p.y;
  }

  // ---------- 6. normals, slope, AO ----------
  progress(0.56, 'Sculpting cliffs');
  const normalTex = new Uint8Array(N * N * 4);
  const slopeY = new Float32Array(N * N);   // normal.y
  // low-res blur of height for cavity/AO estimate
  const Q = N / 8;
  const blurQ = new Float32Array(Q * Q);
  for (let j = 0; j < Q; j++) for (let i = 0; i < Q; i++) {
    let a = 0;
    for (let v = 0; v < 8; v += 2) for (let u = 0; u < 8; u += 2) a += H[(j * 8 + v) * N + i * 8 + u];
    blurQ[j * Q + i] = a / 16;
  }
  const blurQ2 = new Float32Array(Q * Q);
  for (let j = 0; j < Q; j++) for (let i = 0; i < Q; i++) {
    let a = 0, w = 0;
    for (let v = -2; v <= 2; v++) for (let u = -2; u <= 2; u++) {
      const ii = clamp(i + u, 0, Q - 1), jj = clamp(j + v, 0, Q - 1);
      a += blurQ[jj * Q + ii]; w++;
    }
    blurQ2[j * Q + i] = a / w;
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const hl = H[j * N + Math.max(i - 1, 0)], hr = H[j * N + Math.min(i + 1, N - 1)];
      const hu = H[Math.max(j - 1, 0) * N + i], hd = H[Math.min(j + 1, N - 1) * N + i];
      const dx = (hr - hl) / (2 * CELL), dz = (hd - hu) / (2 * CELL);
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      const nx = -dx * inv, ny = inv, nz = -dz * inv;
      slopeY[idx] = ny;
      // bilinear blurred height
      const qx = clamp((i - 3.5) / 8, 0, Q - 1.001), qz = clamp((j - 3.5) / 8, 0, Q - 1.001);
      const q0 = Math.floor(qx), q1 = Math.floor(qz), fx = qx - q0, fz = qz - q1;
      const b = lerp(lerp(blurQ2[q1 * Q + q0], blurQ2[q1 * Q + q0 + 1], fx), lerp(blurQ2[(q1 + 1) * Q + q0], blurQ2[(q1 + 1) * Q + q0 + 1], fx), fz);
      const cav = saturate(0.5 + (H[idx] - b) * 0.035);
      const o = idx * 4;
      normalTex[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normalTex[o + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      normalTex[o + 2] = Math.round(cav * 255);
      normalTex[o + 3] = 255;
    }
    if ((j & 127) === 0) progress(0.56 + 0.08 * j / N, 'Sculpting cliffs');
  }

  // ---------- 7. biome tint map ----------
  progress(0.65, 'Painting meadows');
  const biomeTex = new Uint8Array(BN * BN * 4);
  const bw = new Float32Array(8);
  for (let j = 0; j < BN; j++) {
    for (let i = 0; i < BN; i++) {
      const x = -HALF + (i + 0.5) * (WORLD.size / BN), z = -HALF + (j + 0.5) * (WORLD.size / BN);
      const h = sampleBilinear(H, x, z);
      biomeWeights(x, z, h, bw);
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 8; k++) { r += BIOME_TINT[k][0] * bw[k]; g += BIOME_TINT[k][1] * bw[k]; b += BIOME_TINT[k][2] * bw[k]; a += BIOME_TINT[k][3] * bw[k]; }
      // large-scale painterly variation
      const v1 = fbm(x * 0.0035 + 40, z * 0.0035 - 12, 3);
      const v2 = fbm(x * 0.011 - 7, z * 0.011 + 31, 3);
      const warm = 1 + 0.22 * v1, bright = 1 + 0.16 * v2 + 0.08 * v1;
      r = r * bright * warm; g = g * bright; b = b * bright / warm;
      const o = (j * BN + i) * 4;
      biomeTex[o] = Math.round(Math.sqrt(saturate(r)) * 255);
      biomeTex[o + 1] = Math.round(Math.sqrt(saturate(g)) * 255);
      biomeTex[o + 2] = Math.round(Math.sqrt(saturate(b)) * 255);
      biomeTex[o + 3] = Math.round(saturate(a * (1 + 0.25 * v2) / 1.6) * 255);
    }
  }

  // ---------- 8. masks ----------
  progress(0.68, 'Sowing grass');
  const maskTex = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    const z = -HALF + j * CELL;
    for (let i = 0; i < N; i++) {
      const x = -HALF + i * CELL;
      const idx = j * N + i;
      const h = H[idx], ny = slopeY[idx], w = water[idx];
      const n1 = fbm(x * 0.02 + 3, z * 0.02 - 8, 2);
      let g = sm(0.70, 0.86, ny);                       // slope
      g *= sm(w + 0.5 + n1 * 0.5, w + 2.2 + n1 * 1.2, h);   // shore / beach
      if (w < 0.5) g *= sm(2.2 + n1 * 1.5, 5.5 + n1 * 2.5, h);  // sea beaches are wider
      g *= 1 - sm(285 + n1 * 30, 345 + n1 * 30, h);     // snowline
      g *= 1 - pathMask[idx];
      g *= 1 - clearMask[idx] * 0.92;
      // sparse bald patches
      const fl = flowerDensity(x, z, h) * g;
      const o = idx * 4;
      maskTex[o] = Math.round(saturate(g) * 255);
      maskTex[o + 1] = Math.round(saturate(Math.max(pathMask[idx], clearMask[idx] * 0.85)) * 255);
      maskTex[o + 2] = 0;
      maskTex[o + 3] = Math.round(saturate(fl) * 255);
    }
    if ((j & 127) === 0) progress(0.68 + 0.07 * j / N, 'Sowing grass');
  }

  // ---------- 9. vegetation ----------
  progress(0.76, 'Planting forests');
  const veg = placeVegetation(H, slopeY, water, pathMask, clearMask, rivDist, rivHW, maskTex);

  // ---------- 10. map image ----------
  progress(0.93, 'Drawing the map');
  const mapImg = drawMap(H, slopeY, water, pathMask, biomeTex, maskTex);

  progress(1.0, 'Awakening');
  return {
    N, CELL, HALF, BN, MAPN,
    height: H, water, normalTex, maskTex, biomeTex, slopeY,
    rivers: riversOut, roads: roadsOut, bridges, poiY, veg, mapImg,
  };

  // ---------------- helpers (closures over arrays) ----------------
  function forBox(cx, cz, rad, fn) {
    const i0 = Math.max(0, Math.floor(wx2g(cx - rad))), i1 = Math.min(N - 1, Math.ceil(wx2g(cx + rad)));
    const j0 = Math.max(0, Math.floor(wx2g(cz - rad))), j1 = Math.min(N - 1, Math.ceil(wx2g(cz + rad)));
    for (let j = j0; j <= j1; j++) {
      const z = -HALF + j * CELL;
      for (let i = i0; i <= i1; i++) fn(i, j, -HALF + i * CELL, z);
    }
  }
}

export function sampleBilinear(arr, x, z) {
  let gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
  gx = gx < 0 ? 0 : gx > N - 1.001 ? N - 1.001 : gx;
  gz = gz < 0 ? 0 : gz > N - 1.001 ? N - 1.001 : gz;
  const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j;
  const o = j * N + i;
  const a = arr[o], b = arr[o + 1], c = arr[o + N], d = arr[o + N + 1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

// ------------------------------------------------------------------
// Macro terrain shape
// ------------------------------------------------------------------
function angBump(ang, centerDeg, widthDeg) {
  let d = ang - centerDeg * Math.PI / 180;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const w = widthDeg * Math.PI / 180;
  const t = Math.abs(d) / w;
  return t >= 1 ? 0 : (1 - t * t) * (1 - t * t);
}

function macroHeight(x, z) {
  // domain warp for organic shapes
  const wx = x + 110 * fbm(x * 0.0011 + 13.1, z * 0.0011 + 7.7, 3);
  const wz = z + 110 * fbm(x * 0.0011 - 5.2, z * 0.0011 + 21.3, 3);

  // island outline: radius as a function of angle with designed capes and bays (0° = east, 90° = south)
  const d = Math.hypot(wx, wz);
  const ang = Math.atan2(wz, wx);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let coastR = 1500 + 150 * fbm(ca * 1.7 + 3.3, sa * 1.7 + 8.1, 4) + 70 * fbm(wx * 0.0035, wz * 0.0035, 3);
  coastR += 300 * angBump(ang, 40, 24);      // Coral Coast peninsula
  coastR -= 230 * angBump(ang, 68, 13);      // lagoon bay
  coastR += 150 * angBump(ang, 100, 22);     // south cape (below the plateau)
  coastR -= 200 * angBump(ang, 140, 16);     // south-west cove
  coastR += 190 * angBump(ang, 178, 26);     // west headland
  coastR -= 160 * angBump(ang, -140, 14);    // north-west fjord
  coastR += 120 * angBump(ang, -95, 40);     // northern mountain shore
  coastR += 170 * angBump(ang, -32, 20);     // north-east cape
  coastR += 130 * angBump(ang, 6, 14);       // Eastfall bluff
  const shore = coastR - d;                  // metres inland (negative = offshore)

  // cliffs vs beaches
  let cliffy = 0.72 + 0.4 * fbm(ca * 2.3 - 4.0, sa * 2.3 + 1.7, 2);
  cliffy -= 1.2 * angBump(ang, 44, 40) + 0.9 * angBump(ang, 138, 22) + 0.8 * angBump(ang, -140, 16) + 0.7 * angBump(ang, 95, 14);
  cliffy += 0.8 * angBump(ang, 6, 16);
  cliffy = saturate(cliffy);

  let beach, cliff;
  if (shore > 0) {
    const t = sm(0, 460, shore);
    beach = 2.2 * sm(0, 30, shore) + 20 * t * t * (0.4 + 0.6 * t);
    cliff = 22 * sm(-6, 40, shore) + 4 * sm(40, 300, shore);
  } else {
    beach = -(5.0 * sm(0, 120, -shore) + 62 * sm(100, 560, -shore));
    cliff = -(14 * sm(0, 36, -shore) + 54 * sm(30, 420, -shore));
  }
  let h = lerp(beach, cliff, cliffy);

  const inland = sm(20, 340, shore);
  // rolling hills; a low-frequency "ruggedness" field keeps some areas as calm meadows
  const rug = sm(-0.32, 0.38, fbm(wx * 0.00085 + 4.4, wz * 0.00085 - 1.2, 3));
  const hills = erodedFbm(wx * 0.0021 + 1.7, wz * 0.0021 - 2.3, 7, 0.9) * 0.5 + 0.5;
  h += hills * (12 + 62 * rug) * inland;
  h += fbm(wx * 0.0062 + 9, wz * 0.0062 + 4, 4) * (5 + 8 * rug) * inland;

  // mountains
  let mAcc = 0;
  for (let k = 0; k < MOUNTAINS.length; k++) {
    const M = MOUNTAINS[k];
    const dm = Math.hypot(wx - M.x, wz - M.z) / M.r;
    if (dm >= 1) continue;
    const fall = Math.pow(1 - dm, M.sharp);
    const rg = ridged(wx * 0.0026 + k * 7.1, wz * 0.0026 - k * 3.7, 6, 2.05, 0.52);
    const er = erodedFbm(wx * 0.0046 + k * 3.3, wz * 0.0046 + k * 1.9, 6, 1.4);
    mAcc += M.h * fall * (0.5 + 0.66 * rg) + er * 46 * Math.pow(1 - dm, 0.7) * Math.min(1, M.h / 300);
  }
  h += mAcc * sm(-40, 220, shore);

  // offshore islets
  for (let k = 0; k < ISLETS.length; k++) {
    const I = ISLETS[k];
    const di = Math.hypot(x - I.x, z - I.z) / I.r + 0.25 * fbm(x * 0.012 + k * 5, z * 0.012 - k * 3, 2);
    if (di < 1.6) {
      const bump = -6 + (I.h + 6) * sm(1.0, 0.25, di) + 5 * fbm(x * 0.02, z * 0.02 + k, 3) * sm(1.0, 0.5, di);
      h = Math.max(h, lerp(h, bump, sm(1.6, 1.0, di)));
    }
  }

  // start plateau with cliff edges
  {
    const P = PLATEAU;
    const dp = Math.hypot(x - P.x, z - P.z) + 46 * fbm(x * 0.0085 + 5, z * 0.0085 - 3, 3);
    const t = sm(P.r + 30, P.r - 20, dp);
    if (t > 0) {
      const top = P.h + 4.5 * fbm(x * 0.007, z * 0.007 + 50, 3) + 2.5 * fbm(x * 0.03, z * 0.03, 2);
      h = lerp(h, Math.max(top, h * 0.4 + top * 0.6), t);
    }
  }

  // fine detail (fades on beaches so the shoreline stays clean)
  const det = fbm(x * 0.021 + 11, z * 0.021 + 5, 3) * 2.4 + fbm(x * 0.07, z * 0.07 + 9, 2) * 0.55;
  h += det * sm(1.5, 14, h);
  return h;
}

// ------------------------------------------------------------------
// Biomes
// ------------------------------------------------------------------
function blob(x, z, cx, cz, r, soft = 0.45) {
  const n = fbm(x * 0.0042 + cx * 0.01, z * 0.0042 + cz * 0.01, 3) * 0.28;
  const d = Math.hypot(x - cx, z - cz) / r + n;
  return 1 - sm(1 - soft, 1 + soft * 0.4, d);
}

export function biomeWeights(x, z, h, out) {
  const forest = Math.max(blob(x, z, -850, 180, 640), blob(x, z, -1150, -350, 330) * 0.9, blob(x, z, -480, 560, 260) * 0.8);
  const sakura = Math.max(blob(x, z, 560, 70, 300), blob(x, z, 835, -60, 70));
  const autumn = blob(x, z, 1010, -700, 520);
  const plateau = blob(x, z, PLATEAU.x, PLATEAU.z, PLATEAU.r * 1.02, 0.2);
  const mystic = blob(x, z, POI.temple.x, POI.temple.z, 230, 0.5);
  const alpine = sm(170, 290, h + fbm(x * 0.006, z * 0.006, 2) * 30);
  const beach = (1 - sm(3, 13, h)) * (x + z > 600 ? 1 : 0.7);
  let w1 = forest, w2 = sakura * (1 - forest), w3 = autumn, w6 = plateau, w7 = mystic * 0.8;
  const w5 = alpine, w4 = beach;
  // priority compositing
  let rem = 1;
  out.fill(0);
  const take = (k, w) => { const t = Math.min(rem, w * rem); out[k] += t; rem -= t; };
  take(BIOME.ALPINE, w5);
  take(BIOME.BEACH, w4);
  take(BIOME.PLATEAU, w6);
  take(BIOME.MYSTIC, w7);
  take(BIOME.SAKURA, w2);
  take(BIOME.AUTUMN, w3);
  take(BIOME.FOREST, w1);
  out[BIOME.MEADOW] += rem;
  return out;
}

function flowerDensity(x, z, h) {
  // patches of flowers, strongest in meadows
  const p = fbm(x * 0.013 + 70, z * 0.013 - 20, 3);
  const q = fbm(x * 0.045 - 5, z * 0.045 + 15, 2);
  let f = sm(0.02, 0.38, p) * (0.55 + 0.45 * sm(-0.3, 0.3, q));
  f *= 1 - sm(200, 280, h);
  return f;
}

// ------------------------------------------------------------------
// Vegetation placement
// ------------------------------------------------------------------
// species: 0 oak, 1 pine, 2 birch, 3 sakura, 4 maple, 5 palm, 6 giant
export const TREE_SPECIES = ['oak', 'pine', 'birch', 'sakura', 'maple', 'palm', 'giant'];

function placeVegetation(H, slopeY, water, pathMask, clearMask, rivDist, rivHW, maskTex) {
  const rnd = mulberry32(WORLD.seed ^ 0x51ab);
  const trees = TREE_SPECIES.map(() => []);
  const bushes = [];
  const rocks = [];
  const bw = new Float32Array(8);
  const canopy = new Float32Array(N * N);

  const idxAt = (x, z) => clamp(Math.round(wx2g(z)), 0, N - 1) * N + clamp(Math.round(wx2g(x)), 0, N - 1);

  // --- trees: jittered 6 m grid
  const TC = 6;
  const tn = Math.floor(WORLD.size / TC);
  for (let cj = 0; cj < tn; cj++) {
    for (let ci = 0; ci < tn; ci++) {
      const r0 = hash2(ci, cj, 11), r1 = hash2(ci, cj, 23), r2 = hash2(ci, cj, 37), r3 = hash2(ci, cj, 41);
      const x = -HALF + (ci + 0.12 + 0.76 * r0) * TC, z = -HALF + (cj + 0.12 + 0.76 * r1) * TC;
      const idx = idxAt(x, z);
      const h = H[idx];
      if (h < 1.6 || h < water[idx] + 0.9) continue;
      const ny = slopeY[idx];
      if (ny < 0.8) continue;
      if (pathMask[idx] > 0.05 || clearMask[idx] > 0.02) continue;
      if (rivDist[idx] < rivHW[idx] + 3.5) continue;
      biomeWeights(x, z, h, bw);
      // density per biome (probability per 36 m² cell)
      const grove = sm(0.05, 0.45, fbm(x * 0.006 + 200, z * 0.006 - 100, 3));       // meadow groves
      const dens =
        bw[BIOME.MEADOW] * (0.012 + 0.2 * grove * grove) +
        bw[BIOME.FOREST] * 0.52 +
        bw[BIOME.SAKURA] * 0.2 +
        bw[BIOME.AUTUMN] * (0.12 + 0.32 * grove) +
        bw[BIOME.BEACH] * (h > 2.2 && h < 9 ? 0.07 : 0.0) +
        bw[BIOME.ALPINE] * 0.2 * (1 - sm(250, 330, h)) +
        bw[BIOME.PLATEAU] * (0.02 + 0.2 * grove) +
        bw[BIOME.MYSTIC] * 0.06;
      if (r2 > dens * sm(0.8, 0.92, ny)) continue;
      // species choice
      let sp;
      const pick = r3;
      const cool = sm(120, 230, h);
      if (bw[BIOME.BEACH] > 0.45 && h < 9) sp = 5;
      else if (bw[BIOME.SAKURA] > 0.4) sp = pick < 0.78 ? 3 : (pick < 0.92 ? 2 : 0);
      else if (bw[BIOME.AUTUMN] > 0.4) sp = pick < 0.8 ? 4 : (pick < 0.92 ? 2 : 1);
      else if (bw[BIOME.ALPINE] > 0.35 || cool > 0.6) sp = pick < 0.9 ? 1 : 2;
      else if (bw[BIOME.FOREST] > 0.45) sp = pick < 0.34 ? 0 : (pick < 0.74 ? 1 : (pick < 0.9 ? 6 : 2));
      else if (bw[BIOME.PLATEAU] > 0.5) sp = pick < 0.5 ? 2 : (pick < 0.85 ? 0 : 1);
      else sp = pick < 0.62 ? 0 : (pick < 0.86 ? 2 : 1);
      const scale = (sp === 6 ? 1.0 : 0.78) + rnd() * 0.5 + (sp === 0 ? grove * 0.25 : 0);
      trees[sp].push(x, h - 0.15, z, scale, rnd() * 6.2832, rnd());
      // canopy shade splat
      const cr = (sp === 6 ? 9 : sp === 1 ? 3.2 : 5) * scale;
      splat(canopy, x, z, cr, 0.5);
    }
  }

  // --- bushes: jittered 7 m grid
  const BC = 7;
  const bn = Math.floor(WORLD.size / BC);
  for (let cj = 0; cj < bn; cj++) {
    for (let ci = 0; ci < bn; ci++) {
      const r0 = hash2(ci, cj, 51), r1 = hash2(ci, cj, 63), r2 = hash2(ci, cj, 77);
      const x = -HALF + (ci + r0) * BC, z = -HALF + (cj + r1) * BC;
      const idx = idxAt(x, z);
      const h = H[idx];
      if (h < 2.2 || h < water[idx] + 0.6 || h > 300) continue;
      if (slopeY[idx] < 0.74 || pathMask[idx] > 0.05 || clearMask[idx] > 0.02) continue;
      biomeWeights(x, z, h, bw);
      const cl = sm(-0.05, 0.4, fbm(x * 0.012 - 60, z * 0.012 + 44, 3));
      const dens = 0.035 + cl * 0.14 + bw[BIOME.FOREST] * 0.16 + bw[BIOME.AUTUMN] * 0.06 - bw[BIOME.BEACH] * 0.1 - bw[BIOME.ALPINE] * 0.08;
      if (r2 > dens) continue;
      // tint id by biome: 0 green, 1 autumn, 2 sakura/pink flowers, 3 dark
      let kind = 0;
      if (bw[BIOME.AUTUMN] > 0.4) kind = 1; else if (bw[BIOME.SAKURA] > 0.4 && rnd() < 0.5) kind = 2; else if (bw[BIOME.FOREST] > 0.5) kind = 3;
      bushes.push(x, h - 0.1, z, 0.7 + rnd() * 0.9, rnd() * 6.2832, kind + rnd() * 0.99);
    }
  }

  // --- rocks: jittered 9 m grid, more on slopes / mountains / coast
  const RC = 9;
  const rn = Math.floor(WORLD.size / RC);
  for (let cj = 0; cj < rn; cj++) {
    for (let ci = 0; ci < rn; ci++) {
      const r0 = hash2(ci, cj, 91), r1 = hash2(ci, cj, 103), r2 = hash2(ci, cj, 117), r3 = hash2(ci, cj, 131);
      const x = -HALF + (ci + r0) * RC, z = -HALF + (cj + r1) * RC;
      const idx = idxAt(x, z);
      const h = H[idx];
      if (h < -3 || h < water[idx] - 1.5) continue;
      if (pathMask[idx] > 0.05 || clearMask[idx] > 0.02) continue;
      const ny = slopeY[idx];
      if (ny < 0.55) continue;
      const rough = sm(0.93, 0.74, ny);
      const alt = sm(120, 320, h);
      const coast = 1 - sm(1, 8, Math.abs(h - 1.5));
      const cl = sm(0.1, 0.5, fbm(x * 0.009 + 300, z * 0.009 + 7, 3));
      const dens = 0.012 + rough * 0.22 + alt * 0.16 + coast * 0.05 + cl * 0.07;
      if (r2 > dens) continue;
      // size distribution: mostly small, few large
      const s = 0.35 + Math.pow(r3, 3.2) * 3.6 + (alt > 0.5 ? r3 * 0.6 : 0);
      rocks.push(x, h, z, s, rnd() * 6.2832, rnd());
    }
  }

  // bake canopy shade into mask blue channel
  for (let i = 0; i < N * N; i++) maskTex[i * 4 + 2] = Math.round(saturate(canopy[i]) * 255);

  return {
    trees: trees.map((a) => new Float32Array(a)),
    bushes: new Float32Array(bushes),
    rocks: new Float32Array(rocks),
  };

  function splat(arr, cx, cz, rad, amt) {
    const i0 = Math.max(0, Math.floor(wx2g(cx - rad))), i1 = Math.min(N - 1, Math.ceil(wx2g(cx + rad)));
    const j0 = Math.max(0, Math.floor(wx2g(cz - rad))), j1 = Math.min(N - 1, Math.ceil(wx2g(cz + rad)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(-HALF + i * CELL - cx, -HALF + j * CELL - cz) / rad;
      if (d < 1) arr[j * N + i] += amt * (1 - d * d);
    }
  }
}

// ------------------------------------------------------------------
// Parchment-style map image (RGBA, MAPN x MAPN)
// ------------------------------------------------------------------
function drawMap(H, slopeY, water, pathMask, biomeTex, maskTex) {
  const img = new Uint8ClampedArray(MAPN * MAPN * 4);
  const step = N / MAPN;
  for (let j = 0; j < MAPN; j++) {
    for (let i = 0; i < MAPN; i++) {
      const gi = Math.min(N - 2, Math.floor(i * step)), gj = Math.min(N - 2, Math.floor(j * step));
      const idx = gj * N + gi;
      const h = H[idx], w = water[idx];
      const bi = Math.min(BN - 1, Math.floor(i * BN / MAPN)), bj = Math.min(BN - 1, Math.floor(j * BN / MAPN));
      const bo = (bj * BN + bi) * 4;
      let r = Math.pow(biomeTex[bo] / 255, 2), g = Math.pow(biomeTex[bo + 1] / 255, 2), b = Math.pow(biomeTex[bo + 2] / 255, 2);
      // soften toward parchment-friendly palette
      r = r * 0.8 + 0.16; g = g * 0.75 + 0.2; b = b * 0.7 + 0.12;
      const ny = slopeY[idx];
      const rock = sm(0.82, 0.62, ny);
      r = lerp(r, 0.56, rock); g = lerp(g, 0.52, rock); b = lerp(b, 0.47, rock);
      const sand = (1 - sm(1.5, 5, h)) * (w < 0.5 ? 1 : 0);
      r = lerp(r, 0.86, sand); g = lerp(g, 0.8, sand); b = lerp(b, 0.6, sand);
      const snow = sm(290, 340, h) * sm(0.55, 0.8, ny);
      r = lerp(r, 0.96, snow); g = lerp(g, 0.97, snow); b = lerp(b, 1.0, snow);
      // hillshade (light from NW)
      const hl = H[idx - (gi > 0 ? 1 : 0)], hr = H[idx + 1], hu = H[idx - (gj > 0 ? N : 0)], hd = H[idx + N];
      const sh = clamp(0.5 + ((hl - hr) + (hu - hd)) * 0.11, 0.0, 1.0);
      const shade = 0.62 + 0.62 * sh;
      r *= shade; g *= shade; b *= shade;
      // canopy
      const can = maskTex[idx * 4 + 2] / 255;
      r = lerp(r, r * 0.62, can * 0.7); g = lerp(g, g * 0.78, can * 0.7); b = lerp(b, b * 0.6, can * 0.7);
      // roads
      const pm = pathMask[idx];
      r = lerp(r, 0.8, pm * 0.85); g = lerp(g, 0.7, pm * 0.85); b = lerp(b, 0.5, pm * 0.85);
      // water
      const depth = w - h;
      if (depth > 0) {
        const t = sm(0, 14, depth);
        const wr = lerp(0.42, 0.14, t), wg = lerp(0.78, 0.42, t), wb = lerp(0.82, 0.68, t);
        const a = sm(0, 0.6, depth);
        r = lerp(r, wr, a); g = lerp(g, wg, a); b = lerp(b, wb, a);
      }
      const o = (j * MAPN + i) * 4;
      img[o] = Math.sqrt(saturate(r)) * 255; img[o + 1] = Math.sqrt(saturate(g)) * 255; img[o + 2] = Math.sqrt(saturate(b)) * 255; img[o + 3] = 255;
    }
  }
  return img;
}

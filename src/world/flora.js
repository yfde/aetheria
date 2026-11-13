// Trees and bushes: stylised "fluffy" foliage built from camera-facing leaf-cluster quads with
// spherical normals, plus real trunk geometry, all drawn with one instanced plant shader.
import * as THREE from 'three';
import { shared, U_LIGHT, U_SHADOW, U_WORLD } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_WORLD, GLSL_SHADOW, GLSL_FOG, GLSL_LIGHT, GLSL_WIND } from '../shaders/common.js';
import { WORLD } from './layout.js';
import { TREE_SPECIES } from './worldgen.js';

// ---------------------------------------------------------------- leaf atlas
function makeLeafAtlas() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const ctx = cv.getContext('2d');
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const leaf = (x, y, ang, len, wid, shade) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    const g = Math.round(150 + shade * 105);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.5, -wid, len, 0);
    ctx.quadraticCurveTo(len * 0.5, wid, 0, 0);
    ctx.fill();
    ctx.restore();
  };
  // cell (0,0): dense rounded leaf cluster
  const cluster = (ox, oy, n, lenA, lenB, widK, fill) => {
    const cx = ox + S / 2, cy = oy + S / 2;
    if (fill > 0) {
      ctx.fillStyle = 'rgb(150,150,150)';
      ctx.beginPath(); ctx.arc(cx, cy, S * fill, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, r = Math.pow(rnd(), 0.6) * S * 0.33;
      const len = (lenA + rnd() * lenB) * S;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const maxLen = S * 0.47 - r;
      leaf(x, y, a + (rnd() - 0.5) * 1.2, Math.min(len, Math.max(maxLen, S * 0.05)), len * widK, rnd());
    }
  };
  cluster(0, 0, 70, 0.14, 0.12, 0.42, 0.2);          // broadleaf
  cluster(S, 0, 46, 0.09, 0.08, 0.5, 0.0);           // blossom: smaller, airier petals
  // cell (0,1): pine bough – fan of needles
  {
    const cx = S / 2, cy = S + S / 2;
    for (let i = 0; i < 120; i++) {
      const a = rnd() * Math.PI * 2, r = rnd() * S * 0.2;
      const len = (0.18 + rnd() * 0.12) * S;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      leaf(x, y, a + (rnd() - 0.5) * 0.7, Math.min(len, S * 0.47 - r), len * 0.13, rnd());
    }
  }
  // cell (1,1): left half solid (trunks), right half a palm frond
  ctx.fillStyle = 'rgb(255,255,255)';
  ctx.fillRect(S, S, S / 2, S);
  {
    const x0 = S + S * 0.75;
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      const y = S + 8 + t * (S - 16);
      const w = Math.sin(Math.pow(t, 0.8) * Math.PI) * S * 0.2 + 3;
      for (const sgn of [-1, 1]) {
        ctx.save(); ctx.translate(x0, y); ctx.rotate(sgn * 0.5);
        const g = Math.round(170 + rnd() * 85);
        ctx.fillStyle = `rgb(${g},${g},${g})`;
        ctx.beginPath(); ctx.moveTo(0, -4); ctx.quadraticCurveTo(sgn * w * 0.6, -9, sgn * w, 3); ctx.quadraticCurveTo(sgn * w * 0.5, 3, 0, 5); ctx.fill();
        ctx.restore();
      }
    }
    ctx.fillStyle = 'rgb(200,200,200)';
    ctx.fillRect(x0 - 2.5, S + 4, 5, S - 8);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 4;
  tex.flipY = false;
  return tex;
}

// ---------------------------------------------------------------- geometry builder
class PlantBuilder {
  constructor(seed = 1) {
    this.pos = []; this.nrm = []; this.uv = []; this.corner = []; this.par = []; this.col = []; this.idx = [];
    this.n = 0; this.s = seed;
  }
  rnd() { this.s = (this.s * 16807) % 2147483647; return this.s / 2147483647; }
  _v(p, n, u, v, cx, cy, rand, ao, leaf, c) {
    this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); this.uv.push(u, v);
    this.corner.push(cx, cy); this.par.push(rand, ao, leaf); this.col.push(c[0], c[1], c[2]);
    return this.n++;
  }
  // camera-facing leaf quad. cell: atlas cell index 0..2
  quad(center, normal, size, cell, color, ao) {
    const r = this.rnd();
    const ox = (cell % 2) * 0.5, oy = Math.floor(cell / 2) * 0.5;
    const pad = 0.004;
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const base = this.n;
    for (const [x, y] of c) this._v(center, normal, ox + pad + (x * 0.5 + 0.5) * (0.5 - 2 * pad), oy + pad + (y * 0.5 + 0.5) * (0.5 - 2 * pad), x * size, y * size, r, ao, 1, color);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // static double-sided card (palm frond segment); uv rect in atlas space
  card(p0, p1, p2, p3, uv0, uv1, normal, color, ao, rand) {
    const base = this.n;
    this._v(p0, normal, uv0[0], uv0[1], 0, 0, rand, ao, 0.5, color);
    this._v(p1, normal, uv1[0], uv0[1], 0, 0, rand, ao, 0.5, color);
    this._v(p2, normal, uv1[0], uv1[1], 0, 0, rand, ao, 0.5, color);
    this._v(p3, normal, uv0[0], uv1[1], 0, 0, rand, ao, 0.5, color);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // tapered tube along a path of {p:[x,y,z], r}
  tube(path, radial, colorBase, colorTop) {
    const rings = [];
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(i - 1, 0)].p, b = path[Math.min(i + 1, path.length - 1)].p;
      const t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      const ref = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const u = new THREE.Vector3().crossVectors(t, ref).normalize();
      const v = new THREE.Vector3().crossVectors(t, u);
      const ring = [];
      const f = i / (path.length - 1);
      const col = [colorBase[0] + (colorTop[0] - colorBase[0]) * f, colorBase[1] + (colorTop[1] - colorBase[1]) * f, colorBase[2] + (colorTop[2] - colorBase[2]) * f];
      for (let k = 0; k < radial; k++) {
        const ang = k / radial * Math.PI * 2;
        const nx = u.x * Math.cos(ang) + v.x * Math.sin(ang), ny = u.y * Math.cos(ang) + v.y * Math.sin(ang), nz = u.z * Math.cos(ang) + v.z * Math.sin(ang);
        const p = path[i].p, r = path[i].r;
        ring.push(this._v([p[0] + nx * r, p[1] + ny * r, p[2] + nz * r], [nx, ny, nz], 0.6, 0.75, 0, 0, 0.5, 0.75 + 0.25 * f, 0, col));
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < radial; k++) {
      const a = rings[i][k], b = rings[i][(k + 1) % radial], c = rings[i + 1][k], d = rings[i + 1][(k + 1) % radial];
      this.idx.push(a, b, c, b, d, c);
    }
  }
  // puff of leaf quads on a set of blobs [{c:[x,y,z], r}]
  crown(blobs, perBlob, sizeK, cell, colorFn) {
    let cx = 0, cy = 0, cz = 0, minY = 1e9, maxY = -1e9;
    for (const b of blobs) { cx += b.c[0]; cy += b.c[1]; cz += b.c[2]; minY = Math.min(minY, b.c[1] - b.r); maxY = Math.max(maxY, b.c[1] + b.r); }
    cx /= blobs.length; cy /= blobs.length; cz /= blobs.length;
    for (const b of blobs) {
      const n = Math.max(3, Math.round(perBlob * (b.r * b.r) / 4));
      for (let i = 0; i < n; i++) {
        // fibonacci sphere with jitter
        const y = 1 - (i + 0.5) / n * 2;
        const rad = Math.sqrt(1 - y * y);
        const th = i * 2.39996 + this.rnd() * 0.6;
        const d = [Math.cos(th) * rad, y, Math.sin(th) * rad];
        const rr = b.r * (0.72 + this.rnd() * 0.3);
        const p = [b.c[0] + d[0] * rr, b.c[1] + d[1] * rr * 0.92, b.c[2] + d[2] * rr];
        // skip quads buried inside neighbouring blobs
        let buried = false;
        for (const o of blobs) if (o !== b && Math.hypot(p[0] - o.c[0], p[1] - o.c[1], p[2] - o.c[2]) < o.r * 0.62) { buried = true; break; }
        if (buried) continue;
        // normal: blend of blob-local and crown-wide directions for a soft rounded read
        let nx = d[0] * 0.55 + (p[0] - cx) * 0.2, ny = d[1] * 0.55 + (p[1] - cy) * 0.2 + 0.18, nz = d[2] * 0.55 + (p[2] - cz) * 0.2;
        const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        const hf = (p[1] - minY) / (maxY - minY);
        const ao = 0.5 + 0.5 * Math.min(1, hf * 1.25 + 0.12) * (0.75 + 0.25 * d[1]);
        this.quad(p, [nx, ny, nz], b.r * sizeK * (0.8 + this.rnd() * 0.45), cell, colorFn(this.rnd(), hf), ao);
      }
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(this.corner, 2));
    g.setAttribute('aParams', new THREE.Float32BufferAttribute(this.par, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

const jit = (c, r, k = 0.12) => [c[0] * (1 - k + 2 * k * r), c[1] * (1 - k * 0.6 + 1.2 * k * r), c[2] * (1 - k + 2 * k * r)];

// species definitions: returns { near, far, radius (trunk collider), height }
function buildSpecies(name) {
  const near = new PlantBuilder(11), far = new PlantBuilder(13);
  const bark = { oak: [0.15, 0.095, 0.06], pine: [0.13, 0.08, 0.055], birch: [0.60, 0.59, 0.54], sakura: [0.105, 0.065, 0.06], maple: [0.13, 0.085, 0.065], palm: [0.30, 0.23, 0.15], giant: [0.14, 0.10, 0.075], bush: [0.12, 0.08, 0.05] }[name];
  const barkTop = bark.map((v) => v * 1.25);
  const leafCol = (r, hf) => jit([1, 1, 1], r, 0.14).map((v) => v * (0.82 + 0.3 * hf));
  let info = { trunkR: 0.35, height: 7 };
  if (name === 'oak' || name === 'maple') {
    const tr = [{ p: [0, -0.4, 0], r: 0.52 }, { p: [0.02, 0.5, 0], r: 0.36 }, { p: [0.1, 1.9, 0.05], r: 0.29 }, { p: [0.0, 3.3, 0.0], r: 0.24 }, { p: [-0.1, 4.6, 0.05], r: 0.14 }];
    near.tube(tr, 7, bark, barkTop);
    near.tube([{ p: [0.05, 2.6, 0], r: 0.17 }, { p: [1.0, 3.5, 0.3], r: 0.12 }, { p: [1.8, 4.2, 0.5], r: 0.06 }], 5, bark, barkTop);
    near.tube([{ p: [0.0, 2.9, 0], r: 0.16 }, { p: [-0.9, 3.7, -0.6], r: 0.11 }, { p: [-1.7, 4.3, -1.0], r: 0.05 }], 5, bark, barkTop);
    const blobs = [{ c: [0, 5.3, 0], r: 2.3 }, { c: [1.9, 4.5, 0.5], r: 1.7 }, { c: [-1.7, 4.6, -1.0], r: 1.75 }, { c: [0.3, 4.4, -1.9], r: 1.5 }, { c: [-0.5, 4.3, 1.9], r: 1.6 }, { c: [0.6, 6.6, 0.3], r: 1.45 }];
    near.crown(blobs, 13, 0.92, 0, leafCol);
    far.tube([{ p: [0, -0.4, 0], r: 0.45 }, { p: [0, 3.6, 0], r: 0.22 }], 4, bark, barkTop);
    far.crown([{ c: [0, 5.2, 0], r: 2.6 }, { c: [1.5, 4.5, 0.4], r: 1.8 }, { c: [-1.4, 4.6, -0.8], r: 1.8 }], 2.6, 1.25, 0, leafCol);
    info = { trunkR: 0.4, height: 8 };
  } else if (name === 'birch') {
    const tr = [{ p: [0, -0.4, 0], r: 0.24 }, { p: [0.05, 2.0, 0], r: 0.17 }, { p: [0.0, 4.5, 0.05], r: 0.12 }, { p: [0.05, 7.0, 0], r: 0.05 }];
    near.tube(tr, 6, bark, bark);
    const blobs = [{ c: [0, 4.2, 0], r: 1.35 }, { c: [0.5, 5.4, 0.3], r: 1.3 }, { c: [-0.4, 6.4, -0.2], r: 1.15 }, { c: [0.1, 7.4, 0], r: 0.9 }, { c: [-0.7, 4.9, 0.5], r: 1.0 }];
    near.crown(blobs, 14, 0.95, 0, leafCol);
    far.tube([{ p: [0, -0.4, 0], r: 0.22 }, { p: [0, 5.0, 0], r: 0.1 }], 4, bark, bark);
    far.crown([{ c: [0, 4.6, 0], r: 1.5 }, { c: [0, 6.5, 0], r: 1.25 }], 3.2, 1.3, 0, leafCol);
    info = { trunkR: 0.22, height: 8.3 };
  } else if (name === 'sakura') {
    const tr = [{ p: [0, -0.4, 0], r: 0.46 }, { p: [0.1, 0.8, 0], r: 0.31 }, { p: [0.25, 2.0, 0.1], r: 0.25 }, { p: [0.2, 3.0, 0.0], r: 0.2 }];
    near.tube(tr, 7, bark, barkTop);
    near.tube([{ p: [0.2, 2.2, 0], r: 0.18 }, { p: [1.3, 3.1, 0.4], r: 0.12 }, { p: [2.4, 3.6, 0.7], r: 0.05 }], 5, bark, barkTop);
    near.tube([{ p: [0.2, 2.4, 0], r: 0.17 }, { p: [-1.1, 3.2, -0.5], r: 0.11 }, { p: [-2.3, 3.7, -0.9], r: 0.05 }], 5, bark, barkTop);
    near.tube([{ p: [0.2, 2.6, 0], r: 0.15 }, { p: [0.0, 3.5, 1.2], r: 0.1 }, { p: [-0.2, 4.0, 2.2], r: 0.05 }], 5, bark, barkTop);
    const blobs = [{ c: [0.1, 4.6, 0], r: 2.0 }, { c: [2.5, 4.0, 0.7], r: 1.7 }, { c: [-2.4, 4.1, -0.9], r: 1.7 }, { c: [-0.2, 4.2, 2.4], r: 1.6 }, { c: [0.6, 4.1, -2.2], r: 1.55 }, { c: [1.2, 5.3, -0.4], r: 1.3 }, { c: [-1.1, 5.2, 0.6], r: 1.3 }];
    near.crown(blobs, 13, 0.9, 1, leafCol);
    far.tube([{ p: [0, -0.4, 0], r: 0.4 }, { p: [0.2, 3.0, 0], r: 0.2 }], 4, bark, barkTop);
    far.crown([{ c: [0, 4.6, 0], r: 2.3 }, { c: [2.2, 4.0, 0.5], r: 1.8 }, { c: [-2.1, 4.1, -0.6], r: 1.8 }, { c: [0, 4.1, 2.0], r: 1.6 }], 2.4, 1.25, 1, leafCol);
    info = { trunkR: 0.36, height: 6.6 };
  } else if (name === 'pine') {
    const tr = [{ p: [0, -0.4, 0], r: 0.34 }, { p: [0, 2.5, 0], r: 0.24 }, { p: [0, 6.5, 0], r: 0.12 }, { p: [0, 10.3, 0], r: 0.03 }];
    near.tube(tr, 6, bark, barkTop);
    // layered skirts of drooping boughs
    const tiers = 8;
    for (let t = 0; t < tiers; t++) {
      const f = t / (tiers - 1);
      const y = 2.0 + f * 7.9, rad = 2.7 * (1 - f * 0.88);
      const cnt = Math.max(4, Math.round(12 * (1 - f * 0.62)));
      for (let k = 0; k < cnt; k++) {
        const a = k / cnt * Math.PI * 2 + t * 0.9 + near.rnd() * 0.35;
        const rr = rad * (0.66 + near.rnd() * 0.22);
        const p = [Math.cos(a) * rr, y - rr * 0.38 + near.rnd() * 0.25, Math.sin(a) * rr];
        const n = [Math.cos(a) * 0.62, 0.72, Math.sin(a) * 0.62];
        near.quad(p, n, 0.55 + rad * 0.36, 0, leafCol(near.rnd(), 0.35 + 0.65 * f), 0.5 + 0.5 * (rr / rad) * (0.55 + 0.45 * f));
      }
      // inner fill so the trunk does not show through
      if (t < tiers - 1) for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2 + t; near.quad([Math.cos(a) * rad * 0.3, y, Math.sin(a) * rad * 0.3], [Math.cos(a) * 0.5, 0.8, Math.sin(a) * 0.5], 0.5 + rad * 0.3, 0, leafCol(near.rnd(), 0.3), 0.4); }
    }
    near.quad([0, 10.35, 0], [0, 1, 0], 0.55, 0, leafCol(0.5, 1), 1);
    far.tube([{ p: [0, -0.4, 0], r: 0.3 }, { p: [0, 3.0, 0], r: 0.2 }], 4, bark, barkTop);
    for (let t = 0; t < 5; t++) {
      const f = t / 4, y = 2.4 + f * 7.4, rad = 2.5 * (1 - f * 0.84);
      for (let k = 0; k < 3; k++) {
        const a = k / 3 * Math.PI * 2 + t * 1.1;
        far.quad([Math.cos(a) * rad * 0.4, y, Math.sin(a) * rad * 0.4], [Math.cos(a) * 0.62, 0.72, Math.sin(a) * 0.62], 0.85 + rad * 0.6, 0, leafCol(far.rnd(), 0.35 + 0.65 * f), 0.7 + 0.3 * f);
      }
    }
    info = { trunkR: 0.3, height: 11 };
  } else if (name === 'giant') {
    const tr = [{ p: [0, -1.0, 0], r: 1.9 }, { p: [0, 0.6, 0], r: 1.25 }, { p: [0.1, 3.0, 0.1], r: 1.0 }, { p: [0.0, 7.0, 0.0], r: 0.85 }, { p: [-0.2, 11.0, 0.1], r: 0.7 }, { p: [0, 14.0, 0], r: 0.45 }];
    near.tube(tr, 9, bark, barkTop);
    const br = [[4.5, 13.5, 1.5], [-4.0, 14.0, -2.5], [1.0, 13.8, -4.6], [-1.8, 13.2, 4.4], [3.0, 15.5, -2.0]];
    for (const b of br) near.tube([{ p: [0, 10.5, 0], r: 0.42 }, { p: [b[0] * 0.5, b[1] - 1.6, b[2] * 0.5], r: 0.3 }, { p: b, r: 0.12 }], 5, bark, barkTop);
    const blobs = [{ c: [0, 16.0, 0], r: 4.6 }, { c: [5.0, 14.2, 1.6], r: 3.6 }, { c: [-4.6, 14.6, -2.8], r: 3.8 }, { c: [1.2, 14.4, -5.2], r: 3.4 }, { c: [-2.0, 13.8, 4.9], r: 3.5 }, { c: [3.2, 17.4, -2.2], r: 3.0 }, { c: [-2.2, 18.0, 1.2], r: 3.0 }];
    near.crown(blobs, 6.4, 0.72, 0, leafCol);
    far.tube([{ p: [0, -1.0, 0], r: 1.5 }, { p: [0, 12.5, 0], r: 0.6 }], 5, bark, barkTop);
    far.crown([{ c: [0, 16.0, 0], r: 5.2 }, { c: [4.4, 14.4, 1.2], r: 3.9 }, { c: [-4.2, 14.6, -2.2], r: 4.0 }, { c: [0, 14.2, 4.6], r: 3.6 }], 0.85, 1.05, 0, leafCol);
    info = { trunkR: 1.25, height: 21 };
  } else if (name === 'palm') {
    const path = [];
    for (let i = 0; i <= 6; i++) { const f = i / 6; path.push({ p: [Math.sin(f * 1.1) * 1.3, -0.4 + f * 7.2, 0], r: 0.26 - f * 0.1 }); }
    near.tube(path, 6, bark, barkTop);
    far.tube([path[0], path[3], path[6]], 4, bark, barkTop);
    const top = path[6].p;
    const fronds = 9;
    for (const [B, segs] of [[near, 4], [far, 2]]) {
      for (let k = 0; k < fronds; k++) {
        const a = k / fronds * Math.PI * 2 + 0.3;
        const dx = Math.cos(a), dz = Math.sin(a);
        const len = 3.6 + B.rnd() * 0.8, w = 0.95;
        const droop = 0.55 + B.rnd() * 0.3;
        let prev = null;
        for (let s = 0; s <= segs; s++) {
          const f = s / segs;
          const r = len * f, y = top[1] + 0.25 + Math.sin(f * 2.2) * 1.3 - f * f * len * droop;
          const c = [top[0] + dx * r, y, top[2] + dz * r];
          const l = [c[0] - dz * w, c[1], c[2] + dx * w], rg = [c[0] + dz * w, c[1], c[2] - dx * w];
          if (prev) {
            const u0 = 0.752, u1 = 0.998, v0 = 0.5 + 0.004 + (1 - (s - 1) / segs) * 0.492, v1 = 0.5 + 0.004 + (1 - f) * 0.492;
            B.card(prev.l, prev.rg, rg, l, [u0, v0], [u1, v1], [dx * 0.3, 0.95, dz * 0.3], leafCol(B.rnd(), 0.8), 0.85, B.rnd());
          }
          prev = { l, rg };
        }
      }
    }
    info = { trunkR: 0.26, height: 8 };
  } else if (name === 'bush') {
    const blobs = [{ c: [0, 0.55, 0], r: 0.85 }, { c: [0.6, 0.4, 0.2], r: 0.6 }, { c: [-0.5, 0.42, -0.3], r: 0.62 }, { c: [0.1, 0.4, -0.6], r: 0.55 }];
    near.crown(blobs, 26, 1.0, 0, leafCol);
    far.crown([{ c: [0, 0.55, 0], r: 1.0 }], 5, 1.25, 0, leafCol);
    info = { trunkR: 0, height: 1.4 };
  }
  return { near: near.build(), far: far.build(), ...info };
}

// ---------------------------------------------------------------- shader
const VERT = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_WORLD}
${GLSL_WIND}
${GLSL_SHADOW}
uniform vec3 uCamPos;
uniform vec4 uLod;         // x: fade start, y: fade end, z: 1 = fade out with distance (near LOD), -1 = fade in (far LOD), w: sway amount
uniform float uTreeH;
in vec2 aCorner;
in vec3 aParams;           // rand, ao, leaf flag (1 billboard leaf, 0.5 card, 0 solid)
in vec3 color;
out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec3 vColor;
out vec4 vMisc;            // ao, leaf flag, seed, shadow
void main() {
  vec3 ipos = instanceMatrix[3].xyz;
  float seed = hash12(ipos.xz);
  float iscale = length(instanceMatrix[0].xyz);
  float dCam = distance(ipos, uCamPos);
  float lod = uLod.z > 0.0 ? 1.0 - smoothstep(uLod.x, uLod.y, dCam) : smoothstep(uLod.x, uLod.y, dCam);
  if (lod <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 wc = instanceMatrix * vec4(position, 1.0);
  vec3 wn = normalize(mat3(instanceMatrix) * normal);
  // wind: whole-plant sway grows with height, leaves flutter on top
  float hrel = clamp(position.y / uTreeH, 0.0, 1.0);
  float gust = windGust(ipos.xz);
  float swayA = (gust * 0.55 + 0.12 * sin(uTime * 1.1 + seed * 6.28)) * uWind.z * uLod.w;
  wc.xz += uWind.xy * swayA * hrel * hrel * uTreeH * 0.085;
  float leaf = step(0.75, aParams.z);
  float r = aParams.x;
  if (aParams.z > 0.25) {
    float fl = sin(uTime * (1.7 + r * 1.6) + r * 40.0 + ipos.x) * (0.4 + gust);
    wc.xyz += vec3(fl * 0.05, cos(uTime * 1.3 + r * 20.0) * 0.03 * (0.5 + gust), fl * 0.04) * iscale * uLod.w;
  }
  vec4 vc = viewMatrix * wc;
  float rot = r * 6.2832 + sin(uTime * 0.8 + r * 17.0) * 0.12 * leaf;
  vec2 cr = rot2(rot) * aCorner;
  vc.xy += cr * iscale * lod * leaf;
  vWorldPos = wc.xyz;
  vNormal = wn;
  vUv = uv;
  vColor = color;
  float sh = 1.0;
#ifndef DEPTH_PASS
  sh = aParams.z > 0.25 ? getShadowFast(wc.xyz + wn * 0.6 * iscale) : 1.0;
#endif
  vMisc = vec4(aParams.y, aParams.z, seed, sh);
  gl_Position = projectionMatrix * vc;
}
`;

const FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_WORLD}
${GLSL_SHADOW}
${GLSL_FOG}
${GLSL_LIGHT}
uniform sampler2D uLeafTex;
uniform vec3 uLeafA, uLeafB, uLeafC;
uniform float uSnow;
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in vec3 vColor;
in vec4 vMisc;
out vec4 fragColor;
void main() {
  vec4 tx = texture(uLeafTex, vUv);
  float leafF = vMisc.y;
  float a = tx.a;
  float alpha = 1.0;
  if (leafF > 0.25) {
    alpha = clamp((a - 0.42) / max(fwidth(a), 1e-3) + 0.5, 0.0, 1.0);
    // leaves right in front of the lens melt away so the camera never drowns in foliage
    alpha *= smoothstep(2.9, 3.7, distance(cameraPosition, vWorldPos));
    if (alpha < 0.05) discard;
  }
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 col;
  float ndl = dot(N, uLightDir);
  if (leafF > 0.25) {
    // per-tree colour variation between the species' two leaf tints (+ rare third)
    float seed = vMisc.z;
    vec3 base = mix(uLeafA, uLeafB, smoothstep(0.2, 0.8, fract(seed * 7.31)));
    base = mix(base, uLeafC, step(0.82, fract(seed * 3.17)));
    base *= vColor * (0.82 + 0.3 * tx.r);
    // snow dusting on high-altitude trees
    float snow = uSnow * smoothstep(250.0, 330.0, vWorldPos.y) * smoothstep(0.1, 0.7, N.y);
    base = mix(base, vec3(0.78, 0.84, 0.92), snow);
    float shadow = mix(1.0, vMisc.w, 0.7) * cloudShadow(vWorldPos);
    float lit = smoothstep(-0.35, 0.5, ndl);
    float hi = smoothstep(0.45, 0.95, ndl);
    float ao = vMisc.x;
    vec3 shadeCol = base * vec3(0.52, 0.62, 0.78);              // cool shadow side
    vec3 c = mix(shadeCol, base, lit * shadow);
    c = mix(c, base * vec3(1.32, 1.24, 0.95), hi * shadow * 0.75);
    vec3 light = uLightColor * (0.22 + 0.78 * lit * shadow) + ambientLight(N) * ao;
    col = c * light;
    // sunlight glowing through the canopy edge
    float back = pow(max(dot(-V, uLightDir), 0.0), 3.0) * (1.0 - lit * 0.6);
    col += base * uLightColor * back * 0.55 * shadow * ao;
  } else {
    float shadow = getShadow(vWorldPos, N) * cloudShadow(vWorldPos);
    // painted bark on trunks and boughs (skipped on the green fill inside canopies)
    float bark = smoothstep(-0.05, 0.0, vColor.r - vColor.g);
    float pale = smoothstep(0.5, 0.7, luma(vColor));                    // birch
    vec2 T = normalize(vec2(-N.z, N.x) + vec2(1e-4));
    float u = dot(vWorldPos.xz, T), v = vWorldPos.y;
    float ridge = vnoise(vec2(u * 6.5, v * 0.8)) * 0.62 + vnoise(vec2(u * 15.0 + 3.1, v * 2.1)) * 0.38;
    float plate = smoothstep(0.36, 0.5, ridge);
    vec3 alb = vColor * mix(1.0, mix(0.6, 1.0, plate) * (1.0 + 0.24 * smoothstep(0.6, 0.72, ridge)), bark * (1.0 - pale * 0.75));
    alb *= 1.0 - bark * pale * 0.72 * step(0.8, vnoise(vec2(u * 2.6, v * 7.0)));                       // dark birch scars
    float foot = bark * (1.0 - pale) * smoothstep(1.6, 0.1, v - terrainHeight(vWorldPos.xz)) * smoothstep(0.35, 0.7, vnoise(vWorldPos.xz * 2.3 + v * 1.7));
    alb = mix(alb, vec3(0.2, 0.33, 0.1), foot * 0.75);                                                 // moss at the foot
    col = toonShade(alb, N, V, shadow, vMisc.x, 0.8);
    col += alb * uAmbSky * pow(1.0 - max(dot(N, V), 0.0), 2.0) * 0.6 * bark;                           // sky light wrapping round the trunk
  }
  col = applyFog(col, vWorldPos);
  fragColor = vec4(col, alpha);
}
`;

const DEPTH_FRAG = /* glsl */`
uniform sampler2D uLeafTex;
in vec2 vUv;
in vec4 vMisc;
void main() {
  if (vMisc.y > 0.25 && texture(uLeafTex, vUv).a < 0.42) discard;
}
`;

const LEAF_TINTS = {
  oak: [[0.105, 0.265, 0.045], [0.165, 0.315, 0.05], [0.24, 0.33, 0.06]],
  pine: [[0.035, 0.145, 0.075], [0.05, 0.185, 0.085], [0.045, 0.17, 0.10]],
  birch: [[0.22, 0.36, 0.06], [0.30, 0.40, 0.065], [0.42, 0.40, 0.07]],
  sakura: [[0.62, 0.25, 0.36], [0.70, 0.36, 0.46], [0.74, 0.50, 0.56]],
  maple: [[0.55, 0.12, 0.03], [0.66, 0.30, 0.035], [0.68, 0.48, 0.05]],
  palm: [[0.11, 0.30, 0.07], [0.16, 0.34, 0.07], [0.20, 0.36, 0.08]],
  giant: [[0.07, 0.215, 0.055], [0.10, 0.26, 0.05], [0.13, 0.28, 0.06]],
  bush0: [[0.10, 0.27, 0.05], [0.15, 0.31, 0.06], [0.19, 0.33, 0.07]],
  bush1: [[0.55, 0.20, 0.04], [0.62, 0.38, 0.05], [0.50, 0.12, 0.04]],
  bush2: [[0.16, 0.30, 0.08], [0.60, 0.28, 0.40], [0.66, 0.40, 0.50]],
  bush3: [[0.05, 0.17, 0.05], [0.07, 0.21, 0.06], [0.09, 0.22, 0.07]],
};

export class Flora {
  constructor(scene, gfx, world, quality = 2) {
    this.gfx = gfx;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.leafTex = makeLeafAtlas();
    this.nearEnd = quality >= 2 ? 190 : quality === 1 ? 140 : 100;
    this.bushEnd = quality >= 2 ? 240 : 150;
    this.cells = [];          // near cells: { x, z, meshes: [] }
    this.colliders = new Map();   // spatial hash of trunks for player collision
    const NEAR_CELL = 128, FAR_CELL = 512;
    const dummy = new THREE.Object3D();

    const makeMats = (tints, treeH, sway, snow) => {
      const uniforms = {
        ...shared(...U_LIGHT, ...U_SHADOW, ...U_WORLD, 'uWind', 'uCamPos'),
        uLeafTex: { value: this.leafTex },
        uLeafA: { value: new THREE.Color(...tints[0]) }, uLeafB: { value: new THREE.Color(...tints[1]) }, uLeafC: { value: new THREE.Color(...tints[2]) },
        uTreeH: { value: treeH }, uSnow: { value: snow },
      };
      const mk = (lod) => {
        const u = { ...uniforms, uLod: { value: lod } };
        const main = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide, alphaToCoverage: true });
        const depth = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: DEPTH_FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide, defines: { DEPTH_PASS: 1 }, colorWrite: false });
        return { main, depth };
      };
      return mk;
    };

    const addInstanced = (geo, mats, list, cast) => {
      // list: array of [x,y,z,scale,rot]
      const mesh = new THREE.InstancedMesh(geo, mats.main, list.length);
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        dummy.position.set(t[0], t[1], t[2]);
        dummy.rotation.set(0, t[4], 0);
        dummy.scale.setScalar(t[3]);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.boundingSphere.radius += 6;
      mesh.matrixAutoUpdate = false;
      mesh.userData.shadowMat = mats.depth;
      if (cast) gfx.addCaster(mesh);
      this.group.add(mesh);
      return mesh;
    };

    const bucket = (arr, cell) => {
      const map = new Map();
      for (let i = 0; i < arr.length; i += 6) {
        const x = arr[i], z = arr[i + 2];
        const key = Math.floor((x + WORLD.half) / cell) + Math.floor((z + WORLD.half) / cell) * 1000;
        let b = map.get(key);
        if (!b) { b = []; map.set(key, b); }
        b.push([x, arr[i + 1], z, arr[i + 3], arr[i + 4], arr[i + 5]]);
      }
      return map;
    };
    const nearCells = new Map();
    const cellOf = (key) => {
      let c = nearCells.get(key);
      if (!c) {
        const cx = key % 1000, cz = Math.floor(key / 1000);
        c = { x: (cx + 0.5) * NEAR_CELL - WORLD.half, z: (cz + 0.5) * NEAR_CELL - WORLD.half, meshes: [], bushes: [] };
        nearCells.set(key, c); this.cells.push(c);
      }
      return c;
    };

    // ---- trees
    this.treeCount = 0;
    TREE_SPECIES.forEach((name, si) => {
      const arr = world.veg.trees[si];
      if (!arr || !arr.length) return;
      this.treeCount += arr.length / 6;
      const sp = buildSpecies(name);
      const mk = makeMats(LEAF_TINTS[name], sp.height, name === 'palm' ? 1.6 : 1.0, name === 'pine' ? 1 : 0);
      const nearM = mk(new THREE.Vector4(this.nearEnd - 22, this.nearEnd, 1, 1));
      const farM = mk(new THREE.Vector4(this.nearEnd - 22, this.nearEnd, -1, 0.6));
      for (const [key, list] of bucket(arr, NEAR_CELL)) {
        const m = addInstanced(sp.near, nearM, list, true);
        m.visible = false;
        cellOf(key).meshes.push(m);
      }
      for (const [, list] of bucket(arr, FAR_CELL)) addInstanced(sp.far, farM, list, quality >= 1);
      // colliders
      for (let i = 0; i < arr.length; i += 6) this._addCollider(arr[i], arr[i + 2], sp.trunkR * arr[i + 3] + 0.12);
    });

    // ---- bushes (single LOD, fade out with distance)
    {
      const sp = buildSpecies('bush');
      const byKind = [[], [], [], []];
      const arr = world.veg.bushes;
      for (let i = 0; i < arr.length; i += 6) byKind[Math.min(3, Math.floor(arr[i + 5]))].push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3], arr[i + 4], arr[i + 5]);
      byKind.forEach((list, k) => {
        if (!list.length) return;
        const mk = makeMats(LEAF_TINTS['bush' + k], sp.height, 0.6, 0);
        const mats = mk(new THREE.Vector4(this.bushEnd - 40, this.bushEnd, 1, 0.5));
        for (const [key, l] of bucket(new Float32Array(list), NEAR_CELL)) {
          const m = addInstanced(sp.near, mats, l, true);
          m.visible = false;
          cellOf(key).bushes.push(m);
        }
      });
    }
  }

  _addCollider(x, z, r) {
    const key = Math.floor(x / 8) + Math.floor(z / 8) * 4096;
    let b = this.colliders.get(key);
    if (!b) { b = []; this.colliders.set(key, b); }
    b.push(x, z, r);
  }

  // push a circle (player) out of nearby trunks; returns true if moved
  collide(pos, radius) {
    let hit = false;
    const cx = Math.floor(pos.x / 8), cz = Math.floor(pos.z / 8);
    for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
      const b = this.colliders.get(i + j * 4096);
      if (!b) continue;
      for (let k = 0; k < b.length; k += 3) {
        const dx = pos.x - b[k], dz = pos.z - b[k + 1];
        const rr = b[k + 2] + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          pos.x += dx / d * (rr - d); pos.z += dz / d * (rr - d);
          hit = true;
        }
      }
    }
    return hit;
  }

  // nearest trunk hit along a horizontal ray (trunks as vertical cylinders); returns distance or -1
  raycastTrunks(ox, oz, dx, dz, maxDist, minR = 0.2) {
    let best = -1;
    const steps = Math.ceil(maxDist / 6) + 1, seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(maxDist, s * 6), cx = Math.floor((ox + dx * t) / 8), cz = Math.floor((oz + dz * t) / 8);
      for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
        const key = i + j * 4096;
        if (seen.has(key)) continue; seen.add(key);
        const b = this.colliders.get(key);
        if (!b) continue;
        for (let k = 0; k < b.length; k += 3) {
          const r = b[k + 2]; if (r < minR) continue;
          const px = b[k] - ox, pz = b[k + 1] - oz;
          const along = px * dx + pz * dz;
          if (along < 0 || along > maxDist + r) continue;
          const perp2 = px * px + pz * pz - along * along;
          if (perp2 > r * r) continue;
          const hit = along - Math.sqrt(r * r - perp2);
          if (hit > 0 && (best < 0 || hit < best)) best = hit;
        }
      }
    }
    return best;
  }

  update(camPos) {
    const nr = this.nearEnd + 96, br = this.bushEnd + 96;
    for (const c of this.cells) {
      const d = Math.hypot(c.x - camPos.x, c.z - camPos.z);
      const v = d < nr, vb = d < br;
      for (const m of c.meshes) m.visible = v;
      for (const m of c.bushes) m.visible = vb;
    }
  }
}

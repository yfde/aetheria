// World data container: owns the generated maps, uploads them as textures and answers CPU queries.
import * as THREE from 'three';
import { G } from '../core/globals.js';
import { WORLD, POI } from './layout.js';

const N = WORLD.res, CELL = WORLD.cell, HALF = WORLD.half;

export class World {
  constructor(data, renderer) {
    this.data = data;
    this.height = data.height;
    this.water = data.water;
    this.slopeY = data.slopeY;
    this.mask = data.maskTex;
    this.veg = data.veg;
    this.rivers = data.rivers;
    this.roads = data.roads;
    this.bridges = data.bridges;
    for (const k in data.poiY) POI[k].y = data.poiY[k];

    const gl = renderer.getContext();
    const floatLinear = !!gl.getExtension('OES_texture_float_linear');

    const hT = new THREE.DataTexture(data.height, N, N, THREE.RedFormat, THREE.FloatType);
    hT.minFilter = hT.magFilter = THREE.NearestFilter; hT.needsUpdate = true;

    const wT = new THREE.DataTexture(data.water, N, N, THREE.RedFormat, THREE.FloatType);
    wT.minFilter = wT.magFilter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter; wT.needsUpdate = true;

    const nT = new THREE.DataTexture(data.normalTex, N, N, THREE.RGBAFormat);
    nT.minFilter = THREE.LinearMipmapLinearFilter; nT.magFilter = THREE.LinearFilter; nT.generateMipmaps = true;
    nT.anisotropy = 4; nT.needsUpdate = true;

    const mT = new THREE.DataTexture(data.maskTex, N, N, THREE.RGBAFormat);
    mT.minFilter = THREE.LinearMipmapLinearFilter; mT.magFilter = THREE.LinearFilter; mT.generateMipmaps = true;
    mT.anisotropy = 4; mT.needsUpdate = true;

    const bT = new THREE.DataTexture(data.biomeTex, data.BN, data.BN, THREE.RGBAFormat);
    bT.minFilter = bT.magFilter = THREE.LinearFilter; bT.needsUpdate = true;

    G.uHeightTex.value = hT; G.uWaterTex.value = wT; G.uNormalTex.value = nT; G.uMaskTex.value = mT; G.uBiomeTex.value = bT;
    this.textures = { hT, wT, nT, mT, bT };
  }

  inBounds(x, z) { return x > -HALF + 4 && x < HALF - 6 && z > -HALF + 4 && z < HALF - 6; }

  _bil(arr, x, z) {
    let gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
    gx = gx < 0 ? 0 : gx > N - 1.001 ? N - 1.001 : gx;
    gz = gz < 0 ? 0 : gz > N - 1.001 ? N - 1.001 : gz;
    const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j;
    const o = j * N + i;
    const a = arr[o], b = arr[o + 1], c = arr[o + N], d = arr[o + N + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  heightAt(x, z) { return this._bil(this.height, x, z); }
  waterAt(x, z) { return this._bil(this.water, x, z); }

  // analytic normal of the bilinear surface (smoothed over one cell)
  normalAt(x, z, out) {
    const e = 1.0;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hu = this.heightAt(x, z - e), hd = this.heightAt(x, z + e);
    out.set(hl - hr, 2 * e, hu - hd).normalize();
    return out;
  }

  maskAt(x, z, channel) {
    const i = Math.min(N - 1, Math.max(0, Math.round((x + HALF) / CELL)));
    const j = Math.min(N - 1, Math.max(0, Math.round((z + HALF) / CELL)));
    return this.mask[(j * N + i) * 4 + channel] / 255;
  }

  // March a ray against the heightfield. Returns distance or -1.
  raycast(ox, oy, oz, dx, dy, dz, maxDist, step = 0.5) {
    let t = 0, prevT = 0;
    let prevAbove = oy - this.heightAt(ox, oz);
    if (prevAbove < 0) return 0;
    while (t < maxDist) {
      t = Math.min(maxDist, t + Math.max(step, prevAbove * 0.35));
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const above = y - this.heightAt(x, z);
      if (above < 0) {
        // binary refine
        let a = prevT, b = t;
        for (let k = 0; k < 8; k++) {
          const m = (a + b) * 0.5;
          if (oy + dy * m - this.heightAt(ox + dx * m, oz + dz * m) < 0) b = m; else a = m;
        }
        return a;
      }
      prevAbove = above; prevT = t;
    }
    return -1;
  }
}

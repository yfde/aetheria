// A wind-blown traveller's cape for the hero: a small verlet cloth pinned to the shoulders,
// colliding with the body, the ground and water. Simulated in world space so running drags it behind.
import * as THREE from 'three';
import { G } from '../core/globals.js';
import { makeToonMaterials, characterDepthMaterial } from './characters.js';
import { Builder, meshFrom, M } from '../world/structures.js';

const COLS = 9, ROWS = 11, LENGTH = 0.9, W_TOP = 0.3, W_BOTTOM = 0.76;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _back = new THREE.Vector3(), _up = new THREE.Vector3(), _q = new THREE.Quaternion(), _d = new THREE.Vector3();

export const HERO_PAL = { top: '#7a1420', mid: '#a81f2b', bottom: '#c0352f', trim: '#e9bf5a', emblem: '#f2cf6e', mantle: 0x8f1a25 };

function capeTexture(pal) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 384;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 384);
  g.addColorStop(0, pal.top); g.addColorStop(0.55, pal.mid); g.addColorStop(1, pal.bottom);
  c.fillStyle = g; c.fillRect(0, 0, 256, 384);
  // woven diagonal sheen
  c.globalAlpha = 0.07; c.strokeStyle = '#ffd9a0'; c.lineWidth = 2;
  for (let i = -384; i < 256; i += 14) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 384, 384); c.stroke(); }
  c.globalAlpha = 1;
  // gold trim
  c.strokeStyle = pal.trim; c.lineWidth = 9; c.strokeRect(9, 5, 238, 370);
  c.lineWidth = 2.5; c.strokeRect(22, 18, 212, 344);
  // scalloped hem
  c.fillStyle = pal.trim;
  for (let i = 0; i < 8; i++) { c.beginPath(); c.arc(16 + i * 32, 372, 9, Math.PI, 0); c.fill(); }
  if (pal.emblem) {
  // emblem: a rising sun-star
  c.save(); c.translate(128, 205);
  c.fillStyle = pal.emblem;
  for (let i = 0; i < 8; i++) { c.rotate(Math.PI / 4); c.beginPath(); c.moveTo(0, -62 + (i % 2) * 22); c.lineTo(9, -16); c.lineTo(-9, -16); c.closePath(); c.fill(); }
  c.beginPath(); c.arc(0, 0, 20, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.mid; c.beginPath(); c.arc(0, 0, 11, 0, Math.PI * 2); c.fill();
  c.strokeStyle = pal.emblem; c.lineWidth = 3; c.beginPath(); c.arc(0, 0, 76, 0, Math.PI * 2); c.stroke();
  c.restore();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class Cape {
  constructor(char, game, opts = {}) {
    this.char = char; this.game = game;
    const pal = opts.pal || HERO_PAL;
    const LEN = opts.length || LENGTH, WT = opts.wTop || W_TOP, WB = opts.wBottom || W_BOTTOM;
    const H = char.vrm.humanoid;
    this.bones = {};
    for (const n of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot']) this.bones[n] = H.getNormalizedBoneNode(n);
    this.backSign = char.v0 ? 1 : -1;
    const n = COLS * ROWS;
    this.p = new Float32Array(n * 3); this.prev = new Float32Array(n * 3);
    this.inited = false;
    const geo = new THREE.BufferGeometry();
    const uv = new Float32Array(n * 2), idx = [];
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      uv[(j * COLS + i) * 2] = i / (COLS - 1); uv[(j * COLS + i) * 2 + 1] = 1 - j / (ROWS - 1);
      if (i < COLS - 1 && j < ROWS - 1) { const a = j * COLS + i; idx.push(a, a + COLS, a + 1, a + 1, a + COLS, a + COLS + 1); }
    }
    this.posAttr = new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mats = makeToonMaterials(capeTexture(pal), { doubleSide: true, outline: 0, shared: char.uniforms, gain: 0.78, rim: 0.5 });
    this.mesh = new THREE.Mesh(geo, mats.main);
    this.mesh.frustumCulled = false; this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.shadowMat = characterDepthMaterial();
    game.gfx.scene.add(this.mesh);
    game.gfx.addCaster(this.mesh);

    // mantle over the shoulders with a clasp, so the cloth has something to hang from
    const top = H.getRawBoneNode('upperChest') || H.getRawBoneNode('chest');
    const neck = H.getRawBoneNode('neck');
    if (top && neck) {
      const b = new Builder();
      const z = this.backSign;      // local "back" axis sign
      const ring = new THREE.CylinderGeometry(0.066, 0.215, 0.115, 16, 1, true);
      b.add(ring, { p: [0, -0.012, 0.014 * z], s: [1, 1, 0.74], color: pal.mantle, mat: M.PLAIN });
      b.add(new THREE.TorusGeometry(0.215, 0.011, 5, 22), { p: [0, -0.07, 0.014 * z], r: [Math.PI / 2, 0, 0], s: [1, 0.74, 1], color: 0xe9bf5a, mat: M.METAL });
      b.add(new THREE.OctahedronGeometry(0.022, 0), { p: [0, -0.035, -0.135 * z], s: [1, 1.25, 0.6], color: 0x6fe8ff, mat: M.GLOW, emis: 3.5 });
      const m = meshFrom(b, game.gfx, true);
      m.matrixAutoUpdate = true; m.frustumCulled = false;
      m.position.copy(neck.position); m.position.y -= 0.035;
      top.add(m);
      this.mantle = m;
    }
    // rest lengths
    this.segV = LEN / (ROWS - 1);
    this.rowW = []; for (let j = 0; j < ROWS; j++) { const f = j / (ROWS - 1); this.rowW.push((WT + (WB - WT) * Math.pow(f, 0.8)) / (COLS - 1)); }
    this.colliders = [];
    for (let i = 0; i < 12; i++) this.colliders.push({ c: new THREE.Vector3(), r: 0.1 });
    this.anchor = new Float32Array(COLS * 3);
    this.t = 0;
  }

  reset() { this.inited = false; }

  _frame() {
    const B = this.bones, col = this.colliders;
    const chest = B.upperChest || B.chest;
    chest.getWorldQuaternion(_q);
    _back.set(0, 0, this.backSign).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    B.leftUpperArm.getWorldPosition(_a); B.rightUpperArm.getWorldPosition(_b);
    for (let i = 0; i < COLS; i++) {
      const u = 0.14 + 0.72 * (i / (COLS - 1));
      _c.lerpVectors(_a, _b, u).addScaledVector(_back, 0.068 + 0.03 * Math.sin(Math.PI * i / (COLS - 1))).addScaledVector(_up, 0.03);
      this.anchor[i * 3] = _c.x; this.anchor[i * 3 + 1] = _c.y; this.anchor[i * 3 + 2] = _c.z;
    }
    // body proxies
    let k = 0;
    const sphere = (bone, r, back = 0) => { bone.getWorldPosition(col[k].c); if (back) col[k].c.addScaledVector(_back, back); col[k].r = r; k++; };
    const mid = (b1, b2, r, f = 0.5) => { b1.getWorldPosition(_c); b2.getWorldPosition(_d); col[k].c.lerpVectors(_c, _d, f); col[k].r = r; k++; };
    sphere(B.hips, 0.145); sphere(B.spine, 0.135); sphere(B.chest, 0.14); sphere(B.head, 0.125);
    mid(B.leftUpperLeg, B.leftLowerLeg, 0.092, 0.3); mid(B.rightUpperLeg, B.rightLowerLeg, 0.092, 0.3);
    mid(B.leftUpperLeg, B.leftLowerLeg, 0.082, 0.75); mid(B.rightUpperLeg, B.rightLowerLeg, 0.082, 0.75);
    mid(B.leftLowerLeg, B.leftFoot, 0.065, 0.45); mid(B.rightLowerLeg, B.rightFoot, 0.065, 0.45);
    mid(B.leftLowerLeg, B.leftFoot, 0.06, 0.9); mid(B.rightLowerLeg, B.rightFoot, 0.06, 0.9);
    this.nCol = k;
  }

  update(dt) {
    const vis = this.char.group.visible !== false;
    this.mesh.visible = vis;
    if (!vis) { this.inited = false; return; }
    const p = this.p, prev = this.prev, A = this.anchor;
    this._frame();
    if (!this.inited) {
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const o = (j * COLS + i) * 3;
        p[o] = A[i * 3] + _back.x * j * 0.012; p[o + 1] = A[i * 3 + 1] - j * this.segV; p[o + 2] = A[i * 3 + 2] + _back.z * j * 0.012;
        prev[o] = p[o]; prev[o + 1] = p[o + 1]; prev[o + 2] = p[o + 2];
      }
      this.inited = true;
    }
    dt = Math.min(dt, 0.033);
    if (dt <= 0) return;
    this.t += dt;
    const world = this.game.world, wind = G.uWind.value;
    const SUB = 2, h = dt / SUB, t = this.t;
    const gust = 0.55 + 0.45 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1.3);
    const wx = wind.x * wind.z * 3.2 * gust, wz = wind.y * wind.z * 3.2 * gust;
    // a far teleport: start over
    if (Math.abs(p[0] - A[0]) + Math.abs(p[1] - A[1]) + Math.abs(p[2] - A[2]) > 3) { this.inited = false; return this.update(dt); }
    for (let s = 0; s < SUB; s++) {
      for (let j = 1; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const o = (j * COLS + i) * 3;
        const fl = Math.sin(t * 5.1 + j * 0.9 + i * 0.7) * 1.3 + Math.sin(t * 8.3 + j * 1.7) * 0.7;
        const vx = (p[o] - prev[o]) * 0.9935, vy = (p[o + 1] - prev[o + 1]) * 0.9935, vz = (p[o + 2] - prev[o + 2]) * 0.9935;
        prev[o] = p[o]; prev[o + 1] = p[o + 1]; prev[o + 2] = p[o + 2];
        const f = j / (ROWS - 1);
        p[o] += vx + (wx + _back.x * 0.5 + fl * wind.y * 0.9 * f) * h * h;
        p[o + 1] += vy + (-13.0 + Math.abs(fl) * 0.5 * f) * h * h;
        p[o + 2] += vz + (wz + _back.z * 0.5 - fl * wind.x * 0.9 * f) * h * h;
      }
      for (let it = 0; it < 4; it++) {
        // pins
        for (let i = 0; i < COLS; i++) { p[i * 3] = A[i * 3]; p[i * 3 + 1] = A[i * 3 + 1]; p[i * 3 + 2] = A[i * 3 + 2]; }
        // vertical + horizontal distance constraints
        for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
          const o = (j * COLS + i) * 3;
          if (j > 0) this._link(o - COLS * 3, o, this.segV, j === 1);
          if (i > 0) this._link(o - 3, o, this.rowW[j], false);
        }
      }
      // collisions
      for (let j = 1; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const o = (j * COLS + i) * 3;
        for (let k = 0; k < this.nCol; k++) {
          const c = this.colliders[k], dx = p[o] - c.c.x, dy = p[o + 1] - c.c.y, dz = p[o + 2] - c.c.z;
          const d2 = dx * dx + dy * dy + dz * dz, rr = c.r + 0.018;
          if (d2 < rr * rr && d2 > 1e-8) { const d = Math.sqrt(d2), m = (rr - d) / d; p[o] += dx * m; p[o + 1] += dy * m; p[o + 2] += dz * m; }
        }
        const gy = Math.max(world.heightAt(p[o], p[o + 2]) + 0.03, world.waterAt(p[o], p[o + 2]) - 0.04);
        if (p[o + 1] < gy) { p[o + 1] = gy; prev[o] += (p[o] - prev[o]) * 0.5; prev[o + 2] += (p[o + 2] - prev[o + 2]) * 0.5; }
      }
    }
    this.posAttr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }

  _link(a, b, rest, pinnedA) {
    const p = this.p;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const m = (d - rest) / d;
    if (pinnedA) { p[b] -= dx * m; p[b + 1] -= dy * m; p[b + 2] -= dz * m; }
    else { const hm = m * 0.5; p[a] += dx * hm; p[a + 1] += dy * hm; p[a + 2] += dz * hm; p[b] -= dx * hm; p[b + 1] -= dy * hm; p[b + 2] -= dz * hm; }
  }
}

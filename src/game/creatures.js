// Wildlife: Quaternius' animated animals (CC0) roam the island. Deer and stags graze the meadows and bolt when
// approached, foxes slip through the woods, wild horses keep to open ground, cattle and a friendly dog live in
// Hearthvale, and wolf packs (hostile, handled by the enemy manager) hunt in the deep woods and the snow.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadModel, createCharacter, Animator } from './characters.js';
import { POI, WORLD, BIOME } from '../world/layout.js';
import { biomeWeights } from '../world/worldgen.js';
import { mulberry32 } from '../world/noise.js';

const DIR = './assets/models/creatures/';
// h: height in metres (top of the model), shy: distance at which it bolts (0 = never), r: body radius
export const SPECIES = {
  deer: { file: 'Deer.glb', h: 1.32, walk: 1.2, run: 9.5, shy: 13, r: 0.45, walkRef: 1.25, runRef: 8.5 },
  stag: { file: 'Stag.glb', h: 1.78, walk: 1.2, run: 9.5, shy: 14, r: 0.5, walkRef: 1.3, runRef: 8.5 },
  fox: { file: 'Fox.glb', h: 0.6, walk: 1.4, run: 8.5, shy: 11, r: 0.3, walkRef: 1.2, runRef: 7 },
  horse: { file: 'Horse_White.glb', h: 1.95, walk: 1.5, run: 11, shy: 8, r: 0.6, walkRef: 1.5, runRef: 10 },
  cow: { file: 'Cow.glb', h: 1.5, walk: 0.8, run: 4, shy: 0, r: 0.75, walkRef: 1.0, runRef: 5 },
  dog: { file: 'ShibaInu.glb', h: 0.56, walk: 1.5, run: 6.5, shy: 0, r: 0.28, friendly: true, walkRef: 1.2, runRef: 6 },
  wolf: { file: 'Wolf.glb', h: 0.88, walk: 1.5, run: 7.4, shy: 0, r: 0.42, walkRef: 1.4, runRef: 7.5, gain: 1.25 },
};

const TAU = Math.PI * 2;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };
const _box = new THREE.Box3(), _v = new THREE.Vector3();

// The packs ship as several flat-coloured primitives per animal. Merge them into one skinned mesh that reads its
// colours from a tiny palette texture, smooth the normals for the toon ramp and measure the model for scaling.
function prepare(gltf, sp) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const parts = [];
  scene.traverse((o) => { if (o.isSkinnedMesh) parts.push(o); });
  const colors = [];
  const geos = parts.map((m) => {
    const c = m.material.color;
    let ci = colors.findIndex((k) => k.equals(c));
    if (ci < 0) { ci = colors.length; colors.push(c.clone()); }
    const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'skinIndex', 'skinWeight']) g.setAttribute(k, src.attributes[k]);
    g.userData.ci = ci;
    return g;
  });
  const N = Math.max(2, colors.length);
  const px = new Uint8Array(N * 4);
  const gain = sp.gain || 1.12;
  colors.forEach((c, i) => {
    const s = c.clone().multiplyScalar(gain).convertLinearToSRGB();
    px[i * 4] = Math.min(255, s.r * 255); px[i * 4 + 1] = Math.min(255, s.g * 255); px[i * 4 + 2] = Math.min(255, s.b * 255); px[i * 4 + 3] = 255;
  });
  const palette = new THREE.DataTexture(px, N, 1, THREE.RGBAFormat);
  palette.colorSpace = THREE.SRGBColorSpace; palette.magFilter = palette.minFilter = THREE.NearestFilter; palette.needsUpdate = true;
  for (const g of geos) {
    const n = g.attributes.position.count, uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = (g.userData.ci + 0.5) / N; uv[i * 2 + 1] = 0.5; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
  // smooth normals: average the face normals of all vertices sharing a position
  {
    const P = merged.attributes.position, Nn = merged.attributes.normal, acc = new Map();
    const key = (i) => `${Math.round(P.getX(i) * 4e4)},${Math.round(P.getY(i) * 4e4)},${Math.round(P.getZ(i) * 4e4)}`;
    const keys = new Array(P.count);
    for (let i = 0; i < P.count; i++) {
      const k = keys[i] = key(i);
      let a = acc.get(k); if (!a) { a = [0, 0, 0]; acc.set(k, a); }
      a[0] += Nn.getX(i); a[1] += Nn.getY(i); a[2] += Nn.getZ(i);
    }
    const out = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) { const a = acc.get(keys[i]), l = Math.hypot(a[0], a[1], a[2]) || 1; out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l; }
    merged.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  }
  const body = new THREE.SkinnedMesh(merged, new THREE.MeshBasicMaterial({ map: palette }));
  body.name = 'Body';
  body.bind(parts[0].skeleton, parts[0].bindMatrix);
  parts[0].parent.add(body);
  for (const m of parts) m.parent.remove(m);
  scene.updateMatrixWorld(true);
  body.computeBoundingBox();
  _box.copy(body.boundingBox).applyMatrix4(body.matrixWorld);
  const height = Math.max(0.01, _box.max.y - _box.min.y);
  const animations = gltf.animations.map((c) => { const k = c.clone(); k.name = c.name.replace(/^.*\|/, ''); return k; });
  return { scene, animations, scale: sp.h / height, length: (_box.max.z - _box.min.z) * sp.h / height };
}

const tplCache = {};
export function creatureTemplate(key) {
  if (!tplCache[key]) tplCache[key] = loadModel(DIR + SPECIES[key].file).then((g) => prepare(g, SPECIES[key]));
  return tplCache[key];
}

// shared body motion: follow the ground, lean the spine along the slope
function settle(self, w, dt) {
  const fx = Math.sin(self.yaw), fz = Math.cos(self.yaw), L = self.len * 0.4;
  self.pos.y = w.heightAt(self.pos.x, self.pos.z);
  const hf = w.heightAt(self.pos.x + fx * L, self.pos.z + fz * L), hb = w.heightAt(self.pos.x - fx * L, self.pos.z - fz * L);
  const pitch = Math.max(-0.5, Math.min(0.5, Math.atan2(hf - hb, L * 2)));
  self.pitch += (pitch - self.pitch) * Math.min(1, dt * 6);
  const g = self.char.group;
  g.position.copy(self.pos);
  g.rotation.set(-self.pitch, self.yaw, 0, 'YXZ');
}
function walkable(w, x, z, y) {
  const h = w.heightAt(x, z);
  return w.waterAt(x, z) < h + 0.15 && Math.abs(h - y) < 1.1;
}

class Animal {
  constructor(mgr, key, x, z, herd, rnd) {
    const g = mgr.game, sp = SPECIES[key], tpl = mgr.tpl[key];
    this.mgr = mgr; this.key = key; this.sp = sp; this.herd = herd;
    this.size = 0.9 + rnd() * 0.2;
    this.char = createCharacter(tpl, g.gfx, { scale: tpl.scale * this.size, outline: false, rim: 0.7 });
    this.anim = new Animator(this.char);
    this.len = tpl.length * this.size;
    this.pos = new THREE.Vector3(x, g.world.heightAt(x, z), z);
    this.yaw = rnd() * TAU; this.pitch = 0;
    this.state = 'idle'; this.t = rnd() * 4; this.wait = 2 + rnd() * 6; this.target = null; this.fleeT = 0;
    this.rnd = rnd;
    g.gfx.scene.add(this.char.group);
    this.anim.play(rnd() < 0.5 ? 'Eating' : 'Idle', { fade: 0, startAt: rnd() * 2 });
    settle(this, g.world, 1);
  }
  alarm(from) {
    if (this.sp.shy <= 0 || this.state === 'flee') return;
    this.state = 'flee'; this.t = 0; this.fleeT = 3.5 + this.rnd() * 2.5;
    this.yaw = Math.atan2(this.pos.x - from.x, this.pos.z - from.z) + (this.rnd() - 0.5) * 0.9;
  }
  update(dt, player) {
    const g = this.mgr.game, w = g.world, sp = this.sp, rnd = this.rnd;
    this.t += dt;
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z, dist = Math.hypot(dx, dz);
    const pv = player.vel ? Math.hypot(player.vel.x, player.vel.z) : 0;
    let speed = 0, wantYaw = this.yaw, turn = 3;
    if (sp.shy > 0 && this.state !== 'flee') {
      const near = Math.abs(player.pos.y - this.pos.y) < 6;
      if (near && dist < sp.shy * (pv > 5.5 ? 1.25 : pv < 0.5 ? 0.6 : 1)) { for (const a of this.herd.members) a.alarm(player.pos); }
      else if (near && dist < sp.shy * 1.9 && this.state !== 'alert') { this.state = 'alert'; this.t = 0; this.anim.play('Idle', { fade: 0.25 }); }
    }
    if (this.state === 'alert') {
      wantYaw = Math.atan2(dx, dz); turn = 2.5;
      if (dist > sp.shy * 2.2 || this.t > 6) { this.state = 'idle'; this.t = 0; this.wait = 1 + rnd() * 3; }
    } else if (this.state === 'idle') {
      if (sp.friendly && dist < 16 && dist > 3.2 && g.state === 'play') { this.state = 'follow'; }
      else if (this.t > this.wait) {
        this.t = 0;
        if (rnd() < 0.55) {
          const a = rnd() * TAU, r = 2 + rnd() * this.herd.r;
          this.target = { x: this.herd.x + Math.cos(a) * r, z: this.herd.z + Math.sin(a) * r };
          this.state = 'walk';
        } else { this.wait = 3 + rnd() * 7; this.anim.play(['Eating', 'Idle', 'Idle_2'][Math.floor(rnd() * 3)], { fade: 0.4 }); }
      }
      if (sp.friendly && dist < 3.2) { wantYaw = Math.atan2(dx, dz); this.anim.play('Idle_2', { fade: 0.3 }); }
    } else if (this.state === 'walk') {
      const tx = this.target.x - this.pos.x, tz = this.target.z - this.pos.z;
      if (Math.hypot(tx, tz) < 0.8 || this.t > 14) { this.state = 'idle'; this.t = 0; this.wait = 2 + rnd() * 6; this.anim.play(rnd() < 0.6 ? 'Eating' : 'Idle', { fade: 0.4 }); }
      else { wantYaw = Math.atan2(tx, tz); speed = sp.walk; this.anim.play('Walk', { fade: 0.3, speed: sp.walk / sp.walkRef }); }
    } else if (this.state === 'follow') {
      const hd = Math.hypot(this.pos.x - this.herd.x, this.pos.z - this.herd.z);
      if (dist < 2.8 || dist > 22 || hd > 70) { this.state = 'idle'; this.t = 0; this.wait = dist < 3 ? 1.5 : 0.2; this.anim.play('Idle', { fade: 0.25 }); if (hd > 70) { this.target = { x: this.herd.x, z: this.herd.z }; this.state = 'walk'; } }
      else { wantYaw = Math.atan2(dx, dz); turn = 6; const fast = dist > 7; speed = fast ? sp.run : sp.walk * 1.4; this.anim.play(fast ? 'Gallop' : 'Walk', { fade: 0.2, speed: fast ? sp.run / sp.runRef : 1.4 * sp.walk / sp.walkRef }); }
    } else if (this.state === 'flee') {
      speed = sp.run; turn = 5;
      // keep running away, curving off if the player keeps coming
      if (dist < sp.shy * 2.5) wantYaw = Math.atan2(-dx, -dz) + Math.sin(this.t * 1.3 + this.size * 40) * 0.35;
      this.anim.play('Gallop', { fade: 0.15, speed: sp.run / sp.runRef });
      if (this.t > this.fleeT && dist > sp.shy * 2.6) {
        this.state = 'idle'; this.t = 0; this.wait = 2 + rnd() * 3; this.anim.play('Idle', { fade: 0.35 });
        this.herd.x += (this.pos.x - this.herd.x) * 0.5; this.herd.z += (this.pos.z - this.herd.z) * 0.5;      // the herd settles where it ran to
      }
    }
    this.yaw += angDiff(wantYaw, this.yaw) * Math.min(1, dt * turn);
    if (speed > 0) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const nx = this.pos.x + fx * speed * dt, nz = this.pos.z + fz * speed * dt;
      if (walkable(w, nx + fx * 1.2, nz + fz * 1.2, this.pos.y)) { this.pos.x = nx; this.pos.z = nz; }
      else if (this.state === 'flee') this.yaw += (this.size > 1 ? 1 : -1) * dt * 4;                              // swerve along the bank or cliff
      else { this.state = 'idle'; this.t = 0; this.wait = 1 + rnd() * 3; this.anim.play('Idle', { fade: 0.3 }); }
      if (g.flora) g.flora.collide(this.pos, sp.r);
    }
    this.anim.update(dt);
    settle(this, w, dt);
  }
  dispose() { this.char.dispose(); }
}

// Hostile wolf: stalks, lunges and bites. Speaks the same interface as the other enemies (see enemies.js).
export class Wolf {
  constructor(mgr, kind, x, z) {
    const g = mgr.game, sp = SPECIES.wolf, tpl = g.wildlife.tpl.wolf;
    this.mgr = mgr; this.kind = kind; this.type = 'wolf'; this.sp = sp;
    const white = kind === 'frost';
    this.K = { hp: white ? 7 : 5, dmg: white ? 3 : 2, speed: sp.run, coins: white ? 5 : 3 };
    this.size = white ? 1.12 : 0.95 + Math.random() * 0.12;
    this.char = createCharacter(tpl, g.gfx, { scale: tpl.scale * this.size, outline: false, rim: 0.7, tint: white ? 0xdfe6f2 : 0xffffff, gain: white ? 2.1 : 1 });
    this.anim = new Animator(this.char);
    this.len = tpl.length * this.size;
    this.pos = new THREE.Vector3(x, g.world.heightAt(x, z), z);
    this.home = this.pos.clone(); this.vel = new THREE.Vector3();
    this.hp = this.maxHp = this.K.hp;
    this.radius = 0.5; this.height = sp.h * this.size;
    this.yaw = Math.random() * TAU; this.pitch = 0;
    this.state = 'idle'; this.t = 0; this.barT = 0; this.dead = false;
    this.attackCd = 0.4 + Math.random(); this.wanderT = Math.random() * 3; this.wander = null; this.side = Math.random() < 0.5 ? 1 : -1;
    g.gfx.scene.add(this.char.group);
    this.anim.play('Idle', { fade: 0 });
    settle(this, g.world, 1);
  }
  takeHit(dmg, dx, dz, knock) {
    if (this.dead) return;
    this.hp -= dmg; this.barT = 4;
    this.char.uniforms.uFlash.value.setRGB(1, 1, 1);
    if (this.hp <= 0) { this.die(dx, dz); return; }
    this.vel.set(dx * knock, 0, dz * knock);
    this.state = 'hit'; this.t = 0;
    this.anim.play(Math.random() < 0.5 ? 'Idle_HitReact_Left' : 'Idle_HitReact_Right', { loop: false, fade: 0.05, restart: true });
  }
  die(dx, dz) {
    const g = this.mgr.game;
    this.dead = true; this.state = 'dead'; this.t = 0;
    this.vel.set(dx * 3, 0, dz * 3);
    this.anim.play('Death', { loop: false, fade: 0.1 });
    g.audio && g.audio.sfx('enemyDie');
    this.mgr.drop(this, this.K.coins);
  }
  update(dt, player, dist) {
    const g = this.mgr.game, w = g.world, K = this.K;
    this.t += dt; this.barT -= dt; this.attackCd -= dt;
    this.char.uniforms.uFlash.value.multiplyScalar(Math.exp(-dt * 10));
    const alive = player.action !== 'dead';
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    let move = 0, wantYaw = this.yaw, turn = 6;
    if (this.state === 'dead') {
      if (this.t > 1.6) this.char.uniforms.uDissolve.value = Math.min(1, (this.t - 1.6) / 0.9);
      if (this.t > 2.6) { this.remove = true; this.dispose(); return; }
    } else if (this.state === 'hit') {
      if (this.t > 0.45) this.state = 'chase';
    } else if (this.state === 'idle') {
      if (dist < 19 && alive && Math.abs(player.pos.y - this.pos.y) < 7) this.state = 'chase';
      else {
        this.wanderT -= dt;
        if (this.wanderT <= 0) { this.wanderT = 3 + Math.random() * 5; const a = Math.random() * TAU, r = Math.random() * 7; this.wander = Math.random() < 0.6 ? { x: this.home.x + Math.cos(a) * r, z: this.home.z + Math.sin(a) * r } : null; }
        if (this.wander) {
          const wx = this.wander.x - this.pos.x, wz = this.wander.z - this.pos.z;
          if (Math.hypot(wx, wz) < 0.6) this.wander = null; else { wantYaw = Math.atan2(wx, wz); move = 1.4; turn = 3; }
        }
        this.anim.play(move > 0 ? 'Walk' : 'Idle', { fade: 0.3, speed: move > 0 ? 1.4 / this.sp.walkRef : 1 });
      }
    } else if (this.state === 'chase') {
      const homeD = Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z);
      if (!alive || dist > 36 || homeD > 60) this.state = 'return';
      else {
        const toP = Math.atan2(dx, dz);
        if (dist < 2.3 && this.attackCd <= 0) { this.state = 'attack'; this.t = 0; this.didHit = false; this.anim.play('Attack', { loop: false, fade: 0.1, restart: true, speed: 1.25 }); wantYaw = toP; }
        else if (dist > 5.5 || this.attackCd <= 0.25) { wantYaw = toP; move = K.speed; this.anim.play('Gallop', { fade: 0.15, speed: K.speed / this.sp.runRef }); }
        else { wantYaw = toP + this.side * 1.25; move = 2.6; turn = 4; this.anim.play('Walk', { fade: 0.2, speed: 2.6 / this.sp.walkRef }); }      // circle between bites
      }
    } else if (this.state === 'attack') {
      const p = this.anim.progress();
      if (p < 0.3) wantYaw = Math.atan2(dx, dz);
      if (p > 0.22 && p < 0.5) move = 4.6;
      if (!this.didHit && p > 0.42) {
        this.didHit = true;
        const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), dot = (dx * fx + dz * fz) / Math.max(dist, 0.01);
        if (dist < 2.4 && dot > 0.3 && Math.abs(player.pos.y - this.pos.y) < 1.6) player.takeDamage(K.dmg, this.pos, 4.5);
        g.audio && g.audio.sfx('swing', 0);
      }
      if (p > 0.92) { this.state = 'chase'; this.attackCd = 1.3 + Math.random() * 1.2; this.side = -this.side; }
    } else if (this.state === 'return') {
      const hx = this.home.x - this.pos.x, hz = this.home.z - this.pos.z;
      if (Math.hypot(hx, hz) < 1.5) { this.state = 'idle'; this.hp = this.maxHp; }
      else { wantYaw = Math.atan2(hx, hz); move = K.speed * 0.7; this.anim.play('Gallop', { fade: 0.2, speed: K.speed * 0.7 / this.sp.runRef }); }
      if (dist < 10 && alive) this.state = 'chase';
    }
    this.yaw += angDiff(wantYaw, this.yaw) * Math.min(1, dt * turn);
    this.vel.x *= Math.exp(-dt * 6); this.vel.z *= Math.exp(-dt * 6);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const nx = this.pos.x + (fx * move + this.vel.x) * dt, nz = this.pos.z + (fz * move + this.vel.z) * dt;
    if (walkable(w, nx, nz, this.pos.y)) { this.pos.x = nx; this.pos.z = nz; }
    if (g.flora) g.flora.collide(this.pos, this.sp.r);
    // keep the pack from standing inside one another
    for (const o of this.mgr.list) {
      if (o === this || o.dead || o.type !== 'wolf') continue;
      const sx = this.pos.x - o.pos.x, sz = this.pos.z - o.pos.z, d = Math.hypot(sx, sz);
      if (d < 1.2 && d > 1e-3) { const k = (1.2 - d) * 0.5 / d; this.pos.x += sx * k; this.pos.z += sz * k; }
    }
    this.anim.update(dt);
    settle(this, w, dt);
  }
  dispose() { this.char.dispose(); }
}

export class Wildlife {
  constructor(game) { this.game = game; this.tpl = {}; this.herds = []; this.t = 0; }
  async load() {
    const keys = Object.keys(SPECIES);
    const tpls = await Promise.all(keys.map((k) => creatureTemplate(k)));
    keys.forEach((k, i) => { this.tpl[k] = tpls[i]; });
  }
  addHerd(x, z, members, r = 10, seed = 1) { this.herds.push({ x, z, x0: x, z0: z, r, kinds: members, members: [], active: false, seed }); }
  // scatter herds over the island by biome; wolf packs go to the enemy manager
  populate() {
    const g = this.game, w = g.world, en = g.enemies;
    const rnd = mulberry32(WORLD.seed ^ 0x77a1);
    const bw = new Float32Array(8), spots = [];
    const avoid = [[POI.village.x, POI.village.z, 150], [POI.spawn.x, POI.spawn.z, 40], [POI.temple.x, POI.temple.z, 85], [POI.skyTower.x, POI.skyTower.z, 30]];
    for (const k of ['campNorth', 'campForest', 'campEast', 'emberCamp', 'ruinsWest', 'shrineForest', 'shrineCoast', 'shrinePeak']) avoid.push([POI[k].x, POI[k].z, 55]);
    const flat = (x, z, y) => Math.abs(w.heightAt(x + 4, z) - y) < 1.6 && Math.abs(w.heightAt(x - 4, z) - y) < 1.6 && Math.abs(w.heightAt(x, z + 4) - y) < 1.6 && Math.abs(w.heightAt(x, z - 4) - y) < 1.6;
    let herds = 0, packs = 0, tries = 0;
    const place = (x, z, minD) => {
      const y = w.heightAt(x, z);
      if (y < 3.5 || w.waterAt(x, z) > y - 0.4 || !flat(x, z, y)) return null;
      for (const a of avoid) if (Math.hypot(x - a[0], z - a[1]) < a[2]) return null;
      for (const s of spots) if (Math.hypot(x - s[0], z - s[1]) < minD) return null;
      return y;
    };
    // a small herd close to where the journey starts, on the way to the overlook
    for (let i = 0; i < 60; i++) {
      const x = POI.spawn.x + (rnd() - 0.5) * 120, z = POI.spawn.z - 60 - rnd() * 90;
      if (place(x, z, 60) === null || w.maskAt(x, z, 0) < 0.6) continue;
      this.addHerd(x, z, ['deer', 'deer', 'stag'], 9, 5); spots.push([x, z]); break;
    }
    while ((herds < 34 || packs < 9) && tries++ < 9000) {
      const x = (rnd() - 0.5) * 3300, z = (rnd() - 0.5) * 3300;
      const y = place(x, z, 115);
      if (y === null) continue;
      biomeWeights(x, z, y, bw);
      const snow = y > 215, grass = w.maskAt(x, z, 0) > 0.55;
      const forest = bw[BIOME.FOREST] > 0.5 || bw[BIOME.MYSTIC] > 0.5;
      if ((snow || (forest && rnd() < 0.3)) && packs < 9) {
        const n = 2 + Math.floor(rnd() * 2);
        for (let i = 0; i < n; i++) { const a = rnd() * TAU; en.addSpawn('wolf', snow ? 'frost' : 'grey', x + Math.cos(a) * 3.5, z + Math.sin(a) * 3.5); }
        packs++; spots.push([x, z]);
        continue;
      }
      if (snow || !grass || herds >= 34 || bw[BIOME.BEACH] > 0.4) continue;
      const r = rnd();
      let kinds;
      if (forest) kinds = r < 0.45 ? ['fox'] : r < 0.75 ? ['stag', 'deer'] : ['deer', 'deer'];
      else if (bw[BIOME.AUTUMN] > 0.5) kinds = r < 0.5 ? ['fox', 'fox'] : ['stag', 'deer', 'deer'];
      else kinds = r < 0.42 ? ['stag', 'deer', 'deer', 'deer'].slice(0, 3 + Math.floor(rnd() * 2)) : r < 0.7 ? ['horse', 'horse', 'horse'].slice(0, 2 + Math.floor(rnd() * 2)) : r < 0.88 ? ['fox'] : ['deer', 'deer'];
      this.addHerd(x, z, kinds, 8 + kinds.length * 2, herds + 11);
      herds++; spots.push([x, z]);
    }
    // Hearthvale: cattle in the windmill pasture, a horse by the road, and the village dog
    const v = POI.village, wm = POI.windmill;
    this.addHerd(wm.x + 16, wm.z + 10, ['cow', 'cow', 'cow'], 9, 2);
    this.addHerd(v.x - 52, v.z + 40, ['horse'], 5, 3);
    this.addHerd(v.x + 5, v.z + 9, ['dog'], 7, 4);
    this.stats = { herds: this.herds.length, packs };
  }
  _activate(h) {
    const g = this.game, w = g.world;
    const rnd = mulberry32(h.seed * 977 + 13);
    h.active = true; h.x = h.x0; h.z = h.z0;
    for (const key of h.kinds) {
      for (let t = 0; t < 14; t++) {
        const a = rnd() * TAU, r = 1.5 + rnd() * h.r, x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r, y = w.heightAt(x, z);
        if (w.waterAt(x, z) > y - 0.2 || Math.abs(y - w.heightAt(h.x, h.z)) > 2.5) continue;
        h.members.push(new Animal(this, key, x, z, h, rnd));
        break;
      }
    }
  }
  _deactivate(h) { for (const a of h.members) a.dispose(); h.members.length = 0; h.active = false; }
  update(dt) {
    const p = this.game.player;
    this.t += dt;
    if (this.t > 0.5) {
      this.t = 0;
      for (const h of this.herds) {
        const d = Math.hypot(h.x - p.pos.x, h.z - p.pos.z);
        if (!h.active && d < 135) this._activate(h);
        else if (h.active && d > 185) this._deactivate(h);
      }
    }
    for (const h of this.herds) if (h.active) for (const a of h.members) a.update(dt, p);
  }
}

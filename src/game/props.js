// Interactive world objects: chests, spirit orbs, pickups (coins / hearts / apples), pots, campfires
// and the generic "press E" interaction system.
import * as THREE from 'three';
import { Builder, meshFrom, M } from '../world/structures.js';
import { mulberry32 } from '../world/noise.js';
import { POI, WORLD } from '../world/layout.js';
import { loadModel } from './characters.js';

const _v = new THREE.Vector3();
const WOODC = 0x7a4e2a, WOOD_D = 0x4a2f1a, GOLD = 0xffc45a, CYAN = 0x8fe9ff;

function chestMeshes(gfx, rare) {
  const band = rare ? 0xffd870 : 0xb9b3a4, body = rare ? 0x35517d : WOODC;
  const b = new Builder();
  b.box(0, 0.32, 0, 1.1, 0.64, 0.74, { color: body, mat: M.WOOD });
  for (const x of [-0.42, 0, 0.42]) b.box(x, 0.32, 0, 0.1, 0.68, 0.78, { color: band, mat: M.PLAIN });
  b.box(0, 0.05, 0, 1.18, 0.1, 0.82, { color: WOOD_D, mat: M.WOOD });
  const base = meshFrom(b, gfx, true);
  const l = new Builder();
  l.add(new THREE.CylinderGeometry(0.37, 0.37, 1.1, 10, 1, false, 0, Math.PI), { p: [0, 0, 0.37], r: [0, 0, Math.PI / 2], color: body, mat: M.WOOD });
  for (const x of [-0.42, 0, 0.42]) l.add(new THREE.CylinderGeometry(0.385, 0.385, 0.1, 10, 1, false, 0, Math.PI), { p: [x, 0, 0.37], r: [0, 0, Math.PI / 2], color: band, mat: M.PLAIN });
  l.box(0, 0.02, 0.76, 0.16, 0.2, 0.06, { color: GOLD, mat: M.GLOW, emis: rare ? 2.5 : 0.8 });
  const lid = meshFrom(l, gfx, true);
  lid.matrixAutoUpdate = true; base.matrixAutoUpdate = true;
  lid.position.set(0, 0.64, -0.37);
  const g = new THREE.Group(); g.add(base, lid);
  return { group: g, lid };
}

// Hand-made treasure chest (Quaternius' Ultimate RPG pack, CC0): closed and open models, recoloured for rare chests.
const CHEST = { closed: './assets/models/creatures/Chest_Closed.glb', open: './assets/models/creatures/Chest_Open.glb' };
let chestSrc = null;
function chestFromModel(gfx, rare) {
  const make = (gltf) => {
    const b = new Builder();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.material.name || '', wood = /wood/i.test(n);
      const color = wood ? (rare ? 0x2f5f9a : 0x9a5f34) : (rare ? 0xf2c14e : (/dark/i.test(n) ? 0x4a4658 : 0x6f6a80));
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      b.add(g, { s: [1.18, 1.18, 1.18], color, mat: !wood && rare ? M.METAL : M.PLAIN });
    });
    const m = meshFrom(b, gfx, true);
    m.matrixAutoUpdate = true;
    return m;
  };
  const closed = make(chestSrc.closed), open = make(chestSrc.open);
  open.visible = false;
  const g = new THREE.Group(); g.add(closed, open);
  return { group: g, lid: null, closed, open };
}

function simpleMesh(gfx, fn, cast = false) { const b = new Builder(); fn(b); const m = meshFrom(b, gfx, cast); m.matrixAutoUpdate = true; return m; }

export class Props {
  constructor(game) {
    this.game = game;
    this.scene = game.gfx.scene;
    this.interactables = [];   // { pos, r, label, key?, fn, enabled? }
    this.chests = []; this.orbs = []; this.pickups = []; this.pots = []; this.fires = [];
    this.colliders = [];       // {x, z, r}
    this.current = null;
    // shared pickup geometry
    const gfx = game.gfx;
    this.geo = {
      coin: (() => { const b = new Builder(); b.cyl(0, 0, 0, 0.16, 0.16, 0.05, 12, { r: [Math.PI / 2, 0, 0], color: GOLD, mat: M.GLOW, emis: 0.9 }); return b.build(); })(),
      heart: (() => { const b = new Builder(); b.sphere(-0.09, 0.05, 0, 0.12, 1, { color: 0xff4a5e, mat: M.GLOW, emis: 1.1 }); b.sphere(0.09, 0.05, 0, 0.12, 1, { color: 0xff4a5e, mat: M.GLOW, emis: 1.1 }); b.cone(0, -0.1, 0, 0.19, 0.24, 8, { r: [Math.PI, 0, 0], color: 0xff4a5e, mat: M.GLOW, emis: 1.1 }); return b.build(); })(),
      apple: (() => { const b = new Builder(); b.sphere(0, 0, 0, 0.15, 1, { color: 0xd9352a, mat: M.PLAIN }); b.cyl(0, 0.16, 0, 0.015, 0.015, 0.1, 4, { color: WOOD_D, mat: M.WOOD }); b.sphere(0.06, 0.2, 0, 0.05, 0, { color: 0x4f9a2a, mat: M.PLAIN }); return b.build(); })(),
      orb: (() => { const b = new Builder(); b.sphere(0, 0, 0, 0.22, 2, { color: CYAN, mat: M.GLOW, emis: 4.0 }); b.add(new THREE.TorusGeometry(0.36, 0.02, 5, 24), { color: 0xffffff, mat: M.GLOW, emis: 2.5 }); b.add(new THREE.TorusGeometry(0.36, 0.02, 5, 24), { r: [Math.PI / 2, 0, 0], color: 0xffffff, mat: M.GLOW, emis: 2.5 }); return b.build(); })(),
      pot: (() => { const b = new Builder(); b.cyl(0, 0.3, 0, 0.3, 0.2, 0.6, 10, { color: 0xb86a3c, mat: M.PLAIN }); b.cyl(0, 0.66, 0, 0.2, 0.3, 0.14, 10, { color: 0xc77a48, mat: M.PLAIN }); b.add(new THREE.TorusGeometry(0.21, 0.035, 5, 12), { p: [0, 0.74, 0], r: [Math.PI / 2, 0, 0], color: 0x8a4a28, mat: M.PLAIN }); return b.build(); })(),
    };
    this.mat = this._mat();
  }
  async load() {
    const [closed, open] = await Promise.all([loadModel(CHEST.closed), loadModel(CHEST.open)]);
    chestSrc = { closed, open };
  }
  _mat() { const m = meshFrom(new Builder().box(0, 0, 0, 0.01, 0.01, 0.01), null, false); const mat = { main: m.material, depth: m.userData.shadowMat }; m.geometry.dispose(); return mat; }
  _mesh(geo, cast) { const m = new THREE.Mesh(geo, this.mat.main); m.userData.shadowMat = this.mat.depth; if (cast) this.game.gfx.addCaster(m); this.scene.add(m); return m; }

  addInteract(o) { this.interactables.push(o); return o; }

  // ------------------------------------------------------------ chests
  addChest(id, x, z, loot, opts = {}) {
    const g = this.game, y = opts.y !== undefined ? opts.y : g.world.heightAt(x, z);
    const { group, lid, closed, open } = chestSrc ? chestFromModel(g.gfx, !!opts.rare) : chestMeshes(g.gfx, !!opts.rare);
    group.position.set(x, y, z); group.rotation.y = opts.rot || 0;
    this.scene.add(group);
    const c = { id, pos: new THREE.Vector3(x, y, z), lid, group, shut: closed, ajar: open, loot, open: false, t: 0, rare: !!opts.rare, locked: opts.locked };
    this.chests.push(c);
    this.colliders.push({ x, z, r: 0.75, y, h: 1.2 });
    c.inter = this.addInteract({ pos: c.pos, r: 2.0, label: 'Open chest', enabled: () => !c.open && !(c.locked && c.locked()), fn: () => this.openChest(c) });
    if (g.save && g.save.chests[id]) { c.open = true; c.t = 1; if (lid) lid.rotation.x = -1.9; else { c.shut.visible = false; c.ajar.visible = true; } }
    return c;
  }
  openChest(c) {
    const g = this.game;
    c.open = true; c.t = 0;
    g.player.playInteract(g.player.char.clips.U_Chest_Open ? 'U_Chest_Open' : 'Interact', 0.9);
    g.player.yaw = Math.atan2(c.pos.x - g.player.pos.x, c.pos.z - g.player.pos.z);
    g.audio && g.audio.sfx('chestOpen');
    g.save.chests[c.id] = 1; g.stats.chests++;
    setTimeout(() => {
      g.vfx.orbBurst(c.pos.x, c.pos.y + 0.9, c.pos.z, c.rare ? 0xffd870 : 0xfff0c0);
      g.audio && g.audio.stinger('chest');
      g.giveLoot(c.loot);
    }, 450);
  }

  // ------------------------------------------------------------ orbs
  addOrb(id, x, y, z) {
    const g = this.game;
    if (g.save.orbs[id]) return;
    const m = this._mesh(this.geo.orb, false);
    m.position.set(x, y, z);
    this.orbs.push({ id, pos: new THREE.Vector3(x, y, z), mesh: m, ph: Math.random() * 6 });
  }

  // ------------------------------------------------------------ pickups
  spawnPickup(kind, pos, vel) {
    const m = this._mesh(this.geo[kind], false);
    m.position.copy(pos);
    this.pickups.push({ kind, mesh: m, pos: pos.clone(), vel: vel || new THREE.Vector3((Math.random() - 0.5) * 4, 4 + Math.random() * 3, (Math.random() - 0.5) * 4), t: 0, ground: false });
  }
  spawnDrops(pos, coins, heartChance) {
    const p = _v.set(pos.x, pos.y + 0.8, pos.z);
    const n = Math.min(8, Math.ceil(coins / 2));
    for (let i = 0; i < n; i++) this.spawnPickup('coin', p);
    if (Math.random() < heartChance || this.game.player.hp <= 4) this.spawnPickup('heart', p);
    if (Math.random() < 0.12) this.spawnPickup('apple', p);
  }
  addApple(x, z) { const y = this.game.world.heightAt(x, z) + 0.2; this.spawnPickup('apple', new THREE.Vector3(x, y, z), new THREE.Vector3()); this.pickups[this.pickups.length - 1].persist = true; }

  // ------------------------------------------------------------ pots
  addPot(x, z) {
    const y = this.game.world.heightAt(x, z);
    const m = this._mesh(this.geo.pot, true);
    m.position.set(x, y, z); m.rotation.y = Math.random() * 6;
    const s = 0.9 + Math.random() * 0.4; m.scale.setScalar(s);
    this.pots.push({ pos: new THREE.Vector3(x, y, z), mesh: m, broken: false });
    this.colliders.push({ x, z, r: 0.34 * s, y, h: 0.9, pot: this.pots[this.pots.length - 1] });
  }

  // ------------------------------------------------------------ campfires
  addCampfire(x, z, lit = true) {
    const g = this.game, y = g.world.heightAt(x, z);
    const f = { pos: new THREE.Vector3(x, y + 0.25, z), em: g.vfx.addFire(new THREE.Vector3(x, y + 0.25, z), 1.1) };
    this.fires.push(f);
    this.addInteract({ pos: f.pos, r: 2.4, label: 'Rest by the fire', fn: () => g.restAtFire() });
    return f;
  }

  // ------------------------------------------------------------ physics hooks used by the player
  collide(pos, radius) {
    for (const c of this.colliders) {
      if (c.pot && c.pot.broken) continue;
      if (pos.y > c.y + c.h || pos.y + 1.6 < c.y) continue;
      const dx = pos.x - c.x, dz = pos.z - c.z, rr = c.r + radius, d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); pos.x += dx / d * (rr - d); pos.z += dz / d * (rr - d); }
    }
  }
  hitArc(pos, fx, fz, range, arc) {
    const g = this.game;
    let n = 0;
    for (const p of this.pots) {
      if (p.broken) continue;
      const dx = p.pos.x - pos.x, dz = p.pos.z - pos.z, d = Math.hypot(dx, dz);
      if (d > range || Math.abs(p.pos.y - pos.y) > 1.5) continue;
      if (d > 0.6 && (dx * fx + dz * fz) / d < Math.cos(arc * 0.5 + 0.3)) continue;
      p.broken = true; p.mesh.visible = false; g.gfx.removeCaster(p.mesh);
      g.vfx.poof(p.pos.x, p.pos.y + 0.4, p.pos.z, 0xb86a3c, 8, 0.7);
      g.audio && g.audio.sfx('hit');
      const q = _v.set(p.pos.x, p.pos.y + 0.4, p.pos.z);
      const r = Math.random();
      for (let i = 0; i < (r < 0.5 ? 2 : 1); i++) this.spawnPickup('coin', q);
      if (r > 0.8) this.spawnPickup('apple', q); else if (r > 0.65) this.spawnPickup('heart', q);
      n++;
    }
    return n;
  }

  update(dt) {
    const g = this.game, p = g.player, w = g.world, t = g.time;
    // chest lids
    for (const c of this.chests) if (c.open && c.t < 1) {
      c.t = Math.min(1, c.t + dt * 2.2);
      const e = 1 - Math.pow(1 - c.t, 3);
      if (c.lid) c.lid.rotation.x = -1.9 * e;
      else {
        // the lid springs open: swap to the open model on a squash-and-stretch pop
        if (c.t > 0.18 && c.shut.visible) { c.shut.visible = false; c.ajar.visible = true; }
        const k = c.t < 0.18 ? 1 - c.t * 0.6 : 1 + Math.sin(Math.min(1, (c.t - 0.18) / 0.6) * Math.PI) * 0.16;
        c.group.scale.set(1 + (1 - k) * 0.5, k, 1 + (1 - k) * 0.5);
      }
    }
    // orbs: hover, sparkle, collect on touch
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      const d = o.pos.distanceTo(p.pos);
      if (d > 140) { o.mesh.visible = false; continue; }
      o.mesh.visible = true;
      o.mesh.position.y = o.pos.y + Math.sin(t * 1.6 + o.ph) * 0.18;
      o.mesh.rotation.y = t * 1.2 + o.ph; o.mesh.rotation.x = t * 0.7;
      if (d < 60 && Math.random() < dt * 9) g.vfx.add.spawn(o.pos.x + (Math.random() - 0.5) * 0.8, o.mesh.position.y + (Math.random() - 0.5) * 0.8, o.pos.z + (Math.random() - 0.5) * 0.8, 0, 0.5, 0, { life: 0.9, size: 0.16, size1: 0.02, color: [1.4, 2.6, 3.0], type: 7 });
      _v.set(p.pos.x, p.pos.y + 0.9, p.pos.z);
      if (o.mesh.position.distanceTo(_v) < 1.25) {
        this.scene.remove(o.mesh); this.orbs.splice(i, 1);
        g.save.orbs[o.id] = 1; g.inv.orbs++; g.stats.orbs++;
        g.vfx.orbBurst(o.pos.x, o.mesh.position.y, o.pos.z);
        g.audio && (g.audio.sfx('orb'), g.audio.stinger('orb'));
        g.ui.notify('<b>Dawn Mote</b> — offer four at a Statue of the Dawn');
      }
    }
    // pickups
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const q = this.pickups[i];
      q.t += dt;
      _v.set(p.pos.x, p.pos.y + 0.8, p.pos.z);
      const d = q.pos.distanceTo(_v);
      if (q.t > 0.45 && d < 3.6 && p.action !== 'dead') {
        // magnetise
        q.vel.subVectors(_v, q.pos).normalize().multiplyScalar(6 + (3.6 - d) * 5);
        q.pos.addScaledVector(q.vel, dt); q.ground = false;
        if (d < 0.75) {
          this.scene.remove(q.mesh); this.pickups.splice(i, 1);
          if (q.kind === 'coin') { g.inv.coins++; g.audio && g.audio.sfx('coin'); }
          else if (q.kind === 'heart') { p.heal(4); g.audio && g.audio.sfx('heal'); g.vfx.heal(p.pos.x, p.pos.y, p.pos.z); }
          else if (q.kind === 'apple') { g.inv.apples++; g.audio && g.audio.sfx('pickup'); g.ui.notify('<b>Apple</b> +1 — press R to eat'); }
          continue;
        }
      } else if (!q.ground) {
        q.vel.y -= 16 * dt; q.pos.addScaledVector(q.vel, dt);
        const gy = Math.max(w.heightAt(q.pos.x, q.pos.z), w.waterAt(q.pos.x, q.pos.z)) + 0.28;
        if (q.pos.y < gy) { q.pos.y = gy; if (Math.abs(q.vel.y) < 2) { q.ground = true; q.vel.set(0, 0, 0); } else { q.vel.y *= -0.4; q.vel.x *= 0.5; q.vel.z *= 0.5; } }
      }
      q.mesh.position.copy(q.pos); q.mesh.position.y += q.ground ? Math.sin(t * 3 + i) * 0.05 : 0;
      q.mesh.rotation.y = t * 3 + i;
      if (!q.persist && q.t > 45) { this.scene.remove(q.mesh); this.pickups.splice(i, 1); }
    }
    // interaction prompt
    let best = null, bd = 1e9;
    if (!g.inDialog && p.mode === 'ground' && !p.action && !g.ui.modal) {
      for (const it of this.interactables) {
        if (it.enabled && !it.enabled()) continue;
        const d = Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
        if (d < it.r && Math.abs(it.pos.y - p.pos.y) < 3 && d < bd) { bd = d; best = it; }
      }
    }
    this.current = best;
    g.ui.setPrompt(best ? (typeof best.label === 'function' ? best.label() : best.label) : null);
    if (best && g.input.hit('KeyE') && !(g.dialogCooldown > 0)) { g.audio && g.audio.sfx('uiClick'); best.fn(); }
  }
}

// ------------------------------------------------------------------ world population
export function populateWorld(game) {
  const { props, world, structures: S } = game;
  const rnd = mulberry32(WORLD.seed ^ 0xbeef);
  const h = (x, z) => world.heightAt(x, z);
  const okLand = (x, z) => { const y = h(x, z); return y > 2.5 && world.waterAt(x, z) < y - 0.3 && world.slopeY[Math.min(world.slopeY.length - 1, Math.max(0, Math.round((z + WORLD.half) / WORLD.cell) * WORLD.res + Math.round((x + WORLD.half) / WORLD.cell)))] > 0.86; };

  // --- chests
  const C = (id, x, z, loot, o) => props.addChest(id, x, z, loot, o);
  const sp = POI.spawn;
  C('c_spawn', sp.x - 20, sp.z - 8, { coins: 12, apples: 2 }, { rot: 1.2 });        // on the bank of the plateau pond
  C('c_overlook', POI.overlook.x + 22, POI.overlook.z + 34, { coins: 18 }, { rot: 0.4 });
  { const tc = S.towerChest || new THREE.Vector3(S.towerTop.x + 4.6, 0, S.towerTop.z - 3.2); C('c_tower', tc.x, tc.z, { orbs: 1, coins: 30 }, { y: S.towerTop.y, rare: true, rot: -0.9 }); }
  C('c_lakeisle', S.lakeIsle.x, S.lakeIsle.z, { heart: 1 }, { y: S.lakeIsle.y - 0.1, rare: true });
  C('c_ruinsM', POI.ruinsMeadow.x + 3, POI.ruinsMeadow.z - 4, { coins: 25, apples: 2 });
  C('c_ruinsW', POI.ruinsWest.x - 4, POI.ruinsWest.z + 3, { coins: 30, apples: 1 });
  C('c_village', POI.village.x + 46, POI.village.z + 34, { coins: 15, apples: 3 }, { rot: 2.2 });
  C('c_windmill', POI.windmill.x - 7, POI.windmill.z + 4, { coins: 20 });
  C('c_elder', POI.elderTree.x + 4, POI.elderTree.z - 5, { stamina: 1 }, { rare: true });
  C('c_beach', POI.beachCamp.x, POI.beachCamp.z, { coins: 35, apples: 2 });
  S.islands.forEach((isl, i) => { if (i !== 3) C('c_isl' + i, isl.pos.x + isl.r * 0.35, isl.pos.z - isl.r * 0.3, i === 5 ? { heart: 1 } : { coins: 40, orbs: 1 }, { y: isl.pos.y, rare: true, rot: i }); });
  C('c_skyshrine', -10 + 2.4, -110 + 1.2, { stamina: 1, coins: 50 }, { y: 300.4, rare: true });
  for (const c of S.camps) { const cam = c; C('c_camp_' + c.id, c.pos.x - 4.5, c.pos.z - 4.2, { coins: 30 + Math.floor(rnd() * 20), apples: 1, orbs: c.id === 'emberCamp' ? 1 : 0 }, { rot: rnd() * 6, locked: () => game.enemies.campAlive(cam.id) }); }
  // islets
  for (const [i, p] of [[0, [1760, 760]], [1, [1480, 1560]], [2, [-1840, -420]], [3, [-1500, 1380]], [4, [560, 1800]], [5, [1500, -1320]], [6, [-620, -1800]]]) C('c_islet' + i, p[0], p[1], i % 3 === 0 ? { orbs: 1, coins: 30 } : { coins: 45, apples: 2 }, { rare: i % 3 === 0 });

  // --- campfires at camps and a few rest spots
  for (const c of S.camps) props.addCampfire(c.pos.x, c.pos.z);
  props.addCampfire(sp.x + 22, sp.z + 14);
  props.addCampfire(POI.village.x - 8, POI.village.z + 20);
  props.addCampfire(548 - 8, 118 + 9);
  props.addCampfire(POI.beachCamp.x + 6, POI.beachCamp.z - 3);
  props.addCampfire(POI.elderTree.x - 12, POI.elderTree.z + 14);

  // --- spirit orbs: explicit landmarks + seeded scatter on hilltops
  let oi = 0;
  const O = (x, y, z) => props.addOrb('o' + (oi++), x, y, z);
  O(sp.x + 40, h(sp.x + 40, sp.z - 30) + 1.3, sp.z - 30);
  O(POI.overlook.x, h(POI.overlook.x, POI.overlook.z - 18) + 1.3, POI.overlook.z - 18);
  O(S.towerTop.x, S.towerTop.y + (S.towerOrbY || 9.5), S.towerTop.z);
  O(S.towerTop.x + 7.2, S.towerTop.y - 21.3, S.towerTop.z);
  O(POI.windmill.x, h(POI.windmill.x, POI.windmill.z) + 17.5, POI.windmill.z);
  O(S.sanctum.x, S.sanctum.y + 18, S.sanctum.z);
  O(POI.elderTree.x, h(POI.elderTree.x, POI.elderTree.z) + 2.2, POI.elderTree.z + 6);
  for (const isl of S.islands) O(isl.pos.x - isl.r * 0.4, isl.pos.y + 1.5, isl.pos.z + isl.r * 0.3);
  O(40, 262 - 14, 120);
  O(1522, 9, 213);            // behind the eastern waterfall
  O(222, 76, -316);           // above Silverrun falls
  // highest summit
  { let bx = -150, bz = -1050, bh = -1; for (let i = 0; i < 4000; i++) { const x = -150 + (rnd() - 0.5) * 500, z = -1050 + (rnd() - 0.5) * 500, y = h(x, z); if (y > bh) { bh = y; bx = x; bz = z; } } O(bx, bh + 1.4, bz); game.summit = new THREE.Vector3(bx, bh, bz); }
  let tries = 0;
  while (oi < 44 && tries++ < 6000) {
    const x = (rnd() - 0.5) * 3300, z = (rnd() - 0.5) * 3300;
    if (!okLand(x, z)) continue;
    const y = h(x, z);
    // prefer local high points
    if (y < h(x + 14, z) || y < h(x - 14, z) || y < h(x, z + 14) || y < h(x, z - 14)) { if (rnd() < 0.85) continue; }
    let near = false; for (const o of props.orbs) if (Math.hypot(o.pos.x - x, o.pos.z - z) < 170) { near = true; break; }
    if (near) continue;
    O(x, y + 1.3, z);
  }
  game.totalOrbs = oi;

  // --- pots around the village, camps and ruins
  const potSpots = [[POI.village.x + 12, POI.village.z - 10], [POI.village.x - 24, POI.village.z - 8], [POI.village.x + 24, POI.village.z + 14], [POI.village.x - 6, POI.village.z + 26], [sp.x + 9, sp.z + 12], [POI.ruinsMeadow.x, POI.ruinsMeadow.z], [POI.ruinsWest.x, POI.ruinsWest.z]];
  for (const c of S.camps) potSpots.push([c.pos.x + 3.5, c.pos.z + 5.5]);
  for (const [px, pz] of potSpots) { const n = 2 + Math.floor(rnd() * 3); for (let i = 0; i < n; i++) props.addPot(px + (rnd() - 0.5) * 2.4, pz + (rnd() - 0.5) * 2.4); }

  // --- apples lying under some oak trees
  const oaks = world.veg.trees[0];
  let apples = 0;
  for (let i = 0; i < oaks.length && apples < 120; i += 6 * 23) {
    const x = oaks[i] + 1.6, z = oaks[i + 2] + 0.8;
    if (okLand(x, z)) { props.addApple(x, z); apples++; }
  }
}

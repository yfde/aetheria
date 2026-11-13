// Story: villagers, the main quest line, shrine trials and enemy placement.
import * as THREE from 'three';
import { loadModel, Animator } from './characters.js';
import { loadVRM, createVRMCharacter } from './vrmchar.js';
import { Cape } from './cape.js';
import { Builder, meshFrom, M } from '../world/structures.js';
import { MODEL } from './enemies.js';
import { POI, WORLD, BIOME } from '../world/layout.js';
import { biomeWeights } from '../world/worldgen.js';
import { mulberry32 } from '../world/noise.js';

const _v = new THREE.Vector3();
const SIGIL_NAMES = { forest: 'Verdant Sigil', coast: 'Tidal Sigil', peak: 'Frost Sigil' };

const NPC_MODELS = { A: './assets/models/vrm/AvatarSample_A.vrm', B: './assets/models/vrm/AvatarSample_B.vrm', C: './assets/models/vrm/AvatarSample_C.vrm', V: './assets/models/vrm/Victoria_Rubin.vrm' };
const NPC_CLIPS = ['T-Pose', 'Cheer'];
const NPC_UAL = ['Idle_Loop', 'Idle_Talking_Loop', 'Walk_Loop', 'Interact'];

// travelling clothes so the villagers belong to this world
const OUTFIT = {
  traveler: { hat: 'straw', pal: { top: '#4a3524', mid: '#6b4a2e', bottom: '#7d5a38', trim: '#c9a25a', emblem: null, mantle: 0x5a3f28 } },
  elder: { hat: 'circlet', length: 1.02, pal: { top: '#d9d2c0', mid: '#efe9da', bottom: '#f6f1e6', trim: '#d8b455', emblem: '#d8b455', mantle: 0xe6dfcc } },
  merchant: { pal: { top: '#2c5a32', mid: '#3d7a41', bottom: '#4f8f4a', trim: '#e0c060', emblem: null, mantle: 0x2f6236 } },
  scout: { pal: { top: '#1f4e52', mid: '#2b6d70', bottom: '#38858a', trim: '#d9c27a', emblem: '#d9c27a', mantle: 0x245a5e } },
  fisher: { hat: 'straw', pal: { top: '#27405f', mid: '#345a86', bottom: '#4672a3', trim: '#cfd8e6', emblem: null, mantle: 0x2c4a70 } },
  villager1: { pal: { top: '#7a5a1e', mid: '#a67c2a', bottom: '#bf9438', trim: '#f0e0a8', emblem: null, mantle: 0x86641f } },
  villager2: { pal: { top: '#4a2f66', mid: '#65408a', bottom: '#7b55a3', trim: '#e0c8f0', emblem: null, mantle: 0x543573 } },
};
function makeHat(kind, gfx) {
  const b = new Builder();
  if (kind === 'straw') {
    b.cone(0, 0.235, 0, 0.36, 0.17, 18, { color: 0xd8b866, mat: M.PLAIN });
    b.add(new THREE.TorusGeometry(0.2, 0.012, 4, 18), { p: [0, 0.2, 0], r: [Math.PI / 2, 0, 0], color: 0x8a5a30, mat: M.PLAIN });
    b.add(new THREE.CircleGeometry(0.36, 18), { p: [0, 0.15, 0], r: [Math.PI / 2, 0, 0], color: 0xb89650, mat: M.PLAIN });
  } else {
    b.add(new THREE.TorusGeometry(0.108, 0.011, 5, 20), { p: [0, 0.135, 0], r: [Math.PI / 2 + 0.12, 0, 0], color: 0xe9bf5a, mat: M.METAL });
    b.add(new THREE.OctahedronGeometry(0.022, 0), { p: [0, 0.15, -0.105], s: [1, 1.4, 0.6], color: 0x6fe8ff, mat: M.GLOW, emis: 3.5 });
    b.add(new THREE.OctahedronGeometry(0.022, 0), { p: [0, 0.15, 0.105], s: [1, 1.4, 0.6], color: 0x6fe8ff, mat: M.GLOW, emis: 3.5 });
  }
  const m = meshFrom(b, gfx, true);
  m.matrixAutoUpdate = true; m.frustumCulled = false;
  return m;
}

class NPC {
  constructor(story, def) {
    this.story = story; this.def = def;
    const g = story.game;
    this.pos = new THREE.Vector3(def.x, g.world.heightAt(def.x, def.z), def.z);
    this.yaw = def.yaw || 0; this.baseYaw = this.yaw;
    this.group = new THREE.Group();
    this.group.position.copy(this.pos); this.group.rotation.y = this.yaw;
    g.gfx.scene.add(this.group);
    this.char = null; this.anim = null;
    this.t = Math.random() * 5;
    g.props.addInteract({ pos: this.pos, r: 2.6, label: () => 'Talk to ' + def.name, fn: () => story.talk(this) });
    if (!def.path) g.props.colliders.push({ x: def.x, z: def.z, r: 0.4, y: this.pos.y, h: 2 });
    this.home = this.pos.clone(); this.wp = 0; this.pause = 3 + Math.random() * 5;
  }
  _ground(x, z) {
    const g = this.story.game, th = g.world.heightAt(x, z);
    const mh = g.collision.groundMesh(x, th + 1.0, z, 1.2, 2.4);
    return mh > th ? mh : th;
  }
  // amble between a few spots, stopping to face the hero when she comes close
  _stroll(dt, d) {
    const path = this.def.path;
    if (this.story.talking === this || d < 3.2) { this.walking = false; return; }
    if (this.pause > 0) { this.pause -= dt; this.walking = false; return; }
    const t = path[this.wp], dx = t[0] - this.pos.x, dz = t[1] - this.pos.z, l = Math.hypot(dx, dz);
    if (l < 0.3) { this.wp = (this.wp + 1) % path.length; this.pause = 4 + Math.random() * 7; this.walking = false; return; }
    const sp = 1.05 * dt;
    this.pos.x += dx / l * sp; this.pos.z += dz / l * sp; this.pos.y = this._ground(this.pos.x, this.pos.z);
    this.baseYaw = Math.atan2(dx, dz);
    this.group.position.copy(this.pos);
    this.walking = true;
  }
  // avatars stream in after the game has started; the villager simply appears when ready
  async loadModel() {
    const g = this.story.game;
    const vrm = await loadVRM(NPC_MODELS[this.def.model]);
    this.char = createVRMCharacter(vrm, this.story.knight, g.gfx, { sword: false, clips: NPC_CLIPS, ual: this.story.ual, ualClips: NPC_UAL, ual2: this.def.act ? this.story.ual2 : null, ual2Clips: this.def.act ? [this.def.act] : [], clothTint: this.def.tint ? new THREE.Color(...this.def.tint) : null });
    this.anim = new Animator(this.char);
    // what this villager does when left alone (hand-animated loop), falling back to the plain idle
    this.act = this.def.act && this.char.clips['U_' + this.def.act] ? 'U_' + this.def.act : null;
    this.rest = 'U_Idle_Loop';
    this.anim.play(this.act || 'U_Idle_Loop', { fade: 0, startAt: Math.random() * 2 });
    this.group.add(this.char.group);
    const fit = OUTFIT[this.def.id];
    if (fit) {
      this.char.cape = new Cape(this.char, g, { pal: fit.pal, length: fit.length || 0.98, wBottom: 0.84 });
      const head = vrm.humanoid.getRawBoneNode('head');
      if (fit.hat && head) head.add(makeHat(fit.hat, g.gfx));
    }
  }
  update(dt, player) {
    const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    this.group.visible = d < 80;
    if (!this.char || d > 80) return;
    this.t += dt;
    if (this.def.path) {
      const was = this.walking;
      this._stroll(dt, d);
      if (this.walking !== was) this.anim.play(this.walking ? 'U_Walk_Loop' : this.rest, { fade: 0.35, speed: this.walking ? 1.0 : 1 });
    }
    const want = d < 7 && !this.walking ? Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z) : this.baseYaw;
    let dy = want - this.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 4);
    this.group.rotation.y = this.yaw;
    if (d > 45) return;                      // far away: hold the pose, skip hair physics
    // talking gestures while in conversation; the odd wave or stretch otherwise
    const mineNow = this.story.talking === this;
    // busy with their own work until someone walks up
    const rest = this.act && d > 6.5 && !mineNow ? this.act : 'U_Idle_Loop';
    if (rest !== this.rest) { this.rest = rest; if (!this.walking && !mineNow && !(this.gestureT > 0)) this.anim.play(rest, { fade: 0.45 }); }
    if (mineNow !== this.wasTalking) { this.wasTalking = mineNow; this.gestureT = 0; this.anim.play(mineNow ? 'U_Idle_Talking_Loop' : this.rest, { fade: 0.35 }); }
    if (this.t > 11 && !this.walking && !mineNow) { this.t = 0; if (Math.random() < 0.4 && this.rest === 'U_Idle_Loop') { this.anim.play('Cheer', { loop: false, fade: 0.25, restart: true }); this.gestureT = 1.6; } }
    if (this.gestureT > 0) { this.gestureT -= dt; if (this.gestureT <= 0 && !this.walking && !mineNow) this.anim.play(this.rest, { fade: 0.35 }); }
    // speaking: the mouth follows the text as it types, with a small smile
    const g = this.story.game, em = this.char.vrm.expressionManager, q = g.ui.dialogQ;
    const mine = this.story.talking === this;
    const speaking = mine && q && q.shown < q.text.length;
    this.mouth = (this.mouth || 0) + ((speaking ? 0.3 + 0.5 * Math.abs(Math.sin(g.time * 13) * Math.sin(g.time * 5.3 + 1)) : 0) - (this.mouth || 0)) * Math.min(1, dt * 20);
    this.smile = (this.smile || 0) + ((mine ? 0.45 : 0) - (this.smile || 0)) * Math.min(1, dt * 4);
    if (em) { em.setValue('aa', this.mouth); em.setValue('happy', this.smile); }
    this.anim.update(dt);
    this.char.update(dt);
  }
}

export class Story {
  constructor(game) {
    this.game = game;
    this.stage = 0;
    this.title = ''; this.objective = ''; this.target = null;
    this.npcs = []; this.models = {}; this.clips = {};
    this.altars = [];
  }

  async load() {
    [this.knight, this.ual, this.ual2] = await Promise.all([loadModel(MODEL.knight), loadModel(MODEL.ual), loadModel(MODEL.ual2).catch(() => null)]);
  }

  // ------------------------------------------------------------------ world setup
  build() {
    const g = this.game, S = g.structures, w = g.world, props = g.props, en = g.enemies;
    const v = POI.village, ov = POI.overlook, tw = POI.skyTower;
    const defs = [
      { id: 'traveler', name: 'the Wanderer', model: 'C', x: ov.x + 3, z: ov.z + 9, yaw: Math.PI },
      { id: 'elder', name: 'Keeper Maren', model: 'V', x: v.x - 9, z: v.z - 2, yaw: 1.2 },
      { id: 'merchant', name: 'Pim', model: 'B', x: v.x + 13.2, z: v.z - 9.5, yaw: -2.6, act: 'Idle_FoldArms_Loop' },
      { id: 'scout', name: 'Scout Lyra', model: 'A', x: tw.x + 10, z: tw.z + 13, yaw: 0.6, act: 'Idle_FoldArms_Loop' },
      { id: 'fisher', name: 'Tobin', model: 'C', x: 541, z: 108, yaw: -1.2, tint: [0.75, 1.05, 1.5] },
      { id: 'villager1', name: 'Wren', model: 'A', x: S.npcSpots[1].pos.x, z: S.npcSpots[1].pos.z, yaw: S.npcSpots[1].yaw, tint: [1.25, 0.8, 0.7], act: 'Farm_Harvest' },
      { id: 'villager2', name: 'Halda', model: 'B', x: S.npcSpots[4].pos.x, z: S.npcSpots[4].pos.z, yaw: S.npcSpots[4].yaw, tint: [0.7, 1.1, 0.85] },
    ];
    for (const d of defs) {
      if (d.id === 'villager1' || d.id === 'villager2') {
        const cx = v.x + 1, cz = v.z + 2, k = d.id === 'villager1' ? 1 : -1;
        const mx = d.x + (cx - d.x) * 0.5, mz = d.z + (cz - d.z) * 0.5;
        d.path = [[mx, mz], [mx + (cz - d.z) * 0.28 * k, mz - (cx - d.x) * 0.28 * k], [d.x, d.z]];
      }
      this.npcs.push(new NPC(this, d));
    }
    this.npc = {}; for (const n of this.npcs) this.npc[n.def.id] = n;
    // stream the avatars in one by one, nearest first, without blocking the start of the game
    (async () => {
      const order = [...this.npcs].sort((a, b) => a.pos.distanceTo(g.player.pos) - b.pos.distanceTo(g.player.pos));
      for (const n of order) {
        try { await n.loadModel(); } catch (e) { console.warn('NPC avatar failed to load', n.def.id, e); }
        await new Promise((r) => setTimeout(r, 120));
      }
    })();

    // waypoints
    g.waypoints = S.waypoints.map((wp) => ({ ...wp, active: !!g.save.wp[wp.id] }));
    for (const wp of g.waypoints) {
      props.addInteract({ pos: wp.pos, r: 3.2, label: 'Attune to waypoint', enabled: () => !wp.active, fn: () => {
        wp.active = true; g.save.wp[wp.id] = 1;
        g.vfx.orbBurst(wp.pos.x, wp.pos.y + 4.4, wp.pos.z, 0x66e0ff);
        g.audio && (g.audio.sfx('waypoint'), g.audio.stinger('waypoint'));
        g.ui.itemGet('Waypoint attuned', `<b>${wp.name}</b> — open the map (M) to travel here at any time.`);
        g.player.playInteract('Interact', 0.8);
        g.saveGame();
      } });
      props.colliders.push({ x: wp.pos.x, z: wp.pos.z, r: 0.7, y: wp.pos.y, h: 4 });
    }

    // statues of the dawn: trade four motes for a heart or stamina vessel
    for (const st of S.statues) {
      props.addInteract({ pos: st.pos, r: 3.4, label: () => (g.inv.orbs >= 4 ? 'Offer 4 Dawn Motes' : 'Pray at the statue'), fn: () => this.statue(st) });
      props.colliders.push({ x: st.pos.x, z: st.pos.z, r: 1.6, y: st.pos.y, h: 5 });
    }

    // shrine altars
    for (const sh of S.shrines) {
      const tag = 'shrine_' + sh.id;
      const a = { ...sh, tag, column: null };
      this.altars.push(a);
      props.addInteract({ pos: sh.pos, r: 3.0, label: () => (en.campAlive(tag) ? 'The altar is sealed — defeat its guardians' : 'Claim the ' + SIGIL_NAMES[sh.id]), enabled: () => !g.inv.sigils[sh.id] && this.stage >= 1, fn: () => { if (!en.campAlive(tag)) this.claimSigil(a); else { g.audio && g.audio.sfx('error'); } } });
      if (!g.inv.sigils[sh.id]) a.column = g.vfx.addColumn(new THREE.Vector3(sh.pos.x, sh.pos.y + 0.6, sh.pos.z), sh.gem, 30);
    }
    // sanctum pedestals
    const gate = S.sanctumGate;
    props.addInteract({ pos: S.pedestals[1], r: 5.5, label: 'Set the three Sigils', enabled: () => this.stage === 3, fn: () => this.openSanctum() });

    // ---- enemies
    const rnd = mulberry32(WORLD.seed ^ 0x51);
    const ring = (cx, cz, r, n, fn) => { for (let i = 0; i < n; i++) { const a = i / n * 6.283 + rnd() * 0.8; fn(cx + Math.cos(a) * r * (0.6 + rnd() * 0.5), cz + Math.sin(a) * r * (0.6 + rnd() * 0.5)); } };
    const campKinds = { campNorth: ['grunt', 'grunt', 'brute'], campForest: ['grunt', 'grunt', 'brute'], campEast: ['grunt', 'mage', 'grunt', 'brute'], emberCamp: ['brute', 'mage', 'grunt', 'grunt'], ruinsWest: ['grunt', 'grunt', 'grunt'] };
    for (const c of S.camps) { const kinds = campKinds[c.id]; let i = 0; ring(c.pos.x, c.pos.z, 5, kinds.length, (x, z) => en.addSpawn('shade', kinds[i++], x, z, { tag: c.id })); }
    const guards = { forest: [['shade', 'warrior'], ['shade', 'minion'], ['shade', 'minion'], ['slime', 'blue'], ['slime', 'green']], coast: [['shade', 'rogue'], ['shade', 'rogue'], ['shade', 'mage'], ['slime', 'blue']], peak: [['shade', 'warrior'], ['shade', 'mage'], ['slime', 'frost'], ['slime', 'frost'], ['slime', 'frost']] };
    for (const sh of S.shrines) { const list = guards[sh.id]; let i = 0; ring(sh.pos.x, sh.pos.z, 12, list.length, (x, z) => { const [t, k] = list[i++]; en.addSpawn(t, k, x, z, { tag: 'shrine_' + sh.id, once: true, killed: !!g.inv.sigils[sh.id] }); }); }
    // tutorial slimes on the plateau
    const sp = POI.spawn;
    en.addSpawn('slime', 'green', sp.x + 22, sp.z - 70); en.addSpawn('slime', 'green', sp.x + 27, sp.z - 74); en.addSpawn('slime', 'green', sp.x - 40, sp.z - 120);
    // roaming slime groups by biome
    const bw = new Float32Array(8);
    let groups = 0, tries = 0;
    while (groups < 34 && tries++ < 4000) {
      const x = (rnd() - 0.5) * 3200, z = (rnd() - 0.5) * 3200, y = w.heightAt(x, z);
      if (y < 3 || w.waterAt(x, z) > y - 0.5 || w.maskAt(x, z, 0) < 0.6) continue;
      if (Math.hypot(x - v.x, z - v.z) < 130 || Math.hypot(x - sp.x, z - sp.z) < 60 || Math.hypot(x - POI.temple.x, z - POI.temple.z) < 70) continue;
      biomeWeights(x, z, y, bw);
      let kind = 'green';
      if (y > 230) kind = 'frost'; else if (bw[BIOME.AUTUMN] > 0.5) kind = 'ember'; else if (bw[BIOME.FOREST] > 0.5 || bw[BIOME.BEACH] > 0.3 || bw[BIOME.SAKURA] > 0.5) kind = 'blue';
      const n = 2 + Math.floor(rnd() * 3);
      ring(x, z, 3.5, n, (sx, sz) => en.addSpawn('slime', kind, sx, sz));
      if (rnd() < 0.14) en.addSpawn('slime', 'king', x, z);
      groups++;
    }
    // restless dead that rise along the roads at night
    for (const road of w.roads) for (let i = 30; i < road.pts.length - 20; i += 90) {
      const p = road.pts[i];
      if (Math.hypot(p[0] - v.x, p[1] - v.z) < 110) continue;
      en.addSpawn('shade', 'minion', p[0] + 6, p[1] + 4, { night: true }); en.addSpawn('shade', rnd() < 0.5 ? 'minion' : 'rogue', p[0] - 5, p[1] - 6, { night: true });
    }
    // the boss sleeps in the sanctum
    this.boss = en.spawnBoss(S.sanctum.clone().setY(w.heightAt(S.sanctum.x, S.sanctum.z) + 0.55));
    if (g.save.bossDead) { this.boss.state = 'dead'; this.boss.dead = true; this.boss.parts.core.visible = false; }
  }

  // ------------------------------------------------------------------ quest state
  setStage(s, silent) {
    const g = this.game, S = g.structures;
    this.stage = s; g.save.stage = s;
    g.player.canGlide = s >= 1;
    this.title = 'Echoes of the Dawn';
    if (s === 0) { this.objective = 'Follow the old road north to the overlook'; this.target = this.npc.traveler.pos; }
    else if (s === 1) { this.objective = 'Glide down to Hearthvale and speak with Keeper Maren'; this.target = this.npc.elder.pos; }
    else if (s === 2) this._sigilObjective();
    else if (s === 3) { this.objective = 'Carry the three Sigils to the Sealed Sanctum'; this.target = S.pedestals[1]; }
    else if (s === 4) { this.objective = 'Defeat the Dawnbreaker Colossus'; this.target = null; }
    else { this.title = 'The Dawn Returns'; this.objective = 'Aetheria is at peace. Wander wherever the wind takes you.'; this.target = null; }
    if (!silent) { g.audio && g.audio.stinger('quest'); g.saveGame(); }
  }
  _sigilObjective() {
    const g = this.game, n = Object.values(g.inv.sigils).filter(Boolean).length;
    this.objective = `Recover the three Sigils from the old shrines (${n}/3)`;
    let best = null, bd = 1e9;
    for (const a of this.altars) if (!g.inv.sigils[a.id]) { const d = a.pos.distanceTo(g.player.pos); if (d < bd) { bd = d; best = a; } }
    this.target = best ? best.pos : null;
  }

  talk(npc) {
    const g = this.game, id = npc.def.id, who = npc.def.name.replace(/^the /, '');
    const L = (...t) => t.map((text) => ({ who, text }));
    g.player.yaw = Math.atan2(npc.pos.x - g.player.pos.x, npc.pos.z - g.player.pos.z);
    this.talking = npc;
    g.cam.focusOn(npc.pos, g.player.pos);
    g.ui.hud.classList.add('hidden');
    g.onDialogEnd = () => { this.talking = null; g.cam.release(); g.ui.hud.classList.remove('hidden'); };
    if (id === 'traveler') {
      if (this.stage === 0) {
        g.ui.dialog(L('Well now. The sleeper wakes at last.', 'A hundred years the Colossus has kept the dawn locked beneath the Sanctum, and the land has been waiting — for you, I think.', 'See that valley? Hearthvale lies at the foot of this plateau. The cliffs are no trouble for one who can ride the wind.', 'Take my sailcloth. Leap, then press Space again in the air to open it. Mind your stamina — the green ring is your breath.'), () => {
          g.ui.itemGet('Sailcloth', 'Press <b>Space</b> in mid-air to glide. Gliding, climbing, sprinting and swimming all drain stamina.');
          g.audio && g.audio.stinger('chest');
          this.setStage(1);
        });
      } else g.ui.dialog(L('Steep walls can be climbed — just walk into them. Leap upward with Space if you are in a hurry.', 'And should you find little blue motes of light, the winged statues are fond of them.'));
    } else if (id === 'elder') {
      if (this.stage <= 1) {
        g.ui.dialog(L('So the shrine on the plateau was not a mere story. Welcome, child of the dawn.', 'Long ago three Sigils sealed the Dawnbreaker Colossus inside the Sanctum to the north-west. The seal held... but so did the night in our hearts.', 'To end it, the Colossus must be woken and broken. Gather the Sigils: the Verdant shrine deep in Whispering Woods, the Tidal shrine on Coral Coast, and the Frost shrine on the shoulder of Frostcrown.', 'Each shrine is guarded. Each will also make you stronger. Climb Skywatch Tower if you wish to see the whole land first.', 'Go with the morning light.'), () => { this.setStage(2); });
      } else if (this.stage === 2) g.ui.dialog(L('The shrines glow like lanterns after dusk — easy to spot from high ground.', 'Rest at a campfire to pass the night, and trade Dawn Motes at the winged statue beside me.'));
      else if (this.stage === 3) g.ui.dialog(L('All three! Then the Sanctum awaits, north-west past Skywatch Tower. Strike the Colossus when its heart is laid bare.'));
      else g.ui.dialog(L('Look at that sunrise. I had forgotten the colour of it.'));
    } else if (id === 'merchant') {
      if (g.inv.coins >= 10) g.ui.dialog(L('Fresh apples, three for ten lumen! ...Sold. A pleasure, friend.'), () => { g.inv.coins -= 10; g.inv.apples += 3; g.audio && g.audio.sfx('coin'); g.ui.notify('<b>Apple</b> +3'); });
      else g.ui.dialog(L('Apples, three for ten lumen — come back when your purse is heavier.', 'Pots and monsters both tend to be full of coin, in my experience.'));
    } else if (id === 'scout') g.ui.dialog(L('Skywatch Tower. I have never made it past the second ledge.', 'The trick is to rest on the ledges and let your breath come back before the next stretch.', 'They say a wind rises from the beacon at the top — strong enough to carry a glider all the way to the islands in the sky.'));
    else if (id === 'fisher') g.ui.dialog(L('Mirror Lake. On a still morning you cannot tell which mountain is the real one.', 'There is a pavilion on the little isle. Something shiny in it, too, if you do not mind a swim.'));
    else if (id === 'villager1') g.ui.dialog(L('The Hollow only walk the roads after dark. Keep to the lantern light, or keep your sword loose.', 'And do watch the windmill turn at sunset — best view in Hearthvale.'));
    else g.ui.dialog(L('Press Q and the wind itself answers you — I saw the last sleeper do it in my grandmother\'s stories. It lifts a glider straight up.'));
  }

  statue(st) {
    const g = this.game;
    if (g.inv.orbs < 4) { g.ui.dialog([{ who: '', text: `The statue's bowl holds a faint light. It seems to be waiting for something... (Dawn Motes: ${g.inv.orbs}/4)` }]); return; }
    g.inv.orbs -= 4;
    g.save.statueCount = (g.save.statueCount || 0) + 1;
    const heart = g.save.statueCount % 2 === 1;
    g.vfx.orbBurst(st.pos.x, st.pos.y + 3, st.pos.z, 0xffd870);
    g.audio && g.audio.stinger('levelup');
    if (heart) { g.player.maxHearts++; g.player.hp = g.player.maxHearts * 4; g.ui.itemGet('Heart Vessel', 'Your maximum health grows by one heart.'); }
    else { g.player.maxStamina += 20; g.player.stamina = g.player.maxStamina; g.ui.itemGet('Stamina Vessel', 'Your stamina wheel grows. Climb higher, glide farther.'); }
    g.saveGame();
  }

  claimSigil(a) {
    const g = this.game;
    g.inv.sigils[a.id] = true;
    if (a.column) a.column.on = false;
    g.player.playInteract('Cheer', 1.4);
    g.vfx.orbBurst(a.pos.x, a.pos.y + 1, a.pos.z, a.gem);
    g.audio && g.audio.stinger('sigil');
    g.player.maxHearts++; g.player.hp = g.player.maxHearts * 4;
    g.ui.itemGet(SIGIL_NAMES[a.id], 'One of the three seals of the Sanctum. Its warmth mends you: <b>+1 heart</b>.', 4200);
    const n = Object.values(g.inv.sigils).filter(Boolean).length;
    if (this.stage < 2) this.stage = 2;
    if (n >= 3) this.setStage(3); else { this._sigilObjective(); g.saveGame(); }
  }

  openSanctum() {
    const g = this.game, S = g.structures;
    g.player.playInteract('Spellcast_Raise', 1.6);
    const gems = [0x7dff8a, 0x5ad2ff, 0xdfefff];
    S.pedestals.forEach((p, i) => { setTimeout(() => { g.vfx.orbBurst(p.x, p.y + 0.4, p.z, gems[i]); g.vfx.addColumn(p, gems[i], 20); g.audio && g.audio.sfx('waypoint'); }, i * 450); });
    setTimeout(() => {
      this.boss.awaken();
      g.ui.regionCard('Dawnbreaker Colossus', 'Keeper of the stolen morning');
      this.setStage(4);
    }, 1900);
  }

  onBossDefeated() {
    const g = this.game;
    g.save.bossDead = true;
    g.ui.bossBar(null);
    g.audio && g.audio.stinger('victory');
    g.sky.coverageTarget = 0.25;
    this.setStage(5);
    setTimeout(() => {
      const t = Math.floor(g.stats.playTime || 0);
      g.ui.showCredits({ orbs: g.stats.orbs + ' / ' + g.totalOrbs, chests: g.stats.chests, time: `${Math.floor(t / 60)}m ${t % 60}s` });
    }, 5200);
  }

  update(dt) {
    const g = this.game, p = g.player;
    for (const n of this.npcs) n.update(dt, p);
    if (this.stage === 2) { this._t = (this._t || 0) + dt; if (this._t > 1) { this._t = 0; this._sigilObjective(); } }
    if (this.stage === 4 && this.boss && !this.boss.dead) this.target = this.boss.pos;
  }
}

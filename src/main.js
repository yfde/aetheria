// Boot, game state and main loop.
import * as THREE from 'three';
import { Gfx } from './core/gfx.js';
import { G } from './core/globals.js';
import { Input } from './core/input.js';
import { makeNoiseTexture } from './core/texgen.js';
import { World } from './world/world.js';
import { Terrain } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { Water } from './world/water.js';
import { Grass } from './world/grass.js';
import { Flora } from './world/flora.js';
import { Collision } from './world/collision.js';
import { buildStructures, setBuildingTextures } from './world/structures.js';
import { loadVillageKit } from './world/villagekit.js';
import { POI, WORLD, regionAt } from './world/layout.js';
import { Player } from './game/player.js';
import { OrbitCamera } from './game/camera.js';
import { VFX } from './game/vfx.js';
import { Props, populateWorld } from './game/props.js';
import { Wildlife } from './game/creatures.js';
import { Enemies } from './game/enemies.js';
import { Story } from './game/story.js';
import { UI } from './ui/ui.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'aetheria.save.v1';

function setProgress(p, label) {
  $('load-fill').style.width = Math.round(p * 100) + '%';
  if (label) $('load-label').textContent = label;
}

function generateWorld() {
  const url = new URL('./world/worldgen.worker.js', import.meta.url);
  const N = WORLD.res;
  const K = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const t0 = performance.now();
  // stage 1 (macro terrain) is split into bands across several workers
  const H = new Float32Array(N * N);
  let done = 0;
  const bands = K * 3;       // more bands than workers evens out the mountain-heavy rows
  const queue = [];
  for (let b = 0; b < bands; b++) queue.push([Math.floor(b * N / bands), Math.floor((b + 1) * N / bands)]);
  const workers = [];
  const stage1 = new Promise((resolve, reject) => {
    const next = (w) => {
      const job = queue.shift();
      if (!job) { if (done === bands) resolve(); return; }
      w.postMessage({ cmd: 'strip', j0: job[0], j1: job[1] });
    };
    for (let k = 0; k < K; k++) {
      const w = new Worker(url, { type: 'module' });
      workers.push(w);
      w.onmessage = (e) => {
        H.set(e.data.data, e.data.j0 * N);
        done++;
        setProgress(0.05 + 0.4 * done / bands, 'Raising mountains');
        if (done === bands) resolve(); else next(w);
      };
      w.onerror = (e) => reject(new Error('worldgen: ' + e.message));
      next(w);
    }
  });
  return stage1.then(() => new Promise((resolve, reject) => {
    for (let k = 1; k < workers.length; k++) workers[k].terminate();
    const w = workers[0];
    w.onmessage = (e) => {
      if (e.data.type === 'progress') setProgress(0.45 + Math.max(0, e.data.p - 0.42) * 0.6, e.data.label);
      else if (e.data.type === 'done') { e.data.world.genMs = performance.now() - t0; resolve(e.data.world); w.terminate(); }
    };
    w.onerror = (e) => reject(new Error('worldgen: ' + e.message));
    w.postMessage({ cmd: 'full', height: H }, [H.buffer]);
  }));
}

const defaultSave = () => ({
  stage: 0, pos: null, hp: 12, maxHearts: 3, maxStamina: 100, time: 6.35,
  inv: { orbs: 0, coins: 0, apples: 1, sigils: {} },
  wp: {}, orbs: {}, chests: {}, regions: {}, statueCount: 0, bossDead: false,
  stats: { orbs: 0, chests: 0, kills: 0, playTime: 0 },
});

// audio stub used until (or unless) the real engine loads
const NullAudio = { ready: false, unlock() {}, setVolumes() {}, setEnvironment() {}, sfx() {}, footstep() {}, stinger() {}, update() {} };

class Game {
  constructor() {
    this.params = params;
    this.time = 0;
    this.hitStop = 0;
    this.timeScale = 1;
    this.paused = false;
    this.state = 'boot';
    this.fly = params.has('fly');
    this.updrafts = [];
    this.tempUpdrafts = [];
    this.waypoints = [];
    this.audio = NullAudio;
    this.inv = defaultSave().inv;
    this.stats = defaultSave().stats;
    this.save = defaultSave();
    this.regionName = '';
    this._envT = 0; this._regionT = 0; this._saveT = 0; this._perfT = 0; this._perfN = 0;
  }

  async boot() {
    const canvas = $('game');
    const gfx = this.gfx = new Gfx(canvas);
    this.input = new Input(canvas);
    this.ui = new UI(this);
    const st = this.ui.settings;
    // first visit: pick a starting quality from the GPU name (the player can change it in Settings)
    if (!localStorage.getItem('aetheria.settings')) {
      let name = '';
      try { const e = gfx.gl.getExtension('WEBGL_debug_renderer_info'); name = e ? String(gfx.gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : ''; } catch (e) { /* ignore */ }
      if (/SwiftShader|llvmpipe|Software|Basic Render/i.test(name)) st.quality = 0;
      else if (/Intel|UHD|Iris|Mali|Adreno|PowerVR|Radeon\(TM\) Graphics|Vega/i.test(name)) st.quality = 1;
      this.gpuName = name;
    }
    const q = this.quality = params.has('q') ? Number(params.get('q')) : st.quality;
    gfx.quality.msaa = q >= 1 ? 4 : 2;
    gfx.quality.rays = q >= 1;
    gfx.csm.setTileSize(q >= 2 ? 2048 : 1024);
    this.input.sens = st.sens; this.input.invertY = st.invertY;

    setProgress(0.03, 'Gathering clouds');
    G.uNoiseTex.value = makeNoiseTexture(256);
    const audioP = import('./core/audio.js').then((m) => new m.AudioEngine()).catch((e) => { console.warn('audio unavailable', e); return NullAudio; });
    this.player = new Player(this);
    this.enemies = new Enemies(this);
    this.story = new Story(this);
    this.wildlife = new Wildlife(this);
    this.quests = this.story;          // the HUD reads title / objective / target from here
    const assetsP = Promise.all([this.player.load(), this.enemies.load(), this.story.load(), this.wildlife.load().catch((e) => console.warn('wildlife unavailable', e))]);
    const kitP = loadVillageKit().catch((e) => { console.warn('village kit unavailable, using procedural houses', e); return null; });

    const worldData = await generateWorld();
    setProgress(0.78, 'Lighting the sky');
    this.genMs = Math.round(worldData.genMs);
    const world = this.world = new World(worldData, gfx.renderer);
    this.sky = new Sky(gfx.scene, gfx.renderer);
    this.sky.setQuality(q);
    this.sky.dayLength = 20 * 60;
    this.terrain = new Terrain(gfx.scene, q);
    for (const m of this.terrain.meshes) gfx.addCaster(m);
    this.water = new Water(gfx.scene, world, q);
    this.grass = new Grass(gfx.scene, q);
    this.terrain.uGrassFar.value = this.grass.far;
    setProgress(0.84, 'Planting forests');
    await new Promise((r) => setTimeout(r, 0));
    // the Elder Tree: one colossal tree in the heart of Whispering Woods
    {
      const e = POI.elderTree, g = world.veg.trees[6];
      const ext = new Float32Array(g.length + 6);
      ext.set(g); ext.set([e.x, world.heightAt(e.x, e.z) - 0.6, e.z, 3.1, 0.7, 0.42], g.length);
      world.veg.trees[6] = ext;
    }
    this.flora = new Flora(gfx.scene, gfx, world, q);
    this.collision = new Collision(world, this.flora);
    setProgress(0.9, 'Raising old stones');
    await new Promise((r) => setTimeout(r, 0));
    this.kit = await kitP;
    if (this.kit) setBuildingTextures(this.kit.tex);
    this.structures = buildStructures(this);
    this.updrafts.push(...this.structures.updrafts);
    this.vfx = new VFX(this);
    this.props = new Props(this);
    const propsP = this.props.load().catch((e) => console.warn('chest models unavailable', e));
    this.cam = new OrbitCamera(gfx.camera, this);
    this.ui.initMap(world);

    setProgress(0.95, 'Waking the hero');
    await assetsP; await propsP;
    this.audio = await audioP;
    this.applySettings('audio');

    gfx.onResize = (w, h) => this.sky.setSize(w, h);
    this._resize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const maxPix = this.quality >= 3 ? 3.8e6 : this.quality >= 2 ? 2.8e6 : 2.0e6;
      const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(maxPix / (w * h)));
      gfx.renderScale = this.ui.settings.scale * (this._dynScale || 1);
      gfx.setSize(w, h, Math.max(0.5, dpr));
    };
    window.addEventListener('resize', this._resize);
    this._resize();

    this._decorate();

    // saved game?
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { saved = null; }
    this._saved = saved;

    canvas.addEventListener('click', () => { if (this.state === 'play' && !this.ui.modal && !this.inDialog) this.input.lock(); });
    this.input.onLockChange = (locked) => { if (!locked && this.state === 'play' && !this.ui.modal && !this.inDialog && !this._noAutoPause) this.ui.showPause(false); };
    window.addEventListener('beforeunload', () => { if (this.state === 'play') this.saveGame(); });

    this.sky.time = 7.25;
    if (params.has('tod')) this.sky.time = Number(params.get('tod'));
    if (params.has('cov')) this.sky.coverage = this.sky.coverageTarget = Number(params.get('cov'));
    if (params.has('rain')) { this.sky.coverage = this.sky.coverageTarget = 0.93; this.raining = true; this._wxT = 9999; }
    this._flyYaw = 0; this._flyPitch = 0;
    this.clock = new THREE.Clock();
    this._frames = 0; this._fpsT = 0;
    this.state = 'title';
    if (params.has('play') || params.has('pos') || this.fly) {
      // developer shortcut: skip the title
      this._noAutoPause = true;
      this.startGame(!params.has('continue'), true);
      if (params.has('pos')) { const p = params.get('pos').split(',').map(Number); this.tp(p[0], p[1], p[2]); }
      if (params.has('stage')) this.story.setStage(Number(params.get('stage')), true);
      if (params.has('tod')) this.sky.time = Number(params.get('tod'));
    } else {
      this.ui.showTitle(!!saved);
    }
    const loop = () => { requestAnimationFrame(loop); this.frame(); };
    loop();
  }

  // static glow sprites, mist at waterfalls, chimney smoke
  _decorate() {
    const S = this.structures, glows = [];
    for (const l of S.lanterns) glows.push({ pos: l, color: 0xffa040, size: 3.2, intensity: 1.1, night: true });
    for (const w of S.waypoints) glows.push({ pos: new THREE.Vector3(w.pos.x, w.pos.y + 4.35, w.pos.z), color: 0x58d8ff, size: 3.0, intensity: 0.75 });
    for (const s of S.shrines) glows.push({ pos: new THREE.Vector3(s.pos.x, s.glowY || s.pos.y + 9.2, s.pos.z), color: s.gem, size: 4.5, intensity: 0.8 });
    glows.push({ pos: new THREE.Vector3(S.towerTop.x, S.towerTop.y + 2.6, S.towerTop.z), color: 0x58d8ff, size: 7, intensity: 0.9 });
    for (const c of S.chimneys) this.vfx.addSmoke(c);
    for (const f of (S.braziers || [])) { this.vfx.addFire(f, 0.85); glows.push({ pos: f, color: 0xffa040, size: 3.6, intensity: 1.0, night: true }); }
    if (S.fountain) { this.vfx.addMist(S.fountain, 0.16); glows.push({ pos: new THREE.Vector3(S.fountain.x, S.fountain.y + 0.55, S.fountain.z), color: 0x58d8ff, size: 3.4, intensity: 0.7 }); }
    this.vfx.addColumn(new THREE.Vector3(S.towerTop.x, S.towerTop.y + 3, S.towerTop.z), 0x9ffff0, 80);
    glows.push({ pos: new THREE.Vector3(POI.elderTree.x, this.world.heightAt(POI.elderTree.x, POI.elderTree.z) + 30, POI.elderTree.z), color: 0x9fffb0, size: 26, intensity: 0.25 });
    this.vfx.setGlows(glows);
    // waterfalls: mist where a river drops steeply
    for (const R of this.world.rivers) {
      const s = R.samples;
      for (let i = 4; i < s.length - 1; i++) {
        if (s[i - 4][2] - s[i][2] > 7 && s[i][2] - s[i + 1][2] < 0.6) { this.vfx.addMist(new THREE.Vector3(s[i][0], s[i][2] + 0.4, s[i][1]), 1.5); i += 12; }
      }
    }
  }

  // ------------------------------------------------------------------ session
  startGame(isNew, instant) {
    if (this.state === 'play') return;
    const save = (!isNew && this._saved) ? { ...defaultSave(), ...this._saved } : defaultSave();
    this.save = save; this.inv = save.inv; this.stats = save.stats;
    if (!this.inv.sigils) this.inv.sigils = {};
    const p = this.player;
    p.maxHearts = save.maxHearts; p.hp = Math.max(4, save.hp); p.maxStamina = save.maxStamina; p.stamina = p.maxStamina;
    populateWorld(this);
    this.story.build();
    if (!this.wildlife.herds.length) this.wildlife.populate();
    this.story.setStage(save.stage, true);
    this.sky.time = save.time;
    this.audio.unlock();
    this.audio.stinger('title');
    this.ui.hideTitle();
    const sp = POI.spawn;
    p.char.group.visible = true;
    const begin = () => {
      this.state = 'play';
      this.ui.hud.classList.remove('hidden');
      setTimeout(() => { const h = this.ui.q('.crosshint'); h.style.opacity = 0; }, 60000);
      if (!instant) this.input.lock();
      if (save.pos) {
        p.teleport(save.pos[0], save.pos[1] + 0.2, save.pos[2], save.yaw || 0);
        this.cam.snapBehind(p.yaw);
      } else {
        // wake up on the shrine slab, facing north toward the valley
        const y = this.world.heightAt(sp.x, sp.z);
        p.teleport(sp.x, y + 1.35, sp.z, Math.PI);
        this.cam.snapBehind(Math.PI); this.cam.pitch = 0.05; this.cam.yaw += 0.5;
        if (!instant) {
          p.controlLock = 3.4; p.action = 'sit'; p.actionT = 0;
          if (p.char.clips.U_LayToIdle) {
            // lie still for a moment, then get up (hand-animated)
            const a = p.anim.play('U_LayToIdle', { loop: false, fade: 0, restart: true, speed: 0.9 });
            a.paused = true;
            setTimeout(() => { a.paused = false; }, 900);
          } else {
            p.anim.play('Lie_Idle', { fade: 0 });
            setTimeout(() => { p.anim.play('Lie_StandUp', { loop: false, fade: 0.2, speed: 1.15 }); }, 900);
          }
          setTimeout(() => { if (p.action === 'sit') p.action = null; this.ui.regionCard('Dawn Plateau', 'Where the world remembers you'); this.audio.stinger('discover'); this.save.regions['Dawn Plateau'] = 1; }, 3200);
        }
      }
    };
    if (instant) { begin(); return; }
    this.ui.fade(1, 0.9, true).then(() => { begin(); this.ui.fade(0, 1.6, true); });
  }

  saveGame() {
    if (this.state !== 'play') return;
    const p = this.player, s = this.save;
    const safe = p.mode === 'ground' ? p.pos : p.lastSafe;
    s.pos = [safe.x, safe.y, safe.z]; s.yaw = p.yaw;
    s.hp = p.hp; s.maxHearts = p.maxHearts; s.maxStamina = p.maxStamina; s.time = this.sky.time;
    s.inv = this.inv; s.stats = this.stats;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  applySettings(key) {
    const s = this.ui.settings;
    if (key === 'quality') { this.saveGame(); location.reload(); return; }
    this.input.sens = s.sens; this.input.invertY = s.invertY;
    this.audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx, ambience: s.ambience });
    if (key === 'scale' && this._resize) this._resize();
  }

  // ------------------------------------------------------------------ gameplay events
  giveLoot(l) {
    const parts = [];
    if (l.coins) { this.inv.coins += l.coins; parts.push(`<b>${l.coins}</b> lumen`); }
    if (l.apples) { this.inv.apples += l.apples; parts.push(`<b>${l.apples}</b> apple${l.apples > 1 ? 's' : ''}`); }
    if (l.orbs) { this.inv.orbs += l.orbs; this.stats.orbs += l.orbs; parts.push(`<b>${l.orbs}</b> Dawn Mote`); }
    const p = this.player;
    if (l.heart) { p.maxHearts++; p.hp = p.maxHearts * 4; this.ui.itemGet('Heart Vessel', 'Your maximum health grows by one heart.'); this.audio.stinger('levelup'); }
    else if (l.stamina) { p.maxStamina += 20; p.stamina = p.maxStamina; this.ui.itemGet('Stamina Vessel', 'Your stamina wheel grows. Climb higher, glide farther.' + (parts.length ? '<br>Also found: ' + parts.join(', ') : '')); this.audio.stinger('levelup'); }
    else this.ui.itemGet('Treasure', parts.join(' · '));
    this.saveGame();
  }

  onSkill(p) {
    // Gale Burst: knocks enemies up and leaves a short-lived updraft for the glider
    const x = p.pos.x, y = p.pos.y, z = p.pos.z;
    this.vfx.windBurst(x, y, z);
    this.audio.sfx('skill');
    this.cam.addShake(0.4);
    for (const e of this.enemies.list) {
      if (e.dead || e.state === 'dormant') continue;
      const dx = e.pos.x - x, dz = e.pos.z - z, d = Math.hypot(dx, dz);
      if (d < 7 && Math.abs(e.pos.y - y) < 4) { const l = Math.max(d, 0.1); e.takeHit(e.isBoss ? 2.5 : 1.5, dx / l, dz / l, 8); this.ui.floatText(new THREE.Vector3(e.pos.x, e.pos.y + e.height, e.pos.z), e.isBoss ? '25' : '15', ''); }
    }
    const u = { x, z, r: 5, y0: y, y1: y + 46, strength: 12, life: 8, em: this.vfx.addColumn(new THREE.Vector3(x, y, z), 0x8fffe0, 40) };
    this.tempUpdrafts.push(u); this.updrafts.push(u);
    if (p.mode === 'ground') { p.vel.y = 10.5; p.mode = 'air'; p.airTime = 0.2; p.peakY = p.pos.y; p.action = null; p.pos.y += 0.1; }
    else if (p.mode === 'air' || p.mode === 'glide') p.vel.y = Math.max(p.vel.y, 9);
  }

  onBossDefeated() { this.story.onBossDefeated(); }

  onPlayerDeath() {
    this.audio.stinger('gameover');
    setTimeout(() => { this.ui.showGameOver(); }, 1900);
  }

  _respawnPoint() {
    let best = null, bd = 1e9;
    for (const w of this.waypoints) if (w.active) { const d = w.pos.distanceTo(this.player.pos); if (d < bd) { bd = d; best = w; } }
    if (best) return new THREE.Vector3(best.pos.x + 2.5, best.pos.y + 0.3, best.pos.z + 2.5);
    const sp = POI.spawn; return new THREE.Vector3(sp.x, this.world.heightAt(sp.x, sp.z - 16) + 0.3, sp.z - 16);
  }

  respawn() {
    const r = this._respawnPoint();
    this.ui.fade(1, 0.01).then(() => {
      this.player.revive(r.x, r.y, r.z);
      this.cam.inited = false;
      if (this.story.boss && !this.story.boss.dead && this.story.stage === 4) { const b = this.story.boss; b.hp = b.maxHp; b.state = 'idle'; b.t = 0; }
      this.ui.fade(0, 1.2);
    });
  }

  onPlayerDrown() {
    const p = this.player;
    p.exhausted = false; p.stamina = p.maxStamina * 0.5;
    this.ui.fade(1, 0.35).then(() => {
      p.teleport(p.lastSafe.x, p.lastSafe.y + 0.2, p.lastSafe.z);
      p.invuln = 0; p.takeDamage(4, null, 0);
      this.ui.fade(0, 0.8);
    });
  }

  travelTo(id) {
    const w = this.waypoints.find((x) => x.id === id);
    if (!w || !w.active) return;
    this.ui.closeModal();
    this.audio.sfx('teleport');
    this.input.lock();
    this.ui.fade(1, 0.45, true).then(() => {
      this.player.teleport(w.pos.x + 2.6, w.pos.y + 0.3, w.pos.z + 2.6, 0);
      this.cam.snapBehind(Math.atan2(-2.6, -2.6));
      this.vfx.orbBurst(w.pos.x, w.pos.y + 4.4, w.pos.z, 0x66e0ff);
      this.ui.fade(0, 0.9, true);
    });
  }

  restAtFire() {
    const p = this.player;
    p.playInteract('Sit_Floor_Down', 1.6);
    this.ui.fade(1, 1.0).then(() => {
      const t = this.sky.time;
      this.sky.time = (t >= 5.5 && t < 16.5) ? 18.1 : 6.2;
      p.hp = p.maxHearts * 4; p.stamina = p.maxStamina;
      this.ui.notify(this.sky.time > 12 ? 'You rest until dusk.' : 'You rest until dawn.');
      this.audio.sfx('heal');
      this.saveGame();
      setTimeout(() => this.ui.fade(0, 1.4), 500);
    });
  }

  // ---- debug helpers (also used by the screenshot tool)
  tp(x, z, yawDeg) {
    this.player.teleport(x, this.world.heightAt(x, z) + 0.3, z, yawDeg !== undefined ? yawDeg * Math.PI / 180 : undefined);
    if (yawDeg !== undefined) this.cam.snapBehind(yawDeg * Math.PI / 180);
  }
  setCam(x, y, z, yawDeg, pitchDeg) {
    this.fly = true;
    this.gfx.camera.position.set(x, y, z);
    this._flyYaw = yawDeg * Math.PI / 180; this._flyPitch = pitchDeg * Math.PI / 180;
  }
  _updateFly(dt) {
    const cam = this.gfx.camera, inp = this.input;
    this._flyYaw -= inp.mouseDX * 0.0025; this._flyPitch = Math.max(-1.5, Math.min(1.5, this._flyPitch - inp.mouseDY * 0.0025));
    const sp = (inp.down('ShiftLeft') ? 120 : 20) * dt;
    const f = new THREE.Vector3(-Math.sin(this._flyYaw) * Math.cos(this._flyPitch), Math.sin(this._flyPitch), -Math.cos(this._flyYaw) * Math.cos(this._flyPitch));
    const r = new THREE.Vector3(Math.cos(this._flyYaw), 0, -Math.sin(this._flyYaw));
    const a = inp.axis();
    cam.position.addScaledVector(f, a.y * sp).addScaledVector(r, a.x * sp);
    if (inp.down('KeyE')) cam.position.y += sp;
    if (inp.down('KeyQ')) cam.position.y -= sp;
    cam.rotation.set(this._flyPitch, this._flyYaw, 0, 'YXZ');
  }
  _titleCam(dt) {
    // the hero stands at the plateau's edge looking over the valley; the camera drifts behind her shoulder
    const cam = this.gfx.camera, p = this.player, t = this.time;
    const hx = POI.overlook.x, hz = POI.overlook.z - 17;
    const hy = this.world.heightAt(hx, hz);
    if (p.ready) {
      p.pos.set(hx, hy, hz); p.yaw = Math.PI;
      p.char.group.visible = true;
      p.char.group.position.copy(p.pos); p.char.group.rotation.set(0, Math.PI, 0);
      p.anim.play(p.C.idle, { fade: 0 }); p.anim.update(dt);
      if (p.char.update) p.char.update(dt);
      G.uPlayerPos.value.copy(p.pos);
    }
    const a = 0.42 + Math.sin(t * 0.045) * 0.22;
    const d = 5.2 + Math.sin(t * 0.031) * 0.6;
    cam.position.set(hx + Math.sin(a) * d, hy + 1.75 + Math.sin(t * 0.06) * 0.12, hz + Math.cos(a) * d);
    cam.lookAt(hx - 1.5, hy + 1.45, hz - 30);
  }

  // ------------------------------------------------------------------ frame
  frame() {
    const rawDt = Math.min(this.clock.getDelta(), 0.1);
    const gfx = this.gfx, cam = gfx.camera, p = this.player;
    this.input.pollGamepad();
    const playing = this.state === 'play';
    const blocked = !!this.ui.modal || this.inDialog;
    this.input.enabled = playing && !blocked;
    let dt = rawDt * this.timeScale;
    if (this.paused) dt = 0;
    if (this.hitStop > 0) { this.hitStop -= rawDt; dt *= 0.05; }
    this.time += dt;
    G.uTime.value += dt;
    G.uWind.value.w += dt * (0.6 + G.uWind.value.z);
    if (this.dialogCooldown > 0) this.dialogCooldown -= rawDt;

    if (playing) {
      if (this.fly) { this._updateFly(rawDt); p.frozen = true; p.update(dt); }
      else {
        p.frozen = blocked;
        if (dt > 0) p.update(dt);
        this.cam.update(rawDt, p, this.paused ? null : this.input);
      }
      if (dt > 0) {
        this.enemies.update(dt);
        this.wildlife.update(dt);
        this.props.update(dt);
        this.story.update(dt);
        this._gameplay(dt);
      }
    } else if (this.state === 'title') {
      this._titleCam(rawDt);
    }
    if (dt > 0) this.vfx.update(dt);
    this.structures.update(dt, this.time);
    this.ui.update(rawDt);
    this.audio.update(rawDt);

    this.sky.update(dt);
    this.terrain.update(cam.position);
    this.water.update(cam.position);
    this.grass.update(cam);
    this.flora.update(cam.position);
    this.sky.dome.matrix.makeTranslation(cam.position.x, cam.position.y, cam.position.z);
    this.sky.dome.matrixWorldNeedsUpdate = true;
    gfx.render(this.sky);
    this.input.endFrame();

    this._frames++; this._fpsT += rawDt;
    if (this._fpsT > 0.5) {
      this.fps = this._frames / this._fpsT; this._frames = 0; this._fpsT = 0;
      window.__stats = { fps: Math.round(this.fps), calls: gfx.stats.calls, tris: gfx.stats.tris, w: gfx.width, h: gfx.height, mode: p.mode, pos: p.pos.toArray().map((v) => Math.round(v * 10) / 10), state: this.state, stage: this.story.stage };
      this._autoScale();
    }
    if (!window.__ready && G.uTime.value > 0.3) { window.__ready = true; $('loading').classList.add('hide'); setTimeout(() => { $('loading').style.display = 'none'; }, 1600); }
  }

  // lower the internal resolution if the machine cannot keep up
  _autoScale() {
    if (this.state !== 'play' || this.paused || document.hidden) return;
    this._perfT += 0.5; this._perfN += this.fps;
    if (this._perfT < 4) return;
    const avg = this._perfN / (this._perfT / 0.5);
    this._perfT = 0; this._perfN = 0;
    const s = this._dynScale || 1;
    if (avg < 30 && s > 0.6) { this._dynScale = Math.max(0.6, s - 0.1); this._resize(); }
    else if (avg < 24 && s <= 0.6 && this.quality > 0 && !this._lowHint) {
      // resolution is already at its floor: tell the player how to trade detail for speed
      this._lowHint = true;
      this.ui.notify('Low frame rate — press <b>Esc</b> and lower <b>Quality</b> for smoother play');
    }
    else if (avg > 57 && s < 1) { this._dynScale = Math.min(1, s + 0.05); this._resize(); }
  }

  _gameplay(dt) {
    const p = this.player, inp = this.input;
    this.stats.playTime = (this.stats.playTime || 0) + dt;
    // eat
    if (inp.hit('KeyR') && this.inv.apples > 0 && p.hp < p.maxHearts * 4 && p.action !== 'dead') {
      this.inv.apples--; p.heal(4); this.audio.sfx('eat'); this.vfx.heal(p.pos.x, p.pos.y, p.pos.z);
      if (p.mode === 'ground' && !p.action && p.moving < 0.5 && !this.enemies.inCombat && p.char.clips.U_Consume) p.playInteract('U_Consume', 0.95);
      this.ui.floatText(new THREE.Vector3(p.pos.x, p.pos.y + 2, p.pos.z), '+1 ♥', 'heal');
    }
    // temporary updrafts expire
    for (let i = this.tempUpdrafts.length - 1; i >= 0; i--) {
      const u = this.tempUpdrafts[i]; u.life -= dt;
      if (u.life <= 0) { u.em.on = false; this.tempUpdrafts.splice(i, 1); this.updrafts.splice(this.updrafts.indexOf(u), 1); }
    }
    // region discovery
    this._regionT += dt;
    if (this._regionT > 0.6) {
      this._regionT = 0;
      const r = regionAt(p.pos.x, p.pos.z);
      const name = r ? r.name : '';
      if (name !== this.regionName) {
        this.regionName = name;
        if (r && !(p.controlLock > 0)) {
          const first = !this.save.regions[name];
          if (first) { this.save.regions[name] = 1; this.audio.stinger('discover'); this.ui.regionCard(r.name, r.sub); }
          else if (this.time - (this._lastCard || -99) > 40) this.ui.regionCard(r.name, r.sub);
          this._lastCard = this.time;
        }
      }
    }
    // audio environment
    this._envT += dt;
    if (this._envT > 0.25) {
      this._envT = 0;
      const w = this.world, x = p.pos.x, z = p.pos.z;
      let nearWater = 0;
      for (const [ox, oz] of [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10]]) if (w.waterAt(x + ox, z + oz) > w.heightAt(x + ox, z + oz) + 0.1) nearWater += 0.25;
      this.audio.setEnvironment({ night: G.uNight.value, region: this.regionName, altitude: p.pos.y, nearWater: Math.min(1, nearWater), inForest: w.maskAt(x, z, 2), wind: Math.min(1, G.uWind.value.z * 0.5 + p.pos.y / 500), rain: this.rain || 0, combat: !!this.enemies.inCombat, swimming: p.mode === 'swim', time: this.sky.time });
    }
    // weather drift
    this._wxT = (this._wxT || 0) - dt;
    if (this._wxT <= 0) {
      this._wxT = 90 + Math.random() * 120;
      this.sky.coverageTarget = this.story.stage >= 5 ? 0.25 + Math.random() * 0.2 : 0.28 + Math.random() * 0.38;
      G.uWind.value.z = 0.7 + Math.random() * 0.7;
      // now and then a rain front rolls in (never during the first minutes or the boss fight)
      this.raining = this.stats.playTime > 240 && this.story.stage !== 4 && this.story.stage < 5 && Math.random() < 0.22;
      if (this.params.has('rain')) this.raining = true;
      if (this.raining) { this.sky.coverageTarget = 0.93; G.uWind.value.z = 1.5; }
    }
    {
      const c = this.sky.coverage, want = this.raining ? Math.min(1, Math.max(0, (c - 0.7) / 0.16)) * (p.pos.y < 290 ? 1 : 0.3) : 0;
      this.rain = (this.rain || 0) + (want - (this.rain || 0)) * Math.min(1, dt * 0.4);
      G.uWet.value += ((this.raining ? this.rain : this.rain * 0.6) - G.uWet.value) * Math.min(1, dt * 0.2);
      // thunder
      if (this.rain > 0.6) {
        this._thT = (this._thT === undefined ? 8 : this._thT) - dt;
        if (this._thT <= 0) { this._thT = 14 + Math.random() * 22; this._flash = 1; setTimeout(() => this.audio.sfx('thunder'), 500 + Math.random() * 900); }
      }
      this._flash = Math.max(0, (this._flash || 0) - dt * 3.2);
      this.gfx.exposure = 1 + this._flash * this._flash * 1.6;
    }
    // autosave
    this._saveT += dt;
    if (this._saveT > 20) { this._saveT = 0; this.saveGame(); }
  }
}

const game = new Game();
window.game = game;
game.boot().catch((e) => { console.error(e); $('load-label').textContent = 'Error: ' + e.message; window.__ready = true; });

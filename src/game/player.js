// Player character: movement modes (ground / air / glide / climb / swim), stamina, health, combat actions.
import * as THREE from 'three';
import { G } from '../core/globals.js';
import { loadModel, createCharacter, Animator, makeToonMaterials } from './characters.js';
import { loadVRM, createVRMCharacter } from './vrmchar.js';
import { Cape } from './cape.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _wish = new THREE.Vector3();
const _e = new THREE.Euler();
const _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _origin = new THREE.Vector3(), _dir = new THREE.Vector3();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), terrain: false };
const _hit2 = { point: new THREE.Vector3(), normal: new THREE.Vector3(), terrain: false };
const _cinfo = {};

const RADIUS = 0.36, HEIGHT = 1.62;
const WALK = 2.0, RUN = 5.0, SPRINT = 7.9, GRAVITY = 23, JUMP_V = 7.6;
const WALKABLE = 0.64;      // min normal.y to stand
const ATTACKS_HUMAN = [
  { clip: '1H_Melee_Attack_Slice_Diagonal', speed: 1.7, hit: 0.30, next: 0.42, dmg: 1.0, arc: 1.5, range: 2.5 },
  { clip: '1H_Melee_Attack_Slice_Horizontal', speed: 1.7, hit: 0.30, next: 0.42, dmg: 1.0, arc: 1.9, range: 2.5 },
  { clip: 'U_Sword_Attack', speed: 1.75, hit: 0.40, next: 0.68, dmg: 1.9, arc: 1.3, range: 3.1, startAt: 0.12, lunge: 6.5 },   // heavy lunging finisher
];
// hand-animated three-hit sword combo (rising cut, falling cut, leaping spin) plus a dash slash out of a sprint
const ATTACKS_COMBO = [
  { clip: 'U_Sword_Regular_A', rec: 'U_Sword_Regular_A_Rec', speed: 1.0, hit: 0.42, next: 0.8, dmg: 1.0, arc: 1.6, range: 2.6 },
  { clip: 'U_Sword_Regular_B', rec: 'U_Sword_Regular_B_Rec', speed: 1.0, hit: 0.4, next: 0.8, dmg: 1.1, arc: 1.8, range: 2.6 },
  { clip: 'U_Sword_Regular_C', speed: 1.55, hit: 0.36, next: 0.6, dmg: 2.0, arc: 2.8, range: 3.1, lunge: 5.5 },
  { clip: 'U_Sword_Dash', speed: 1.6, hit: 0.62, next: 0.78, dmg: 1.6, arc: 1.7, range: 3.2, lunge: 13, lungeAt: 0.2, dash: true },
];
const ATTACKS = [
  { clip: '1H_Melee_Attack_Slice_Diagonal', speed: 1.7, hit: 0.30, next: 0.42, dmg: 1.0, arc: 1.5, range: 2.5 },
  { clip: '1H_Melee_Attack_Slice_Horizontal', speed: 1.7, hit: 0.30, next: 0.42, dmg: 1.0, arc: 1.9, range: 2.5 },
  { clip: '1H_Melee_Attack_Chop', speed: 1.5, hit: 0.34, next: 0.55, dmg: 1.7, arc: 1.2, range: 2.8 },
];

function angLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function makeGlider(gfx) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#efe6cf'; c.fillRect(0, 0, 256, 128);
  c.fillStyle = '#c8452f';
  for (let i = 0; i < 8; i++) { c.beginPath(); c.moveTo(i * 36 - 10, 128); c.lineTo(i * 36 + 8, 96); c.lineTo(i * 36 + 26, 128); c.fill(); }
  c.fillStyle = '#2f7f86'; c.fillRect(0, 0, 256, 10);
  c.strokeStyle = '#2f7f86'; c.lineWidth = 5;
  c.beginPath(); c.arc(128, 58, 24, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.moveTo(128, 26); c.lineTo(138, 58); c.lineTo(128, 90); c.lineTo(118, 58); c.closePath(); c.fillStyle = '#e2a53a'; c.fill();
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mats = makeToonMaterials(tex, { doubleSide: true, outline: 0 });
  const geo = new THREE.PlaneGeometry(3.0, 1.5, 10, 3);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, -x * x * 0.16 + Math.cos(x * 4.2) * 0.04 - Math.abs(z) * 0.08);
  }
  geo.computeVertexNormals();
  const sail = new THREE.Mesh(geo, mats.main);
  const wood = makeToonMaterials(null, { tint: 0x6b4526, outline: 0 });
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 3.0, 6), wood.main); bar.rotation.z = Math.PI / 2; bar.position.y = -0.02;
  const bar2 = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), wood.main); bar2.rotation.x = Math.PI / 2; bar2.position.y = 0.02;
  const g = new THREE.Group();
  g.add(sail, bar, bar2);
  for (const sx of [-0.45, 0.45]) {
    const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.9, 5), wood.main);
    strap.position.set(sx, -0.47, 0); g.add(strap);
  }
  g.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; } });
  g.visible = false;
  return g;
}

export class Player {
  constructor(game) {
    this.game = game;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.mode = 'ground';
    this.action = null;         // attack | roll | hit | block | cast | interact | dead | mantle | sit
    this.actionT = 0;
    this.grounded = true;
    this.groundN = new THREE.Vector3(0, 1, 0);
    this.airTime = 0;
    this.peakY = 0;
    this.sprinting = false;
    this.moving = 0;
    this.maxHearts = 3;
    this.hp = 12;               // quarter hearts
    this.maxStamina = 100;
    this.stamina = 100;
    this.exhausted = false;
    this.staminaDelay = 0;
    this.invuln = 0;
    this.combo = 0;
    this.attackHit = false;
    this.queuedAttack = false;
    this.climbN = new THREE.Vector3(0, 0, 1);
    this.climbC = new THREE.Vector3();
    this.climbLeap = 0;
    this.mantleFrom = new THREE.Vector3(); this.mantleTo = new THREE.Vector3();
    this.lastSafe = new THREE.Vector3();
    this.safeT = 0;
    this.tilt = new THREE.Vector2();
    this.glideBlend = 0;
    this.swimBob = 0;
    this.skillCd = 0;
    this.stepT = 0;
    this.controlLock = 0;       // seconds of ignored input (cutscenes)
    this.frozen = false;
    this.heightScale = 1;
    this.target = null;         // soft-locked enemy
    this.ready = false;
  }

  async load() {
    const gltf = await loadModel('./assets/models/kaykit/opt/Knight.glb');
    // the hero is an anime-style VRM avatar driven by the re-targeted clips; the knight is the fallback
    const hero = this.game.params.get('hero') || 'vrm';
    if (hero !== 'knight') {
      try {
        const vrm = await loadVRM('./assets/models/vrm/Vita.vrm');
        const [ual, ual2] = await Promise.all([loadModel('./assets/models/ual/UAL.glb'), loadModel('./assets/models/ual/UAL2.glb').catch(() => null)]);
        this.char = createVRMCharacter(vrm, gltf, this.game.gfx, { recolor: true, ual, ual2 });
        this.heightScale = 0.9;
        this.trailY = [0.14, 0.97];
        this.char.cape = new Cape(this.char, this.game);
      } catch (e) { console.warn('VRM hero unavailable, using the knight', e); }
    }
    if (!this.char) this.char = createCharacter(gltf, this.game.gfx, { show: ['1H_Sword', 'Round_Shield', 'Knight_Helmet', 'Knight_Cape'], scale: 0.72 });
    this.anim = new Animator(this.char);
    // which clips drive which state: the anime hero uses the human-proportioned library, the knight his own set
    const V = !!this.char.isVRM && !!this.char.clips.U_Idle_Loop;
    this.human = V;
    const combo = V && ATTACKS_COMBO.every((a) => this.char.clips[a.clip]);
    this.attacks = combo ? ATTACKS_COMBO : V ? ATTACKS_HUMAN : ATTACKS;
    this.comboLen = 3;
    this.C = V
      ? { idle: 'U_Idle_Loop', combatIdle: 'U_Sword_Idle', hit: ['U_Hit_Chest', 1.0], death: 'U_Death01', block: this.char.clips.U_Sword_Block ? 'U_Sword_Block' : 'U_Spell_Simple_Idle_Loop', blockHold: this.char.clips.U_Sword_Block ? 0.42 : 0,
        jumpStart: ['U_Jump_Start', 1.0, 0.34], jumpLoop: 'U_Jump_Loop', jumpLand: ['U_Jump_Land', 1.7, 0.06, 0.3],
        roll: ['U_Roll', 2.05, 0.14], rollDur: 0.6, rollFast: 0.4, rollIframes: 0.46, interact: ['U_Interact', 2.1] }
      : { idle: 'Idle', combatIdle: 'Idle', hit: ['Hit_A', 1.3], death: 'Death_A', block: 'Blocking',
        jumpStart: ['Jump_Start', 1.4, 0], jumpLoop: 'Jump_Idle', jumpLand: ['Jump_Land', 1.5, 0, 0.22],
        roll: ['Dodge_Forward', 0.95, 0], rollDur: 0.46, rollFast: 0.3, rollIframes: 0.36, interact: ['Interact', 1.3] };
    this.game.gfx.scene.add(this.char.group);
    this.glider = makeGlider(this.game.gfx);
    this.glider.position.set(0, this.char.isVRM ? 2.02 : 2.25, 0.05);
    this.char.group.add(this.glider);
    this.anim.play(this.C.idle);
    this.sword = this.char.parts['1H_Sword'];
    // guarding conjures a ward of light in front of the hero
    this.barrier = new THREE.Mesh(new THREE.CircleGeometry(0.82, 6), new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uK: { value: 0 } },
      vertexShader: 'out vec2 vQ; void main(){ vQ = position.xy / 0.82; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uTime; uniform float uK; in vec2 vQ; out vec4 fragColor; void main(){ float r = length(vQ); vec2 a = abs(vQ); float hex = max(a.y, a.x * 0.866 + a.y * 0.5); float rim = smoothstep(0.78, 0.85, hex) * smoothstep(0.9, 0.86, hex); float cells = smoothstep(0.44, 0.5, abs(fract(hex * 3.0 - uTime * 0.6) - 0.5)); vec3 c = vec3(0.3, 0.9, 1.2) * (rim * 1.5 + cells * 0.16 + 0.05 * (1.0 - r)); fragColor = vec4(c * uK, 1.0); }',
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.barrier.position.set(0, 1.0, 0.62); this.barrier.visible = false; this.barrier.layers.set(1); this.barrier.renderOrder = 33; this.barrier.frustumCulled = false;
    this.char.group.add(this.barrier);
    this.ready = true;
  }

  get hearts() { return this.hp / 4; }

  teleport(x, y, z, yaw) {
    this.pos.set(x, y, z); this.vel.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
    this.mode = 'air'; this.action = null; this.airTime = 0; this.peakY = y;
    this.lastSafe.copy(this.pos);
    this.game.cam.inited = false;
    if (this.char && this.char.resetPhysics) { this.char.group.position.copy(this.pos); this.char.resetPhysics(); }
  }

  // ------------------------------------------------------------------ queries
  _groundY(x, y, z) {
    const w = this.game.world, col = this.game.collision;
    const th = w.heightAt(x, z);
    const mh = col ? col.groundMesh(x, y, z, 0.7, 1.5) : -Infinity;
    if (mh > th && mh < y + 0.75) { this.groundN.set(0, 1, 0); this._onMesh = true; return mh; }
    w.normalAt(x, z, this.groundN); this._onMesh = false;
    return th;
  }

  spendStamina(a) {
    this.stamina -= a; this.staminaDelay = 0.9;
    if (this.stamina <= 0) { this.stamina = 0; this.exhausted = true; }
  }

  // ------------------------------------------------------------------ damage
  takeDamage(q, from, knock = 4) {
    if (this.invuln > 0 || this.action === 'dead' || this.frozen) return false;
    if (this.action === 'roll' && this.actionT < this.C.rollIframes) return false;
    const g = this.game;
    if (this.action === 'block' && from) {
      _v.set(from.x - this.pos.x, 0, from.z - this.pos.z).normalize();
      const f = Math.sin(this.yaw) * _v.x + Math.cos(this.yaw) * _v.z;
      if (f > 0.2) {
        this.spendStamina(12);
        if (!this.human) this.anim.play('Block_Hit', { loop: false, fade: 0.05, restart: true });
        this.blockHitT = 0.3;
        this.vel.addScaledVector(_v, -2.5);
        g.audio && g.audio.sfx('block');
        g.vfx && g.vfx.sparks(this.pos.x + _v.x * 0.5, this.pos.y + 1, this.pos.z + _v.z * 0.5, 0xfff2c0, 8);
        g.cam.addShake(0.3);
        return false;
      }
    }
    this.hp = Math.max(0, this.hp - q);
    this.invuln = 0.9;
    this.char.uniforms.uFlash.value.setRGB(0.9, 0.15, 0.1);
    g.cam.addShake(0.6);
    g.audio && g.audio.sfx('hurt');
    g.ui && g.ui.damageVignette();
    if (from) { _v.set(this.pos.x - from.x, 0, this.pos.z - from.z).normalize(); this.vel.x = _v.x * knock; this.vel.z = _v.z * knock; }
    if (this.mode === 'climb' || this.mode === 'glide') this.mode = 'air';
    if (this.hp <= 0) { this.die(); return true; }
    if (this.mode !== 'swim') { this.action = 'hit'; this.actionT = 0; this.anim.play(this.C.hit[0], { loop: false, fade: 0.06, restart: true, speed: this.C.hit[1] }); }
    return true;
  }

  die() {
    if (this.action === 'dead') return;
    this.action = 'dead'; this.actionT = 0;
    this.anim.play(this.C.death, { loop: false, fade: 0.12 });
    this.game.onPlayerDeath && this.game.onPlayerDeath();
  }

  revive(x, y, z) {
    this.hp = this.maxHearts * 4; this.stamina = this.maxStamina; this.exhausted = false;
    this.action = null; this.invuln = 2;
    this.teleport(x, y, z);
    this.anim.play(this.C.idle, { fade: 0 });
  }

  heal(q) { this.hp = Math.min(this.maxHearts * 4, this.hp + q); }

  // ------------------------------------------------------------------ update
  update(dt) {
    if (!this.ready) return;
    const g = this.game, inp = g.input, cam = g.cam, w = g.world;
    this.invuln = Math.max(0, this.invuln - dt);
    this.skillCd = Math.max(0, this.skillCd - dt);
    const fl = this.char.uniforms.uFlash.value; fl.multiplyScalar(Math.exp(-dt * 9));

    // camera-relative wish direction
    let ax = { x: 0, y: 0 };
    const canInput = !this.frozen && this.controlLock <= 0 && this.action !== 'dead';
    this.controlLock = Math.max(0, this.controlLock - dt);
    if (canInput) ax = inp.axis();
    cam.forward(_fwd); cam.right(_right);
    _wish.set(_fwd.x * ax.y + _right.x * ax.x, 0, _fwd.z * ax.y + _right.z * ax.x);
    const wishLen = Math.min(1, _wish.length());
    if (wishLen > 1e-3) _wish.multiplyScalar(1 / _wish.length());
    const jumpHit = canInput && (inp.hit('Space') || inp.padHit(0));
    const jumpHeld = canInput && (inp.down('Space') || inp.padDown(0));
    const sprintHeld = canInput && (inp.down('ShiftLeft') || inp.down('ShiftRight') || inp.padDown(1));
    const walkHeld = canInput && inp.down('AltLeft');

    if (this.action === 'dead') { this.actionT += dt; this._physicsDead(dt); this._finish(dt, 0); return; }

    // ---------------- actions that override locomotion
    if (this.action) this.actionT += dt;
    if (this.action === 'hit' && this.actionT > 0.38) this.action = null;
    if (this.action === 'cast' && this.actionT > 0.9) this.action = null;
    if (this.action === 'interact' && this.actionT > (this.interactDur || 0.8)) this.action = null;
    if (this.blockHitT > 0) this.blockHitT -= dt;
    if (this.chainT > 0) this.chainT -= dt;

    if (canInput && this.mode === 'ground' && (!this.action || this.action === 'attack' || this.action === 'block')) {
      if (inp.mouseHit(0) || inp.padHit(2)) this._tryAttack(wishLen);
      else if ((inp.hit('ControlLeft') || inp.hit('KeyC') || inp.padHit(3)) && !this.exhausted && this.stamina > 8) this._startRoll(wishLen);
    }
    if (canInput && (inp.hit('KeyQ') || inp.padHit(5)) && this.skillCd <= 0 && !this.action && this.mode !== 'swim' && this.mode !== 'climb') this._castSkill();
    // block
    const wantBlock = canInput && this.mode === 'ground' && (inp.mouse(2) || inp.padDown(4)) && (!this.action || this.action === 'block') && !this.exhausted;
    if (wantBlock && this.action !== 'block') { this.action = 'block'; this.actionT = 0; }
    if (!wantBlock && this.action === 'block') this.action = null;

    switch (this.mode) {
      case 'ground': this._ground(dt, wishLen, jumpHit, sprintHeld, walkHeld); break;
      case 'air': this._air(dt, wishLen, jumpHit, jumpHeld); break;
      case 'glide': this._glide(dt, wishLen, jumpHit); break;
      case 'climb': this._climb(dt, ax, jumpHit, canInput); break;
      case 'swim': this._swim(dt, wishLen, sprintHeld); break;
      case 'mantle': this._mantle(dt); break;
    }

    // stamina regen
    if (this.staminaDelay > 0) this.staminaDelay -= dt;
    else if (this.mode === 'ground' || (this.mode === 'mantle')) {
      this.stamina = Math.min(this.maxStamina, this.stamina + dt * 34);
      if (this.exhausted && this.stamina >= this.maxStamina) this.exhausted = false;
    }

    // remember a safe place to respawn after drowning / falling into the void
    if (this.mode === 'ground' && !this.action && this.groundN.y > 0.85) {
      this.safeT += dt;
      if (this.safeT > 0.6 && w.waterAt(this.pos.x, this.pos.z) < this.pos.y - 0.2) { this.lastSafe.copy(this.pos); this.safeT = 0; }
    }
    this._finish(dt, wishLen);
  }

  // ------------------------------------------------------------------ ground
  _ground(dt, wishLen, jumpHit, sprintHeld, walkHeld) {
    const g = this.game, w = g.world;
    let speed = RUN;
    this.sprinting = false;
    let control = 1;
    if (this.action === 'attack') { control = 0.0; this._updateAttack(dt); }
    else if (this.action === 'roll') { control = 0; this._updateRoll(dt); }
    else if (this.action === 'hit' || this.action === 'cast' || this.action === 'interact' || this.action === 'sit') control = 0;
    else if (this.action === 'block') speed = 1.6;
    else if (walkHeld) speed = WALK;
    else if (sprintHeld && wishLen > 0.5 && !this.exhausted) { speed = SPRINT; this.sprinting = true; this.spendStamina(dt * 11); }

    if (control > 0) {
      // slow down when heading uphill
      const up = -(this.groundN.x * _wish.x + this.groundN.z * _wish.z);
      const slopeK = 1 - Math.max(0, up) * 0.55;
      const tx = _wish.x * speed * wishLen * slopeK, tz = _wish.z * speed * wishLen * slopeK;
      const rate = wishLen > 0.01 ? 34 : 26;
      const k = Math.min(1, rate * dt / Math.max(0.001, Math.hypot(tx - this.vel.x, tz - this.vel.z)));
      this.vel.x += (tx - this.vel.x) * k; this.vel.z += (tz - this.vel.z) * k;
      if (wishLen > 0.05 && this.action !== 'block') this.yaw = angLerp(this.yaw, Math.atan2(_wish.x, _wish.z), Math.min(1, dt * 13));
      else if (this.action === 'block' && wishLen < 0.05) { /* keep facing */ }
    } else if (this.action !== 'roll' && this.action !== 'attack') {
      this.vel.x *= Math.exp(-dt * 8); this.vel.z *= Math.exp(-dt * 8);
    }

    // steep slopes: slide down, or grab on when pushing into them
    if (this.groundN.y < WALKABLE && !this._onMesh) {
      const pushing = wishLen > 0.4 && (this.groundN.x * _wish.x + this.groundN.z * _wish.z) < -0.25;
      if (pushing && !this.action && !this.exhausted && this._tryStartClimb(_wish)) return;
      this.vel.x += this.groundN.x * 26 * dt; this.vel.z += this.groundN.z * 26 * dt;
    }

    if (jumpHit && (!this.action || this.action === 'block') && this.groundN.y > 0.45) {
      this.vel.y = JUMP_V; this.mode = 'air'; this.airTime = 0; this.peakY = this.pos.y; this.action = null;
      this.anim.play(this.C.jumpStart[0], { loop: false, fade: 0.08, restart: true, speed: this.C.jumpStart[1], startAt: this.C.jumpStart[2] });
      this.jumpAnimT = 0.28;
      g.audio && g.audio.sfx('jump');
      this.pos.y += 0.05;
      return;
    }

    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    this._collideWalls();
    const gy = this._groundY(this.pos.x, this.pos.y, this.pos.z);
    if (this.pos.y - gy > 0.45) {
      // walked off an edge
      this.mode = 'air'; this.airTime = 0; this.peakY = this.pos.y; this.vel.y = 0; this.coyote = 0.12;
      if (this.action === 'attack' || this.action === 'block') this.action = null;
    } else {
      this.pos.y = gy; this.vel.y = 0;
    }
    // wading into deep water
    const wl = w.waterAt(this.pos.x, this.pos.z);
    if (wl - this.pos.y > 1.05) this._enterSwim(wl);

    // try to climb structure walls when walking straight into them
    if (wishLen > 0.6 && !this.action && this._wallAhead) {
      this.wallPushT = (this.wallPushT || 0) + dt;
      if (this.wallPushT > 0.16 && (this._tryVault(_wish) || (!this.exhausted && this._tryStartClimb(_wish)))) this.wallPushT = 0;
    } else this.wallPushT = 0;
  }

  _collideWalls() {
    const g = this.game;
    this._wallAhead = false;
    if (g.flora) g.flora.collide(this.pos, RADIUS);
    if (g.props) g.props.collide(this.pos, RADIUS);
    if (g.collision && g.collision.resolveCapsule(this.pos, RADIUS, HEIGHT, _cinfo)) {
      if (!_cinfo.grounded && !_cinfo.ceiling) this._wallAhead = true;
      if (_cinfo.ceiling && this.vel.y > 0) this.vel.y = 0;
    }
    // keep inside the world
    const lim = 2020;
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x)); this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));
  }

  // ------------------------------------------------------------------ air
  _air(dt, wishLen, jumpHit, jumpHeld) {
    const g = this.game, w = g.world;
    this.airTime += dt;
    this.sprinting = false;
    if (this.coyote > 0) {
      this.coyote -= dt;
      if (jumpHit) { this.vel.y = JUMP_V; this.coyote = 0; this.peakY = this.pos.y; this.anim.play(this.C.jumpStart[0], { loop: false, fade: 0.08, restart: true, speed: this.C.jumpStart[1], startAt: this.C.jumpStart[2] }); this.jumpAnimT = 0.28; jumpHit = false; }
    }
    this.vel.y -= GRAVITY * dt * (this.vel.y < 0 ? 1.25 : 1);
    if (!jumpHeld && this.vel.y > 3.2) this.vel.y -= 22 * dt;          // variable jump height
    this.vel.y = Math.max(this.vel.y, -48);
    const sp = Math.max(RUN, Math.hypot(this.vel.x, this.vel.z));
    if (wishLen > 0.01) {
      const tx = _wish.x * sp * wishLen, tz = _wish.z * sp * wishLen;
      const k = Math.min(1, dt * 3.2);
      this.vel.x += (tx - this.vel.x) * k; this.vel.z += (tz - this.vel.z) * k;
      this.yaw = angLerp(this.yaw, Math.atan2(_wish.x, _wish.z), Math.min(1, dt * 8));
    }
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y > this.peakY) this.peakY = this.pos.y;
    this._collideWalls();

    // glide
    if (jumpHit && this.airTime > 0.12 && !this.exhausted && this.stamina > 3 && !this.action && this.canGlide !== false) {
      const gy0 = this._groundY(this.pos.x, this.pos.y, this.pos.z);
      if (this.pos.y - gy0 > 1.2) { this.mode = 'glide'; this.vel.y = Math.max(this.vel.y, -3); g.audio && g.audio.sfx('glider'); return; }
    }
    // grab walls in mid-air when steering into them
    if (wishLen > 0.5 && this.airTime > 0.18 && !this.exhausted && !this.action && this.vel.y < 4) {
      if (this._tryStartClimb(_wish)) return;
    }
    const wl = w.waterAt(this.pos.x, this.pos.z);
    if (wl - w.heightAt(this.pos.x, this.pos.z) > 1.2 && this.pos.y < wl - 0.95) { this._enterSwim(wl, true); return; }

    const gy = this._groundY(this.pos.x, this.pos.y, this.pos.z);
    if (this.pos.y <= gy && this.vel.y <= 0.01) this._land(gy);
  }

  _land(gy) {
    const g = this.game;
    const drop = this.peakY - gy;
    this.pos.y = gy;
    const vy = this.vel.y;
    this.vel.y = 0;
    this.mode = 'ground';
    if (this.action === 'hit') { /* keep */ }
    if (drop > 9.5) {
      const dmg = Math.min(40, Math.floor((drop - 8.5) * 0.75));
      this.invuln = 0;
      this.takeDamage(dmg, null, 0);
      this.vel.x *= 0.2; this.vel.z *= 0.2;
    }
    if (vy < -9 && !this.action) {
      this.anim.play(this.C.jumpLand[0], { loop: false, fade: 0.06, restart: true, speed: this.C.jumpLand[1], startAt: this.C.jumpLand[2] });
      this.landT = this.C.jumpLand[3];
      g.cam.addShake(Math.min(0.5, -vy * 0.02));
    }
    g.audio && g.audio.sfx('land', Math.min(1, -vy / 14));
    g.vfx && g.vfx.dust(this.pos.x, this.pos.y + 0.05, this.pos.z, Math.min(10, 3 + (-vy) * 0.4));
  }

  // ------------------------------------------------------------------ glide
  _glide(dt, wishLen, jumpHit) {
    const g = this.game, w = g.world;
    this.airTime += dt;
    this.spendStamina(dt * 3.0);
    let targetVy = -2.1;
    // updrafts lift the glider
    if (g.updrafts) for (const u of g.updrafts) {
      const d = Math.hypot(this.pos.x - u.x, this.pos.z - u.z);
      if (d < u.r && this.pos.y > u.y0 - 2 && this.pos.y < u.y1) targetVy = Math.max(targetVy, u.strength * (1 - (d / u.r) * 0.5));
    }
    this.vel.y += (targetVy - this.vel.y) * Math.min(1, dt * (targetVy > 0 ? 2.2 : 5));
    const sp = 9.2;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let tx = fx * sp * 0.55, tz = fz * sp * 0.55;
    if (wishLen > 0.01) { tx = _wish.x * sp * wishLen; tz = _wish.z * sp * wishLen; this.yaw = angLerp(this.yaw, Math.atan2(_wish.x, _wish.z), Math.min(1, dt * 3.2)); }
    const k = Math.min(1, dt * 2.4);
    this.vel.x += (tx - this.vel.x) * k; this.vel.z += (tz - this.vel.z) * k;
    this.pos.addScaledVector(this.vel, dt);
    this.peakY = this.pos.y + 2;      // no fall damage out of a glide
    this._collideWalls();
    if (jumpHit || this.exhausted || this.action === 'hit') { this.mode = 'air'; this.peakY = this.pos.y; return; }
    if (wishLen > 0.5 && this._tryStartClimb(_wish)) return;
    const wl = w.waterAt(this.pos.x, this.pos.z);
    if (wl - w.heightAt(this.pos.x, this.pos.z) > 1.2 && this.pos.y < wl - 0.95) { this._enterSwim(wl, true); return; }
    const gy = this._groundY(this.pos.x, this.pos.y, this.pos.z);
    if (this.pos.y <= gy) { this.peakY = gy; this._land(gy); }
  }

  // hop onto low ledges (up to ~1.3 m) without needing to jump
  _tryVault(dirv) {
    const col = this.game.collision;
    if (!col) return false;
    _origin.set(this.pos.x + dirv.x * 0.8, this.pos.y + 1.5, this.pos.z + dirv.z * 0.8);
    _dir.set(0, -1, 0);
    const t = col.raycast(_origin, _dir, 1.35, _hit2);
    if (t < 0 || _hit2.normal.y < 0.7) return false;
    const top = _hit2.point.y - this.pos.y;
    if (top < 0.3 || top > 1.3) return false;
    this.mode = 'mantle'; this.actionT = 0;
    this.mantleFrom.copy(this.pos); this.mantleTo.copy(_hit2.point);
    return true;
  }

  // ------------------------------------------------------------------ climb
  _tryStartClimb(dirv) {
    const col = this.game.collision;
    if (!col) return false;
    // chest and head rays must both find a steep surface
    _dir.set(dirv.x, 0, dirv.z).normalize();
    _origin.set(this.pos.x, this.pos.y + 0.95, this.pos.z);
    const t1 = col.raycast(_origin, _dir, 0.85, _hit);
    if (t1 < 0 || _hit.normal.y > 0.6 || _hit.normal.y < -0.5) return false;
    _origin.y = this.pos.y + 1.55;
    const t2 = col.raycast(_origin, _dir, 1.5, _hit2);
    if (t2 < 0 || _hit2.normal.y > 0.66) return false;
    this.mode = 'climb'; this.action = null;
    this.climbN.copy(_hit.normal); this.climbN.y *= 0.5; this.climbN.normalize();
    this.climbC.copy(_hit.point).addScaledVector(_hit.normal, 0.36);
    this.vel.set(0, 0, 0);
    this.climbLeap = 0; this.climbPhase = 0;
    this.game.audio && this.game.audio.sfx('grab');
    return true;
  }

  _climb(dt, ax, jumpHit, canInput) {
    const g = this.game, col = g.collision;
    const n = this.climbN;
    _right.crossVectors(UP, n); if (_right.lengthSq() < 1e-4) _right.set(1, 0, 0); _right.normalize();
    const upA = _v2.crossVectors(n, _right).normalize();
    let ix = ax.x, iy = ax.y;
    let speed = 1.75;
    if (this.climbLeap > 0) { this.climbLeap -= dt; ix = 0; iy = 1; speed = 6.5; }
    const moving = Math.hypot(ix, iy);
    if (moving > 0.05) this.spendStamina(dt * (this.climbLeap > 0 ? 0 : 4.4));
    if (this.exhausted) { this.mode = 'air'; this.airTime = 0; this.peakY = this.pos.y; this.vel.copy(n).multiplyScalar(1.5); return; }
    if (canInput && (g.input.hit('ControlLeft') || g.input.hit('KeyC') || g.input.padHit(3))) { this.mode = 'air'; this.airTime = 0; this.peakY = this.pos.y; this.vel.copy(n).multiplyScalar(1.2); return; }
    if (jumpHit && this.climbLeap <= 0) {
      if (iy < -0.3) {   // kick off the wall
        this.mode = 'air'; this.airTime = 0.2; this.peakY = this.pos.y;
        this.vel.set(n.x * 5, 6.2, n.z * 5); this.yaw = Math.atan2(n.x, n.z);
        this.spendStamina(10); g.audio && g.audio.sfx('jump');
        return;
      }
      if (this.stamina > 14) { this.spendStamina(16); this.climbLeap = 0.24; g.audio && g.audio.sfx('jump'); }
    }
    const prev = _v.copy(this.climbC);
    this.climbC.addScaledVector(_right, ix * speed * dt).addScaledVector(upA, iy * speed * dt);
    this.climbPhase = (this.climbPhase || 0) + moving * dt * (this.climbLeap > 0 ? 9 : 3.4);

    // re-attach to the surface
    _origin.copy(this.climbC).addScaledVector(n, 0.55);
    _dir.copy(n).negate();
    const t = col.raycast(_origin, _dir, 1.5, _hit);
    if (t >= 0) {
      if (_hit.normal.y > 0.74) {
        // the surface levelled out: stand up
        this.pos.copy(_hit.point); this.mode = 'ground'; this.vel.set(0, 0, 0); this.yaw = Math.atan2(-n.x, -n.z);
        return;
      }
      this.climbC.copy(_hit.point).addScaledVector(_hit.normal, 0.36);
      n.lerp(_hit.normal, Math.min(1, dt * 10)).normalize();
      // an overhanging ledge above the head: pull up onto it instead of clipping through
      if (iy > 0.1) {
        _origin.copy(this.climbC).addScaledVector(n, 0.12); _dir.set(0, 1, 0);
        const tc = col.raycastMesh(_origin, _dir, 1.15, _hit2);
        if (tc >= 0 && _hit2.normal.y < -0.4) {
          _origin.set(this.climbC.x + n.x * 0.55, _hit2.point.y + 2.2, this.climbC.z + n.z * 0.55); _dir.set(0, -1, 0);
          const tt = col.raycastMesh(_origin, _dir, 2.3, _hit2);
          if (tt >= 0 && _hit2.normal.y > 0.6) {
            this.mode = 'mantle'; this.actionT = 0;
            this.mantleFrom.copy(this.climbC).addScaledVector(upA, -0.92); this.mantleTo.copy(_hit2.point);
            this.yaw = Math.atan2(-n.x, -n.z);
            return;
          }
          this.climbC.copy(prev);
        }
      }
    } else {
      // ran out of wall: try to mantle over the top
      let mantled = false;
      if (iy > 0.1) {
        _origin.copy(this.climbC).addScaledVector(upA, 1.0).addScaledVector(n, -0.6);
        _dir.set(0, -1, 0);
        const t2 = col.raycast(_origin, _dir, 1.9, _hit2);
        if (t2 >= 0 && _hit2.normal.y > 0.6) {
          this.mode = 'mantle'; this.actionT = 0;
          this.mantleFrom.copy(this.pos); this.mantleTo.copy(_hit2.point);
          this.yaw = Math.atan2(-n.x, -n.z);
          mantled = true;
        }
      }
      if (!mantled) this.climbC.copy(prev);
      else return;
    }
    // feet reached walkable ground while descending
    this.pos.copy(this.climbC).addScaledVector(upA, -0.92);
    if (iy < -0.1) {
      const gy = this._groundY(this.climbC.x + n.x * 0.3, this.climbC.y, this.climbC.z + n.z * 0.3);
      if (this.groundN.y > WALKABLE && this.climbC.y - gy < 1.05) { this.pos.set(this.climbC.x + n.x * 0.3, gy, this.climbC.z + n.z * 0.3); this.mode = 'ground'; return; }
    }
    this.yaw = Math.atan2(-n.x, -n.z);
  }

  _mantle(dt) {
    this.actionT += dt * (this.char.clips.U_ClimbUp_1m ? 2.1 : 2.6);
    const t = Math.min(1, this.actionT);
    const e = t * t * (3 - 2 * t);
    this.pos.lerpVectors(this.mantleFrom, this.mantleTo, e);
    this.pos.y = this.mantleFrom.y + (this.mantleTo.y - this.mantleFrom.y) * Math.min(1, t * 1.5) + Math.sin(t * Math.PI) * 0.25;
    if (t >= 1) { this.pos.copy(this.mantleTo); this.mode = 'ground'; this.vel.set(0, 0, 0); }
  }

  // ------------------------------------------------------------------ swim
  _enterSwim(wl, splash) {
    this.mode = 'swim'; this.action = null; this.vel.y = 0;
    if (splash || true) { this.game.vfx && this.game.vfx.splash(this.pos.x, wl, this.pos.z, splash ? 1 : 0.5); this.game.audio && this.game.audio.sfx('splash', splash ? 1 : 0.5); }
  }

  _swim(dt, wishLen, sprintHeld) {
    const g = this.game, w = g.world;
    const wl = w.waterAt(this.pos.x, this.pos.z);
    const fast = sprintHeld && wishLen > 0.5;
    const sp = fast ? 4.3 : 2.7;
    this.sprinting = false;
    this.spendStamina(dt * (fast ? 10 : 3.6) * (wishLen > 0.1 ? 1 : 0.5));
    const tx = _wish.x * sp * wishLen, tz = _wish.z * sp * wishLen;
    const k = Math.min(1, dt * 3);
    this.vel.x += (tx - this.vel.x) * k; this.vel.z += (tz - this.vel.z) * k;
    if (wishLen > 0.05) this.yaw = angLerp(this.yaw, Math.atan2(_wish.x, _wish.z), Math.min(1, dt * 5));
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    this._collideWalls();
    this.swimBob += dt * (1.6 + wishLen * 2);
    const targetY = wl - 1.08 + Math.sin(this.swimBob) * 0.035;
    this.pos.y += (targetY - this.pos.y) * Math.min(1, dt * 6);
    const th = w.heightAt(this.pos.x, this.pos.z);
    if (th > wl - 0.9) { this.pos.y = Math.max(th, this.pos.y); if (th > wl - 0.75) { this.mode = 'ground'; this.pos.y = th; } }
    if (wl - th < 0.4) { this.mode = 'ground'; this.pos.y = th; }
    if (this.exhausted) {
      // drowned: lose a heart and wash back to the last safe spot
      g.onPlayerDrown ? g.onPlayerDrown() : this.revive(this.lastSafe.x, this.lastSafe.y, this.lastSafe.z);
    }
    if (wishLen > 0.3 && Math.random() < dt * 5) g.vfx && g.vfx.ripple(this.pos.x, wl, this.pos.z);
  }

  // ------------------------------------------------------------------ combat
  _tryAttack(wishLen) {
    if (this.action === 'attack') {
      const a = this.attacks[this.combo];
      if (this.anim.progress() > a.next * 0.6) this.queuedAttack = true;
      return;
    }
    const dash = this.attacks.length > 3 && this.sprinting && Math.hypot(this.vel.x, this.vel.z) > 6;
    // a click shortly after a swing has ended still continues the combo
    this._startAttack(dash ? 3 : this.chainT > 0 ? this.chainNext : 0, wishLen);
  }

  _startAttack(idx, wishLen) {
    const g = this.game;
    this.combo = idx; this.action = 'attack'; this.actionT = 0; this.attackHit = false; this.queuedAttack = false; this.recT = 0; this.chainT = 0;
    const a = this.attacks[idx];
    this.anim.play(a.clip, { loop: false, fade: 0.07, restart: true, speed: a.speed, startAt: a.startAt || 0 });
    // face: nearest enemy in front, else stick direction
    // auto-aim: toward the stick if it is held, otherwise at the nearest foe all around (then whatever is in front)
    let tgt = null;
    if (g.enemies) {
      if (wishLen > 0.2) tgt = g.enemies.nearest(this.pos, 5.5, Math.atan2(_wish.x, _wish.z), 1.2);
      else tgt = g.enemies.nearest(this.pos, 4.5, this.yaw, Math.PI);
    }
    if (tgt) this.yaw = Math.atan2(tgt.pos.x - this.pos.x, tgt.pos.z - this.pos.z);
    else if (wishLen > 0.2) this.yaw = Math.atan2(_wish.x, _wish.z);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let lunge = tgt ? Math.min(5.5, Math.max(0, Math.hypot(tgt.pos.x - this.pos.x, tgt.pos.z - this.pos.z) - 1.5) * 5) : 3.2;
    this.lunged = !a.lunge;
    if (a.lunge) lunge = 0.6;                    // heavy finisher: step in on the swing, not on the wind-up
    this.vel.x = fx * lunge; this.vel.z = fz * lunge;
    g.audio && g.audio.sfx('swing', idx);
    g.vfx && g.vfx.startTrail(this);
  }

  _updateAttack(dt) {
    const g = this.game, a = this.attacks[this.combo];
    const p = this.anim.progress();
    this.vel.x *= Math.exp(-dt * 7); this.vel.z *= Math.exp(-dt * 7);
    if (!this.lunged && p >= (a.lungeAt !== undefined ? a.lungeAt : a.hit - 0.1)) { this.lunged = true; this.vel.x = Math.sin(this.yaw) * a.lunge; this.vel.z = Math.cos(this.yaw) * a.lunge; g.audio && g.audio.sfx('swing', 2); }
    if (!this.attackHit && p >= a.hit) {
      this.attackHit = true;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      let hits = 0;
      if (g.enemies) hits += g.enemies.hitArc(this.pos, fx, fz, a.range, a.arc, a.dmg * (this.attackPower || 1), this.combo === 2 ? 7 : 4);
      if (g.props) hits += g.props.hitArc(this.pos, fx, fz, a.range, a.arc);
      if (hits > 0) { g.hitStop = 0.06 + (this.combo === 2 ? 0.05 : 0); g.cam.addShake(this.combo === 2 ? 0.5 : 0.28); }
    }
    if (p >= a.next && this.queuedAttack) { this._startAttack(this.combo >= this.comboLen - 1 ? 0 : this.combo + 1, 0); return; }
    if (p >= Math.min(0.98, a.next + 0.22)) {
      this.action = null; g.vfx && g.vfx.endTrail();
      this.chainT = 0.4; this.chainNext = this.combo >= this.comboLen - 1 ? 0 : this.combo + 1;
      // no follow-up: settle back into the stance with the clip's own recovery
      if (a.rec && this.char.clips[a.rec]) { const r = this.anim.play(a.rec, { loop: false, fade: 0.08, restart: true, speed: 1.35 }); this.recT = r ? r.getClip().duration / 1.35 * 0.9 : 0; }
    }
  }

  _startRoll(wishLen) {
    const g = this.game;
    this.action = 'roll'; this.actionT = 0;
    if (wishLen > 0.2) this.yaw = Math.atan2(_wish.x, _wish.z);
    this.spendStamina(14);
    this.anim.play(this.C.roll[0], { loop: false, fade: 0.06, restart: true, speed: this.C.roll[1], startAt: this.C.roll[2] });
    g.audio && g.audio.sfx('roll');
    g.vfx && g.vfx.dust(this.pos.x, this.pos.y + 0.05, this.pos.z, 4);
  }

  _updateRoll(dt) {
    const t = this.actionT;
    const C = this.C, v0 = this.human ? 9.4 : 10.5;
    const sp = t < C.rollFast ? v0 : v0 * Math.max(0, 1 - (t - C.rollFast) / (C.rollDur - C.rollFast));
    this.vel.x = Math.sin(this.yaw) * sp; this.vel.z = Math.cos(this.yaw) * sp;
    if (t > C.rollDur) this.action = null;
  }

  _castSkill() {
    const g = this.game;
    this.action = this.mode === 'ground' ? 'cast' : this.action; this.actionT = 0;
    this.skillCd = 9;
    if (this.mode === 'ground') this.anim.play('Spellcast_Raise', { loop: false, fade: 0.08, restart: true, speed: 2.2 });
    g.onSkill && g.onSkill(this);
  }

  playInteract(clip = 'Interact', dur = 0.8) {
    this.action = 'interact'; this.actionT = 0; this.interactDur = dur;
    if (clip === 'Interact') this.anim.play(this.C.interact[0], { loop: false, fade: 0.12, restart: true, speed: this.C.interact[1] });
    else this.anim.play(clip, { loop: false, fade: 0.1, restart: true, speed: 1.3 });
    this.vel.x = this.vel.z = 0;
  }

  _physicsDead(dt) {
    this.vel.x *= Math.exp(-dt * 5); this.vel.z *= Math.exp(-dt * 5);
    this.vel.y -= GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    const gy = Math.max(this._groundY(this.pos.x, this.pos.y, this.pos.z), this.game.world.waterAt(this.pos.x, this.pos.z) - 0.6);
    if (this.pos.y < gy) { this.pos.y = gy; this.vel.y = 0; }
  }

  // Procedural poses layered on the static T-pose clip (the asset pack has no climb / glide / swim clips).
  // Axes found by experiment: upper arm z raises (-left / +right), x- swings forward; legs x- lift forward, x+ bend the knee.
  // VRM humanoid bones are axis-aligned in the T-pose, so poses are written in character space
  // (x right-to-left pitch, +z raises the left arm); VRM 0.x rigs face -Z, hence the mirrored x/z.
  _poseVRM(dt) {
    const B = this.char.bones, m = this.char.v0 ? -1 : 1;
    // Absolute targets (the T-pose is identity on this rig), eased in. They must not be multiplied onto the
    // current value: the mixer only rewrites a bone when its animated value changes, so a product would accumulate.
    const w = 1 - Math.exp(-dt * 16);
    const add = (name, x, y, z) => { const b = B[name]; if (b) b.quaternion.slerp(_q.setFromEuler(_e.set(x * m, y, z * m)), w); };
    const t = this.game.time;
    // ---- additive layer on bones whose clip tracks are constant (neck, upper chest): undo last frame's offset first
    const S = this._addS || (this._addS = {});
    const layer = (name, x, y, z, on) => {
      const b = B[name]; if (!b) return;
      const st = S[name] || (S[name] = { base: b.quaternion.clone(), last: b.quaternion.clone() });
      if (b.quaternion.equals(st.last)) b.quaternion.copy(st.base); else st.base.copy(b.quaternion);
      if (on) b.quaternion.multiply(_q.setFromEuler(_e.set(x * m, y, z * m)));
      st.last.copy(b.quaternion);
    };
    const free = (this.mode === 'ground' || this.mode === 'air') && (!this.action || this.action === 'block') && !this.frozen;
    // the hero glances where the camera looks, and breathes
    let dyaw = this.game.cam.yaw + Math.PI - this.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    const lookT = free && Math.abs(dyaw) < 1.9 ? Math.max(-0.75, Math.min(0.75, dyaw)) : 0;
    this._look = (this._look || 0) + (lookT - (this._look || 0)) * Math.min(1, dt * 5);
    const pitchT = free ? Math.max(-0.3, Math.min(0.3, this.game.cam.pitch * 0.45)) : 0;
    this._lookP = (this._lookP || 0) + (pitchT - (this._lookP || 0)) * Math.min(1, dt * 5);
    const breath = Math.sin(t * 1.7);
    layer('neck', -this._lookP + breath * 0.012, this._look * 0.62, 0, true);
    layer('upperChest', breath * 0.016, this._look * 0.2, 0, true);
    if (this.mode === 'climb') {
      // reach - hold - pull: flatten the sine so each hand rests on its hold before the next move
      const sh = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.55);
      const s = sh(Math.sin(this.climbPhase || 0)), c = sh(Math.cos(this.climbPhase || 0));
      add('hips', 0, 0.1 * s, 0.07 * s); add('chest', 0, -0.12 * s, -0.05 * s);
      add('leftUpperArm', 0, -0.5, 1.2 + 0.3 * s); add('rightUpperArm', 0, 0.5, -(1.2 - 0.3 * s));
      add('leftLowerArm', 0, -(0.75 - 0.35 * s), 0); add('rightLowerArm', 0, 0.75 + 0.35 * s, 0);
      add('leftUpperLeg', -(0.75 - 0.5 * s), 0, 0.22); add('rightUpperLeg', -(0.75 + 0.5 * s), 0, -0.22);
      add('leftLowerLeg', 1.05 - 0.45 * s, 0, 0); add('rightLowerLeg', 1.05 + 0.45 * s, 0, 0);
      add('spine', 0.1, 0.06 * c, 0); add('head', -0.32, 0, 0);
    } else if (this.mode === 'glide') {
      const sw = Math.sin(t * 2.1) * 0.07;
      add('leftUpperArm', 0, -0.12, 1.22); add('rightUpperArm', 0, 0.12, -1.22);
      add('leftLowerArm', 0, -0.2, 0); add('rightLowerArm', 0, 0.2, 0);
      add('leftUpperLeg', 0.12 + sw, 0, 0.04); add('rightUpperLeg', -0.2 - sw, 0, -0.04);
      add('leftLowerLeg', 0.35 + sw, 0, 0); add('rightLowerLeg', 0.75 - sw, 0, 0);
      add('spine', -0.12, 0, 0); add('head', -0.2, 0, 0);
    } else if (this.mode === 'swim' && !this.human) {
      const ph = this.swimBob * 2.2, s = Math.sin(ph), c = Math.cos(ph);
      const mv = Math.min(1, this.moving / 2);
      const reach = 1.35 - 0.85 * mv * (0.5 + 0.5 * s);        // arms sweep from overhead out to the sides
      add('leftUpperArm', 0, -0.25 * mv * (0.5 + 0.5 * c), reach); add('rightUpperArm', 0, 0.25 * mv * (0.5 + 0.5 * c), -reach);
      add('leftLowerArm', 0, -0.3 * (0.5 - 0.5 * s), 0); add('rightLowerArm', 0, 0.3 * (0.5 - 0.5 * s), 0);
      add('leftUpperLeg', 0.1 + 0.3 * mv * s, 0, 0.08); add('rightUpperLeg', 0.1 - 0.3 * mv * s, 0, -0.08);
      add('leftLowerLeg', 0.3 + 0.3 * mv * c, 0, 0); add('rightLowerLeg', 0.3 - 0.3 * mv * c, 0, 0);
      add('head', -0.7 * mv, 0, 0);
    }
  }

  _pose(dt) {
    if (this.char.isVRM) { if (!this.poseDebug) return this._poseVRM(dt); }
    const B = this.char.bones;
    if (!this._restQ) {
      // T-pose rotations of the knight's bones: procedural poses are rest * offset, applied as absolute targets
      this._restQ = {};
      const tp = this.char.clips['T-Pose'];
      if (tp) for (const tr of tp.tracks) { const [bn, prop] = tr.name.split('.'); if (prop === 'quaternion') this._restQ[bn] = new THREE.Quaternion().fromArray(tr.values, 0); }
    }
    const w = 1 - Math.exp(-dt * 16);
    const add = (name, x, y, z) => {
      const b = B[name]; if (!b) return;
      _q.setFromEuler(_e.set(x, y, z));
      const r = this._restQ[name]; if (r) _q.premultiply(r);
      b.quaternion.slerp(_q, w);
    };
    if (this.poseDebug) { for (const k in this.poseDebug) { const r = this.poseDebug[k]; add(k, r[0], r[1], r[2]); } return; }
    const t = this.game.time;
    if (this.mode === 'climb') {
      const s = Math.sin(this.climbPhase || 0), c = Math.cos(this.climbPhase || 0);
      add('upperarml', -0.55, 0, -(1.15 + 0.32 * s)); add('upperarmr', -0.55, 0, 1.15 - 0.32 * s);
      add('lowerarml', 0, 0, -(0.75 - 0.3 * s)); add('lowerarmr', 0, 0, 0.75 + 0.3 * s);
      add('upperlegl', -0.75 + 0.45 * s, 0, 0.18); add('upperlegr', -0.75 - 0.45 * s, 0, -0.18);
      add('lowerlegl', 1.05 - 0.4 * s, 0, 0); add('lowerlegr', 1.05 + 0.4 * s, 0, 0);
      add('spine', 0.12, 0, 0.06 * c); add('head', -0.35, 0, 0);
    } else if (this.mode === 'glide') {
      const sw = Math.sin(t * 2.1) * 0.08;
      add('upperarml', -0.1, 0, -1.28); add('upperarmr', -0.1, 0, 1.28);
      add('lowerarml', 0, 0, -0.12); add('lowerarmr', 0, 0, 0.12);
      add('upperlegl', -0.38 + sw, 0, 0); add('upperlegr', -0.14 - sw, 0, 0);
      add('lowerlegl', 0.7 + sw, 0, 0); add('lowerlegr', 0.42 - sw, 0, 0);
      add('head', -0.25, 0, 0);
    } else if (this.mode === 'swim') {
      const ph = this.swimBob * 2.2, s = Math.sin(ph), c = Math.cos(ph);
      const mv = Math.min(1, this.moving / 2);
      // breast-stroke: arms sweep from forward to the sides, legs kick
      add('upperarml', -1.25 + 0.75 * mv * (0.5 + 0.5 * s), 0, -0.25 * mv * (0.5 + 0.5 * c)); add('upperarmr', -1.25 + 0.75 * mv * (0.5 + 0.5 * s), 0, 0.25 * mv * (0.5 + 0.5 * c));
      add('upperlegl', 0.25 + 0.35 * mv * s, 0, 0); add('upperlegr', 0.25 - 0.35 * mv * s, 0, 0);
      add('lowerlegl', 0.3 + 0.3 * mv * c, 0, 0); add('lowerlegr', 0.3 - 0.3 * mv * c, 0, 0);
      add('head', -0.75 * mv, 0, 0);
    }
  }

  // ------------------------------------------------------------------ animation + transform
  _finish(dt, wishLen) {
    const g = this.game, A = this.anim, grp = this.char.group;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.moving = hs;
    if (this.jumpAnimT > 0) this.jumpAnimT -= dt;
    if (this.landT > 0) this.landT -= dt;

    if (this.action === 'dead') { /* death clip holds */ }
    else if (this.mode === 'mantle') A.play(this.char.clips.U_ClimbUp_1m ? 'U_ClimbUp_1m' : 'Jump_Land', { fade: 0.08, loop: false, speed: this.char.clips.U_ClimbUp_1m ? 1.4 : 0.9 });
    else if (this.mode === 'swim' && this.human) A.play(hs > 0.5 ? 'U_Swim_Fwd_Loop' : 'U_Swim_Idle_Loop', { fade: 0.35, speed: hs > 0.5 ? Math.max(0.8, hs / 2.6) : 1 });
    else if (this.mode === 'climb' || this.mode === 'swim' || this.mode === 'glide') A.play('T-Pose', { fade: 0.18 });
    else if (this.mode === 'air') { if (!(this.jumpAnimT > 0) && this.action !== 'hit' && this.action !== 'sit') A.play(this.C.jumpLoop, { fade: 0.2 }); }
    else if (!this.action) {
      if (this.recT > 0 && hs >= 0.6) this.recT = 0;
      if (this.landT > 0) { /* landing clip */ }
      else if (this.recT > 0) this.recT -= dt;            // sword recovery plays out while standing still
      else if (this.char.isVRM) {
        // long legs cover more ground per stride than the chibi rig the clips were made for
        // playback rate follows ground speed so the feet do not slide
        if (!this.human) {
          if (hs > 2.6) A.play('Running_A', { fade: 0.18, speed: Math.max(0.8, hs / 4.3) });
          else if (hs > 0.25) A.play('Walking_A', { fade: 0.2, speed: Math.max(0.7, hs / 1.5) });
          else A.play('Idle', { fade: 0.25 });
        }
        else if (hs > 3.9) A.play('U_Sprint_Loop', { fade: 0.2, speed: Math.min(1.5, hs / 5.5) });
        else if (hs > 1.9) A.play('U_Jog_Fwd_Loop', { fade: 0.2, speed: Math.max(0.8, hs / 3.0) });
        else if (hs > 0.25) A.play('U_Walk_Loop', { fade: 0.22, speed: Math.min(1.7, Math.max(0.75, hs / 1.25)) });
        else A.play(g.enemies && g.enemies.inCombat ? this.C.combatIdle : this.C.idle, { fade: 0.3 });
      }
      else if (hs > SPRINT - 1.6 && this.sprinting) A.play('Running_B', { fade: 0.18, speed: 1.55 });
      else if (hs > 2.6) A.play('Running_A', { fade: 0.18, speed: Math.max(0.7, hs / 4.6) });
      else if (hs > 0.25) A.play('Walking_A', { fade: 0.2, speed: Math.max(0.6, hs / 1.7) });
      else A.play('Idle', { fade: 0.25 });
    } else if (this.action === 'block' && !(this.blockHitT > 0 && !this.human)) {
      const b = A.play(this.C.block, { fade: 0.12, loop: !this.C.blockHold });
      if (b && this.C.blockHold && b.time > this.C.blockHold) b.time = this.C.blockHold;        // hold the braced guard
    }
    A.update(dt);
    this._pose(dt);

    // model transform
    grp.position.copy(this.pos);
    const glide = this.mode === 'glide';
    this.glideBlend += ((glide ? 1 : 0) - this.glideBlend) * Math.min(1, dt * 10);
    this.glider.visible = this.glideBlend > 0.02;
    this.glider.scale.setScalar(Math.max(0.001, this.glideBlend));
    if (this.barrier) {
      const bu = this.barrier.material.uniforms.uK;
      bu.value += ((this.action === 'block' ? 1 : 0) - bu.value) * Math.min(1, dt * 14);
      this.barrier.visible = bu.value > 0.02;
      this.barrier.scale.setScalar(0.6 + 0.4 * bu.value);
    }
    if (this.mode === 'climb') {
      const n = this.climbN;
      _right.crossVectors(UP, n).normalize();
      _v2.crossVectors(n, _right).normalize();
      _m.makeBasis(_right.clone().negate(), _v2, _v.copy(n).negate());
      _q.setFromRotationMatrix(_m);
      grp.quaternion.slerp(_q, Math.min(1, dt * 14));
      // procedural hand-over-hand bob
      grp.position.addScaledVector(_v2, Math.abs(Math.sin(this.climbPhase * 2)) * 0.06);
    } else {
      let pitch = 0, roll = 0;
      if (this.mode === 'swim' && !this.human) pitch = hs > 0.5 ? 1.15 : 0.5;
      else if (glide) { pitch = 0.32; roll = -this.tilt.x * 0.5; }
      else if (this.mode === 'ground' && !this.action) pitch = Math.min(0.2, hs * 0.018) * (this.sprinting ? 1.6 : 1);
      // bank into turns
      const dy = Math.atan2(Math.sin(this.yaw - (this._prevYaw || this.yaw)), Math.cos(this.yaw - (this._prevYaw || this.yaw)));
      this.tilt.x += ((dt > 0 ? dy / dt : 0) * 0.1 - this.tilt.x) * Math.min(1, dt * 6);
      this._prevYaw = this.yaw;
      if (this.mode === 'ground') roll = -Math.max(-0.25, Math.min(0.25, this.tilt.x * 0.25)) * Math.min(1, hs / 5);
      _q.setFromEuler(new THREE.Euler(pitch, this.yaw, roll, 'YXZ'));
      grp.quaternion.slerp(_q, Math.min(1, dt * 16));
      if (this.mode === 'swim') grp.position.y += this.human ? 0.12 : 0.35;
    }
    G.uPlayerPos.value.copy(this.pos);
    if (this.char.isVRM) {
      const em = this.char.vrm.expressionManager, k = Math.min(1, dt * 10);
      const fight = this.action === 'attack' || this.action === 'block' || this.action === 'roll' || this.action === 'cast';
      this._fAng = (this._fAng || 0) + ((fight ? 0.8 : 0) - (this._fAng || 0)) * k;
      this._fJoy = (this._fJoy || 0) + ((this.action === 'interact' || this.mode === 'glide' ? 0.6 : 0) - (this._fJoy || 0)) * k * 0.5;
      this._fSad = (this._fSad || 0) + ((this.action === 'hit' || this.action === 'dead' || this.exhausted ? 0.85 : 0) - (this._fSad || 0)) * k;
      if (em) { em.setValue('angry', this._fAng); em.setValue('happy', this._fJoy * (1 - this._fAng)); em.setValue('sad', this._fSad); em.setValue('aa', this._fSad * 0.4 + (this.sprinting ? 0.12 : 0)); }
    }
    if (this.char.update) this.char.update(dt);

    // footsteps
    if (this.mode === 'ground' && hs > 1.2 && !this.action) {
      this.stepT += dt * hs;
      if (this.stepT > (this.sprinting ? 2.6 : 2.2)) { this.stepT = 0; g.audio && g.audio.footstep(this); if (hs > 6) g.vfx && g.vfx.dust(this.pos.x, this.pos.y + 0.05, this.pos.z, 1); }
    }
  }
}

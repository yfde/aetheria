// Enemies: jelly slimes, masked shades, orc raiders and their demon chiefs (Quaternius, CC0), wolves and the Sanctum boss.
import * as THREE from 'three';
import { shared, U_LIGHT, U_SHADOW } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_SHADOW, GLSL_FOG, GLSL_LIGHT } from '../shaders/common.js';
import { loadModel, createCharacter, Animator } from './characters.js';
import { Wolf } from './creatures.js';
import { loadVRM, prepareShadeTemplate, createShade } from './vrmchar.js';
import { Builder, meshFrom, M } from '../world/structures.js';
import { mulberry32 } from '../world/noise.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const MODEL = {
  knight: './assets/models/kaykit/opt/Knight.glb',
  shade: './assets/models/vrm/Shade.vrm',
  ual: './assets/models/ual/UAL.glb',
  ual2: './assets/models/ual/UAL2.glb',
  orc: './assets/models/creatures/Orc.glb',
  demon: './assets/models/creatures/Demon.glb',
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const TAU = Math.PI * 2;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };

// ------------------------------------------------------------------ slime
const SLIME_VERT = /* glsl */`
uniform float uTime;
uniform float uWobble;
out vec3 vWorldPos; out vec3 vNormal; out vec3 vLocal;
void main() {
  vec3 p = position;
  // soft jelly wobble
  p.xz *= 1.0 + sin(uTime * 7.0 + p.y * 3.0) * 0.03 * uWobble;
  p.y *= 1.0 + sin(uTime * 9.0) * 0.02 * uWobble;
  vLocal = position;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const SLIME_FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_SHADOW}
${GLSL_FOG}
${GLSL_LIGHT}
uniform vec3 uColor; uniform vec3 uFlash; uniform float uGlow;
in vec3 vWorldPos; in vec3 vNormal; in vec3 vLocal;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormal), V = normalize(cameraPosition - vWorldPos);
  float shadow = getShadow(vWorldPos, N) * cloudShadow(vWorldPos);
  float ndl = dot(N, uLightDir);
  float lit = smoothstep(-0.1, 0.25, ndl) * shadow;
  vec3 base = uColor * mix(0.62, 1.12, smoothstep(-0.6, 0.9, vLocal.y));         // darker belly
  vec3 col = base * (uLightColor * (0.25 + 0.75 * lit) + ambientLight(N) * 1.1);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);
  col += (uColor * 1.3 + 0.35) * fres * (0.35 + 0.65 * lit) * (uLightColor * 0.45 + uAmbSky * 0.5);   // jelly rim
  vec3 H = normalize(uLightDir + V);
  col += uLightColor * smoothstep(0.965, 0.985, dot(N, H)) * 0.9 * shadow;                              // wet highlight
  // face: two glossy eyes on the +z side
  vec3 q = vLocal;
  if (q.z > 0.0) {
    vec2 e1 = (q.xy - vec2(-0.3, 0.12)) / vec2(0.115, 0.17), e2 = (q.xy - vec2(0.3, 0.12)) / vec2(0.115, 0.17);
    float eye = min(dot(e1, e1), dot(e2, e2));
    col = mix(col, vec3(0.02, 0.025, 0.04), smoothstep(1.0, 0.8, eye));
    vec2 h1 = (q.xy - vec2(-0.33, 0.19)) / 0.04, h2 = (q.xy - vec2(0.27, 0.19)) / 0.04;
    col = mix(col, vec3(1.6), smoothstep(1.0, 0.6, min(dot(h1, h1), dot(h2, h2))));
  }
  col += uColor * uGlow + uFlash;
  col = applyFog(col, vWorldPos);
  fragColor = vec4(col, 1.0);
}
`;
let slimeGeo = null, slimeDepth = null;
function slimeMesh(color) {
  if (!slimeGeo) {
    slimeGeo = mergeVertices(new THREE.IcosahedronGeometry(1, 4));
    const P = slimeGeo.attributes.position;
    for (let i = 0; i < P.count; i++) {
      let y = P.getY(i);
      const k = y < 0 ? 0.55 : 0.92;             // flat-ish bottom
      const bulge = 1 + 0.12 * Math.max(0, -y);
      P.setXYZ(i, P.getX(i) * bulge, y * k, P.getZ(i) * bulge);
    }
    slimeGeo.computeVertexNormals();
    slimeDepth = new THREE.ShaderMaterial({ vertexShader: 'void main(){ gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }', fragmentShader: 'void main(){}', glslVersion: THREE.GLSL3, colorWrite: false });
  }
  const uniforms = { ...shared(...U_LIGHT, ...U_SHADOW), uColor: { value: new THREE.Color(color) }, uFlash: { value: new THREE.Color(0, 0, 0) }, uGlow: { value: 0 }, uWobble: { value: 1 } };
  const m = new THREE.Mesh(slimeGeo, new THREE.ShaderMaterial({ uniforms, vertexShader: SLIME_VERT, fragmentShader: SLIME_FRAG, glslVersion: THREE.GLSL3 }));
  m.userData.shadowMat = slimeDepth;
  return m;
}

const SLIME_KINDS = {
  green: { color: 0x58c23a, hp: 3, dmg: 2, size: 0.62, speed: 3.0, coins: 2 },
  blue: { color: 0x3aa0e8, hp: 4, dmg: 2, size: 0.68, speed: 3.4, coins: 3 },
  ember: { color: 0xf0652a, hp: 5, dmg: 3, size: 0.72, speed: 3.6, coins: 4, glow: 0.35 },
  frost: { color: 0xa8e4ff, hp: 5, dmg: 3, size: 0.72, speed: 3.2, coins: 4, glow: 0.15 },
  king: { color: 0x8a5cf0, hp: 16, dmg: 4, size: 1.5, speed: 3.0, coins: 14, glow: 0.2 },
};

class Slime {
  constructor(mgr, kind, x, z) {
    const K = SLIME_KINDS[kind];
    this.mgr = mgr; this.kind = kind; this.K = K;
    this.type = 'slime';
    this.pos = new THREE.Vector3(x, mgr.game.world.heightAt(x, z), z);
    this.home = this.pos.clone();
    this.vel = new THREE.Vector3();
    this.hp = this.maxHp = K.hp;
    this.radius = K.size * 0.9; this.height = K.size * 1.5;
    this.yaw = Math.random() * TAU;
    this.state = 'idle'; this.t = Math.random() * 2; this.air = false;
    this.squash = 0; this.barT = 0; this.dead = false; this.hitCd = 0;
    this.mesh = slimeMesh(K.color);
    this.mesh.material.uniforms.uGlow.value = K.glow || 0;
    this.mesh.matrixAutoUpdate = true;
    mgr.game.gfx.scene.add(this.mesh);
    mgr.game.gfx.addCaster(this.mesh);
  }
  takeHit(dmg, dx, dz, knock) {
    if (this.dead) return;
    this.hp -= dmg; this.barT = 4;
    this.vel.set(dx * knock, 4.5, dz * knock); this.air = true; this.state = 'hit'; this.t = 0;
    this.mesh.material.uniforms.uFlash.value.setRGB(1.2, 1.2, 1.2);
    this.squash = -0.35;
    if (this.hp <= 0) this.die();
  }
  die() {
    const g = this.mgr.game;
    this.dead = true; this.deadT = 0;
    g.vfx.poof(this.pos.x, this.pos.y + this.K.size, this.pos.z, this.K.color, 14, this.K.size * 1.4);
    g.audio && g.audio.sfx('enemyDie');
    this.mgr.drop(this, this.K.coins);
    g.gfx.removeCaster(this.mesh); g.gfx.scene.remove(this.mesh);
    this.remove = true;
  }
  update(dt, player, dist) {
    const g = this.mgr.game, w = g.world, K = this.K;
    this.t += dt; this.hitCd -= dt; this.barT -= dt;
    this.mesh.material.uniforms.uFlash.value.multiplyScalar(Math.exp(-dt * 10));
    const gy = w.heightAt(this.pos.x, this.pos.z);
    const toP = _v.set(player.pos.x - this.pos.x, 0, player.pos.z - this.pos.z);
    const alive = player.action !== 'dead';
    if (this.air) {
      this.vel.y -= 20 * dt;
      this.pos.addScaledVector(this.vel, dt);
      if (this.pos.y <= gy && this.vel.y < 0) {
        this.pos.y = gy; this.air = false; this.vel.set(0, 0, 0); this.squash = 0.4; this.t = 0;
        if (this.state === 'hit') this.state = 'chase';
        if (dist < 30) g.audio && g.audio.sfx('slimeHop', 0.5);
      }
      // body slam damage
      if (this.state === 'lunge' && this.hitCd <= 0 && dist < this.radius + 0.75 && Math.abs(player.pos.y - this.pos.y) < 1.6 && alive) {
        if (player.takeDamage(K.dmg, this.pos, 5)) this.hitCd = 1.0; else this.hitCd = 0.5;
      }
    } else {
      this.pos.y = gy;
      const wl = w.waterAt(this.pos.x, this.pos.z);
      if (this.state === 'idle') {
        if (dist < 13 && alive && Math.abs(player.pos.y - this.pos.y) < 6) { this.state = 'chase'; this.t = 0; }
        else if (this.t > 1.6 + Math.random()) {
          // lazy wander around home
          const a = Math.random() * TAU;
          let tx = this.home.x + Math.cos(a) * 4, tz = this.home.z + Math.sin(a) * 4;
          this.yaw = Math.atan2(tx - this.pos.x, tz - this.pos.z);
          this._hop(1.6, 3.6);
        }
      } else if (this.state === 'chase' || this.state === 'lunge') {
        this.state = 'chase';
        const homeD = Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z);
        if (dist > 26 || homeD > 40 || !alive) { this.state = 'idle'; this.yaw = Math.atan2(this.home.x - this.pos.x, this.home.z - this.pos.z); if (homeD > 6) this._hop(K.speed, 4.5); }
        else {
          this.yaw = Math.atan2(toP.x, toP.z);
          if (this.t > 0.38) {
            if (dist < 3.4 + this.radius) { this.state = 'lunge'; this._hop(Math.min(9, dist * 2.2), 5.2); }
            else this._hop(K.speed, 4.8);
          }
        }
      }
      if (wl > this.pos.y + 0.4) { this.yaw += Math.PI; this.state = 'idle'; }
    }
    // squash & stretch
    this.squash *= Math.exp(-dt * 7);
    const st = this.air ? Math.max(-0.25, Math.min(0.3, this.vel.y * 0.035)) : -this.squash + Math.sin(this.t * 3) * 0.04;
    const s = K.size;
    this.mesh.position.set(this.pos.x, this.pos.y + s * 0.5 * (1 + st), this.pos.z);
    this.mesh.scale.set(s * (1 - st * 0.5), s * (1 + st), s * (1 - st * 0.5));
    this.mesh.rotation.y = this.yaw;
    if (this.kind === 'ember' && Math.random() < dt * 6) g.vfx.add.spawn(this.pos.x, this.pos.y + s, this.pos.z, 0, 1.5, 0, { life: 0.6, size: 0.3, size1: 0.05, color: [2.5, 1.0, 0.2], type: 0 });
  }
  _hop(speed, vy) {
    this.vel.set(Math.sin(this.yaw) * speed, vy, Math.cos(this.yaw) * speed);
    this.air = true; this.pos.y += 0.02; this.t = 0;
  }
  dispose() { const g = this.mgr.game; g.gfx.removeCaster(this.mesh); g.gfx.scene.remove(this.mesh); }
}

// ------------------------------------------------------------------ shades: hollow swordsmen of living shadow
const SK_KINDS = {
  minion: { hp: 4, dmg: 2, speed: 4.6, scale: 0.86, weapon: 'dagger', coins: 4, poise: 0, glow: 0x7a45ff },
  warrior: { hp: 9, dmg: 4, speed: 3.6, scale: 1.14, weapon: 'axe', coins: 8, poise: 1, glow: 0xff3a30 },
  rogue: { hp: 6, dmg: 3, speed: 5.2, scale: 0.96, weapon: 'blade', coins: 6, poise: 0, glow: 0x2dffb0 },
  mage: { hp: 5, dmg: 3, speed: 3.0, scale: 1.0, weapon: 'staff', coins: 8, poise: 0, ranged: true, glow: 0xd24bff },
  // camp raiders: hand-made, hand-animated monsters
  grunt: { hp: 5, dmg: 2, speed: 4.1, h: 1.32, radius: 0.5, skin: 'orc', coins: 5, poise: 0, glow: 0x9be15d },
  brute: { hp: 12, dmg: 4, speed: 3.3, h: 1.95, radius: 0.62, skin: 'demon', coins: 10, poise: 1, glow: 0xff5a3a },
};
// clip names and timings per skin
const A_SHADE = { idle: 'U_Idle_Loop', guard: 'U_Sword_Idle', walk: 'U_Walk_Loop', jog: 'U_Jog_Fwd_Loop', sprint: 'U_Sprint_Loop', attack: 'U_Sword_Attack', hit: ['U_Hit_Chest', 'U_Hit_Head'], death: 'U_Death01', taunt: 'Spellcast_Raise',
  hitSpeed: 0.9, deathSpeed: 1.5, tauntSpeed: 2.6, tauntT: 0.6, atkSpeed: [1.4, 1.15], hitAt: 0.43, lunge: [0.33, 0.5], jogRef: 3.0, sprintRef: 5.6, walkSpeed: 1.15 };
const A_BEAST = { idle: 'Idle', guard: 'Idle', walk: 'Walk', jog: 'Run', sprint: 'Run', attack: 'Weapon', hit: ['HitReact'], death: 'Death', taunt: 'Yes',
  hitSpeed: 1, deathSpeed: 1, tauntSpeed: 2.3, tauntT: 0.7, atkSpeed: [0.62, 0.52], hitAt: 0.5, lunge: [0.36, 0.55], jogRef: 4.4, sprintRef: 4.4, walkSpeed: 1.0 };
const SHADE_CLIPS = ['T-Pose', 'Walking_Backwards', 'Lie_StandUp', 'Spellcast_Raise', 'Spellcast_Shoot', '1H_Melee_Attack_Chop'];
const SHADE_UAL = ['Sword_Idle', 'Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Sword_Attack', 'Hit_Chest', 'Hit_Head', 'Death01'];

class Shade {
  constructor(mgr, kind, x, z, opts = {}) {
    const K = SK_KINDS[kind];
    this.mgr = mgr; this.kind = kind; this.K = K; this.type = 'shade';
    const w = mgr.game.world;
    this.pos = new THREE.Vector3(x, w.heightAt(x, z), z);
    this.home = this.pos.clone();
    this.vel = new THREE.Vector3();
    this.hp = this.maxHp = K.hp;
    const skin = K.skin ? mgr.skins[K.skin] : null;
    this.A = skin ? A_BEAST : A_SHADE;
    this.radius = K.radius || 0.42; this.height = K.h || 1.62 * K.scale;
    this.yaw = Math.random() * TAU;
    this.state = opts.rise ? 'rise' : 'idle'; this.t = 0; this.barT = 0; this.dead = false;
    this.attackCd = 0.5 + Math.random(); this.hitCount = 0; this.wanderT = Math.random() * 3; this.wander = null;
    const g = mgr.game;
    this.char = skin ? createCharacter(skin, g.gfx, { scale: K.h / skin.h * (0.95 + Math.random() * 0.1), rim: 0.8 })
      : createShade(mgr.shadeTpl, g.gfx, { scale: K.scale, glow: K.glow, weapon: K.weapon, kind });
    this.anim = new Animator(this.char);
    g.gfx.scene.add(this.char.group);
    if (opts.rise) { this.anim.play('Lie_StandUp', { loop: false, fade: 0, speed: 1.6 }); g.vfx.poof(this.pos.x, this.pos.y + 0.3, this.pos.z, 0x2a1a44, 10, 1.2); }
    else this.anim.play(this.A.idle, { fade: 0 });
    this.char.group.position.copy(this.pos);
  }
  takeHit(dmg, dx, dz, knock) {
    if (this.dead || this.state === 'rise') return;
    const g = this.mgr.game;
    this.hp -= dmg; this.barT = 4; this.hitCount++;
    this.char.uniforms.uFlash.value.setRGB(1.0, 1.0, 1.0);
    if (this.hp <= 0) { this.die(dx, dz); return; }
    const stagger = this.K.poise === 0 || this.hitCount % 2 === 0 || this.state !== 'attack';
    this.vel.set(dx * knock * (stagger ? 1 : 0.4), 0, dz * knock * (stagger ? 1 : 0.4));
    if (stagger) { this.state = 'hit'; this.t = 0; this.anim.play(this.A.hit[Math.floor(Math.random() * this.A.hit.length)], { loop: false, fade: 0.05, restart: true, speed: this.A.hitSpeed }); }
    if (this.state === 'idle') this.state = 'chase';
  }
  die(dx, dz) {
    const g = this.mgr.game;
    this.dead = true; this.state = 'dead'; this.t = 0;
    this.vel.set(dx * 3, 0, dz * 3);
    this.anim.play(this.A.death, { loop: false, fade: 0.1, speed: this.A.deathSpeed });
    g.audio && g.audio.sfx('enemyDie');
    g.vfx.poof(this.pos.x, this.pos.y + 1.0, this.pos.z, this.K.glow, 10, 1.1);
    this.mgr.drop(this, this.K.coins);
  }
  update(dt, player, dist) {
    const g = this.mgr.game, w = g.world, K = this.K;
    this.t += dt; this.barT -= dt; this.attackCd -= dt;
    this.char.uniforms.uFlash.value.multiplyScalar(Math.exp(-dt * 10));
    const alive = player.action !== 'dead';
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    let move = 0, faceP = false;
    if (this.state === 'dead') {
      if (this.t > 1.3) { this.char.uniforms.uDissolve.value = Math.min(1, (this.t - 1.3) / 0.9); }
      if (this.t > 1.75 && !this.gearOff) { this.gearOff = true; for (const m of this.char.gear || []) m.visible = false; g.vfx.poof(this.pos.x, this.pos.y + 0.4, this.pos.z, 0x2a1a44, 8, 0.9); }
      if (this.t > 2.3) { this.remove = true; this.dispose(); return; }
    } else if (this.state === 'rise') {
      if (this.t > 1.5) this.state = 'chase';
    } else if (this.state === 'hit') {
      if (this.t > 0.42) this.state = 'chase';
    } else if (this.state === 'idle') {
      if (dist < 15 && alive && Math.abs(player.pos.y - this.pos.y) < 7) { this.state = 'chase'; this.anim.play(this.A.taunt, { loop: false, fade: 0.1, speed: this.A.tauntSpeed }); this.t = 0; this.tauntT = this.A.tauntT; g.audio && g.audio.sfx('fire', 0.4); }
      else {
        this.wanderT -= dt;
        if (this.wanderT <= 0) { this.wanderT = 3 + Math.random() * 4; const a = Math.random() * TAU, r = Math.random() * 5; this.wander = Math.random() < 0.6 ? new THREE.Vector3(this.home.x + Math.cos(a) * r, 0, this.home.z + Math.sin(a) * r) : null; }
        if (this.wander) {
          const wx = this.wander.x - this.pos.x, wz = this.wander.z - this.pos.z;
          if (Math.hypot(wx, wz) < 0.5) this.wander = null;
          else { this.yaw = Math.atan2(wx, wz); move = 1.3; }
        }
        this.anim.play(move > 0 ? this.A.walk : this.A.idle, { fade: 0.3, speed: move > 0 ? this.A.walkSpeed : 1 });
      }
    } else if (this.state === 'chase') {
      if (this.tauntT > 0) { this.tauntT -= dt; faceP = true; }
      else {
        const homeD = Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z);
        if (!alive || dist > 32 || homeD > 50) { this.state = 'return'; }
        else {
          faceP = true;
          const want = K.ranged ? 9 : 1.9;
          if (K.ranged && dist < 14 && dist > 4 && this.attackCd <= 0) { this.state = 'attack'; this.t = 0; this.didHit = false; this.anim.play('Spellcast_Shoot', { loop: false, fade: 0.1, restart: true, speed: 1.1 }); }
          else if (!K.ranged && dist < 2.2 && this.attackCd <= 0) {
            this.state = 'attack'; this.t = 0; this.didHit = false;
            // a long, readable wind-up before the lunge: time to dodge or raise the ward
            this.atk = this.A.attack;
            this.anim.play(this.atk, { loop: false, fade: 0.12, restart: true, speed: this.A.atkSpeed[K.poise ? 1 : 0] });
          } else if (dist > want + 0.3) { move = K.speed; this.anim.play(K.speed > 4.2 ? this.A.sprint : this.A.jog, { fade: 0.2, speed: K.speed > 4.2 ? K.speed / this.A.sprintRef : K.speed / this.A.jogRef }); }
          else if (K.ranged && dist < 4) { move = -2.2; this.anim.play('Walking_Backwards', { fade: 0.2 }) || this.anim.play('Walking_A', { fade: 0.2 }); }
          else this.anim.play(K.ranged ? this.A.idle : this.A.guard, { fade: 0.25 });
        }
      }
    } else if (this.state === 'attack') {
      const p = this.anim.progress();
      if (p < 0.3) faceP = true;
      if (!this.didHit && p > (K.ranged ? 0.45 : this.A.hitAt)) {
        this.didHit = true;
        if (K.ranged) {
          _v.set(this.pos.x, this.pos.y + 1.2, this.pos.z);
          _v2.set(dx, player.pos.y + 0.9 - _v.y, dz).normalize();
          this.mgr.shoot(_v, _v2, 12, K.dmg, K.glow);
          g.audio && g.audio.sfx('fire');
        } else {
          const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
          const dot = (dx * fx + dz * fz) / Math.max(dist, 0.01);
          if (dist < 2.7 && dot > 0.35 && Math.abs(player.pos.y - this.pos.y) < 1.8) player.takeDamage(K.dmg, this.pos, 5.5);
          g.audio && g.audio.sfx('swing', 0);
        }
      }
      if (!K.ranged && p > this.A.lunge[0] && p < this.A.lunge[1]) move = 3.4;
      if (p > 0.92) { this.state = 'chase'; this.attackCd = K.ranged ? 2.6 : 0.9 + Math.random() * 0.8; }
    } else if (this.state === 'return') {
      const hx = this.home.x - this.pos.x, hz = this.home.z - this.pos.z;
      if (Math.hypot(hx, hz) < 1.5) { this.state = 'idle'; this.hp = this.maxHp; }
      else { this.yaw = Math.atan2(hx, hz); move = K.speed * 0.8; this.anim.play(this.A.jog, { fade: 0.2, speed: K.speed * 0.8 / this.A.jogRef }); }
      if (dist < 9 && alive) this.state = 'chase';
    }
    if (faceP) { const ty = Math.atan2(dx, dz); this.yaw += angDiff(ty, this.yaw) * Math.min(1, dt * 9); }
    // integrate
    this.vel.x *= Math.exp(-dt * 6); this.vel.z *= Math.exp(-dt * 6);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let nx = this.pos.x + (fx * move + this.vel.x) * dt, nz = this.pos.z + (fz * move + this.vel.z) * dt;
    const nh = w.heightAt(nx, nz);
    // don't walk into water or up cliffs
    if (w.waterAt(nx, nz) > nh + 0.5 || nh - this.pos.y > 1.2) { nx = this.pos.x; nz = this.pos.z; }
    this.pos.x = nx; this.pos.z = nz;
    if (g.flora) g.flora.collide(this.pos, this.radius);
    this.pos.y = w.heightAt(this.pos.x, this.pos.z);
    this.anim.update(dt);
    this.char.group.position.copy(this.pos);
    this.char.group.rotation.y = this.yaw;
  }
  dispose() { this.char.dispose(); }
}

// ------------------------------------------------------------------ boss: the Dawnbreaker Colossus
class Colossus {
  constructor(mgr, center) {
    this.mgr = mgr; this.type = 'boss'; this.isBoss = true;
    const g = mgr.game;
    this.center = center.clone();
    this.pos = center.clone();
    this.hp = this.maxHp = 46;
    this.radius = 2.6; this.height = 7.5;
    this.yaw = 0; this.state = 'dormant'; this.t = 0; this.dead = false; this.barT = 0;
    this.group = new THREE.Group();
    this.parts = {};
    const mk = (name, fn, x, y, z) => {
      const b = new Builder(); fn(b);
      const m = meshFrom(b, g.gfx, true);
      m.matrixAutoUpdate = true; m.position.set(x, y, z);
      m.userData.rest = new THREE.Vector3(x, y, z);
      this.group.add(m); this.parts[name] = m;
      return m;
    };
    const ROCKC = 0x9a9085, ROCKD = 0x7b7268, GLOW = 0xff7a3d;
    mk('torso', (b) => { b.rock(0, 0, 0, 2.3, 3, { color: ROCKC, flat: 1.0, detail: 1 }); b.rock(0, 1.7, 0, 1.9, 4, { color: ROCKD, flat: 0.8 }); b.add(new THREE.TorusGeometry(1.5, 0.1, 6, 24), { p: [0, 0.3, 1.55], color: GLOW, mat: M.GLOW, emis: 3 }); }, 0, 4.2, 0);
    mk('core', (b) => { b.sphere(0, 0, 0, 0.75, 2, { color: GLOW, mat: M.GLOW, emis: 6 }); }, 0, 4.5, 1.75);
    mk('head', (b) => { b.rock(0, 0, 0, 1.15, 5, { color: ROCKC, flat: 0.85 }); b.box(-0.4, 0.05, 0.92, 0.3, 0.14, 0.2, { color: GLOW, mat: M.GLOW, emis: 5 }); b.box(0.4, 0.05, 0.92, 0.3, 0.14, 0.2, { color: GLOW, mat: M.GLOW, emis: 5 }); }, 0, 7.3, 0.3);
    for (const [s, sx] of [['L', -1], ['R', 1]]) {
      mk('shoulder' + s, (b) => { b.rock(0, 0, 0, 1.25, 6 + sx, { color: ROCKD }); }, sx * 3.1, 6.0, 0);
      mk('arm' + s, (b) => { b.rock(0, 0, 0, 0.95, 8 + sx, { color: ROCKC, flat: 1.3 }); }, sx * 3.7, 4.2, 0.3);
      mk('fist' + s, (b) => { b.rock(0, 0, 0, 1.35, 10 + sx, { color: ROCKD, flat: 0.95 }); b.add(new THREE.TorusGeometry(0.9, 0.07, 5, 16), { r: [Math.PI / 2, 0, 0], color: GLOW, mat: M.GLOW, emis: 3 }); }, sx * 4.0, 2.2, 0.8);
    }
    for (const [s, sx] of [['L', -1], ['R', 1]]) mk('leg' + s, (b) => { b.rock(0, 0, 0, 1.2, 12 + sx, { color: ROCKC, flat: 1.5 }); }, sx * 1.35, 1.3, 0);
    this.group.position.copy(this.pos);
    g.gfx.scene.add(this.group);
    this.slamTarget = new THREE.Vector3();
    this.pattern = 0; this.stunT = 0; this.flash = 0;
    this._setDormant();
  }
  _setDormant() {
    // slumped pile of stones
    for (const k in this.parts) { const m = this.parts[k]; m.position.copy(m.userData.rest); m.position.y *= 0.42; m.rotation.set(0, 0, 0); }
    this.parts.core.scale.setScalar(0.3);
  }
  awaken() { if (this.state !== 'dormant') return; this.state = 'awaken'; this.t = 0; this.mgr.game.audio && this.mgr.game.audio.sfx('bossRoar'); this.mgr.game.cam.addShake(1.0); }
  takeHit(dmg, dx, dz) {
    if (this.dead || this.state === 'dormant' || this.state === 'awaken') return;
    const g = this.mgr.game;
    const mult = this.stunT > 0 ? 2.0 : 0.6;
    this.hp -= dmg * mult; this.flash = 1;
    g.audio && g.audio.sfx(this.stunT > 0 ? 'hitHeavy' : 'block');
    if (this.hp <= 0) { this.hp = 0; this.dead = true; this.state = 'dying'; this.t = 0; g.audio && g.audio.sfx('bossRoar'); g.cam.addShake(1.2); }
  }
  update(dt, player, dist) {
    const g = this.mgr.game, P = this.parts;
    this.t += dt; this.flash *= Math.exp(-dt * 8);
    const time = g.time;
    if (this.state === 'dormant') return;
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    const alive = player.action !== 'dead';
    let rise = 1, armL = 0, armR = 0;     // arm raise amounts
    if (this.state === 'awaken') {
      rise = Math.min(1, this.t / 2.4); rise = rise * rise * (3 - 2 * rise);
      if (this.t > 3.0) { this.state = 'idle'; this.t = 0; }
      if (Math.random() < dt * 30) g.vfx.dust(this.pos.x + (Math.random() - 0.5) * 6, this.pos.y, this.pos.z + (Math.random() - 0.5) * 6, 2);
    } else if (this.state === 'idle') {
      const ty = Math.atan2(dx, dz); this.yaw += angDiff(ty, this.yaw) * Math.min(1, dt * 1.8);
      // slowly stomp toward the player but stay in the arena
      if (dist > 6 && alive) { const sp = 2.1; const nx = this.pos.x + Math.sin(this.yaw) * sp * dt, nz = this.pos.z + Math.cos(this.yaw) * sp * dt; if (Math.hypot(nx - this.center.x, nz - this.center.z) < 19) { this.pos.x = nx; this.pos.z = nz; } }
      if (this.t > (this.hp < this.maxHp * 0.5 ? 1.5 : 2.3) && alive) {
        this.t = 0; this.pattern = (this.pattern + 1) % 3;
        if (dist > 16 || this.pattern === 2) { this.state = 'barrage'; this.shots = 0; }
        else if (this.pattern === 1 && dist < 9) this.state = 'sweep';
        else { this.state = 'slamUp'; this.slamTarget.copy(player.pos); this.slamArm = Math.random() < 0.5 ? 'L' : 'R'; }
      }
    } else if (this.state === 'slamUp') {
      const k = Math.min(1, this.t / 0.9);
      if (this.slamArm === 'L') armL = k; else armR = k;
      const ty = Math.atan2(this.slamTarget.x - this.pos.x, this.slamTarget.z - this.pos.z); this.yaw += angDiff(ty, this.yaw) * Math.min(1, dt * 4);
      if (this.t < 0.7) this.slamTarget.lerp(player.pos, dt * 3);
      g.vfx.add.spawn(this.slamTarget.x + (Math.random() - 0.5) * 5, this.slamTarget.y + 0.1, this.slamTarget.z + (Math.random() - 0.5) * 5, 0, 1.5, 0, { life: 0.4, size: 0.35, color: [3, 0.8, 0.2], type: 0 });
      if (this.t > 1.05) { this.state = 'slamDown'; this.t = 0; }
    } else if (this.state === 'slamDown') {
      const k = Math.max(0, 1 - this.t / 0.14);
      if (this.slamArm === 'L') armL = k; else armR = k;
      if (!this.slammed && this.t > 0.14) {
        this.slammed = true;
        const s = this.slamTarget;
        g.cam.addShake(1.0); g.audio && g.audio.sfx('bossSlam');
        g.vfx.poof(s.x, s.y + 0.3, s.z, 0x9a8f80, 22, 2.4); g.vfx.hit(s.x, s.y + 0.5, s.z, 0xff9a4d, true);
        this.mgr.shockwave(s, 9, 4, 4);
        if (Math.hypot(player.pos.x - s.x, player.pos.z - s.z) < 3.2 && Math.abs(player.pos.y - s.y) < 2.5) player.takeDamage(6, s, 9);
      }
      if (this.t > 0.16) { if (this.slamArm === 'L') armL = -0.25; else armR = -0.25; }
      if (this.t > 1.9) { this.state = 'idle'; this.t = 0; this.slammed = false; this.stunT = 0; }
      else if (this.t > 0.2) this.stunT = 1;            // fist stuck in the ground: core exposed
    } else if (this.state === 'sweep') {
      // spin with both arms out
      armL = armR = 0.45;
      const sp = this.t < 0.6 ? 0 : 5.5;
      this.yaw += sp * dt;
      if (this.t > 0.6 && dist < 6.2 && Math.abs(player.pos.y - this.pos.y) < 3 && !this.sweepHit) { if (player.takeDamage(5, this.pos, 11)) this.sweepHit = true; }
      if (this.t > 0.6 && Math.random() < dt * 20) g.vfx.dust(this.pos.x + Math.sin(this.yaw) * 5, this.pos.y, this.pos.z + Math.cos(this.yaw) * 5, 2);
      if (this.t > 2.2) { this.state = 'idle'; this.t = 0; this.sweepHit = false; this.stunT = 1.4; }
    } else if (this.state === 'barrage') {
      armL = armR = 0.8 + Math.sin(this.t * 8) * 0.1;
      const ty = Math.atan2(dx, dz); this.yaw += angDiff(ty, this.yaw) * Math.min(1, dt * 3);
      if (this.t > 0.7 + this.shots * 0.38 && this.shots < (this.hp < this.maxHp * 0.5 ? 7 : 5)) {
        this.shots++;
        const tx = player.pos.x + (Math.random() - 0.5) * 6 + player.vel.x * 0.8, tz = player.pos.z + (Math.random() - 0.5) * 6 + player.vel.z * 0.8;
        this.mgr.meteor(new THREE.Vector3(tx, g.world.heightAt(tx, tz) + 0.4, tz), 1.25, 5);
      }
      if (this.t > 3.6) { this.state = 'idle'; this.t = 0; this.stunT = 1.2; }
    } else if (this.state === 'dying') {
      rise = Math.max(0, 1 - this.t / 3);
      if (Math.random() < dt * 14) g.vfx.fireBurst(this.pos.x + (Math.random() - 0.5) * 5, this.pos.y + Math.random() * 6, this.pos.z + (Math.random() - 0.5) * 5, 8);
      if (this.t > 3.2) { this.state = 'dead'; g.vfx.orbBurst(this.pos.x, this.pos.y + 3, this.pos.z, 0xffc070); g.onBossDefeated && g.onBossDefeated(); this._setDormant(); P.core.visible = false; return; }
    } else if (this.state === 'dead') return;
    if (this.stunT > 0 && this.state === 'idle') this.stunT -= dt;

    // contact damage when hugging the body
    if (this.state !== 'dying' && dist < 3.0 && Math.abs(player.pos.y - this.pos.y) < 4 && alive && this.state !== 'awaken') {
      const l = Math.max(dist, 0.01); player.pos.x += dx / l * (3.0 - dist) * 0.5; player.pos.z += dz / l * (3.0 - dist) * 0.5;
    }
    // ---- pose the floating stones
    const bob = Math.sin(time * 1.6) * 0.18;
    const stun = this.stunT > 0 && this.state === 'idle' ? 1 : 0;
    for (const k in P) {
      const m = P[k], r = m.userData.rest;
      const phase = r.x * 0.7 + r.y * 0.5;
      let y = r.y * (0.42 + 0.58 * rise) + (bob + Math.sin(time * 2.1 + phase) * 0.1) * rise - stun * 0.6 * (r.y / 7);
      let x = r.x, z = r.z;
      m.rotation.set(Math.sin(time * 0.7 + phase) * 0.06 * rise, 0, Math.cos(time * 0.9 + phase) * 0.06 * rise);
      const side = k.endsWith('L') ? armL : (k.endsWith('R') ? armR : 0);
      if (k.startsWith('fist')) {
        if (this.state === 'slamDown' && this.slammed && k === 'fist' + this.slamArm) {
          // fist planted at the slam point (group-local)
          _v.copy(this.slamTarget).sub(this.pos).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -this.yaw);
          x = _v.x; y = 0.9; z = _v.z;
        } else { y += side * 5.6; z += side * 1.4; x *= 1 + Math.abs(side) * 0.2; }
        if (this.state === 'sweep') { x *= 1.5; y = 2.6; }
      } else if (k.startsWith('arm')) { y += side * 3.2; z += side * 0.6; if (this.state === 'sweep') { x *= 1.3; y = 3.4; } }
      else if (k.startsWith('shoulder')) y += side * 0.8;
      m.position.x += (x - m.position.x) * Math.min(1, dt * 14); m.position.y += (y - m.position.y) * Math.min(1, dt * 14); m.position.z += (z - m.position.z) * Math.min(1, dt * 14);
    }
    const cs = (this.stunT > 0 ? 1.5 + Math.sin(time * 12) * 0.15 : 0.9 + Math.sin(time * 3) * 0.08) * (0.3 + 0.7 * rise);
    P.core.scale.setScalar(cs);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    g.ui && g.ui.bossBar(this.state === 'dying' || this.state === 'awaken' || this.hp > 0 ? 'DAWNBREAKER COLOSSUS' : null, this.hp / this.maxHp);
  }
  dispose() {}
}

// ------------------------------------------------------------------ manager
export class Enemies {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.spawns = [];       // { kind, type, x, z, alive: enemy|null, deadT }
    this.projectiles = [];
    this.meteors = [];
    this.waves = [];
    this.shadeTpl = null;
    this.nightT = 0;
    this.combatT = 0;
  }

  async load() {
    const [knight, ual, vrm] = await Promise.all([loadModel(MODEL.knight), loadModel(MODEL.ual), loadVRM(MODEL.shade)]);
    this.shadeTpl = prepareShadeTemplate(vrm, knight, SHADE_CLIPS, ual, SHADE_UAL);
    // raider skins: measure each model once so kinds can ask for a height in metres
    this.skins = {};
    await Promise.all(['orc', 'demon'].map(async (k) => {
      const gltf = await loadModel(MODEL[k]);
      gltf.scene.updateMatrixWorld(true);
      const box = new THREE.Box3();
      gltf.scene.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingBox(); box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
      this.skins[k] = { scene: gltf.scene, animations: gltf.animations, h: Math.max(0.1, box.max.y - box.min.y) };
    }));
  }

  addSpawn(type, kind, x, z, opts = {}) { this.spawns.push({ type, kind, x, z, e: null, deadT: 0, ...opts }); }
  // true while any spawn with this tag has not been defeated
  campAlive(tag) { for (const s of this.spawns) if (s.tag === tag && !s.killed) return true; return false; }

  spawnBoss(center) { this.boss = new Colossus(this, center); this.list.push(this.boss); return this.boss; }

  nearest(pos, range, yaw, arc) {
    let best = null, bd = range;
    for (const e of this.list) {
      if (e.dead || e.state === 'dormant') continue;
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z, d = Math.hypot(dx, dz) - e.radius;
      if (d > bd || Math.abs(e.pos.y - pos.y) > 3.5) continue;
      if (arc !== undefined && Math.abs(angDiff(Math.atan2(dx, dz), yaw)) > arc) continue;
      bd = d; best = e;
    }
    return best;
  }

  hitArc(pos, fx, fz, range, arc, dmg, knock) {
    const g = this.game;
    let n = 0;
    for (const e of this.list) {
      if (e.dead || e.state === 'dormant') continue;
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z, d = Math.hypot(dx, dz);
      if (d - e.radius > range || e.pos.y - pos.y > 2.6 || pos.y - (e.pos.y + e.height) > 1.0) continue;
      const dot = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      if (d > e.radius + 0.5 && Math.acos(Math.max(-1, Math.min(1, dot))) > arc * 0.5 + 0.25) continue;
      const l = Math.max(d, 0.01);
      const crit = Math.random() < 0.12;
      const dealt = dmg * (crit ? 1.8 : 1);
      const before = e.hp;
      e.takeHit(dealt, dx / l, dz / l, knock);
      const hx = e.pos.x - dx / l * e.radius * 0.6, hy = e.pos.y + Math.min(e.height * 0.6, 1.4 + (e.isBoss ? 2.6 : 0)), hz = e.pos.z - dz / l * e.radius * 0.6;
      g.vfx.hit(hx, hy, hz, crit ? 0xffd36b : 0xffffff, crit);
      const shown = Math.max(1, Math.round((before - Math.max(e.hp, 0)) * 10));
      g.ui.floatText(_v.set(e.pos.x, e.pos.y + e.height + 0.2, e.pos.z), String(shown), crit ? 'crit' : '');
      g.audio && g.audio.sfx(e.type === 'slime' ? 'slimeHit' : 'hit');
      this.combatT = 6;
      n++;
    }
    return n;
  }

  drop(e, coins) {
    const g = this.game;
    g.props && g.props.spawnDrops(e.pos, coins, e.type === 'shade' ? 0.3 : 0.18);
    g.stats.kills = (g.stats.kills || 0) + 1;
    g.onEnemyKilled && g.onEnemyKilled(e);
  }

  shoot(pos, dir, speed, dmg, color) { this.projectiles.push({ pos: pos.clone(), vel: dir.clone().multiplyScalar(speed), life: 3, dmg, color: new THREE.Color(color) }); }
  meteor(target, delay, dmg) { this.meteors.push({ target, t: 0, delay, dmg }); }
  shockwave(center, radius, dmg, speed) { this.waves.push({ c: center.clone(), r: 1, max: radius, dmg, hit: false }); }

  update(dt) {
    const g = this.game, p = g.player, vfx = g.vfx;
    this.combatT -= dt;
    // activate / deactivate spawn points around the player
    this._spawnT = (this._spawnT || 0) + dt;
    if (this._spawnT > 0.5) {
      this._spawnT = 0;
      for (const s of this.spawns) {
        const d = Math.hypot(s.x - p.pos.x, s.z - p.pos.z);
        if (s.e && s.e.remove) { s.e = null; s.deadT = g.time; s.killed = true; }
        if (!s.e && d < 85 && (!s.killed || (!s.once && g.time - s.deadT > 420))) {
          if (s.night && g.sky.night < 0.6) continue;
          s.killed = false;
          if (s.type === 'wolf' && !(g.wildlife && g.wildlife.tpl.wolf)) continue;
          s.e = s.type === 'slime' ? new Slime(this, s.kind, s.x, s.z) : s.type === 'wolf' ? new Wolf(this, s.kind, s.x, s.z) : new Shade(this, s.kind, s.x, s.z, { rise: !!s.night });
          this.list.push(s.e);
        } else if (s.e && !s.e.dead && d > 125) { s.e.dispose(); s.e.remove = true; s.e = null; }
      }
    }
    let inCombat = false;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.remove) { this.list.splice(i, 1); continue; }
      const dist = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      e.update(dt, p, dist);
      if (!e.dead && (e.state === 'chase' || e.state === 'attack' || e.state === 'lunge' || (e.isBoss && e.state !== 'dormant' && e.state !== 'dead')) && dist < 30) inCombat = true;
    }
    // soft separation so enemies don't stack
    for (let i = 0; i < this.list.length; i++) for (let j = i + 1; j < this.list.length; j++) {
      const a = this.list[i], b = this.list[j];
      if (a.dead || b.dead || a.isBoss || b.isBoss) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz), r = a.radius + b.radius;
      if (d < r && d > 1e-3) { const k = (r - d) * 0.5 / d; a.pos.x -= dx * k; a.pos.z -= dz * k; b.pos.x += dx * k; b.pos.z += dz * k; }
    }
    this.inCombat = inCombat || this.combatT > 0;

    // projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const q = this.projectiles[i];
      q.life -= dt; q.pos.addScaledVector(q.vel, dt);
      const c = q.color;
      vfx.add.spawn(q.pos.x, q.pos.y, q.pos.z, 0, 0, 0, { life: 0.28, size: 0.7, size1: 0.1, color: [c.r * 3, c.g * 3, c.b * 3], type: 0 });
      const hitG = q.pos.y < g.world.heightAt(q.pos.x, q.pos.z);
      const dp = Math.hypot(q.pos.x - p.pos.x, q.pos.y - (p.pos.y + 0.9), q.pos.z - p.pos.z);
      if (dp < 0.8) { p.takeDamage(q.dmg, q.pos, 4); q.life = 0; }
      if (q.life <= 0 || hitG) { vfx.hit(q.pos.x, q.pos.y, q.pos.z, c.getHex(), false); this.projectiles.splice(i, 1); }
    }
    // falling rocks with a ground telegraph
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.t += dt;
      const t = m.target;
      if (Math.random() < dt * 40) { const a = Math.random() * 6.28; vfx.add.spawn(t.x + Math.cos(a) * 2.4, t.y, t.z + Math.sin(a) * 2.4, 0, 0.6, 0, { life: 0.35, size: 0.3, color: [3, 0.7, 0.2], type: 0 }); }
      const k = m.t / m.delay;
      if (k > 0.45) vfx.add.spawn(t.x, t.y + (1 - k) * 38, t.z, 0, 0, 0, { life: 0.3, size: 2.2, size1: 0.4, color: [3, 1.1, 0.3], type: 0 });
      if (m.t >= m.delay) {
        vfx.fireBurst(t.x, t.y + 0.5, t.z, 18); vfx.poof(t.x, t.y + 0.3, t.z, 0x8a8078, 10, 1.8);
        g.cam.addShake(0.5); g.audio && g.audio.sfx('explosion');
        if (Math.hypot(p.pos.x - t.x, p.pos.z - t.z) < 2.7 && Math.abs(p.pos.y - t.y) < 3) p.takeDamage(m.dmg, t, 7);
        this.meteors.splice(i, 1);
      }
    }
    // expanding shockwaves (jump over them)
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.r += dt * 9;
      for (let k = 0; k < 10; k++) { const a = Math.random() * 6.28; const x = w.c.x + Math.cos(a) * w.r, z = w.c.z + Math.sin(a) * w.r; vfx.add.spawn(x, g.world.heightAt(x, z) + 0.25, z, 0, 1.2, 0, { life: 0.3, size: 0.6, size1: 0.1, color: [3, 1.2, 0.4], type: 0 }); }
      const d = Math.hypot(p.pos.x - w.c.x, p.pos.z - w.c.z);
      if (!w.hit && Math.abs(d - w.r) < 0.8 && p.mode === 'ground') { if (p.takeDamage(w.dmg, w.c, 7)) w.hit = true; }
      if (w.r > w.max) this.waves.splice(i, 1);
    }
  }
}

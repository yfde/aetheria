// Third-person orbit camera with collision and smoothing.
import * as THREE from 'three';

const _target = new THREE.Vector3(), _dir = new THREE.Vector3(), _want = new THREE.Vector3();

export class OrbitCamera {
  constructor(camera, game) {
    this.camera = camera;
    this.game = game;
    this.yaw = 0;
    this.pitch = -0.12;
    this.dist = 4.2;
    this.distTarget = 4.2;
    this.curDist = 4.2;
    this.focus = new THREE.Vector3();
    this.shake = 0;
    this.fovBase = 55;
    this.fovKick = 0;
    this.heightOffset = 1.5;
    this.override = null;      // { pos, look, t } cinematic override
    this.inited = false;
  }

  // forward direction on the ground plane
  forward(out) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  right(out) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  snapBehind(yaw) { this.yaw = yaw + Math.PI; this.pitch = -0.12; this.inited = false; }

  addShake(a) { this.shake = Math.min(1.2, this.shake + a); }

  // over-the-shoulder conversation shot of someone at `npcPos`
  focusOn(npcPos, playerPos) {
    const dx = playerPos.x - npcPos.x, dz = playerPos.z - npcPos.z, l = Math.hypot(dx, dz) || 1;
    const ux = dx / l, uz = dz / l, rx = uz, rz = -ux;
    const pos = new THREE.Vector3(npcPos.x + ux * 2.45 + rx * 0.95, npcPos.y + 1.36, npcPos.z + uz * 2.45 + rz * 0.95);
    const w = this.game.world;
    pos.y = Math.max(pos.y, w.heightAt(pos.x, pos.z) + 0.5);
    this.talk = { pos, look: new THREE.Vector3(npcPos.x - rx * 0.12, npcPos.y + 1.24, npcPos.z - rz * 0.12), from: this.camera.position.clone(), fromLook: this.focus.clone(), t: 0 };
    this.talkYaw = Math.atan2(ux, uz);
  }
  release() {
    if (!this.talk) return;
    this.ret = { from: this.camera.position.clone(), t: 0 };
    this.yaw = this.talkYaw; this.pitch = -0.08;
    this.talk = null;
  }

  update(dt, player, input) {
    const cam = this.camera;
    if (this.talk) {
      const d = this.talk; d.t = Math.min(1, d.t + dt * 1.9);
      const e = d.t * d.t * (3 - 2 * d.t);
      cam.position.lerpVectors(d.from, d.pos, e);
      _target.lerpVectors(d.fromLook, d.look, e);
      cam.lookAt(_target);
      this.focus.copy(player.pos); this.focus.y += this.heightOffset * (player.heightScale || 1);
      if (Math.abs(cam.fov - 34) > 0.01) { cam.fov += (34 - cam.fov) * (1 - Math.exp(-dt * 5)); cam.updateProjectionMatrix(); }
      const gf = this.game.gfx; gf.dof += (1 - gf.dof) * Math.min(1, dt * 3); gf.dofFocus = cam.position.distanceTo(d.look);
      return;
    }
    if (input && input.enabled) {
      const s = 0.0023 * input.sens;
      this.yaw -= input.mouseDX * s;
      this.pitch -= input.mouseDY * s * (input.invertY ? -1 : 1);
      this.yaw -= input.pad.x * dt * 2.6;
      this.pitch -= input.pad.y * dt * 1.8;
      this.distTarget = Math.min(10, Math.max(2.4, this.distTarget + input.wheel * 0.6));
    }
    this.pitch = Math.min(1.25, Math.max(-1.3, this.pitch));

    // focus follows the player with a little lag (snappier vertically when falling)
    _target.copy(player.pos); _target.y += this.heightOffset * (player.heightScale || 1);
    if (!this.inited) { this.focus.copy(_target); this.inited = true; }
    const k = 1 - Math.exp(-dt * 14), ky = 1 - Math.exp(-dt * 9);
    this.focus.x += (_target.x - this.focus.x) * k;
    this.focus.z += (_target.z - this.focus.z) * k;
    this.focus.y += (_target.y - this.focus.y) * ky;

    const extra = (player.mode === 'glide' ? 1.6 : 0) + (player.sprinting ? 0.5 : 0);
    this.dist += (this.distTarget + extra - this.dist) * (1 - Math.exp(-dt * 4));

    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);   // from focus to camera
    // collision: pull the camera in front of obstacles
    let d = this.dist;
    const col = this.game.collision;
    if (col) {
      const t = col.raycast(this.focus, _dir, this.dist + 0.4, null);
      if (t >= 0) d = Math.max(0.6, t - 0.35);
    }
    // tree trunks: slide the camera in front of them (only while it is down among the trunks)
    const fl = this.game.flora, hl = Math.hypot(_dir.x, _dir.z);
    if (fl && hl > 0.3 && _dir.y < 0.75) {
      const tt = fl.raycastTrunks(this.focus.x, this.focus.z, _dir.x / hl, _dir.z / hl, d * hl + 0.3);
      if (tt >= 0 && (tt / hl) * _dir.y < 5.5) d = Math.min(d, Math.max(0.7, tt / hl - 0.3));
    }
    if (d < this.curDist) this.curDist = d; else this.curDist += (d - this.curDist) * (1 - Math.exp(-dt * 5));
    _want.copy(this.focus).addScaledVector(_dir, this.curDist);
    // never dip below the terrain / water surface
    const w = this.game.world;
    const minY = Math.max(w.heightAt(_want.x, _want.z) + 0.3, w.waterAt(_want.x, _want.z) + 0.25);
    if (_want.y < minY) _want.y = minY;
    { const gf = this.game.gfx; gf.dof += (0 - gf.dof) * Math.min(1, dt * 4); }
    cam.position.copy(_want);
    if (this.ret) { const r = this.ret; r.t = Math.min(1, r.t + dt * 2.6); cam.position.lerpVectors(r.from, _want, r.t * r.t * (3 - 2 * r.t)); if (r.t >= 1) this.ret = null; }
    cam.lookAt(this.focus);

    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.12;
      const t = performance.now() * 0.05;
      cam.position.x += Math.sin(t * 1.3) * s; cam.position.y += Math.cos(t * 1.7) * s; cam.position.z += Math.sin(t * 2.1 + 1) * s;
      this.shake *= Math.exp(-dt * 7);
    }
    const fovT = this.fovBase + (player.sprinting ? 5 : 0) + (player.mode === 'glide' ? 4 : 0) + this.fovKick;
    if (Math.abs(cam.fov - fovT) > 0.01) { cam.fov += (fovT - cam.fov) * (1 - Math.exp(-dt * 5)); cam.updateProjectionMatrix(); }
    this.fovKick *= Math.exp(-dt * 6);
  }
}

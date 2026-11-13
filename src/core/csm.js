// Cascaded shadow maps rendered into a 2x2 depth atlas with hardware PCF.
import * as THREE from 'three';
import { G } from './globals.js';

const _v = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(), _fwd = new THREE.Vector3(), _c = new THREE.Vector3();
const _bias = new THREE.Matrix4();

export class CSM {
  constructor(tile = 2048) {
    this.tile = tile;
    this.splits = [13, 44, 140, 440];
    this.frame = 0;
    this._makeTarget();
    this.cams = [];
    for (let i = 0; i < 4; i++) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
      cam.layers.set(2);
      cam.matrixAutoUpdate = false;
      this.cams.push(cam);
    }
    this.pending = [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];
  }

  _makeTarget() {
    if (this.rt) { this.rt.depthTexture.dispose(); this.rt.dispose(); }
    const atlas = this.tile * 2;
    const dt = new THREE.DepthTexture(atlas, atlas, THREE.UnsignedIntType);
    dt.compareFunction = THREE.LessEqualCompare;
    dt.minFilter = dt.magFilter = THREE.LinearFilter;
    this.rt = new THREE.WebGLRenderTarget(atlas, atlas, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, depthTexture: dt, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.rt.scissorTest = true;
    G.uShadowTex.value = dt;
    G.uShadowParams.value.x = 1 / atlas;
    this.frame = 0;
  }

  setTileSize(tile) { if (tile !== this.tile) { this.tile = tile; this._makeTarget(); } }

  // which cascades to refresh this frame (far ones alternate)
  _active(c) { return c < 2 || this.frame < 4 || (c === 2 ? (this.frame & 1) === 0 : (this.frame & 1) === 1); }

  update(camera, lightDir) {
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const k2 = tanY * tanY * (1 + camera.aspect * camera.aspect);
    camera.getWorldDirection(_fwd);
    // stable light basis
    _up.set(0, 1, 0);
    if (Math.abs(lightDir.y) > 0.98) _up.set(0, 0, 1);
    _right.crossVectors(_up, lightDir).normalize();
    _up.crossVectors(lightDir, _right).normalize();
    const sp = G.uShadowSplits.value, tx = G.uShadowTexel.value;
    for (let c = 0; c < 4; c++) {
      if (!this._active(c)) continue;
      const far = this.splits[c];
      const cz = Math.min(far, far * 0.5 * (1 + k2));
      const radius = Math.sqrt((far - cz) * (far - cz) + k2 * far * far) * 1.03;
      const texel = (radius * 2) / this.tile;
      _c.copy(camera.position).addScaledVector(_fwd, cz);
      // snap centre to shadow texels (light space)
      const cx = _c.dot(_right), cy = _c.dot(_up);
      _c.addScaledVector(_right, Math.floor(cx / texel) * texel - cx).addScaledVector(_up, Math.floor(cy / texel) * texel - cy);
      const cam = this.cams[c];
      const D = 1400;
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
      cam.near = 1; cam.far = D + radius + 900;
      cam.updateProjectionMatrix();
      _v.copy(_c).addScaledVector(lightDir, D);
      cam.matrixWorld.makeBasis(_right, _up, lightDir);
      cam.matrixWorld.setPosition(_v);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      const ox = (c & 1) * 0.5, oy = (c >> 1) * 0.5;
      _bias.set(0.25, 0, 0, 0.25 + ox, 0, 0.25, 0, 0.25 + oy, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      this.pending[c].multiplyMatrices(_bias, cam.projectionMatrix).multiply(cam.matrixWorldInverse);
      if (c === 0) sp.x = far; else if (c === 1) sp.y = far; else if (c === 2) sp.z = far; else sp.w = far;
      if (c === 0) tx.x = texel; else if (c === 1) tx.y = texel; else if (c === 2) tx.z = texel; else tx.w = texel;
    }
  }

  render(renderer, scene, casters) {
    for (const m of casters) { m.userData._mainMat = m.material; m.material = m.userData.shadowMat; }
    const rt = this.rt, t = this.tile;
    for (let c = 0; c < 4; c++) {
      if (!this._active(c)) continue;
      const x = (c & 1) * t, y = (c >> 1) * t;
      rt.viewport.set(x, y, t, t);
      rt.scissor.set(x, y, t, t);
      renderer.setRenderTarget(rt);
      renderer.clear(false, true, false);
      renderer.render(scene, this.cams[c]);
      G.uShadowMat.value[c].copy(this.pending[c]);
    }
    for (const m of casters) { m.material = m.userData._mainMat; }
    this.frame++;
  }
}

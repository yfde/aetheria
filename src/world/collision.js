// Static collision: heightfield terrain + a BVH of structure meshes + tree trunks.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const _box = new THREE.Box3(), _seg = new THREE.Line3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _start0 = new THREE.Vector3();
const _ray = new THREE.Ray(), _n = new THREE.Vector3();

export class Collision {
  constructor(world, flora) {
    this.world = world;
    this.flora = flora;
    this.chunks = [];        // Float32Array position chunks (world space, triangle soup)
    this.bvh = null;
    this.triCount = 0;
  }

  // add a mesh's triangles (world space) to the static collider set
  addMesh(geometry, matrixWorld) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const src = g.attributes.position;
    const out = new Float32Array(src.count * 3);
    for (let i = 0; i < src.count; i++) {
      _v1.fromBufferAttribute(src, i).applyMatrix4(matrixWorld);
      out[i * 3] = _v1.x; out[i * 3 + 1] = _v1.y; out[i * 3 + 2] = _v1.z;
    }
    this.chunks.push(out);
    if (g !== geometry) g.dispose();
  }
  addObject(obj) {
    obj.updateWorldMatrix(true, true);
    obj.traverse((o) => { if (o.isMesh && !o.userData.noCollide) this.addMesh(o.geometry, o.matrixWorld); });
  }

  build() {
    let n = 0;
    for (const c of this.chunks) n += c.length;
    if (n === 0) { this.bvh = null; return; }
    const pos = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) { pos.set(c, o); o += c.length; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.bvh = new MeshBVH(geo);
    this.geo = geo;
    this.triCount = n / 9;
  }

  // Push a vertical capsule (feet at pos) out of structure meshes. Returns ground flag.
  resolveCapsule(pos, radius, height, info) {
    info.grounded = false; info.hit = false;
    if (!this.bvh) return false;
    _seg.start.set(pos.x, pos.y + radius, pos.z);
    _seg.end.set(pos.x, pos.y + height - radius, pos.z);
    _start0.copy(_seg.start);
    _box.makeEmpty(); _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
    _box.min.addScalar(-radius); _box.max.addScalar(radius);
    let hit = false;
    this.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        const d = tri.closestPointToSegment(_seg, _v1, _v2);
        if (d < radius) {
          const depth = radius - d;
          const dir = _v2.sub(_v1).normalize();
          _seg.start.addScaledVector(dir, depth);
          _seg.end.addScaledVector(dir, depth);
          hit = true;
        }
      },
    });
    if (hit) {
      const dx = _seg.start.x - _start0.x, dy = _seg.start.y - _start0.y, dz = _seg.start.z - _start0.z;
      const len = Math.hypot(dx, dy, dz);
      pos.x += dx; pos.y += dy; pos.z += dz;
      info.hit = true;
      if (len > 1e-5) { info.nx = dx / len; info.ny = dy / len; info.nz = dz / len; info.grounded = dy / len > 0.6; info.ceiling = dy / len < -0.5; }
    }
    return hit;
  }

  // Raycast against structures only. Returns distance or -1; fills out.point / out.normal.
  raycastMesh(origin, dir, maxDist, out) {
    if (!this.bvh) return -1;
    _ray.origin.copy(origin); _ray.direction.copy(dir);
    const h = this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxDist);
    if (!h) return -1;
    if (out) {
      out.point.copy(h.point);
      out.normal.copy(h.face.normal);
      if (out.normal.dot(dir) > 0) out.normal.negate();
    }
    return h.distance;
  }

  // Raycast against terrain + structures; nearest wins.
  raycast(origin, dir, maxDist, out) {
    let best = -1;
    const t = this.world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist, 0.25);
    if (t >= 0) {
      best = t;
      if (out) {
        out.point.copy(origin).addScaledVector(dir, t);
        this.world.normalAt(out.point.x, out.point.z, out.normal);
        out.terrain = true;
      }
    }
    const tmp = this._tmp || (this._tmp = { point: new THREE.Vector3(), normal: new THREE.Vector3() });
    const m = this.raycastMesh(origin, dir, best >= 0 ? best : maxDist, tmp);
    if (m >= 0 && (best < 0 || m < best)) {
      best = m;
      if (out) { out.point.copy(tmp.point); out.normal.copy(tmp.normal); out.terrain = false; }
    }
    return best;
  }

  // Height of walkable structure surface under (x, z) near y, or -Infinity.
  groundMesh(x, y, z, up = 0.7, down = 1.4) {
    if (!this.bvh) return -Infinity;
    _v1.set(x, y + up, z); _v2.set(0, -1, 0);
    const o = this._tmp2 || (this._tmp2 = { point: new THREE.Vector3(), normal: new THREE.Vector3() });
    const d = this.raycastMesh(_v1, _v2, up + down, o);
    if (d < 0 || o.normal.y < 0.55) return -Infinity;
    return o.point.y;
  }
}

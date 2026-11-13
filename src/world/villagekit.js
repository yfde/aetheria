// Hearthvale's houses are assembled from Quaternius' Medieval Village MegaKit (CC0): hand-made, textured
// modular walls, roofs, doors and windows on a 2 m grid, drawn with the game's toon lighting.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { shared, U_LIGHT, U_SHADOW } from '../core/globals.js';
import { GLSL_UNIFORMS, GLSL_MATH, GLSL_SHADOW, GLSL_FOG, GLSL_LIGHT } from '../shaders/common.js';
import { mulberry32 } from './noise.js';

const BASE = './assets/models/village/';
const TEX = { MI_Plaster: 'plaster.jpg', MI_WoodTrim: 'wood.jpg', MI_WoodTrim_Wear: 'wood.jpg', MI_RoundTiles: 'tiles.jpg', MI_UnevenBrick: 'stone.jpg',
  MI_Brick: 'brick.jpg', MI_RockTrim: 'rock.jpg', MI_MetalOrnaments: 'metal.jpg', MI_Vine: 'vine.png', MI_WindowGlass: null };

export async function loadVillageKit() {
  const gltf = await new Promise((res, rej) => new GLTFLoader().load(BASE + 'kit.glb', res, undefined, rej));
  const pieces = {};
  for (const node of gltf.scene.children) {
    const parts = [];
    node.traverse((o) => { if (o.isMesh) parts.push({ geo: o.geometry, mat: o.material.name }); });
    pieces[node.name] = parts;
  }
  const tl = new THREE.TextureLoader(), tex = {};
  await Promise.all([...new Set(Object.values(TEX).filter(Boolean))].map((f) => tl.loadAsync(BASE + f).then((t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.flipY = false; t.anisotropy = 8; tex[f] = t;
  })));
  return { pieces, tex };
}

const VERT = /* glsl */`
in vec3 color;
out vec3 vWorldPos; out vec3 vNormal; out vec2 vUv; out vec3 vColor;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz; vNormal = normalize(mat3(modelMatrix) * normal); vUv = uv; vColor = color;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FRAG = /* glsl */`
${GLSL_UNIFORMS}
${GLSL_MATH}
${GLSL_SHADOW}
${GLSL_FOG}
${GLSL_LIGHT}
uniform sampler2D uMap;
uniform float uKind;       // 0 textured, 1 window glass, 2 vine leaves
in vec3 vWorldPos; in vec3 vNormal; in vec2 vUv; in vec3 vColor;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 wp = vWorldPos, V = normalize(cameraPosition - wp);
  vec3 albedo, emissive = vec3(0.0);
  float alpha = 1.0, rim = 0.35;
  if (uKind > 0.5 && uKind < 1.5) {
    // dark panes by day, warm lamplight behind most of them at night
    float lit = smoothstep(0.25, 0.75, uNight) * step(0.22, hash12(floor(wp.xz * 0.31) + floor(wp.y * 0.4)));
    emissive = vec3(1.0, 0.62, 0.25) * 2.4 * lit;
    albedo = mix(vec3(0.08, 0.12, 0.2), vec3(0.4, 0.28, 0.12), lit);
    rim = 1.2;
  } else {
    vec4 tx = texture(uMap, vUv);
    albedo = tx.rgb;
    if (uKind > 1.5) {
      alpha = clamp((tx.a - 0.5) / max(fwidth(tx.a), 1e-3) + 0.5, 0.0, 1.0);
      if (alpha < 0.08) discard;
      albedo = vec3(0.16, 0.36, 0.07) * (0.6 + 0.8 * tx.g);
    } else {
      // optional re-colouring (roof tints): keep the painted detail as luminance
      float recol = step(0.02, distance(vColor, vec3(1.0)));
      albedo = mix(albedo, vColor * (0.3 + 1.45 * luma(albedo)), recol);
    }
  }
  albedo *= 1.0 - uWet * 0.22;
  float shadow = getShadow(wp, N) * cloudShadow(wp);
  vec3 col = toonShade(albedo, N, V, shadow, 1.0, rim) + emissive;
  col = applyFog(col, wp);
  fragColor = vec4(col, alpha);
}
`;

const _m = new THREE.Matrix4(), _l = new THREE.Matrix4(), _n = new THREE.Matrix3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();

// Collects transformed kit pieces into one geometry per material.
export class KitBuilder {
  constructor(kit) { this.kit = kit; this.buf = {}; this.col = []; this.base = new THREE.Matrix4(); }
  setBase(x, y, z, rotY = 0) { this.base.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, rotY, 0)), _s.set(1, 1, 1)); return this; }
  _buf(mat) { return this.buf[mat] || (this.buf[mat] = { pos: [], nrm: [], uv: [], col: [], idx: [], n: 0 }); }
  _append(geo, mat, m, tint, collide) {
    const B = this._buf(mat), P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv, I = geo.index;
    _n.getNormalMatrix(m); _c.set(tint);
    const base = B.n, cb = this.col.length / 3;
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(m); B.pos.push(_v.x, _v.y, _v.z);
      if (collide) this.col.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(N, i).applyMatrix3(_n).normalize(); B.nrm.push(_v.x, _v.y, _v.z);
      B.uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
      B.col.push(_c.r, _c.g, _c.b);
    }
    const cnt = I ? I.count : P.count;
    for (let i = 0; i < cnt; i++) { const k = I ? I.getX(i) : i; B.idx.push(base + k); if (collide) (this.colIdx || (this.colIdx = [])).push(cb + k); }
    B.n += P.count;
  }
  // place a kit piece; p/ry are in the current base frame
  add(name, { p = [0, 0, 0], ry = 0, s = [1, 1, 1], tint = 0xffffff, collide = true } = {}) {
    const parts = this.kit.pieces[name];
    if (!parts) { console.warn('kit piece missing', name); return this; }
    _l.compose(_p.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(0, ry, 0)), _s.set(s[0], s[1], s[2]));
    _m.multiplyMatrices(this.base, _l);
    for (const part of parts) this._append(part.geo, part.mat, _m, part.mat === 'MI_RoundTiles' ? tint : 0xffffff, collide && part.mat !== 'MI_Vine' && part.mat !== 'MI_WindowGlass');
    return this;
  }
  // plain box wearing a kit texture (foundations, steps, rubble); uv = metres * k, continuous between neighbouring boxes
  box(mat, x, y, z, sx, sy, sz, k = 0.4, r = null, collide = true) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      const px = P.getX(i) + x, py = P.getY(i) + y, pz = P.getZ(i) + z, ax = Math.abs(N.getX(i)), ay = Math.abs(N.getY(i));
      if (ay > 0.5) U.setXY(i, px * k, pz * k); else if (ax > 0.5) U.setXY(i, pz * k, -py * k); else U.setXY(i, px * k, -py * k);
    }
    if (r) _l.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.set(1, 1, 1)); else _l.makeTranslation(x, y, z);
    _m.multiplyMatrices(this.base, _l);
    this._append(g, mat, _m, 0xffffff, collide);
    g.dispose();
    return this;
  }
  // invisible collision slab (smooth climbing surface in place of many detailed wall pieces)
  collideBox(x, y, z, sx, sy, sz, r = null) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (r) _l.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.set(1, 1, 1)); else _l.makeTranslation(x, y, z);
    _m.multiplyMatrices(this.base, _l);
    const P = g.attributes.position, I = g.index, cb = this.col.length / 3;
    for (let i = 0; i < P.count; i++) { _v.fromBufferAttribute(P, i).applyMatrix4(_m); this.col.push(_v.x, _v.y, _v.z); }
    for (let i = 0; i < I.count; i++) (this.colIdx || (this.colIdx = [])).push(cb + I.getX(i));
    g.dispose();
    return this;
  }
  // -> { meshes: [THREE.Mesh], collider: BufferGeometry }
  build(gfx) {
    const meshes = [];
    const depth = new THREE.ShaderMaterial({ vertexShader: 'void main(){ gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }', fragmentShader: 'void main(){}', glslVersion: THREE.GLSL3, colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: 3 });
    for (const mat in this.buf) {
      const B = this.buf[mat];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
      g.setIndex(B.idx);
      g.computeBoundingSphere();
      const kind = mat === 'MI_WindowGlass' ? 1 : mat === 'MI_Vine' ? 2 : 0;
      const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
        uniforms: { ...shared(...U_LIGHT, ...U_SHADOW), uMap: { value: this.kit.tex[TEX[mat]] || null }, uKind: { value: kind } },
        vertexShader: VERT, fragmentShader: FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide, alphaToCoverage: kind === 2,
      }));
      m.matrixAutoUpdate = false;
      m.userData.shadowMat = depth;
      if (gfx && kind !== 2) gfx.addCaster(m);
      meshes.push(m);
    }
    const collider = new THREE.BufferGeometry();
    collider.setAttribute('position', new THREE.Float32BufferAttribute(this.col, 3));
    collider.setIndex(this.colIdx || []);
    return { meshes, collider };
  }
}

const ROOF_TINTS = [0xffffff, 0x2f7a80, 0x3d5fa0, 0xb98a2c, 0xffffff];

// One house in the builder's current frame: door on +z, ridge along x. L = 8 or 10 m long, 6 m deep, 1 or 2 storeys.
// Returns { chimney: Vector3 (world), doorX }.
export function kitHouse(b, { L = 8, floors = 1, stone = false, roof = 0, seed = 1 }) {
  const rnd = mulberry32(seed * 977 + 5);
  const W = 6, n = L / 2, FLOOR = 0.34, H = 3.0;
  const tint = ROOF_TINTS[roof % ROOF_TINTS.length];
  const doorI = n === 4 ? (rnd() < 0.5 ? 1 : 2) : 2;
  const doorX = -L / 2 + 1 + 2 * doorI;
  // foundation of field stone, a step at the door
  b.box('MI_UnevenBrick', 0, FLOOR - 0.95, 0, L + 0.5, 1.9, W + 0.5);
  b.box('MI_RockTrim', doorX, FLOOR - 0.17, W / 2 + 0.75, 1.9, 0.34, 1.1, 0.25);
  b.box('MI_RockTrim', doorX, FLOOR - 0.3, W / 2 + 1.35, 2.3, 0.16, 0.7, 0.25);

  const wall = (kind, st, x, y, z, ry) => {
    const fam = st ? 'Wall_UnevenBrick_' : 'Wall_Plaster_';
    const o = { p: [x, y, z], ry };
    const small = { p: [x, y, z], ry, collide: false };
    if (kind === 'door') {
      b.add(fam + (st ? 'Door_Round' : 'Door_Flat'), o);
      b.add(st ? 'DoorFrame_Round_WoodDark' : 'DoorFrame_Flat_WoodDark', small);
      // the leaf hangs from its hinge at local x = -0.55
      const c = Math.cos(ry), s = Math.sin(ry);
      b.add(st ? 'Door_8_Round' : 'Door_1_Flat', { p: [x - 0.55 * c - 0.04 * s, y, z + 0.55 * s - 0.04 * c], ry, collide: false });
    } else if (kind === 'win') {
      b.add(fam + (st ? 'Window_Wide_Round' : 'Window_Wide_Flat'), o);
      b.add(st ? 'Window_Wide_Round1' : 'Window_Wide_Flat1', small);
      b.add(st ? 'WindowShutters_Wide_Round_Open' : 'WindowShutters_Wide_Flat_Open', small);
    } else if (kind === 'thin') {
      b.add(fam + 'Window_Thin_Round', o);
      b.add('Window_Thin_Round1', small);
      b.add('WindowShutters_Thin_Round_Open', small);
    } else if (kind === 'grid' && !st) {
      // the timber lattice is an open frame: it goes over a solid plaster panel
      b.add(y < 1 ? 'Wall_Plaster_Straight_Base' : 'Wall_Plaster_Straight', o);
      b.add('Wall_Plaster_WoodGrid', small);
    }
    else b.add(st ? 'Wall_UnevenBrick_Straight' : (y < 1 ? 'Wall_Plaster_Straight_Base' : 'Wall_Plaster_Straight'), o);
  };
  for (let f = 0; f < floors; f++) {
    const y = FLOOR + f * H, st = stone && f === 0, up = f > 0;
    // long sides
    for (let i = 0; i < n; i++) {
      const x = -L / 2 + 1 + 2 * i;
      let front = up ? (i % 2 === 0 ? 'win' : 'grid') : (i === doorI ? 'door' : (Math.abs(i - doorI) === 1 || n === 4 ? 'win' : 'grid'));
      if (!up && n === 4 && i !== doorI && Math.abs(i - doorI) > 1) front = 'grid';
      wall(front, st, x, y, W / 2, 0);
      wall(i % 2 === (up ? 1 : 0) ? 'win' : (st ? 'plain' : 'grid'), st, x, y, -W / 2, Math.PI);
    }
    // gable ends: three modules each
    for (let i = 0; i < 3; i++) {
      const z = -2 + 2 * i, mid = i === 1;
      wall(mid ? (up ? 'thin' : 'win') : (st ? 'plain' : 'grid'), st, L / 2, y, z, Math.PI / 2);
      wall(mid ? 'thin' : (st ? 'plain' : (up ? 'grid' : 'plain')), st, -L / 2, y, z, -Math.PI / 2);
    }
    // timber corner posts
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('Corner_ExteriorWide_Wood', { p: [sx * L / 2, y, sz * W / 2], collide: false });
  }
  const top = FLOOR + floors * H;
  b.add('Roof_RoundTiles_6x' + L, { p: [0, top, 0], ry: Math.PI / 2, tint });
  b.add('Roof_Front_Brick6', { p: [L / 2, top, 0], ry: Math.PI / 2 });
  b.add('Roof_Front_Brick6', { p: [-L / 2, top, 0], ry: -Math.PI / 2 });
  // chimney through the back slope
  const cx = (rnd() < 0.5 ? -1 : 1) * L * 0.2;
  b.add(stone ? 'Prop_Chimney2' : 'Prop_Chimney', { p: [cx, top + 1.0, -1.25] });
  // creepers on the walls, a crate or two by the side
  if (rnd() < 0.8) b.add(rnd() < 0.5 ? 'Prop_Vine1' : 'Prop_Vine2', { p: [-L / 2 + 1 + 2 * (doorI === 0 ? 1 : 0), FLOOR + 2.75, W / 2 + 0.1], collide: false });
  if (rnd() < 0.7) b.add('Prop_Vine2', { p: [L / 2 + 0.1, FLOOR + (floors > 1 ? 5.6 : 2.75), 2], ry: Math.PI / 2, collide: false });
  const side = rnd() < 0.5 ? -1 : 1;
  b.add('Prop_Crate', { p: [side * (L / 2 + 0.85), FLOOR - 0.34, 1.6], ry: rnd() });
  if (rnd() < 0.6) b.add('Prop_Crate', { p: [side * (L / 2 + 0.8), FLOOR - 0.34, 0.35], ry: rnd(), s: [0.8, 0.8, 0.8] });
  return { chimney: new THREE.Vector3(cx, top + 4.25, -1.25).applyMatrix4(b.base), doorX, floorY: FLOOR };
}


// ------------------------------------------------------------------ landmarks built from the kit
const SIDES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];      // wall yaw per side; outward normal = (sin, cos)
// place a piece on a side: D = distance of the wall plane from the centre, u = offset along the wall
function put(kb, name, ry, D, u, y, o = {}) {
  const c = Math.cos(ry), s = Math.sin(ry);
  kb.add(name, { ...o, p: [s * D + c * u, y, c * D - s * u], ry });
}

// Skywatch Tower: a 6 m square stone keep with two timber ledges, a railed gallery and a tiled belfry.
// Returns { topY (local height of the gallery floor), roofTop }.
export function kitTower(kb, { storeys = 12 } = {}) {
  const half = 3, H = 3.0, F = 0.45;
  kb.box('MI_UnevenBrick', 0, F - 1.7, 0, 7.6, 3.4, 7.6);
  for (let f = 0; f < storeys; f++) {
    const y = F + f * H;
    SIDES.forEach((ry, k) => {
      for (let i = 0; i < 3; i++) {
        const u = -2 + 2 * i, vis = { collide: false };
        if (f === 0 && k === 0 && i === 1) { put(kb, 'Wall_UnevenBrick_Door_Round', ry, half, u, y, vis); put(kb, 'DoorFrame_Round_Brick', ry, half, u, y, vis); put(kb, 'Door_8_Round', ry, half - 0.04, u - 0.55, y, vis); }
        else if (i === 1 && f % 3 === 2) { put(kb, 'Wall_UnevenBrick_Window_Thin_Round', ry, half, u, y, vis); put(kb, 'Window_Thin_Round1', ry, half, u, y, vis); }
        else if (i !== 1 && f % 3 === 0 && f > 0 && (k + f / 3) % 2 === 0) { put(kb, 'Wall_UnevenBrick_Window_Thin_Round', ry, half, u, y, vis); put(kb, 'Window_Thin_Round1', ry, half, u, y, vis); }
        else put(kb, 'Wall_UnevenBrick_Straight', ry, half, u, y, vis);
      }
    });
  }
  const yT = F + storeys * H;
  // one smooth collision shaft: climbing never snags on window frames or trims
  kb.collideBox(0, F + storeys * H / 2, 0, half * 2 + 0.18, storeys * H, half * 2 + 0.18);
  // stone corner buttresses
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kb.box('MI_Brick', sx * half, yT / 2, sz * half, 0.62, yT, 0.62, 0.33);
  // timber resting ledges with braces
  for (const f of [4, 8]) {
    const y = F + f * H;
    SIDES.forEach((ry) => {
      for (const u of [-2, 0, 2]) put(kb, 'Floor_WoodDark', ry, half + 0.5, u, y, { s: [1, 1, 0.5] });
      put(kb, 'Floor_WoodDark', ry, half + 0.5, half + 0.5, y, { s: [0.5, 1, 0.5] });
      for (const u of [-2, 2]) put(kb, 'Roof_Support2', ry, half + 0.08, u, y - 0.08, { collide: false });
    });
  }
  // top gallery: plank floor, railings at the corners (the middle of each side is open for leaping off)
  for (const gx of [-3, -1, 1, 3]) for (const gz of [-3, -1, 1, 3]) kb.add('Floor_WoodDark', { p: [gx, yT, gz] });
  SIDES.forEach((ry) => { for (const u of [-3, 3]) put(kb, 'Balcony_Cross_Straight', ry, 3, u, yT, { collide: false }); for (const u of [-3, -1, 1, 3]) put(kb, 'Roof_Support2', ry, half + 0.08, u, yT - 0.08, { collide: false }); });
  // belfry: timber posts and arches under a tiled spire
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kb.add('Corner_ExteriorWide_Wood', { p: [sx * 2, yT, sz * 2], collide: false });
  SIDES.forEach((ry) => { for (const u of [-1, 1]) put(kb, 'Wall_Arch', ry, 2, u, yT, { collide: false }); });
  kb.add('Roof_Tower_RoundTiles', { p: [0, yT + 3.0, 0], tint: 0x2f7a80 });
  return { topY: yT, roofTop: yT + 3.0 + 6.8 };
}

// Trial shrine: a small open-fronted stone chapel on a stepped platform. Front = +z. Returns the platform height.
export function kitShrine(kb, tint = 0x2f7a80) {
  const P = 0.85;
  kb.box('MI_UnevenBrick', 0, (P - 0.05 - 2.5) / 2, 0, 7.9, P - 0.05 + 2.5, 5.9);
  for (const x of [-3, -1, 1, 3]) for (const z of [-2, 0, 2]) kb.add('Stairs_Exterior_Platform', { p: [x, P - 1.0, z] });
  for (const x of [-1, 1]) kb.add('Stairs_Exterior_Straight', { p: [x, P - 1.0, 4], collide: false });
  { // the steps are walked as a smooth ramp
    const a = Math.atan2(1.1, 2.2), t = 0.3;
    kb.collideBox(0, P - 0.55 - Math.cos(a) * t / 2, 4.1 - Math.sin(a) * t / 2, 4.0, t, Math.hypot(2.2, 1.1), [a, 0, 0]);
  }
  // back wall with a lancet window, side walls with open arches
  put(kb, 'Wall_UnevenBrick_Straight', Math.PI, 2, -2, P); put(kb, 'Wall_UnevenBrick_Straight', Math.PI, 2, 2, P);
  put(kb, 'Wall_UnevenBrick_Window_Thin_Round', Math.PI, 2, 0, P); put(kb, 'Window_Thin_Round1', Math.PI, 2, 0, P, { collide: false });
  for (const ry of [Math.PI / 2, -Math.PI / 2]) for (const u of [-1, 1]) put(kb, 'Wall_UnevenBrick_Window_Wide_Round', ry, 3, u, P);
  // stone piers at the corners, timber arches across the open front
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kb.box('MI_Brick', sx * 3, P + 1.5, sz * 2, 0.6, 3.0, 0.6, 0.33);
  for (const u of [-2, 0, 2]) put(kb, 'Wall_Arch', 0, 2, u, P, { collide: false });
  kb.add('Roof_RoundTiles_4x6', { p: [0, P + 3.0, 0], ry: Math.PI / 2, tint });
  kb.add('Roof_Front_Brick4', { p: [3, P + 3.0, 0], ry: Math.PI / 2 }); kb.add('Roof_Front_Brick4', { p: [-3, P + 3.0, 0], ry: -Math.PI / 2 });
  kb.add('Prop_Vine1', { p: [-3.12, P + 2.8, 1], ry: -Math.PI / 2, collide: false }); kb.add('Prop_Vine2', { p: [1.2, P + 2.8, -2.12], ry: Math.PI, collide: false });
  return { P, ridge: P + 3.0 + 3.75 };
}

// Raiders' camp: a fence ring, two timber lean-tos and stacked crates around a fire pit (world coordinates).
export function kitCamp(kb, hAt, cx, cz, seed) {
  const rnd = mulberry32(seed * 131 + 9);
  const R = 8.4, n = 26, gapA = Math.floor(rnd() * n), gapB = (gapA + 12) % n;
  for (let i = 0; i < n; i++) {
    if (i === gapA || i === (gapA + 1) % n || i === gapB || i === (gapB + 1) % n) continue;
    const a = (i + 0.5) / n * Math.PI * 2, x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
    kb.setBase(x, hAt(x, z) - 0.05, z, -a - Math.PI / 2);
    kb.add('Prop_WoodenFence_Single', { collide: false });
  }
  for (let k = 0; k < 2; k++) {
    const a = 0.8 + k * 2.5, x = cx + Math.cos(a) * 5.0, z = cz + Math.sin(a) * 5.0;
    kb.setBase(x, hAt(x, z) - 0.05, z, Math.atan2(cx - x, cz - z) + Math.PI);      // high side toward the outside, open toward the fire
    kb.add('Roof_Wooden_2x1_L', { p: [-1, 1.5, -0.75], collide: false }); kb.add('Roof_Wooden_2x1_R', { p: [1, 1.5, -0.75], collide: false });
    for (const sx of [-1.95, 0, 1.95]) { kb.add('Corner_Exterior_Wood', { p: [sx, 0, -0.7], s: [0.8, 0.45, 0.8], collide: false }); kb.add('Corner_Exterior_Wood', { p: [sx, 0, 0.7], s: [0.8, 0.84, 0.8], collide: false }); }
    kb.add('Prop_Crate', { p: [-1.1, 0, 0.1], ry: rnd(), s: [0.7, 0.7, 0.7] });
    if (rnd() < 0.6) kb.add('Prop_Crate', { p: [0.9, 0, 0.2], ry: rnd(), s: [0.55, 0.55, 0.55] });
  }
  { const a = 4.4, x = cx + Math.cos(a) * 5.6, z = cz + Math.sin(a) * 5.6; kb.setBase(x, hAt(x, z), z, rnd() * 6.28); kb.add('Prop_Crate', {}); kb.add('Prop_Crate', { p: [1.15, 0, 0.25], ry: 0.6 }); kb.add('Prop_Crate', { p: [0.55, 1.06, 0.1], ry: 0.3, s: [0.8, 0.8, 0.8] }); }
  if (seed % 2 === 0) { const a = 5.6, x = cx + Math.cos(a) * 11.5, z = cz + Math.sin(a) * 11.5; kb.setBase(x, hAt(x, z), z, a + 1.2); kb.add('Prop_Wagon', {}); }
}

// Ruined stone cottage: crumbling runs of stonework, one surviving window wall, creepers, rubble and old flagstones.
// gy(lx, lz) gives the ground height in the builder's frame so the stonework follows a slope.
export function kitRuin(kb, seed, gy = () => 0) {
  const rnd = mulberry32(seed * 733 + 3);
  const T = 0.55, STONE = 'MI_UnevenBrick';
  const run = (x0, z0, dx, dz, len, h, fall) => {
    for (let i = 0; i < len; i++) {
      const cx = x0 + dx * (i + 0.5), cz = z0 + dz * (i + 0.5), g = gy(cx, cz);
      if (h - g > 0.3) kb.box(STONE, cx, (h + g - 0.6) / 2, cz, dx ? 1.0 : T, h - g + 0.6, dz ? 1.0 : T, 0.42);
      h -= fall * (0.25 + rnd() * 0.9);
      if (rnd() < 0.18) h += 0.5;
      if (h < 0.2) break;
    }
  };
  const flip = rnd() < 0.5 ? 1 : -1;                                   // which end of the cottage still stands
  const X = 3 * flip, top = 3.0;
  // the standing corner with a surviving window wall beside it
  kb.box(STONE, X, top / 2 - 0.5 + gy(X, -2) * 0.5, -2, 0.7, top + 1.0 - gy(X, -2), 0.7, 0.42);
  put(kb, 'Wall_UnevenBrick_Window_Wide_Round', Math.PI, 2, -2 * flip, Math.min(0, gy(2 * flip, -2)) - 0.05);
  put(kb, rnd() < 0.5 ? 'Prop_Vine1' : 'Prop_Vine2', Math.PI, 2.14, -2 * flip, 2.75, { collide: false });
  run(X - flip * 2, -2, -flip, 0, 4, 2.3 + rnd() * 0.5, 1);            // back wall crumbling away from the window
  run(X, -1.65, 0, 1, 4, 2.6 + rnd() * 0.4, 0.8);                      // gable end
  run(-X, 2.35, 0, -1, 4, 1.2 + rnd() * 1.0, 0.7);                     // far end, mostly fallen
  run(X - flip * 0.35, 2, -flip, 0, 6, 1.6 + rnd() * 0.8, 0.9);        // front wall with the doorway gap
  if (rnd() < 0.6) put(kb, 'Prop_Vine2', flip > 0 ? Math.PI / 2 : -Math.PI / 2, 3.3, 1.2 * flip, 2.2, { collide: false });
  // rubble: tumbled blocks, loose bricks, a few flagstones left of the floor
  for (let i = 0; i < 7; i++) {
    const x = (rnd() - 0.5) * 9, z = (rnd() - 0.5) * 7.5, s = 0.35 + rnd() * 0.5;
    kb.box(STONE, x, gy(x, z) + s * 0.25, z, s * 1.3, s * 0.75, s, 0.42, [rnd() * 0.5 - 0.25, rnd() * 6.28, rnd() * 0.5 - 0.25], false);
  }
  for (let i = 0; i < 14; i++) { const x = (rnd() - 0.5) * 9, z = (rnd() - 0.5) * 7; kb.add('Prop_Brick' + (1 + (i % 3)), { p: [x, gy(x, z) + 0.09, z], ry: rnd() * 6.28, s: [1.5, 1.5, 1.5], collide: false }); }
  for (const [x, z] of [[-1.6, -0.6], [0.5, 0.4], [1.9, -0.7]]) {
    const g = gy(x, z);
    if (rnd() < 0.75 && Math.abs(gy(x + 1, z) - gy(x - 1, z)) < 0.25 && Math.abs(gy(x, z + 1) - gy(x, z - 1)) < 0.25) kb.add('Floor_UnevenBrick', { p: [x, g + 0.05, z], ry: rnd() * 0.5, collide: false });
  }
}

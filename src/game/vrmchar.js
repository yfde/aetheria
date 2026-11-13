// Anime-style hero: loads a VRM avatar, re-targets the KayKit animation clips onto its humanoid rig,
// swaps the MToon materials for the game's own cel shader and exposes the same interface as createCharacter().
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { VRMLoaderPlugin, VRMUtils } from 'three-vrm';
import { makeToonMaterials, addSmoothNormals, characterDepthMaterial } from './characters.js';
import { Builder, meshFrom, buildingMaterial, M } from '../world/structures.js';

// KayKit bone (sanitised name) -> VRM humanoid bone
const MAP = {
  hips: 'hips', spine: 'spine', chest: 'chest', head: 'head',
  upperarml: 'leftUpperArm', lowerarml: 'leftLowerArm', wristl: 'leftHand',
  upperarmr: 'rightUpperArm', lowerarmr: 'rightLowerArm', wristr: 'rightHand',
  upperlegl: 'leftUpperLeg', lowerlegl: 'leftLowerLeg', footl: 'leftFoot', toesl: 'leftToes',
  upperlegr: 'rightUpperLeg', lowerlegr: 'rightLowerLeg', footr: 'rightFoot', toesr: 'rightToes',
};
const INV = {}; for (const k in MAP) INV[MAP[k]] = k;
// target bones in parent-before-child order with their humanoid parent
const CHAIN = [
  ['hips', null], ['spine', 'hips'], ['chest', 'spine'], ['upperChest', 'chest'], ['neck', 'upperChest'], ['head', 'neck'],
  ['leftShoulder', 'upperChest'], ['leftUpperArm', 'leftShoulder'], ['leftLowerArm', 'leftUpperArm'], ['leftHand', 'leftLowerArm'],
  ['rightShoulder', 'upperChest'], ['rightUpperArm', 'rightShoulder'], ['rightLowerArm', 'rightUpperArm'], ['rightHand', 'rightLowerArm'],
  ['leftUpperLeg', 'hips'], ['leftLowerLeg', 'leftUpperLeg'], ['leftFoot', 'leftLowerLeg'], ['leftToes', 'leftFoot'],
  ['rightUpperLeg', 'hips'], ['rightLowerLeg', 'rightUpperLeg'], ['rightFoot', 'rightLowerLeg'], ['rightToes', 'rightFoot'],
];

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();
const LEG_GAIN = { Idle: 0.5, Walking_A: 0.68, Walking_B: 0.68, Walking_Backwards: 0.7, Blocking: 0.6, Block: 0.6, Block_Hit: 0.6, Interact: 0.6, Cheer: 0.8, 'T-Pose': 1, Lie_Idle: 1, Lie_StandUp: 1, Sit_Floor_Idle: 1, Sit_Floor_Down: 1, Sit_Floor_StandUp: 1, Sit_Chair_Idle: 1, Death_A: 1, Death_B: 1 };
const TUCK_L = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.33);
const TUCK_R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.33);

const vrmLoader = new GLTFLoader();
vrmLoader.register((p) => new VRMLoaderPlugin(p));
export function loadVRM(url) { return new Promise((res, rej) => vrmLoader.load(url, (g) => res(g.userData.vrm), undefined, rej)); }

// ---- animation sources -------------------------------------------------------------------------------
// KayKit Adventurers: chibi rig (short legs, wide arms) -> needs arm tuck, leg damping and re-grounding.
export const SRC_KAYKIT = {
  rest: 'T-Pose', map: MAP, hips: 'hips', feet: ['footl', 'footr', 'toesl', 'toesr'], toe: ['footl', 'toesl'],
  tuck: true, ground: true, hipScale: 0.6, prefix: '',
  legGain: (name) => (LEG_GAIN[name] !== undefined ? LEG_GAIN[name] : 0.86),
};
// Quaternius Universal Animation Library: human proportions, clean loops -> copied as is. Clips get a "U_" prefix.
export const SRC_UAL = {
  rest: 'A_TPose', hips: 'DEF-hips', feet: ['DEF-footL', 'DEF-footR', 'DEF-toeL', 'DEF-toeR'], toe: ['DEF-footL', 'DEF-toeL'],
  tuck: false, ground: false, hipScale: 1, prefix: 'U_', legGain: () => 1,
  map: {
    'DEF-hips': 'hips', 'DEF-spine001': 'spine', 'DEF-spine002': 'chest', 'DEF-spine003': 'upperChest', 'DEF-neck': 'neck', 'DEF-head': 'head',
    'DEF-shoulderL': 'leftShoulder', 'DEF-upper_armL': 'leftUpperArm', 'DEF-forearmL': 'leftLowerArm', 'DEF-handL': 'leftHand',
    'DEF-shoulderR': 'rightShoulder', 'DEF-upper_armR': 'rightUpperArm', 'DEF-forearmR': 'rightLowerArm', 'DEF-handR': 'rightHand',
    'DEF-thighL': 'leftUpperLeg', 'DEF-shinL': 'leftLowerLeg', 'DEF-footL': 'leftFoot', 'DEF-toeL': 'leftToes',
    'DEF-thighR': 'rightUpperLeg', 'DEF-shinR': 'rightLowerLeg', 'DEF-footR': 'rightFoot', 'DEF-toeR': 'rightToes',
  },
};
// Universal Animation Library 2 uses the Unreal mannequin's bone names
export const SRC_UAL2 = {
  ...SRC_UAL, hips: 'pelvis', feet: ['foot_l', 'foot_r', 'ball_l', 'ball_r'], toe: ['foot_l', 'ball_l'],
  map: {
    pelvis: 'hips', spine_01: 'spine', spine_02: 'chest', spine_03: 'upperChest', neck_01: 'neck', Head: 'head',
    clavicle_l: 'leftShoulder', upperarm_l: 'leftUpperArm', lowerarm_l: 'leftLowerArm', hand_l: 'leftHand',
    clavicle_r: 'rightShoulder', upperarm_r: 'rightUpperArm', lowerarm_r: 'rightLowerArm', hand_r: 'rightHand',
    thigh_l: 'leftUpperLeg', calf_l: 'leftLowerLeg', foot_l: 'leftFoot', ball_l: 'leftToes',
    thigh_r: 'rightUpperLeg', calf_r: 'rightLowerLeg', foot_r: 'rightFoot', ball_r: 'rightToes',
  },
};
// limb segments whose rest direction is aligned between source and target (makes A-pose sources work)
const LIMBS = [['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'], ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot']];

// Bake source clips onto the VRM's humanoid bones as world-space rotation deltas from a shared T-pose.
export function retargetClips(srcGltf, vrm, names, fps = 30, raw = false, spec = SRC_KAYKIT) {
  const src = SkeletonUtils.clone(srcGltf.scene);
  const mixer = new THREE.AnimationMixer(src);
  const sb = {}; src.traverse((o) => { if (o.isBone) sb[o.name] = o; });
  const clipByName = {}; for (const c of srcGltf.animations) clipByName[c.name] = c;
  const pose = (clip, t) => { mixer.stopAllAction(); const a = mixer.clipAction(clip); a.play(); a.time = t; mixer.update(0); src.updateMatrixWorld(true); };
  const MAPs = spec.map, INVs = {}; for (const k in MAPs) INVs[MAPs[k]] = k;
  const srcHips = sb[spec.hips];

  const H = vrm.humanoid, v0 = vrm.meta.metaVersion === '0';
  // raw = drive the model's own bones (VRM 0.x rigs rest with identity rotations), so clones need no VRM runtime
  const nodes = {}; for (const [b] of CHAIN) nodes[b] = raw ? H.getRawBoneNode(b) : H.getNormalizedBoneNode(b);
  const hipsNode = nodes.hips;
  const tgtHipsRest = hipsNode.position.clone();
  vrm.scene.updateMatrixWorld(true);
  const baseY = vrm.scene.getWorldPosition(new THREE.Vector3()).y;
  const hipsY = hipsNode.getWorldPosition(new THREE.Vector3()).y - baseY;

  // rest reference
  pose(clipByName[spec.rest], 0);
  const srcHipsRest = srcHips.getWorldPosition(new THREE.Vector3());
  const scale = hipsY / srcHipsRest.y;
  // does the source face -Z? (the target faces +Z in world space; VRM 0.x bones live in a frame turned by 180 degrees)
  const srcBack = sb[spec.toe[1]].getWorldPosition(new THREE.Vector3()).z < sb[spec.toe[0]].getWorldPosition(new THREE.Vector3()).z;
  const flip = v0 !== srcBack;
  const restInv = {}, tmp = new THREE.Quaternion();
  for (const k in MAPs) if (sb[k]) restInv[k] = sb[k].getWorldQuaternion(new THREE.Quaternion()).invert();
  const wpos = (n) => n.getWorldPosition(new THREE.Vector3());
  for (const [b, c] of LIMBS) {
    const sB = sb[INVs[b]], sC = sb[INVs[c]];
    if (!sB || !sC || !nodes[b] || !nodes[c]) continue;
    const sd = wpos(sC).sub(wpos(sB)).normalize(), td = wpos(nodes[c]).sub(wpos(nodes[b])).normalize();
    if (srcBack) { td.x = -td.x; td.z = -td.z; }
    if (sd.angleTo(td) > 1.2) continue;
    // virtual T-pose of the source bone = C * rest;  delta(t) = R(t) * (C * rest)^-1
    restInv[INVs[b]].multiply(new THREE.Quaternion().setFromUnitVectors(sd, td).invert());
  }

  // ---- grounding data (chibi sources): each baked frame is posed on the target and the hips are placed so its
  // lowest point rests on the ground, because hip heights of a short-legged rig cannot be copied.
  const GB = [['leftFoot', null], ['rightFoot', null], ['leftToes', null], ['rightToes', null], ['leftLowerLeg', 0.07], ['rightLowerLeg', 0.07],
    ['hips', 0.11], ['chest', 0.12], ['head', 0.11], ['leftHand', 0.04], ['rightHand', 0.04]].filter(([n]) => nodes[n]);
  const gOff = GB.map(([n, r]) => (r === null ? nodes[n].getWorldPosition(_v).y - baseY : r));
  const srcFeet = spec.feet.map((n) => sb[n]).filter(Boolean);
  const srcFootRest = srcFeet.map((f) => f.getWorldPosition(_v).y);
  const saved = {}; for (const [b] of CHAIN) if (nodes[b]) saved[b] = nodes[b].quaternion.clone();
  const LEGS = { leftUpperLeg: 1, rightUpperLeg: 1, leftLowerLeg: 1, rightLowerLeg: 1 };
  const ident = new THREE.Quaternion();

  const out = {};
  const delta = {};
  for (const [b] of CHAIN) delta[b] = new THREE.Quaternion();
  for (const name of names) {
    const clip = clipByName[name];
    if (!clip) continue;
    const legGain = spec.legGain(name);
    const dur = clip.duration, n = Math.max(1, Math.ceil(dur * fps)) + 1;
    const times = new Float32Array(n);
    const rot = {}; for (const [b] of CHAIN) if (nodes[b]) rot[b] = new Float32Array(n * 4);
    const pos = new Float32Array(n * 3);
    for (let f = 0; f < n; f++) {
      const t = n === 1 ? 0 : Math.min(dur, f / (n - 1) * dur);
      times[f] = t;
      pose(clip, Math.min(t, Math.max(0, dur - 1e-4)));
      for (const [b, parent] of CHAIN) {
        const sk = INVs[b];
        if (sk && sb[sk]) {
          delta[b].copy(sb[sk].getWorldQuaternion(tmp)).multiply(restInv[sk]);
          // the chibi rig holds its arms wide around a barrel body; tuck them in for slim proportions
          if (spec.tuck) { if (b === 'leftUpperArm') delta[b].premultiply(TUCK_L); else if (b === 'rightUpperArm') delta[b].premultiply(TUCK_R); }
        }
        else if (parent) delta[b].copy(delta[parent]); else delta[b].identity();
        if (!nodes[b]) continue;
        if (parent) _q.copy(delta[parent]).invert().multiply(delta[b]); else _q.copy(delta[b]);
        if (LEGS[b] && legGain < 1) _q.copy(_q2.copy(ident).slerp(_q, legGain));
        if (flip) { _q.x = -_q.x; _q.z = -_q.z; }
        rot[b].set([_q.x, _q.y, _q.z, _q.w], f * 4);
        nodes[b].quaternion.copy(_q);
      }
      const hp = srcHips.getWorldPosition(_v).sub(srcHipsRest);
      const dy = hp.y * scale;
      hp.multiplyScalar(scale * spec.hipScale);
      if (flip) { hp.x = -hp.x; hp.z = -hp.z; }
      const hx = tgtHipsRest.x + hp.x, hz = tgtHipsRest.z + hp.z;
      let y;
      if (spec.ground) {
        // lowest body point on the ground, plus a share of the source's real air time
        hipsNode.position.set(hx, tgtHipsRest.y, hz);
        hipsNode.updateWorldMatrix(false, true);
        let low = 1e9;
        for (let k = 0; k < GB.length; k++) low = Math.min(low, nodes[GB[k][0]].getWorldPosition(_v).y - baseY - gOff[k]);
        let lift = 1e9;
        for (let k = 0; k < srcFeet.length; k++) lift = Math.min(lift, srcFeet[k].getWorldPosition(_v).y - srcFootRest[k]);
        y = tgtHipsRest.y - low + Math.max(0, lift) * scale * 0.55;
      } else y = tgtHipsRest.y + dy;
      pos.set([hx, y, hz], f * 3);
    }
    const tracks = [new THREE.VectorKeyframeTrack(hipsNode.name + '.position', times, pos)];
    for (const b in rot) tracks.push(new THREE.QuaternionKeyframeTrack(nodes[b].name + '.quaternion', times, rot[b]));
    out[spec.prefix + name] = new THREE.AnimationClip(spec.prefix + name, dur, tracks);
  }
  // leave the target in its rest pose
  for (const b in saved) nodes[b].quaternion.copy(saved[b]);
  hipsNode.position.copy(tgtHipsRest);
  hipsNode.updateWorldMatrix(false, true);
  mixer.stopAllAction();
  return out;
}

// Where an accessory (sword, shield) sits relative to a KayKit wrist in the T-pose, in character space.
function accessoryRest(srcGltf, meshName, wristName) {
  const src = SkeletonUtils.clone(srcGltf.scene);
  const mixer = new THREE.AnimationMixer(src);
  const tp = srcGltf.animations.find((c) => c.name === 'T-Pose');
  const a = mixer.clipAction(tp); a.play(); mixer.update(0); src.updateMatrixWorld(true);
  let mesh = null, wrist = null;
  src.traverse((o) => { if (o.name === meshName && o.isMesh) mesh = o; if (o.name === wristName && o.isBone) wrist = o; });
  if (!mesh || !wrist) return null;
  return {
    geometry: mesh.geometry, map: mesh.material.map,
    quat: mesh.getWorldQuaternion(new THREE.Quaternion()),
    offset: mesh.getWorldPosition(new THREE.Vector3()).sub(wrist.getWorldPosition(new THREE.Vector3())),
  };
}

// Merge sibling skinned primitives that share a material (VRoid exports dozens of hair strips).
function mergeByMaterial(root) {
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    if (o.geometry.morphAttributes && Object.keys(o.geometry.morphAttributes).length) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const key = o.parent.uuid + '|' + mat.uuid + '|' + o.skeleton.uuid;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'];
    const geos = list.map((m) => {
      const g = m.geometry.clone(); g.clearGroups();
      for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
      return g;
    });
    if (!geos.every((g) => keep.every((k) => g.attributes[k]))) continue;
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const first = list[0];
    const sm = new THREE.SkinnedMesh(merged, first.material);
    sm.name = first.name + '_merged';
    sm.bind(first.skeleton, first.bindMatrix);
    first.parent.add(sm);
    for (const m of list) m.parent.remove(m);
  }
}

// Build the playable hero from a loaded VRM. Returns the same shape of object as createCharacter().
export function createVRMCharacter(vrm, srcGltf, gfx, opts = {}) {
  const v0 = vrm.meta.metaVersion === '0';
  const H = vrm.humanoid;
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(vrm.scene);
  VRMUtils.rotateVRM0(vrm);
  mergeByMaterial(vrm.scene);
  const group = new THREE.Group();
  group.add(vrm.scene);

  // ---- materials: MToon -> the game's cel shader (shares light, fog and shadows with the world)
  const sharedU = { uFlash: { value: new THREE.Color(0, 0, 0) }, uEmissive: { value: new THREE.Color(0, 0, 0) }, uDissolve: { value: 0 } };
  const meshes = [];
  const list = [];
  vrm.scene.traverse((o) => { if (o.isMesh) list.push(o); });
  const white = new THREE.Color(1, 1, 1);
  for (const m of list) {
    const src = Array.isArray(m.material) ? m.material[0] : m.material;
    const name = src.name || '';
    const isEye = /EYE|Eye/.test(name) && !/Eyelash|Eyeline|Brow/i.test(name);
    const isFaceDetail = /Brow|Eyelash|Eyeline|Mouth|EyeHighlight/i.test(name);
    const isSkin = /SKIN|Skin|Face_00/.test(name);
    const isHair = /HAIR|Hair/.test(name);
    const cut = src.alphaTest > 0 || src.transparent;
    const shade = src.shadeColorFactor && src.shadeColorFactor.isColor ? src.shadeColorFactor.clone() : white.clone();
    // keep shaded sides colourful: pull the MToon shade colour toward white a little
    shade.lerp(white, isSkin ? 0.35 : 0.5);
    const baseTint = src.color && src.color.isColor ? src.color.clone() : new THREE.Color(1, 1, 1);
    if (opts.clothTint && !isSkin && !isEye && !isFaceDetail) baseTint.multiply(isHair ? (opts.hairTint || opts.clothTint) : opts.clothTint);
    const mats = makeToonMaterials(src.map || null, {
      shared: sharedU, tint: baseTint,
      alphaTest: cut ? 0.5 : 0, doubleSide: src.side === THREE.DoubleSide || cut || isHair,
      shadeTint: shade, flat: isSkin ? 0.7 : (isFaceDetail ? 1 : (isHair ? 0.25 : 0)), unlit: isEye ? 1 : 0,
      gain: isEye ? 0.72 : 0.64, rim: isSkin || isEye || isFaceDetail ? 0.25 : 0.7, outline: 1.25,
      recolor: opts.recolor && !isEye && !isHair && !isSkin && !isFaceDetail ? 1 : 0,
    });
    m.geometry.clearGroups();
    m.material = mats.main;
    m.userData.shadowMat = characterDepthMaterial();
    m.frustumCulled = false;
    meshes.push(m);
    gfx.addCaster(m);
    // inverted-hull outline for the solid parts
    if (!cut && !isEye && !isFaceDetail && opts.outline !== false) {
      addSmoothNormals(m.geometry);
      let ol;
      if (m.isSkinnedMesh) { ol = new THREE.SkinnedMesh(m.geometry, mats.outline); ol.bind(m.skeleton, m.bindMatrix); } else ol = new THREE.Mesh(m.geometry, mats.outline);
      if (m.morphTargetInfluences) { ol.morphTargetInfluences = m.morphTargetInfluences; ol.morphTargetDictionary = m.morphTargetDictionary; }
      ol.frustumCulled = false;
      ol.position.copy(m.position); ol.quaternion.copy(m.quaternion); ol.scale.copy(m.scale);
      m.parent.add(ol);
    }
  }

  // ---- animation: every KayKit clip, re-targeted
  const clips = retargetClips(srcGltf, vrm, opts.clips || srcGltf.animations.map((c) => c.name));
  if (opts.ual) Object.assign(clips, retargetClips(opts.ual, vrm, opts.ualClips || opts.ual.animations.map((c) => c.name), 30, false, SRC_UAL));
  if (opts.ual2) Object.assign(clips, retargetClips(opts.ual2, vrm, opts.ual2Clips || opts.ual2.animations.map((c) => c.name).filter((n) => n !== 'A_TPose'), 30, false, SRC_UAL2));
  const mixer = new THREE.AnimationMixer(vrm.scene);

  // ---- sword + shield, placed exactly as the knight holds them
  const parts = {};
  group.updateMatrixWorld(true);
  const accScale = opts.accessoryScale || 0.6;
  // a slender blade forged for the hero (the knight's chunky sword only lends its grip pose)
  if (opts.sword !== false) {
    const r = accessoryRest(srcGltf, '1H_Sword', 'wristr');
    const hand = H.getRawBoneNode('rightHand');
    if (r && hand) {
      const b = new Builder();
      const STEEL = 0xdfe8f2, GOLDC = 0xe7b950, NAVY = 0x1c2a52, CY = 0x6fe8ff;
      // blade: flat diamond section tapering to the point (width along x, thin along z)
      const blade = new THREE.CylinderGeometry(0.012, 0.042, 0.8, 4, 1); blade.scale(1, 1, 0.22);
      b.add(blade, { p: [0, 0.5, 0], r: [0, Math.PI / 4, 0], color: STEEL, mat: M.METAL });
      b.add(new THREE.ConeGeometry(0.012, 0.07, 4), { p: [0, 0.935, 0], r: [0, Math.PI / 4, 0], s: [1, 1, 0.22], color: STEEL, mat: M.METAL });
      b.box(0, 0.47, 0, 0.012, 0.62, 0.014, { color: CY, mat: M.GLOW, emis: 2.6 });                 // glowing fuller
      // guard with swept wings
      b.box(0, 0.085, 0, 0.2, 0.028, 0.034, { color: GOLDC, mat: M.METAL });
      for (const sx of [-1, 1]) b.box(sx * 0.105, 0.105, 0, 0.05, 0.022, 0.03, { color: GOLDC, mat: M.METAL, r: [0, 0, sx * 0.7] });
      b.add(new THREE.OctahedronGeometry(0.022, 0), { p: [0, 0.085, 0], s: [1, 1.2, 1.3], color: CY, mat: M.GLOW, emis: 3.2 });
      b.cyl(0, 0.0, 0, 0.014, 0.016, 0.15, 6, { color: NAVY, mat: M.PLAIN });                          // grip
      b.add(new THREE.OctahedronGeometry(0.024, 0), { p: [0, -0.09, 0], color: GOLDC, mat: M.METAL });
      const mesh = meshFrom(b, gfx, true);
      mesh.matrixAutoUpdate = true;
      const hq = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
      mesh.quaternion.copy(hq).multiply(r.quat);
      mesh.position.copy(r.offset).multiplyScalar(0.45).applyQuaternion(hq);
      mesh.frustumCulled = false;
      hand.add(mesh);
      parts['1H_Sword'] = mesh; meshes.push(mesh);
    }
  }

  // ---- hands: curl the fingers around the grips (the source rig has no finger bones)
  const sgn = v0 ? -1 : 1;
  for (const [side, s, curl] of [['left', -1, opts.sword === false ? 0.35 : 0.95], ['right', 1, opts.sword === false ? 0.35 : 1.15]]) {
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
      const b = H.getNormalizedBoneNode(side + f + seg);
      if (b) b.rotation.z = s * curl * sgn;
    }
    for (const seg of ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal']) { const b = H.getNormalizedBoneNode(side + seg); if (b) b.rotation.y = -s * 0.45 * sgn; }
  }

  const bones = {};
  for (const [b] of CHAIN) bones[b] = H.getNormalizedBoneNode(b);
  let blinkT = 2 + Math.random() * 3, blink = 0;
  const em = vrm.expressionManager;
  return {
    isVRM: true, v0, vrm, group, root: vrm.scene, mixer, clips, bones, parts, meshes, outlines: [], uniforms: sharedU, scale: 1,
    setPartVisible(name, v) { const p = parts[name]; if (p) p.visible = v; },
    resetPhysics() { if (vrm.springBoneManager) vrm.springBoneManager.reset(); if (this.cape) this.cape.reset(); },
    // call after the mixer + procedural pose: copies the humanoid pose to the mesh, runs hair / cloth springs, blinks
    update(dt) {
      blinkT -= dt;
      if (blinkT < 0) { blink = 1; blinkT = 2.2 + Math.random() * 3.5; }
      if (blink > 0) { blink = Math.max(0, blink - dt * 7); if (em) em.setValue('blink', Math.sin(Math.min(1, blink) * Math.PI)); }
      group.updateMatrixWorld(true);
      vrm.update(Math.min(dt, 0.05));
      if (this.cape) { group.updateMatrixWorld(true); this.cape.update(dt); }
    },
    dispose() { for (const m of meshes) gfx.removeCaster(m); mixer.stopAllAction(); if (group.parent) group.parent.remove(group); },
  };
}


// ------------------------------------------------------------------ shade enemies
// One avatar is turned into a template: a single dark skinned mesh + clips baked on its raw bones.
// Every enemy is then a cheap SkeletonUtils clone (one draw call, no textures, no spring bones).
export function prepareShadeTemplate(vrm, srcGltf, clipNames, ual, ualNames) {
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(vrm.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.updateMatrixWorld(true);
  const H = vrm.humanoid;
  const clips = retargetClips(srcGltf, vrm, clipNames, 30, true);
  if (ual) Object.assign(clips, retargetClips(ual, vrm, ualNames, 30, true, SRC_UAL));
  // merge all skinned primitives per skeleton
  const bySkel = new Map(), drop = [];
  vrm.scene.traverse((o) => {
    if (o.isSkinnedMesh) { if (!bySkel.has(o.skeleton.uuid)) bySkel.set(o.skeleton.uuid, []); bySkel.get(o.skeleton.uuid).push(o); }
    else if (o.isMesh) drop.push(o);
  });
  for (const list of bySkel.values()) {
    const geos = list.map((m) => {
      const g = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'skinIndex', 'skinWeight']) g.setAttribute(k, m.geometry.attributes[k]);
      g.setIndex(m.geometry.index);
      return g;
    });
    const merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    const sm = new THREE.SkinnedMesh(merged, new THREE.MeshBasicMaterial());
    sm.name = 'ShadeBody';
    sm.bind(list[0].skeleton, list[0].bindMatrix);
    list[0].parent.add(sm);
    for (const m of list) m.parent.remove(m);
  }
  for (const m of drop) m.parent.remove(m);
  if (H.normalizedHumanBonesRoot && H.normalizedHumanBonesRoot.parent) H.normalizedHumanBonesRoot.parent.remove(H.normalizedHumanBonesRoot);
  // where a weapon sits in the right hand (same grip as the knight's sword)
  const r = accessoryRest(srcGltf, '1H_Sword', 'wristr');
  const hand = H.getRawBoneNode('rightHand');
  const hq = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
  const grip = { quat: hq.clone().multiply(r.quat), pos: r.offset.clone().multiplyScalar(0.45).applyQuaternion(hq) };
  const name = (b) => { const n = H.getRawBoneNode(b); return n ? n.name : null; };
  // attachment frames for masks, manes and pauldrons: model-space axes (x = left, y = up, z = forward) at rest
  const wq = (n) => n.getWorldQuaternion(new THREE.Quaternion()).invert();
  const wp = (n) => n.getWorldPosition(new THREE.Vector3());
  const gear = {};
  {
    const head = H.getRawBoneNode('head'), eL = H.getRawBoneNode('leftEye'), eR = H.getRawBoneNode('rightEye');
    const neck = H.getRawBoneNode('neck'), chest = H.getRawBoneNode('upperChest') || H.getRawBoneNode('chest');
    if (head) {
      const hp = wp(head), inv = wq(head);
      const face = eL && eR ? wp(eL).add(wp(eR)).multiplyScalar(0.5) : hp.clone().add(new THREE.Vector3(0, 0.07, 0.02));
      face.z += 0.078;                                                        // from the eye joints out to the skin
      gear.head = { bone: head.name, quat: inv, pos: face.sub(hp).applyQuaternion(inv) };
    }
    if (neck && chest) { const inv = wq(chest); gear.neck = { bone: chest.name, quat: inv, pos: wp(neck).sub(wp(chest)).applyQuaternion(inv) }; }
    for (const [k, bn] of [['armL', 'leftUpperArm'], ['armR', 'rightUpperArm']]) { const n = H.getRawBoneNode(bn); if (n) gear[k] = { bone: n.name, quat: wq(n), pos: new THREE.Vector3() }; }
  }
  return { scene: vrm.scene, clips, grip, gear, hand: name('rightHand'), head: name('head'), eyes: [name('leftEye'), name('rightEye')] };
}

const shadeGeo = {};
function shadeWeapon(kind) {
  if (shadeGeo[kind]) return shadeGeo[kind];
  const b = new Builder();
  const DARK = 0x1a1626, EDGE = { blade: 0xb070ff, axe: 0xff5a4a, dagger: 0x55ffc0, staff: 0xd070ff }[kind];
  if (kind === 'staff') {
    b.cyl(0, 0.35, 0, 0.016, 0.02, 1.25, 6, { color: DARK, mat: M.PLAIN });
    b.add(new THREE.OctahedronGeometry(0.075, 0), { p: [0, 1.06, 0], s: [1, 1.5, 1], color: EDGE, mat: M.GLOW, emis: 5 });
    for (let i = 0; i < 3; i++) { const a = i * 2.094; b.box(Math.cos(a) * 0.07, 0.98, Math.sin(a) * 0.07, 0.016, 0.2, 0.016, { color: DARK, mat: M.PLAIN, r: [Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5] }); }
  } else {
    const len = kind === 'axe' ? 1.05 : kind === 'dagger' ? 0.5 : 0.85, wid = kind === 'axe' ? 0.085 : 0.05;
    // jagged dark blade with a glowing edge
    const blade = new THREE.CylinderGeometry(0.01, wid, len, 4, 1); blade.scale(1, 1, 0.2);
    b.add(blade, { p: [0, 0.1 + len / 2, 0], r: [0, Math.PI / 4, 0], color: DARK, mat: M.METAL });
    b.box(wid * 0.55, 0.1 + len * 0.45, 0, 0.008, len * 0.8, 0.012, { color: EDGE, mat: M.GLOW, emis: 4.5, r: [0, 0, 0.045] });
    for (let i = 0; i < 3; i++) b.cone(-wid * 0.7, 0.3 + i * len * 0.24, 0, 0.022, 0.09, 4, { color: DARK, mat: M.METAL, r: [0, 0, 1.1] });
    b.box(0, 0.085, 0, 0.17, 0.03, 0.04, { color: DARK, mat: M.METAL });
    b.cyl(0, 0, 0, 0.015, 0.017, 0.16, 6, { color: 0x2a2233, mat: M.PLAIN });
  }
  return (shadeGeo[kind] = b.build());
}
const eyeGeo = {};

// Carved bone masks, horns, feathered manes and pauldrons worn by the shades (built once per kind).
const gearCache = {};
function horn(b, x, y, z, side, len, r0, tilt, curl, back, color, tip) {
  let px = x, py = y, pz = z, ang = side * tilt;
  const n = 5, sl = len / n;
  for (let i = 0; i < n; i++) {
    const ra = r0 * (1 - i / n), rb = r0 * (1 - (i + 1) / n) + 0.0015;
    const dx = Math.sin(ang), dy = Math.cos(ang);
    b.cyl(px + dx * sl / 2, py + dy * sl / 2, pz - back * sl / 2, rb, ra, sl * 1.1, 6, { color: i >= n - 2 ? tip : color, mat: M.PLAIN, r: [0, 0, -ang] });
    px += dx * sl; py += dy * sl; pz -= back * sl; ang -= side * curl;
  }
}
function shadeGear(kind, glow) {
  const key = kind + glow;
  if (gearCache[key]) return gearCache[key];
  const BONE = 0xe9dfc8, BONE_D = 0x8d7d66, DARK = 0x1b1628, DARK2 = 0x2c2440, INK = 0x09070e;
  const S = { minion: { w: 0.112, h: 0.138, cy: -0.012 }, warrior: { w: 0.13, h: 0.168, cy: -0.022 }, rogue: { w: 0.1, h: 0.162, cy: -0.03 }, mage: { w: 0.105, h: 0.186, cy: -0.006 } }[kind];
  const D = 0.115, Z0 = 0.03 - 0.105;
  const sz = (x, y) => Z0 + D * Math.sqrt(Math.max(0.05, 1 - (x / S.w) ** 2 - ((y - S.cy) / S.h) ** 2));   // mask surface
  const out = {};
  {
    const b = new Builder();
    const cap = (sc, dz, color) => b.add(new THREE.SphereGeometry(1, 18, 12, Math.PI / 2 - 1.05, 2.1, 0.45, 2.2), { p: [0, S.cy, Z0 + dz], s: [S.w * sc, S.h * sc, D], color, mat: M.PLAIN });
    cap(1.1, -0.016, BONE_D);                                   // weathered rim behind the face plate
    cap(1.0, 0, BONE);
    const ex = S.w * 0.38, ey = 0.002;
    for (const sd of [-1, 1]) {
      const tilt = kind === 'minion' ? 0.12 : kind === 'rogue' ? 0.5 : 0.32;
      b.sphere(sd * ex, ey, sz(ex, ey) - 0.004, 0.03, 1, { s: [1.25, kind === 'minion' ? 0.9 : 0.6, 0.36], r: [0, sd * 0.3, sd * tilt], color: INK, mat: M.PLAIN });
      b.sphere(sd * ex, ey - 0.002, sz(ex, ey) + 0.004, 0.02, 1, { s: [1.05, kind === 'minion' ? 0.7 : 0.36, 0.3], r: [0, sd * 0.3, sd * tilt], color: glow, mat: M.GLOW, emis: 8 });
    }
    const mark = (x, y, w, h, rz, emis = 1.3) => b.box(x, y, sz(x, y) + 0.001, w, h, 0.006, { r: [0, x * 4.5, rz], color: glow, mat: M.GLOW, emis });
    if (kind === 'minion') {
      mark(0, S.cy + S.h * 0.5, 0.016, 0.045, 0);
      for (const sd of [-1, 1]) { mark(sd * 0.05, -0.052, 0.014, 0.014, 0.78); mark(sd * 0.032, -0.07, 0.012, 0.012, 0.78); }
      b.box(0, -0.085, sz(0, -0.085) + 0.001, 0.05, 0.007, 0.006, { color: INK, mat: M.PLAIN });
      for (const sd of [-1, 1]) horn(b, sd * 0.062, S.cy + S.h * 0.66, -0.03, sd, 0.12, 0.022, 0.55, 0.2, 0.2, BONE_D, DARK);
    } else if (kind === 'warrior') {
      mark(0, S.cy + S.h * 0.56, 0.02, 0.085, 0);
      for (const sd of [-1, 1]) { mark(sd * 0.062, -0.058, 0.014, 0.06, sd * 0.55); mark(sd * 0.085, -0.03, 0.012, 0.04, sd * 0.55); }
      b.box(0, -0.105, sz(0, -0.105) + 0.001, 0.085, 0.016, 0.006, { color: INK, mat: M.PLAIN });
      for (let i = -2; i <= 2; i++) b.cone(i * 0.016, -0.1 + (i % 2 ? 0.004 : -0.004), sz(i * 0.016, -0.1) + 0.006, 0.006, 0.02, 4, { color: BONE, mat: M.PLAIN, r: [i % 2 ? Math.PI : 0, 0, 0] });
      for (const sd of [-1, 1]) { horn(b, sd * 0.092, S.cy + S.h * 0.5, -0.05, sd, 0.36, 0.038, 1.3, 0.42, 0.04, BONE_D, BONE); b.cone(sd * 0.05, -0.135, sz(0.05, -0.135) + 0.012, 0.012, 0.055, 5, { color: BONE, mat: M.PLAIN, r: [0.25, 0, -sd * 0.2] }); }
    } else if (kind === 'rogue') {
      for (const sd of [-1, 1]) { mark(sd * 0.064, 0.035, 0.011, 0.07, -sd * 1.0); mark(sd * 0.03, -0.075, 0.009, 0.05, sd * 0.25); }
      mark(0, S.cy + S.h * 0.62, 0.012, 0.03, 0.78, 2.0);
      b.cone(0, S.cy - S.h * 0.86, Z0 + 0.03, 0.03, 0.07, 4, { color: BONE, mat: M.PLAIN, r: [Math.PI, 0, 0], s: [1, 1, 0.5] });        // pointed chin
      for (const sd of [-1, 1]) horn(b, sd * 0.072, S.cy + S.h * 0.55, -0.04, sd, 0.3, 0.024, 0.5, 0.04, 0.62, DARK2, glow);
    } else {
      b.add(new THREE.OctahedronGeometry(0.02, 0), { p: [0, S.cy + S.h * 0.52, sz(0, S.cy + S.h * 0.52) + 0.004], s: [0.8, 1.5, 0.4], color: glow, mat: M.GLOW, emis: 7 });
      for (const sd of [-1, 1]) { mark(sd * 0.022, -0.105, 0.008, 0.075, 0); mark(sd * 0.06, -0.045, 0.01, 0.05, sd * 0.3); }
      mark(0, -0.12, 0.008, 0.06, 0);
      horn(b, 0, S.cy + S.h * 0.8, -0.03, 0, 0.2, 0.022, 0, 0, 0.12, BONE_D, glow);
      for (const sd of [-1, 1]) horn(b, sd * 0.055, S.cy + S.h * 0.66, -0.03, sd, 0.15, 0.018, 0.42, 0.06, 0.12, BONE_D, glow);
      b.add(new THREE.TorusGeometry(0.19, 0.007, 5, 32), { p: [0, 0.06, -0.2], color: glow, mat: M.GLOW, emis: 4 });                       // halo behind the head
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; b.add(new THREE.OctahedronGeometry(0.014, 0), { p: [Math.cos(a) * 0.19, 0.06 + Math.sin(a) * 0.19, -0.2], s: [0.7, 1.6, 0.7], r: [0, 0, a - Math.PI / 2], color: glow, mat: M.GLOW, emis: 4 }); }
    }
    out.head = b.build();
  }
  { // feathered mane over the shoulders, clasped with a glowing gem
    const b = new Builder();
    const big = kind === 'warrior' ? 1.25 : kind === 'minion' ? 0.85 : 1;
    for (let row = 0; row < 2; row++) {
      const n = row ? 9 : 12;
      for (let i = 0; i < n; i++) {
        const a = (i + (row ? 0.5 : 0)) / n * Math.PI * 2, front = Math.max(0, Math.cos(a));
        const len = (row ? 0.15 : 0.22) * big * (1 - front * 0.45), R = (row ? 0.065 : 0.085);
        const g = new THREE.ConeGeometry(0.036 * big, len, 5);
        g.translate(0, len / 2, 0); g.scale(1.7, 1, 0.42); g.rotateX((row ? 1.75 : 2.0) + front * 0.35); g.rotateY(a);
        b.add(g, { p: [Math.sin(a) * R, row ? 0.035 : 0.01, Math.cos(a) * R - 0.01], color: (i + row) % 3 === 0 ? DARK2 : DARK, mat: M.PLAIN });
      }
    }
    b.add(new THREE.OctahedronGeometry(0.03, 0), { p: [0, -0.045, 0.105], s: [0.8, 1.3, 0.5], color: glow, mat: M.GLOW, emis: 5 });
    out.neck = b.build();
  }
  if (kind === 'warrior' || kind === 'rogue') {
    const k = kind === 'warrior' ? 1 : 0.72;
    for (const [name, sd] of [['armL', 1], ['armR', -1]]) {
      const b = new Builder();
      b.sphere(sd * 0.03, 0.035, 0, 0.1 * k, 2, { s: [1.12, 0.74, 1.08], color: BONE_D, mat: M.PLAIN });
      b.add(new THREE.TorusGeometry(0.097 * k, 0.011, 5, 18), { p: [sd * 0.03, 0.016, 0], r: [Math.PI / 2, 0, 0], color: glow, mat: M.GLOW, emis: 1.8 });
      if (kind === 'warrior') { b.cone(sd * 0.085, 0.135, 0, 0.03, 0.16, 6, { color: BONE, mat: M.PLAIN, r: [0, 0, -sd * 0.55] }); b.cone(sd * 0.02, 0.125, 0, 0.022, 0.1, 6, { color: BONE, mat: M.PLAIN, r: [0, 0, -sd * 0.1] }); }
      out[name] = b.build();
    }
  }
  return (gearCache[key] = out);
}

export function createShade(tpl, gfx, opts) {
  const root = SkeletonUtils.clone(tpl.scene);
  const group = new THREE.Group();
  group.add(root);
  root.scale.setScalar(opts.scale || 1);
  const glow = new THREE.Color(opts.glow);
  const mats = makeToonMaterials(null, { tint: new THREE.Color(0.035, 0.03, 0.06), rimGlow: glow, rim: 0.2, outline: 0 });
  const meshes = [], byName = {};
  root.traverse((o) => {
    byName[o.name] = o;
    if (o.isSkinnedMesh) { o.material = mats.main; o.userData.shadowMat = characterDepthMaterial(); o.frustumCulled = false; gfx.addCaster(o); meshes.push(o); }
  });
  const bm = buildingMaterial();
  // burning eyes
  const key = glow.getHexString();
  if (!eyeGeo[key]) { const b = new Builder(); b.sphere(0, 0, 0, 0.026, 1, { color: glow.getHex(), mat: M.GLOW, emis: 9, s: [1.5, 0.55, 0.6] }); eyeGeo[key] = b.build(); }
  const gear = [];
  const worn = opts.kind && tpl.gear ? shadeGear(opts.kind, glow.getHex()) : null;
  if (worn) {
    for (const k in worn) {
      const a = tpl.gear[k], bone = a && byName[a.bone];
      if (!bone) continue;
      const m = new THREE.Mesh(worn[k], bm.main);
      m.userData.shadowMat = bm.depth; m.frustumCulled = false;
      m.quaternion.copy(a.quat); m.position.copy(a.pos);
      bone.add(m); gfx.addCaster(m); meshes.push(m); gear.push(m);
    }
  } else for (const n of tpl.eyes) { const e = byName[n]; if (!e) continue; const m = new THREE.Mesh(eyeGeo[key], bm.main); m.position.set(0, 0, -0.085); m.frustumCulled = false; e.add(m); }
  // weapon
  const hand = byName[tpl.hand];
  if (hand && opts.weapon) {
    const w = new THREE.Mesh(shadeWeapon(opts.weapon), bm.main);
    w.userData.shadowMat = bm.depth; w.frustumCulled = false;
    w.quaternion.copy(tpl.grip.quat); w.position.copy(tpl.grip.pos);
    hand.add(w); gfx.addCaster(w); meshes.push(w); gear.push(w);
  }
  const mixer = new THREE.AnimationMixer(root);
  return {
    group, root, mixer, clips: tpl.clips, bones: {}, parts: {}, meshes, gear, uniforms: mats.uniforms, scale: opts.scale || 1,
    dispose() { for (const m of meshes) gfx.removeCaster(m); mixer.stopAllAction(); if (group.parent) group.parent.remove(group); mats.main.dispose(); },
  };
}

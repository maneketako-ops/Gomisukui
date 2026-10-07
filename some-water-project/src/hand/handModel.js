import * as THREE from 'three';
import { buildSurfaceNets } from './surfaceNets.js';

// 右手（前腕つき）の手続き的モデル。
//
// 骨格に沿って「先細りカプセル」を並べ、それらを滑らかに結合した符号付き距離場（SDF）から
// Surface Nets でメッシュを生成し、各頂点を近い骨にスキニングする。
// 同じカプセル群がそのまま物理用のコライダーにもなるので、見た目と当たり判定が一致する。
//
// 手の座標系（休止姿勢）: 原点 = 手首、+Z = 指先方向、+Y = 手の甲、+X = 親指側

const V = (x, y, z) => new THREE.Vector3(x, y, z);

const FINGER_DEFS = [
  {
    name: 'index',
    base: V(0.012, 0.0, 0.014),
    head: V(0.026, 0.0, 0.088),
    metaR: [0.0122, 0.0112],
    spread: 0.16,
    len: [0.041, 0.025, 0.021],
    rad: [
      [0.0097, 0.0089],
      [0.0088, 0.0081],
      [0.008, 0.0071],
    ],
  },
  {
    name: 'middle',
    base: V(0.002, 0.001, 0.014),
    head: V(0.006, 0.001, 0.092),
    metaR: [0.0124, 0.0118],
    spread: 0.035,
    len: [0.045, 0.028, 0.022],
    rad: [
      [0.0099, 0.0091],
      [0.0089, 0.0083],
      [0.0081, 0.0073],
    ],
  },
  {
    name: 'ring',
    base: V(-0.009, 0.0, 0.014),
    head: V(-0.0135, 0.0, 0.086),
    metaR: [0.012, 0.011],
    spread: -0.11,
    len: [0.042, 0.027, 0.021],
    rad: [
      [0.0093, 0.0086],
      [0.0084, 0.0078],
      [0.0076, 0.0069],
    ],
  },
  {
    name: 'little',
    base: V(-0.018, -0.001, 0.016),
    head: V(-0.031, -0.002, 0.076),
    metaR: [0.0114, 0.0099],
    spread: -0.25,
    len: [0.033, 0.02, 0.019],
    rad: [
      [0.0084, 0.0077],
      [0.0075, 0.007],
      [0.0068, 0.0062],
    ],
  },
];

const THUMB_DEF = {
  cmc: V(0.02, -0.008, 0.02),
  dirMeta: V(0.6, -0.2, 0.775).normalize(),
  dirPhal: V(0.44, -0.12, 0.89).normalize(),
  yHint: V(0.75, 0.62, -0.2).normalize(),
  len: [0.046, 0.033, 0.028],
  rad: [
    [0.0128, 0.0107],
    [0.0104, 0.0097],
    [0.0097, 0.0084],
  ],
};

function makeFrame(origin, zDir, yHint) {
  const z = zDir.clone().normalize();
  const x = new THREE.Vector3().crossVectors(yHint, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin);
}

function rotY(v, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return V(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

// 先細りカプセル（round cone）の厳密な SDF（Inigo Quilez）
function sdRoundCone(px, py, pz, p) {
  const bax = p.bx - p.ax;
  const bay = p.by - p.ay;
  const baz = p.bz - p.az;
  const l2 = p.l2;
  const rr = p.r1 - p.r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - p.ax;
  const pay = py - p.ay;
  const paz = pz - p.az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const qx = pax * l2 - bax * y;
  const qy = pay * l2 - bay * y;
  const qz = paz * l2 - baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - p.r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - p.r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - p.r1;
}

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export class HandModel {
  constructor() {
    this.bones = [];
    this.boneByName = {};
    this.restWorld = []; // 手の座標系での休止姿勢の行列
    this.prims = [];
    this.groups = [];
    this._buildSkeleton();
    this._buildPrimitives();
    this.colliders = this._makeColliderBuffers();
    this.lattice = this._buildLattice();
  }

  // ---- 骨格 ---------------------------------------------------------------

  _addBone(name, parentName, restMatrix) {
    const bone = new THREE.Bone();
    bone.name = name;
    const idx = this.bones.length;
    this.bones.push(bone);
    this.boneByName[name] = idx;
    this.restWorld.push(restMatrix);
    const parentIdx = parentName ? this.boneByName[parentName] : -1;
    bone.userData.parent = parentIdx;
    bone.userData.children = [];
    const local = restMatrix.clone();
    if (parentIdx >= 0) {
      local.premultiply(this.restWorld[parentIdx].clone().invert());
      this.bones[parentIdx].add(bone);
      this.bones[parentIdx].userData.children.push(idx);
    }
    local.decompose(bone.position, bone.quaternion, bone.scale);
    bone.userData.restQ = bone.quaternion.clone();
    return idx;
  }

  _buildSkeleton() {
    const Y = V(0, 1, 0);
    const Z = V(0, 0, 1);
    this._addBone('forearm', null, makeFrame(V(0, 0, 0), Z, Y));
    this._addBone('hand', 'forearm', makeFrame(V(0, 0, 0), Z, Y));
    this.fingerTips = [];
    for (const f of FINGER_DEFS) {
      const metaDir = f.head.clone().sub(f.base);
      this._addBone(`${f.name}_meta`, 'hand', makeFrame(f.base, metaDir, Y));
      const dir = rotY(Z, f.spread);
      let p = f.head.clone();
      this._addBone(`${f.name}_prox`, `${f.name}_meta`, makeFrame(p, dir, Y));
      p = p.clone().addScaledVector(dir, f.len[0]);
      this._addBone(`${f.name}_mid`, `${f.name}_prox`, makeFrame(p, dir, Y));
      p = p.clone().addScaledVector(dir, f.len[1]);
      this._addBone(`${f.name}_dist`, `${f.name}_mid`, makeFrame(p, dir, Y));
    }
    const t = THUMB_DEF;
    this._addBone('thumb_meta', 'hand', makeFrame(t.cmc, t.dirMeta, t.yHint));
    let p = t.cmc.clone().addScaledVector(t.dirMeta, t.len[0]);
    this._addBone('thumb_prox', 'thumb_meta', makeFrame(p, t.dirPhal, t.yHint));
    p = p.clone().addScaledVector(t.dirPhal, t.len[1]);
    this._addBone('thumb_dist', 'thumb_prox', makeFrame(p, t.dirPhal, t.yHint));
  }

  // ---- プリミティブ ---------------------------------------------------------

  _prim(boneName, a, b, r1, r2, group, tag = '') {
    const bone = this.boneByName[boneName];
    const inv = this.restWorld[bone].clone().invert();
    const p = {
      bone,
      tag,
      group,
      ax: a.x,
      ay: a.y,
      az: a.z,
      bx: b.x,
      by: b.y,
      bz: b.z,
      r1,
      r2,
      aLocal: a.clone().applyMatrix4(inv),
      bLocal: b.clone().applyMatrix4(inv),
    };
    p.l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2;
    const r = Math.max(r1, r2);
    p.min = V(Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.min(a.z, b.z) - r);
    p.max = V(Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r, Math.max(a.z, b.z) + r);
    this.prims.push(p);
    return p;
  }

  _buildPrimitives() {
    // グループ: 順番に滑らかに結合していく（k: グループ内のブレンド幅, join: 全体との結合幅）
    const G = (name, k, join) => {
      const g = { name, k, join, prims: [] };
      this.groups.push(g);
      return this.groups.length - 1;
    };
    const gPalm = G('palm', 0.011, 0);
    const gFore = G('forearm', 0.014, 0.02);
    const gThenar = G('thenar', 0.001, 0.012);
    const gThumb = G('thumb', 0.005, 0.008);
    const gF = FINGER_DEFS.map((f) => G(f.name, 0.0035, 0.0065));

    // 前腕（断面が楕円になるよう 2 本並べる）
    this._prim('forearm', V(0.011, 0.001, -0.02), V(0.013, 0.002, -0.2), 0.0175, 0.0235, gFore);
    this._prim('forearm', V(-0.011, 0.0, -0.02), V(-0.013, 0.001, -0.2), 0.0165, 0.0225, gFore);
    // 手首・手のひら
    this._prim('hand', V(0.011, 0.0, -0.025), V(0.012, -0.001, 0.022), 0.0165, 0.0168, gPalm);
    this._prim('hand', V(-0.011, 0.0, -0.025), V(-0.012, -0.001, 0.022), 0.016, 0.0162, gPalm);
    this._prim('hand', V(0.001, -0.0045, 0.03), V(0.003, -0.0045, 0.07), 0.0135, 0.0128, gPalm, 'palmpad');
    this._prim('little_meta', V(-0.021, -0.0045, 0.024), V(-0.029, -0.0045, 0.064), 0.0125, 0.0103, gPalm, 'hypothenar');
    for (const f of FINGER_DEFS) {
      this._prim(`${f.name}_meta`, f.base, f.head, f.metaR[0], f.metaR[1], gPalm, 'meta');
    }
    // 母指球
    this._prim('thumb_meta', V(0.011, -0.006, 0.02), V(0.029, -0.011, 0.05), 0.0145, 0.0118, gThenar, 'thenar');
    // 親指
    {
      const t = THUMB_DEF;
      let p = t.cmc.clone();
      const names = ['thumb_meta', 'thumb_prox', 'thumb_dist'];
      for (let s = 0; s < 3; s++) {
        const dir = s === 0 ? t.dirMeta : t.dirPhal;
        const q = p.clone().addScaledVector(dir, t.len[s]);
        this._prim(names[s], p, q, t.rad[s][0], t.rad[s][1], gThumb, s === 2 ? 'distal' : '');
        p = q;
      }
    }
    // 4 本の指
    FINGER_DEFS.forEach((f, fi) => {
      const dir = rotY(V(0, 0, 1), f.spread);
      let p = f.head.clone();
      const names = [`${f.name}_prox`, `${f.name}_mid`, `${f.name}_dist`];
      for (let s = 0; s < 3; s++) {
        const q = p.clone().addScaledVector(dir, f.len[s]);
        this._prim(names[s], p, q, f.rad[s][0], f.rad[s][1], gF[fi], s === 2 ? 'distal' : '');
        p = q;
      }
    });
    this.prims.forEach((p, i) => this.groups[p.group].prims.push(i));
  }

  // 休止姿勢での SDF（メッシュ生成用）。active はプリミティブごとの有効フラグ（カリング用）
  restSDF(x, y, z, active) {
    let total = Infinity;
    for (const g of this.groups) {
      let gv = Infinity;
      for (const pi of g.prims) {
        if (active && !active[pi]) continue;
        const d = sdRoundCone(x, y, z, this.prims[pi]);
        gv = gv === Infinity ? d : smin(gv, d, g.k);
      }
      if (gv === Infinity) continue;
      total = total === Infinity ? gv : smin(total, gv, g.join);
    }
    return total;
  }

  // ---- メッシュ -------------------------------------------------------------

  buildMesh(step = 0.0022) {
    const prims = this.prims;
    const bmin = V(Infinity, Infinity, Infinity);
    const bmax = V(-Infinity, -Infinity, -Infinity);
    for (const p of prims) {
      bmin.min(p.min);
      bmax.max(p.max);
    }
    bmin.subScalar(0.008);
    bmax.addScalar(0.008);

    const surf = buildSurfaceNets(
      (x, y, z, active) => this.restSDF(x, y, z, active),
      prims.map((p) => ({ min: p.min, max: p.max })),
      bmin,
      bmax,
      step,
    );

    const nv = surf.positions.length / 3;
    const skinIndex = new Uint16Array(nv * 4);
    const skinWeight = new Float32Array(nv * 4);
    const colors = new Float32Array(nv * 3);
    const nb = this.bones.length;
    const boneDist = new Float32Array(nb);
    const palmFamily = new Set(['hand', 'thumb_meta', ...FINGER_DEFS.map((f) => `${f.name}_meta`)].map((n) => this.boneByName[n]));
    const allowed = new Uint8Array(nb);
    const tau = 0.0035;

    const skin = new THREE.Color().setRGB(0.86, 0.64, 0.53, THREE.SRGBColorSpace);
    const palm = new THREE.Color().setRGB(0.92, 0.7, 0.62, THREE.SRGBColorSpace);
    const nail = new THREE.Color().setRGB(0.95, 0.79, 0.75, THREE.SRGBColorSpace);
    const nailTip = new THREE.Color().setRGB(0.97, 0.9, 0.86, THREE.SRGBColorSpace);
    const knuckle = new THREE.Color().setRGB(0.84, 0.58, 0.5, THREE.SRGBColorSpace);
    const col = new THREE.Color();
    const tmpV = new THREE.Vector3();
    const invRest = this.restWorld.map((m) => m.clone().invert());

    for (let v = 0; v < nv; v++) {
      const x = surf.positions[v * 3];
      const y = surf.positions[v * 3 + 1];
      const z = surf.positions[v * 3 + 2];
      boneDist.fill(Infinity);
      let best = -1;
      let bestD = Infinity;
      let bestPrim = null;
      for (const p of prims) {
        const d = sdRoundCone(x, y, z, p);
        if (d < boneDist[p.bone]) boneDist[p.bone] = d;
        if (d < bestD) {
          bestD = d;
          best = p.bone;
          bestPrim = p;
        }
      }
      // 混ぜてよい骨: 最寄りの骨・その親・子。手のひらの骨同士は互いに混ぜてよい
      allowed.fill(0);
      allowed[best] = 1;
      const bu = this.bones[best].userData;
      if (bu.parent >= 0) allowed[bu.parent] = 1;
      for (const c of bu.children) allowed[c] = 1;
      if (palmFamily.has(best)) for (const b of palmFamily) allowed[b] = 1;
      const cand = [];
      for (let b = 0; b < nb; b++) {
        if (!allowed[b]) continue;
        const dd = boneDist[b] - bestD;
        if (dd > 0.012) continue;
        cand.push([b, Math.exp(-dd / tau)]);
      }
      cand.sort((a, b) => b[1] - a[1]);
      let wsum = 0;
      for (let c = 0; c < Math.min(4, cand.length); c++) wsum += cand[c][1];
      for (let c = 0; c < 4; c++) {
        if (c < cand.length) {
          skinIndex[v * 4 + c] = cand[c][0];
          skinWeight[v * 4 + c] = cand[c][1] / wsum;
        }
      }

      // 色: 手のひら側は明るく、爪、関節の甲側は少し赤み
      const ny = surf.normals[v * 3 + 1];
      col.copy(skin);
      {
        // 手のひら・前腕の内側は明るい
        const palmSide = THREE.MathUtils.smoothstep(-ny, 0.1, 0.75);
        col.lerp(palm, palmSide * (0.35 + 0.45 * THREE.MathUtils.smoothstep(z, -0.09, -0.01)));
      }
      if (bestPrim.tag === 'distal') {
        tmpV.set(x, y, z).applyMatrix4(invRest[best]);
        const len = Math.sqrt(bestPrim.l2);
        const r = bestPrim.r2;
        const along = tmpV.z / len;
        const side = Math.abs(tmpV.x) / r;
        const up = tmpV.y / r;
        const nailMask =
          THREE.MathUtils.smoothstep(along, 0.3, 0.42) *
          THREE.MathUtils.smoothstep(up, 0.25, 0.5) *
          (1 - THREE.MathUtils.smoothstep(side, 0.7, 0.85));
        col.lerp(nail, nailMask);
        const tipMask = THREE.MathUtils.smoothstep(along, 0.95, 1.08) * THREE.MathUtils.smoothstep(up, 0.1, 0.4);
        col.lerp(nailTip, tipMask * 0.8);
      } else if (ny > 0.5 && (bestPrim.tag === '' || bestPrim.tag === 'meta')) {
        // 関節付近の甲側
        tmpV.set(x, y, z).applyMatrix4(invRest[best]);
        const len = Math.sqrt(bestPrim.l2);
        const along = tmpV.z / len;
        const nearJoint = Math.max(1 - Math.abs(along) / 0.25, 1 - Math.abs(along - 1) / 0.2, 0);
        col.lerp(knuckle, nearJoint * 0.35 * (ny - 0.5) * 2);
      }
      colors[v * 3] = col.r;
      colors[v * 3 + 1] = col.g;
      colors[v * 3 + 2] = col.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(surf.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(surf.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    geo.setIndex(new THREE.BufferAttribute(surf.indices, 1));
    geo.computeBoundingSphere();

    this.material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.52,
      metalness: 0,
      sheen: 0.6,
      sheenRoughness: 0.55,
      sheenColor: new THREE.Color(0.9, 0.42, 0.32),
      clearcoat: 0,
      clearcoatRoughness: 0.28,
      specularIntensity: 0.55,
    });
    // 皮膚の簡易的な表面下散乱（光の回り込み）
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          float wrapAmt = 0.0;
          #if NUM_DIR_LIGHTS > 0
            for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
              float ndl = dot(normal, directionalLights[i].direction);
              wrapAmt += max(0.0, (ndl + 0.45) / 1.45) * (1.0 - max(ndl, 0.0)) * 0.35;
            }
          #endif
          reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.36, 0.25) * wrapAmt;
        }`,
      );
    };

    const mesh = new THREE.SkinnedMesh(geo, this.material);
    mesh.add(this.bones[0]);
    mesh.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(this.bones);
    mesh.bind(skeleton);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.mesh = mesh;
    this.sleeve = this._buildSleeve();
    this.bones[this.boneByName.forearm].add(this.sleeve);
    this.triangleCount = surf.indices.length / 3;
    return mesh;
  }

  // 前腕の切れ目を隠す、まくり上げた袖（前腕の骨に固定）
  _buildSleeve() {
    const pts = [];
    const z0 = 0.165;
    // 折り返したカフ（丸み）→ 袖本体（奥へ向かって広がる）
    for (let s = 0; s <= 10; s++) {
      const a = -Math.PI / 2 + (s / 10) * Math.PI;
      pts.push(new THREE.Vector2(0.034 + 0.008 + 0.008 * Math.cos(a), z0 + 0.008 + 0.008 * Math.sin(a)));
    }
    pts.push(new THREE.Vector2(0.044, z0 + 0.03));
    pts.push(new THREE.Vector2(0.041, z0 + 0.034));
    for (let s = 1; s <= 24; s++) {
      const t = s / 24;
      pts.push(new THREE.Vector2(0.041 + 0.016 * t * t + 0.003 * Math.sin(t * 19), z0 + 0.034 + t * 1.2));
    }
    const geo = new THREE.LatheGeometry(pts, 48);
    // しわ（周方向と長さ方向の揺らぎ）と楕円断面
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const ang = Math.atan2(z, x);
      const along = y - z0;
      const k =
        1 +
        (along > 0.035 ? 0.05 * Math.sin(ang * 5 + along * 22) * Math.min(1, (along - 0.035) * 12) : 0) +
        0.02 * Math.sin(ang * 9 - along * 35);
      p.setXYZ(i, x * k * 1.12, y, z * k * 0.92);
    }
    geo.rotateX(-Math.PI / 2); // +Y（回転軸）を -Z（肘の方向）へ
    geo.computeVertexNormals();
    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setRGB(0.34, 0.42, 0.55, THREE.SRGBColorSpace),
      roughness: 0.92,
      sheen: 1.0,
      sheenRoughness: 0.8,
      sheenColor: new THREE.Color(0.85, 0.9, 1.0),
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false; // カメラ側へ伸びる袖の影は不自然なので落とさない
    m.receiveShadow = true;
    m.frustumCulled = false;
    return m;
  }

  // ---- 姿勢 ---------------------------------------------------------------

  // angles: { wrist:[flex, dev], fingers:[{abd, mcp, pip, dip, arch}], thumb:{abd, flex, roll, mcp, ip} }
  applyPose(angles) {
    const qa = new THREE.Quaternion();
    const X = V(1, 0, 0);
    const Yax = V(0, 1, 0);
    const Zax = V(0, 0, 1);
    const set = (name, ...rots) => {
      const bone = this.bones[this.boneByName[name]];
      bone.quaternion.copy(bone.userData.restQ);
      for (const [axis, ang] of rots) {
        if (!ang) continue;
        qa.setFromAxisAngle(axis, ang);
        bone.quaternion.multiply(qa);
      }
    };
    set('hand', [X, angles.wrist[0]], [Yax, angles.wrist[1]]);
    FINGER_DEFS.forEach((f, i) => {
      const a = angles.fingers[i];
      // 手のひらのくぼみ: 中手骨を手のひら側へ曲げ、少し中指側へ寄せる
      set(`${f.name}_meta`, [X, a.arch], [Yax, -a.arch * 0.25 * Math.sign(f.spread)]);
      set(`${f.name}_prox`, [Yax, a.abd], [X, a.mcp]);
      set(`${f.name}_mid`, [X, a.pip]);
      set(`${f.name}_dist`, [X, a.dip]);
    });
    const t = angles.thumb;
    set('thumb_meta', [Yax, t.abd], [X, t.flex], [Zax, t.roll]);
    set('thumb_prox', [X, t.mcp]);
    set('thumb_dist', [X, t.ip]);
  }

  // ---- 物理用 -------------------------------------------------------------

  _makeColliderBuffers() {
    const n = this.prims.length;
    return {
      count: n,
      a: new Float32Array(n * 3),
      b: new Float32Array(n * 3),
      prevA: new Float32Array(n * 3),
      prevB: new Float32Array(n * 3),
      va: new Float32Array(n * 3),
      vb: new Float32Array(n * 3),
      r1: Float32Array.from(this.prims.map((p) => p.r1)),
      r2: Float32Array.from(this.prims.map((p) => p.r2)),
      bound: [0, 0, 0, 1],
      fingertip: [],
      initialized: false,
    };
  }

  // ボーンのワールド行列からコライダーを更新（mesh.updateMatrixWorld の後に呼ぶ）
  updateColliders(dt) {
    const C = this.colliders;
    const tmp = new THREE.Vector3();
    C.prevA.set(C.a);
    C.prevB.set(C.b);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    this.prims.forEach((p, i) => {
      const m = this.bones[p.bone].matrixWorld;
      tmp.copy(p.aLocal).applyMatrix4(m);
      C.a[i * 3] = tmp.x;
      C.a[i * 3 + 1] = tmp.y;
      C.a[i * 3 + 2] = tmp.z;
      cx += tmp.x;
      cy += tmp.y;
      cz += tmp.z;
      tmp.copy(p.bLocal).applyMatrix4(m);
      C.b[i * 3] = tmp.x;
      C.b[i * 3 + 1] = tmp.y;
      C.b[i * 3 + 2] = tmp.z;
      cx += tmp.x;
      cy += tmp.y;
      cz += tmp.z;
    });
    if (!C.initialized) {
      C.prevA.set(C.a);
      C.prevB.set(C.b);
      C.initialized = true;
    }
    const inv = dt > 0 ? 1 / dt : 0;
    for (let i = 0; i < C.count * 3; i++) {
      C.va[i] = (C.a[i] - C.prevA[i]) * inv;
      C.vb[i] = (C.b[i] - C.prevB[i]) * inv;
    }
    const n = C.count * 2;
    cx /= n;
    cy /= n;
    cz /= n;
    let R = 0;
    for (let i = 0; i < C.count; i++) {
      const r = Math.max(C.r1[i], C.r2[i]);
      R = Math.max(R, Math.hypot(C.a[i * 3] - cx, C.a[i * 3 + 1] - cy, C.a[i * 3 + 2] - cz) + r);
      R = Math.max(R, Math.hypot(C.b[i * 3] - cx, C.b[i * 3 + 1] - cy, C.b[i * 3 + 2] - cz) + r);
    }
    // 前腕は大きいので、手の部分だけの境界球も別に持つ
    C.bound[0] = cx;
    C.bound[1] = cy;
    C.bound[2] = cz;
    C.bound[3] = R;
  }

  // ワールド座標での手の SDF（カプセル近似、滑らか結合なし）
  sdfWorld(x, y, z) {
    const C = this.colliders;
    let best = Infinity;
    for (let c = 0; c < C.count; c++) {
      const c3 = c * 3;
      const ax = C.a[c3];
      const ay = C.a[c3 + 1];
      const az = C.a[c3 + 2];
      const ex = C.b[c3] - ax;
      const ey = C.b[c3 + 1] - ay;
      const ez = C.b[c3 + 2] - az;
      const px = x - ax;
      const py = y - ay;
      const pz = z - az;
      const l2 = ex * ex + ey * ey + ez * ez;
      let u = l2 > 0 ? (px * ex + py * ey + pz * ez) / l2 : 0;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
      const d = Math.hypot(px - ex * u, py - ey * u, pz - ez * u) - (C.r1[c] + (C.r2[c] - C.r1[c]) * u);
      if (d < best) best = d;
    }
    return best;
  }

  // 指先（末節の先端）のワールド座標とその半径
  fingertips(out) {
    out.length = 0;
    const C = this.colliders;
    this.prims.forEach((p, i) => {
      if (p.tag !== 'distal') return;
      out.push({ x: C.b[i * 3], y: C.b[i * 3 + 1], z: C.b[i * 3 + 2], r: p.r2, i });
    });
    return out;
  }

  // すくった水を生成する候補点（手の骨の局所座標、手のひら側）
  _buildLattice() {
    const s = 0.008;
    const pts = [];
    for (let x = -0.044; x <= 0.05; x += s) {
      for (let z = -0.004; z <= 0.168; z += s) {
        for (let y = -0.066; y <= -0.006; y += s) {
          pts.push(x, y, z);
        }
      }
    }
    return Float32Array.from(pts);
  }

  palmCenterLocal() {
    return V(0.0, -0.016, 0.058);
  }
}

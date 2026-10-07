import * as THREE from 'three';
import { TUB, sdTub, sdTubNormal } from '../config.js';

// 湯船に浮かぶゴミ。水面の高さ・傾き・流れに乗って漂い、手に押される。
// 手のひらを上にしたくぼみに囲まれると手に乗り（held）、水面から持ち上げ続けると回収される。

const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

function makeLeaf(rng) {
  const L = 0.044;
  const W = 0.017;
  const s = new THREE.Shape();
  s.moveTo(0, -L / 2);
  s.quadraticCurveTo(W, -L * 0.15, 0, L / 2);
  s.quadraticCurveTo(-W, -L * 0.15, 0, -L / 2);
  const geo = new THREE.ShapeGeometry(s, 10);
  // 少し反らせる（xy 平面 → 水平に寝かせる）
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    p.setXYZ(i, x, y, 90 * x * x + 6 * y * y);
  }
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  const autumn = rng() < 0.45;
  const color = autumn ? srgb(0.82, 0.48, 0.16) : srgb(0.33, 0.55, 0.2);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55, side: THREE.DoubleSide })));
  const rib = new THREE.Mesh(
    new THREE.BoxGeometry(0.0012, 0.0012, L * 1.05),
    new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.6), roughness: 0.6 }),
  );
  rib.position.y = 0.0008;
  g.add(rib);
  return g;
}

function makeHair(rng) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: srgb(0.1, 0.07, 0.05), roughness: 0.35 });
  const strands = 6;
  for (let s = 0; s < strands; s++) {
    const pts = [];
    const loops = 1.5 + rng() * 1.5;
    const r = 0.008 + rng() * 0.01;
    const ph = rng() * Math.PI * 2;
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      const a = ph + t * loops * Math.PI * 2;
      const rr = r * (0.6 + 0.5 * Math.sin(t * 7 + s));
      pts.push(new THREE.Vector3(Math.cos(a) * rr + (rng() - 0.5) * 0.004, (rng() - 0.5) * 0.002, Math.sin(a) * rr * 0.8 + (rng() - 0.5) * 0.004));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 80, 0.00065, 4, false), mat));
  }
  return g;
}

function makeLint(rng) {
  const geo = new THREE.IcosahedronGeometry(0.0095, 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    v.multiplyScalar(0.75 + rng() * 0.5);
    v.y *= 0.55;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  // 水色の湯に埋もれないよう、少し濃いめの灰色・藍色
  const tint = 0.3 + rng() * 0.15;
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: srgb(tint, tint + 0.04, tint + 0.16), roughness: 1, flatShading: true }),
  );
}

function makeChip(rng) {
  const geo = new THREE.BoxGeometry(0.032, 0.005, 0.014, 4, 1, 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * (1 + (rng() - 0.5) * 0.25), p.getY(i), p.getZ(i) * (1 + (rng() - 0.5) * 0.4));
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: srgb(0.74, 0.55, 0.33), roughness: 0.8 }));
}

// draft: 水面からの沈み具合、drag: 流れへの追従しやすさ
// slip: 手のひらの水の上での滑りやすさ、gap: 指のすき間から抜ける確率（1 回ぶつかるごと）
export const DEBRIS_TYPES = {
  leaf: { label: '葉っぱ', points: 10, radius: 0.02, draft: 0.001, drag: 4.0, slip: 1.25, gap: 0.0, make: makeLeaf },
  hair: { label: '髪の毛', points: 30, radius: 0.017, draft: 0.006, drag: 5.0, slip: 0.9, gap: 0.35, make: makeHair },
  lint: { label: '糸くず', points: 20, radius: 0.012, draft: 0.003, drag: 4.5, slip: 0.8, gap: 0.2, make: makeLint },
  chip: { label: '木くず', points: 15, radius: 0.016, draft: 0.0015, drag: 3.0, slip: 1.1, gap: 0.0, make: makeChip },
};

// 見やすさのため見た目だけ少し大きく
const ITEM_SCALE = 1.2;
const HELD_RELEASE_PALM = 0.2; // 手のひらがこれより下を向くとこぼれる
const COLLECT_HEIGHT = 0.05; // 水面からこの高さ以上に…
export const COLLECT_TIME = 0.9; // …この時間持ち上げ続けると回収
// 手のひらのくぼみ（手の骨の局所座標）。中心と、縁までの半径（x: 親指⇔小指, z: 手首⇔指先）
const CUP_CENTER = new THREE.Vector3(0.002, -0.03, 0.062);
const CUP_RX = 0.027;
const CUP_RZ = 0.036;
const DRAIN_TIME = 1.3; // すくった水が指の間から抜けきるまでの時間
const DRAIN_SPEED = 0.3; // 抜けていく水の流れの速さ [m/s]
const SURGE_MIN = 0.1; // 「ザッ」と寄せる流れの強さ [m/s]
const SURGE_RANGE = 0.25;
const BOWL = 30; // くぼみが中心へ戻そうとする強さ [1/s²]

export class DebrisField {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.group = new THREE.Group();
    this.items = [];
    this._prevHandVel = new THREE.Vector3();
    this._handAcc = new THREE.Vector3();
    this._qInv = new THREE.Quaternion();
    this._g = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._palm = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  clear() {
    for (const it of this.items) {
      this.group.remove(it.obj);
      it.obj.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          o.material.dispose();
        }
      });
    }
    this.items.length = 0;
  }

  // 浴槽の中にばらまく。avoid: [{x, z, r}] の近くは避ける
  spawn(count, rng = Math.random, avoid = []) {
    const kinds = Object.keys(DEBRIS_TYPES);
    let tries = 0;
    while (this.items.length < count && tries++ < 2000) {
      const x = (rng() * 2 - 1) * (TUB.halfX - 0.1);
      const z = (rng() * 2 - 1) * (TUB.halfZ - 0.08);
      if (sdTub(x, z) > -0.09) continue;
      if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
      if (this.items.some((it) => Math.hypot(it.x - x, it.z - z) < 0.09)) continue;
      const kind = kinds[this.items.length % kinds.length];
      const def = DEBRIS_TYPES[kind];
      const obj = def.make(rng);
      obj.scale.setScalar(ITEM_SCALE);
      obj.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      this.group.add(obj);
      this.items.push({
        kind,
        def,
        obj,
        x,
        y: TUB.floorY + 0.27,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        yaw: rng() * Math.PI * 2,
        yawRate: 0,
        tilt: new THREE.Quaternion(),
        state: 'float',
        local: new THREE.Vector3(),
        cup: { x: 0, z: 0, vx: 0, vz: 0, t: 0, drainX: 0, drainZ: 0, surge: 0 },
        liftTime: 0,
        looseTime: 0,
        anim: 0,
      });
    }
  }

  remaining() {
    return this.items.filter((it) => it.state !== 'collected' && it.state !== 'gone').length;
  }

  heldCount() {
    return this.items.filter((it) => it.state === 'held').length;
  }

  // events に { type: 'held' | 'slip' | 'drop' | 'land' | 'collect', item } を積む
  update(dt, { water, hand, controller, coupling }, events = []) {
    const handBone = hand ? hand.bones[hand.boneByName.hand] : null;
    let palmUp = -1;
    let palmPos = null;
    if (handBone) {
      controller.palmNormal(this._palm);
      palmUp = this._palm.y;
      palmPos = controller.pos;
      this._handAcc.copy(controller.vel).sub(this._prevHandVel).divideScalar(Math.max(dt, 1e-4));
      this._prevHandVel.copy(controller.vel);
      handBone.getWorldQuaternion(this._qInv).invert();
    }

    for (const it of this.items) {
      if (it.state === 'gone') continue;
      if (it.state === 'collected') {
        // 回収アニメーション: ふわっと上がって縮む
        it.anim += dt;
        const s = Math.max(0, 1 - it.anim / 0.45);
        it.y += dt * 0.35;
        it.obj.scale.setScalar(s * ITEM_SCALE);
        it.obj.position.set(it.x, it.y, it.z);
        if (s <= 0) {
          it.state = 'gone';
          it.obj.visible = false;
        }
        continue;
      }

      if (it.state === 'held') {
        const slipped = this._cupDynamics(it, dt);
        this._v.set(CUP_CENTER.x + it.cup.x, CUP_CENTER.y - it.def.draft, CUP_CENTER.z + it.cup.z);
        it.local.lerp(this._v, 1 - Math.exp(-12 * dt));
        this._m.copy(handBone.matrixWorld);
        this._v.copy(it.local).applyMatrix4(this._m);
        it.vx = (this._v.x - it.x) / Math.max(dt, 1e-4);
        it.vy = (this._v.y - it.y) / Math.max(dt, 1e-4);
        it.vz = (this._v.z - it.z) / Math.max(dt, 1e-4);
        it.x = this._v.x;
        it.y = this._v.y;
        it.z = this._v.z;
        // 傾けたり、手のひらを返したりしてもこぼれる
        const ok = palmUp > HELD_RELEASE_PALM && (it.cup.t < 0.15 || coupling.contained(it.x, it.y - 0.006, it.z));
        it.looseTime = ok ? 0 : it.looseTime + dt;
        if (slipped || it.looseTime > 0.25) {
          it.state = 'fall';
          if (slipped) {
            // 縁から外へ滑り出る勢い（手の局所 → ワールド）
            this._v.set(it.cup.vx, 0, it.cup.vz).applyQuaternion(this._qInv.clone().invert());
            it.vx += this._v.x;
            it.vy += 0.15;
            it.vz += this._v.z;
          }
          // 水が残っているうちに抜けたら「スルッ」、傾けたり返したりしたら「こぼれた」
          const isSlip = slipped || (palmUp > HELD_RELEASE_PALM + 0.15 && it.cup.t < DRAIN_TIME * 1.5);
          events.push({ type: isSlip ? 'slip' : 'drop', item: it });
        } else {
          const eta = water.heightAt(it.x, it.z);
          if (it.y > eta + COLLECT_HEIGHT && sdTub(it.x, it.z) < 0.2) it.liftTime += dt;
          else it.liftTime = 0;
          if (it.liftTime > COLLECT_TIME) {
            it.state = 'collected';
            it.anim = 0;
            events.push({ type: 'collect', item: it });
          }
        }
        this._apply(it, dt, null);
        continue;
      }

      const eta = water.heightAt(it.x, it.z);
      if (it.state === 'fall') {
        it.vy -= 9.81 * dt;
        it.x += it.vx * dt;
        it.y += it.vy * dt;
        it.z += it.vz * dt;
        if (it.y <= eta - it.def.draft) {
          it.state = 'float';
          events.push({ type: 'land', item: it, speed: -it.vy });
          water.addWaveVolume(it.x, it.z, -2e-6 * Math.min(3, -it.vy), 1.2);
          water.addFoam(it.x, it.z, 0.15, 1.0);
          it.vy = 0;
        }
      } else {
        // 浮かぶ: 浮力（ばね）+ 流れ + 波の斜面
        const target = eta - it.def.draft;
        it.vy += (160 * (target - it.y) - 14 * it.vy) * dt;
        it.y += it.vy * dt;
        const v = water.velocityAt(it.x, it.z, [0, 0]);
        const grad = water.gradientAt(it.x, it.z, [0, 0]);
        const kd = it.def.drag;
        it.vx += ((v[0] - it.vx) * kd - grad[0] * 9.81 * 0.8) * dt;
        it.vz += ((v[1] - it.vz) * kd - grad[1] * 9.81 * 0.8) * dt;
        it.x += it.vx * dt;
        it.z += it.vz * dt;
        it.yawRate += (water.vorticityAt(it.x, it.z) * 0.5 - it.yawRate) * 2 * dt;
        it.yaw += it.yawRate * dt;
      }

      // 手が水中で動くと押しのけられた水がゴミを先へ押しやる（近づくほど逃げる）。
      // 手を勢いよく持ち上げると、くぼみから外へ向かう流れでも流される
      if (hand && it.state === 'float' && coupling.submergedFraction > 0.05) this._handWash(it, controller, dt);

      // 手に押される。ただし手のひらを上にして真上から沈めるときは、くぼみの上にあるものは
      // 水と一緒に手の周りを回り込み、その場に残る（すくう動作が素直に決まるように）
      const overCup =
        palmPos && palmUp > 0.35 && controller.vel.y < -0.02 && Math.hypot(it.x - palmPos.x, it.z - palmPos.z) < 0.05;
      if (hand && !overCup) this._pushByHand(it, hand);

      // 壁・他のゴミ
      const sd = sdTub(it.x, it.z);
      const lim = -it.def.radius;
      if (sd > lim) {
        const n = sdTubNormal(it.x, it.z, [0, 0]);
        it.x -= n[0] * (sd - lim);
        it.z -= n[1] * (sd - lim);
        const vn = it.vx * n[0] + it.vz * n[1];
        if (vn > 0) {
          it.vx -= 1.3 * vn * n[0];
          it.vz -= 1.3 * vn * n[1];
        }
      }
      for (const o of this.items) {
        if (o === it || o.state !== 'float' || it.state !== 'float') continue;
        const dx = it.x - o.x;
        const dz = it.z - o.z;
        const R = (it.def.radius + o.def.radius) * 0.8;
        const d2 = dx * dx + dz * dz;
        if (d2 < R * R && d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const k = ((R - d) / d) * 0.5;
          it.x += dx * k;
          it.z += dz * k;
        }
      }
      if (it.y < TUB.floorY) it.y = TUB.floorY;

      // 手のひらのくぼみに囲まれて水面から持ち上がったら手に乗る
      // （沈めている途中に巻き込まないよう、手が下がっていないときだけ）
      if (
        it.state !== 'fall' &&
        palmPos &&
        palmUp > 0.35 &&
        controller.vel.y > -0.02 &&
        it.y > eta - it.def.draft - 0.006 &&
        Math.hypot(it.x - palmPos.x, it.z - palmPos.z) < 0.13 &&
        it.y > palmPos.y - 0.03 &&
        coupling.contained(it.x, it.y - 0.002, it.z)
      ) {
        this._m.copy(handBone.matrixWorld).invert();
        it.local.set(it.x, it.y, it.z).applyMatrix4(this._m);
        this._startCup(it);
        it.state = 'held';
        it.liftTime = 0;
        it.looseTime = 0;
        events.push({ type: 'held', item: it });
      }

      this._apply(it, dt, it.state === 'float' ? water : null);
    }
    return events;
  }

  _startCup(it) {
    const c = it.cup;
    const rng = this.rng;
    c.x = THREE.MathUtils.clamp(it.local.x - CUP_CENTER.x, -CUP_RX * 0.9, CUP_RX * 0.9);
    c.z = THREE.MathUtils.clamp(it.local.z - CUP_CENTER.z, -CUP_RZ * 0.9, CUP_RZ * 0.9);
    c.vx = 0;
    c.vz = 0;
    c.t = 0;
    // 水が抜けていく向き: 低い手首側か、親指と人差し指のすき間が多い
    const r = rng();
    const ang = r < 0.5 ? -Math.PI / 2 + (rng() - 0.5) * 1.2 : r < 0.8 ? 0.35 + (rng() - 0.5) * 0.6 : Math.PI - 0.3 + (rng() - 0.5) * 0.6;
    c.drainX = Math.cos(ang);
    c.drainZ = Math.sin(ang);
    c.surge = 0.25 + rng() * 0.6; // 最初の波が来るまで
  }

  // 手のひらにたまった水の上でゴミが滑る。縁を越えたら true（スルッと抜けた）
  _cupDynamics(it, dt) {
    const c = it.cup;
    const rng = this.rng;
    c.t += dt;
    const wet = Math.exp(-c.t / (DRAIN_TIME * 0.45)); // 手のひらの水の量（1 → 0）
    const slip = it.def.slip;
    // 手の局所座標での重力と慣性（手が加速すると中身は逆へ取り残される）
    this._g.set(0, -9.81, 0).sub(this._handAcc).applyQuaternion(this._qInv);
    let ax = this._g.x * 0.55 * slip;
    let az = this._g.z * 0.55 * slip;
    // くぼみの形が中心へ戻そうとする
    ax -= BOWL * c.x;
    az -= BOWL * c.z;
    // 指のすき間や手首側から水が抜けていく流れ
    const drain = DRAIN_SPEED * wet * slip;
    ax += (c.drainX * drain - c.vx) * 6 * wet;
    az += (c.drainZ * drain - c.vz) * 6 * wet;
    // 水が抜けるあいだ、ときどき「ザッ」と流れが寄せる
    c.surge -= dt;
    if (c.surge <= 0 && c.t < DRAIN_TIME) {
      const ang = Math.atan2(c.drainZ, c.drainX) + (rng() - 0.5) * 1.8;
      const mag = (SURGE_MIN + rng() * SURGE_RANGE) * slip * (0.4 + 0.6 * wet);
      c.vx += Math.cos(ang) * mag;
      c.vz += Math.sin(ang) * mag;
      c.surge = 0.18 + rng() * 0.45;
    }
    // 水が少なくなるほど肌に張りついて止まる
    const damp = 2.5 + 22 * (1 - wet);
    c.vx += (ax - damp * c.vx) * dt;
    c.vz += (az - damp * c.vz) * dt;
    c.x += c.vx * dt;
    c.z += c.vz * dt;

    // 縁
    const e = (c.x / CUP_RX) ** 2 + (c.z / CUP_RZ) ** 2;
    if (e <= 1) return false;
    const k = 1 / Math.sqrt(e);
    const nx = c.x / CUP_RX ** 2;
    const nz = c.z / CUP_RZ ** 2;
    const nl = Math.hypot(nx, nz) || 1;
    const vn = (c.vx * nx + c.vz * nz) / nl;
    const frontness = c.z / CUP_RZ; // 指先側ほど縁（指）が高い
    if (frontness < -0.35) return true; // 手首側は低いので越えてしまう
    if (frontness > 0.4) {
      // 指の壁に当たる。細いものは指のすき間から抜ける
      if (vn > 0.05 && rng() < it.def.gap) return true;
    } else if (vn > 0.22 * (1 - wet * 0.5)) return true; // 親指・小指側は勢いがあれば越える
    c.x *= k;
    c.z *= k;
    if (vn > 0) {
      c.vx -= (1.5 * vn * nx) / nl;
      c.vz -= (1.5 * vn * nz) / nl;
    }
    return false;
  }

  _handWash(it, controller, dt) {
    const p = controller.pos;
    const dx = it.x - p.x;
    const dz = it.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.16 || d < 1e-5) return;
    const v = controller.vel;
    const fall = Math.exp(-Math.max(0, d - 0.03) / 0.045);
    // 手の進む向きにあるものを押す
    const toward = (v.x * dx + v.z * dz) / d;
    if (toward > 0) {
      const k = 0.55 * toward * fall * dt * 8;
      it.vx += (dx / d) * k;
      it.vz += (dz / d) * k;
    }
    // 持ち上げるときの外向きの流れ（中心ほど弱い）
    if (v.y > 0.05) {
      const k = 0.9 * v.y * fall * Math.min(1, d / 0.035) * dt * 8;
      it.vx += (dx / d) * k;
      it.vz += (dz / d) * k;
    }
  }

  _pushByHand(it, hand) {
    const C = hand.colliders;
    const r = it.def.radius * 0.5;
    for (let c = 0; c < C.count; c++) {
      const c3 = c * 3;
      const ax = C.a[c3];
      const ay = C.a[c3 + 1];
      const az = C.a[c3 + 2];
      const ex = C.b[c3] - ax;
      const ey = C.b[c3 + 1] - ay;
      const ez = C.b[c3 + 2] - az;
      const px = it.x - ax;
      const py = it.y - ay;
      const pz = it.z - az;
      const l2 = ex * ex + ey * ey + ez * ez;
      let u = l2 > 0 ? (px * ex + py * ey + pz * ez) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = px - ex * u;
      const dy = py - ey * u;
      const dz = pz - ez * u;
      const R = C.r1[c] + (C.r2[c] - C.r1[c]) * u + r;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= R * R || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const hvx = C.va[c3] + (C.vb[c3] - C.va[c3]) * u;
      const hvy = C.va[c3 + 1] + (C.vb[c3 + 1] - C.va[c3 + 1]) * u;
      const hvz = C.va[c3 + 2] + (C.vb[c3 + 2] - C.va[c3 + 2]) * u;
      if (hvy < -0.05 && dy > -r) {
        // 上から手が下りてくると、浮いているものは横へ逃げるより水中へ押し込まれる（後で浮き上がる）
        it.y -= R - d;
        it.vy = Math.min(it.vy, hvy);
        continue;
      }
      const k = ((R - d) / d) * 0.7;
      it.x += dx * k;
      it.y += dy * k;
      it.z += dz * k;
      it.vx += (hvx - it.vx) * 0.15;
      it.vz += (hvz - it.vz) * 0.15;
      if (dy * k > 0) it.vy = Math.max(it.vy, 0);
    }
  }

  _apply(it, dt, water) {
    const o = it.obj;
    o.position.set(it.x, it.y, it.z);
    if (water) {
      const grad = water.gradientAt(it.x, it.z, [0, 0]);
      this._v.set(-grad[0], 1, -grad[1]).normalize();
      this._q.setFromUnitVectors(this._up, this._v);
      it.tilt.slerp(this._q, 1 - Math.exp(-8 * dt));
    }
    this._q.setFromAxisAngle(this._up, it.yaw);
    o.quaternion.copy(it.tilt).multiply(this._q);
  }
}

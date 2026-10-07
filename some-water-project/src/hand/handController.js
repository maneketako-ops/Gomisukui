import * as THREE from 'three';
import { TUB, sdTub, sdTubNormal } from '../config.js';

// 手の姿勢（関節角）と位置・向きの制御。
// pitch: 前腕が上から下りてくる角度、roll: 前腕まわりの回転（π で手のひらが上）、wrist: 手首の屈曲
// control: 位置合わせの基準点（手の骨の局所座標）、dive: 沈めたときの水面からの深さ

const SPREAD = [0.16, 0.035, -0.11, -0.25];

const fingersFrom = (fn) => SPREAD.map((s, i) => fn(s, i));

export const POSES = {
  scoop: {
    label: 'すくう',
    pitch: 0.5,
    roll: Math.PI,
    wrist: [0.46, 0.0],
    fingers: fingersFrom((s, i) => ({
      abd: -s - 0.012 * (i - 1.5),
      mcp: [0.42, 0.44, 0.5, 0.56][i],
      pip: [0.5, 0.52, 0.54, 0.56][i],
      dip: [0.26, 0.28, 0.28, 0.3][i],
      arch: [0.06, 0.0, 0.18, 0.34][i],
    })),
    thumb: { abd: -0.1, flex: 0.3, roll: 0.0, mcp: 0.15, ip: 0.15 },
    control: [0.0, -0.02, 0.06],
    dive: 0.065,
    hover: 0.13,
  },
  stir: {
    label: 'かき混ぜる',
    pitch: 0.85,
    roll: Math.PI * 0.5,
    wrist: [0.0, 0.0],
    fingers: fingersFrom((s, i) => ({
      abd: -s * 0.4,
      mcp: 0.12 + i * 0.03,
      pip: 0.2 + i * 0.03,
      dip: 0.1,
      arch: [0.02, 0, 0.05, 0.1][i],
    })),
    thumb: { abd: -0.15, flex: 0.12, roll: 0, mcp: 0.15, ip: 0.1 },
    control: [0.0, 0.0, 0.11],
    dive: 0.075,
    hover: 0.1,
  },
  open: {
    label: 'パー',
    pitch: 0.32,
    roll: 0.0,
    wrist: [-0.22, 0.0],
    fingers: fingersFrom((s) => ({ abd: s * 0.35, mcp: -0.05, pip: 0.05, dip: 0.03, arch: 0 })),
    thumb: { abd: 0.12, flex: -0.05, roll: 0, mcp: 0.0, ip: 0.0 },
    control: [0.0, -0.012, 0.06],
    dive: 0.02,
    hover: 0.12,
  },
  fist: {
    label: 'グー',
    pitch: 0.55,
    roll: 0.25,
    wrist: [0.05, 0.0],
    fingers: fingersFrom((s, i) => ({
      abd: -s * 0.9,
      mcp: 1.45,
      pip: 1.75,
      dip: 0.95,
      arch: [0.02, 0, 0.08, 0.16][i],
    })),
    thumb: { abd: 0.6, flex: 0.4, roll: -0.6, mcp: 0.6, ip: 0.9 },
    control: [0.0, -0.01, 0.08],
    dive: 0.08,
    hover: 0.12,
  },
};

function clonePose(p) {
  return JSON.parse(JSON.stringify(p));
}

function lerpPose(cur, tgt, a) {
  const l = (x, y) => x + (y - x) * a;
  cur.pitch = l(cur.pitch, tgt.pitch);
  cur.roll = l(cur.roll, tgt.roll);
  cur.wrist[0] = l(cur.wrist[0], tgt.wrist[0]);
  cur.wrist[1] = l(cur.wrist[1], tgt.wrist[1]);
  for (let i = 0; i < 4; i++) {
    for (const k of ['abd', 'mcp', 'pip', 'dip', 'arch']) cur.fingers[i][k] = l(cur.fingers[i][k], tgt.fingers[i][k]);
  }
  for (const k of ['abd', 'flex', 'roll', 'mcp', 'ip']) cur.thumb[k] = l(cur.thumb[k], tgt.thumb[k]);
  for (let i = 0; i < 3; i++) cur.control[i] = l(cur.control[i], tgt.control[i]);
  cur.dive = l(cur.dive, tgt.dive);
  cur.hover = l(cur.hover, tgt.hover);
}

export class HandController {
  constructor(hand, water) {
    this.hand = hand;
    this.water = water;
    this.poseName = 'scoop';
    this.cur = clonePose(POSES.scoop);
    this.pos = new THREE.Vector3(0.05, water.level + 0.13, 0.02);
    this.vel = new THREE.Vector3();
    this.target = this.pos.clone();
    this.diving = false;
    this.yaw = 0;
    this.yawInput = 0;
    this.pouring = false;
    this.pour = 0;
    this.heightOffset = 0;
    this.heightInput = 0;
    this.quat = new THREE.Quaternion();
    this.targetQuat = new THREE.Quaternion();
    this._initialized = false;
    // 前腕は常にこの点（体・肩のあたり）の方から伸びてくる
    this.shoulder = new THREE.Vector3(0.3, 0.8, 0.9);
    this.armYaw = 0;
  }

  // カメラ位置から肩のおおよその位置を決める（右下手前）
  setShoulderFromCamera(camera) {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    this.shoulder.copy(camera.position).addScaledVector(right, 0.28);
    this.shoulder.y -= 0.35;
  }

  setPose(name) {
    if (POSES[name]) this.poseName = name;
  }

  setTargetXZ(x, z) {
    this.target.x = x;
    this.target.z = z;
  }

  _orientation(out, roll) {
    const c = this.cur;
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + this.armYaw + this.yaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), c.pitch);
    const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);
    return out.copy(qYaw).multiply(qPitch).multiply(qRoll);
  }

  update(dt) {
    const tgt = POSES[this.poseName];
    lerpPose(this.cur, tgt, 1 - Math.exp(-9 * dt));
    this.pour += ((this.pouring ? 1 : 0) - this.pour) * (1 - Math.exp(-4 * dt));
    this.yaw += this.yawInput * 1.6 * dt;
    this.yaw = Math.max(-1.2, Math.min(1.2, this.yaw));
    this.heightOffset = Math.max(-0.05, Math.min(0.2, this.heightOffset + this.heightInput * 0.15 * dt));

    const c = this.cur;
    const level = this.water.level;

    // 目標位置（浴槽の内側に制限）
    const t = this.target;
    const sd = sdTub(t.x, t.z);
    const margin = -0.065;
    if (sd > margin) {
      const n = sdTubNormal(t.x, t.z, [0, 0]);
      t.x -= n[0] * (sd - margin);
      t.z -= n[1] * (sd - margin);
    }
    t.y = this.diving ? level - c.dive : level + c.hover + this.heightOffset;
    t.y = Math.max(TUB.floorY + 0.05, t.y);

    // 臨界減衰ばね
    const spring = (axis, w) => {
      const x = this.pos[axis];
      const v = this.vel[axis];
      const a = w * w * (t[axis] - x) - 2 * w * v;
      this.vel[axis] = v + a * dt;
      this.pos[axis] = x + this.vel[axis] * dt;
    };
    if (!this._initialized) {
      this.pos.copy(t);
      this._initialized = true;
    }
    spring('x', 15);
    spring('z', 15);
    spring('y', 10);

    // 前腕が肩の方から伸びるように水平方向の向きを決める
    const dxs = this.shoulder.x - this.pos.x;
    const dzs = this.shoulder.z - this.pos.z;
    if (dxs * dxs + dzs * dzs > 1e-4) {
      let target = Math.atan2(dxs, dzs);
      let diff = target - this.armYaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.armYaw += diff * (1 - Math.exp(-6 * dt));
    }

    // 向き（移動方向へ少し傾く）
    const roll = c.roll + this.pour * (this.poseName === 'scoop' ? 1.35 : 0.8);
    this._orientation(this.targetQuat, roll);
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (hv > 1e-3) {
      const ang = Math.min(0.28, hv * 0.22);
      const axis = new THREE.Vector3(this.vel.z, 0, -this.vel.x).normalize();
      this.targetQuat.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, -ang));
    }
    if (!this._q0) {
      this.quat.copy(this.targetQuat);
      this._q0 = true;
    }
    this.quat.slerp(this.targetQuat, 1 - Math.exp(-10 * dt));

    // 関節角を適用し、基準点が pos に来るように根元（手首）の位置を決める
    this.hand.applyPose(c);
    const mesh = this.hand.mesh;
    const qWrist = this.hand.bones[this.hand.boneByName.hand].quaternion;
    const ctrl = new THREE.Vector3(...c.control).applyQuaternion(qWrist).applyQuaternion(this.quat);
    mesh.position.copy(this.pos).sub(ctrl);
    mesh.quaternion.copy(this.quat);
    mesh.updateMatrixWorld(true);
    this.hand.updateColliders(dt);
  }

  // 手のひらの向き（ワールド）。y 成分が大きいほど上向き
  palmNormal(out) {
    const m = this.hand.bones[this.hand.boneByName.hand].matrixWorld;
    return out.set(0, -1, 0).transformDirection(m);
  }
}

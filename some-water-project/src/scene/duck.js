import * as THREE from 'three';
import { TUB, sdTub, sdTubNormal } from '../config.js';

// 浮かぶアヒル。浮力・波の傾き・流れ・手との接触で動く。
export class Duck {
  constructor() {
    const g = new THREE.Group();
    const yellow = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setRGB(1.0, 0.8, 0.12, THREE.SRGBColorSpace),
      roughness: 0.32,
      clearcoat: 0.8,
      clearcoatRoughness: 0.15,
    });
    const orange = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setRGB(1.0, 0.42, 0.08, THREE.SRGBColorSpace),
      roughness: 0.35,
      clearcoat: 0.6,
    });
    const black = new THREE.MeshPhysicalMaterial({ color: 0x111111, roughness: 0.1, clearcoat: 1 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.045, 40, 28), yellow);
    body.scale.set(1.25, 0.78, 0.95);
    body.position.y = 0.012;
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.02, 20, 14), yellow);
    tail.position.set(-0.05, 0.03, 0);
    tail.scale.set(1.2, 0.8, 0.9);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.029, 32, 24), yellow);
    head.position.set(0.032, 0.062, 0);
    const beak = new THREE.Mesh(new THREE.SphereGeometry(0.014, 20, 12), orange);
    beak.scale.set(1.5, 0.45, 1.0);
    beak.position.set(0.06, 0.056, 0);
    const eyeGeo = new THREE.SphereGeometry(0.0042, 12, 8);
    const eyeL = new THREE.Mesh(eyeGeo, black);
    eyeL.position.set(0.05, 0.072, 0.017);
    const eyeR = eyeL.clone();
    eyeR.position.z = -0.017;
    g.add(body, tail, head, beak, eyeL, eyeR);
    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.object = g;
    this.radius = 0.055;
    this.reset();
  }

  reset() {
    this.x = 0.42;
    this.z = -0.12;
    this.y = 0.27;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.yaw = 2.4;
    this.yawRate = 0;
    this.tilt = new THREE.Quaternion();
  }

  update(dt, water, hand) {
    const eta = water.heightAt(this.x, this.z);
    const draft = 0.012;
    // 鉛直: 浮力（ばね + 減衰）
    const target = eta - draft;
    this.vy += (90 * (target - this.y) - 9 * this.vy) * dt;
    this.y += this.vy * dt;

    // 水平: 流れに引きずられ、波の斜面を滑る
    const v = water.velocityAt(this.x, this.z, [0, 0]);
    const grad = water.gradientAt(this.x, this.z, [0, 0]);
    const kd = 2.2;
    this.vx += ((v[0] - this.vx) * kd - grad[0] * 9.81 * 0.7) * dt;
    this.vz += ((v[1] - this.vz) * kd - grad[1] * 9.81 * 0.7) * dt;
    this.yawRate += (water.vorticityAt(this.x, this.z) * 0.5 - this.yawRate) * 1.5 * dt;
    this.yaw += this.yawRate * dt;

    // 手に押される
    if (hand) {
      const C = hand.colliders;
      for (let c = 0; c < C.count; c++) {
        const c3 = c * 3;
        const ax = C.a[c3];
        const ay = C.a[c3 + 1];
        const az = C.a[c3 + 2];
        const ex = C.b[c3] - ax;
        const ey = C.b[c3 + 1] - ay;
        const ez = C.b[c3 + 2] - az;
        const cy = this.y + 0.03;
        const px = this.x - ax;
        const py = cy - ay;
        const pz = this.z - az;
        const l2 = ex * ex + ey * ey + ez * ez;
        let u = l2 > 0 ? (px * ex + py * ey + pz * ez) / l2 : 0;
        u = Math.max(0, Math.min(1, u));
        const dx = px - ex * u;
        const dy = py - ey * u;
        const dz = pz - ez * u;
        const r = C.r1[c] + (C.r2[c] - C.r1[c]) * u;
        const R = r + this.radius;
        const d = Math.hypot(dx, dy * 1.6, dz);
        if (d < R && d > 1e-6) {
          const push = (R - d) / d;
          this.x += dx * push * 0.9;
          this.z += dz * push * 0.9;
          const hvx = C.va[c3] + (C.vb[c3] - C.va[c3]) * u;
          const hvz = C.va[c3 + 2] + (C.vb[c3 + 2] - C.va[c3 + 2]) * u;
          this.vx += (hvx - this.vx) * 0.25;
          this.vz += (hvz - this.vz) * 0.25;
          // 上から押されると沈む
          if (dy > 0 && Math.abs(dy) > Math.hypot(dx, dz)) this.y -= (R - d) * 0.5;
        }
      }
    }

    this.x += this.vx * dt;
    this.z += this.vz * dt;
    // 壁
    const sd = sdTub(this.x, this.z);
    const lim = -this.radius * 0.95;
    if (sd > lim) {
      const n = sdTubNormal(this.x, this.z, [0, 0]);
      this.x -= n[0] * (sd - lim);
      this.z -= n[1] * (sd - lim);
      const vn = this.vx * n[0] + this.vz * n[1];
      if (vn > 0) {
        this.vx -= 1.4 * vn * n[0];
        this.vz -= 1.4 * vn * n[1];
      }
    }
    this.y = Math.max(TUB.floorY, this.y);

    // 水面の法線に合わせて傾く
    const nrm = new THREE.Vector3(-grad[0], 1, -grad[1]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm);
    this.tilt.slerp(q, 1 - Math.exp(-6 * dt));
    const o = this.object;
    o.position.set(this.x, this.y, this.z);
    o.quaternion.copy(this.tilt).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw));
  }

  collider() {
    return { x: this.x, y: this.y + 0.025, z: this.z, r: 0.045 };
  }
}

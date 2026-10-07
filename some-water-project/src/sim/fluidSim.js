import { FLUID, ROOM, TUB, sdTub, sdTubNormal } from '../config.js';

// Position Based Fluids（Macklin & Müller 2013）による粒子の水。
// 手ですくった水、指の間からこぼれる水、しずく、蛇口の水流を担当する。
// 浴槽の水面より下に入った粒子は水面シミュレーションへ体積・運動量ごと吸収される。

const TABLE_BITS = 14;
const TABLE_SIZE = 1 << TABLE_BITS;
const MAX_NEIGHBORS = 48;

export class FluidSim {
  constructor(maxParticles = FLUID.maxParticles) {
    this.max = maxParticles;
    this.spacing = FLUID.spacing;
    this.h = this.spacing * 2.0; // カーネル半径
    this.radius = this.spacing * 0.5; // 衝突半径
    this.particleVolume = this.spacing ** 3;
    this.count = 0;

    const M = maxParticles;
    this.pos = new Float32Array(M * 3);
    this.prev = new Float32Array(M * 3);
    this.vel = new Float32Array(M * 3);
    this.lambda = new Float32Array(M);
    this.density = new Float32Array(M);
    this.age = new Float32Array(M);
    this.floorTime = new Float32Array(M);
    this.delta = new Float32Array(M * 3);
    this.nbr = new Int32Array(M * MAX_NEIGHBORS);
    this.nbrCount = new Int32Array(M);
    this.cellStart = new Int32Array(TABLE_SIZE + 1);
    this.sorted = new Int32Array(M);
    this.hashOf = new Int32Array(M);
    this.cellX = new Int32Array(M);
    this.cellY = new Int32Array(M);
    this.cellZ = new Int32Array(M);

    const h = this.h;
    this.poly6 = 315 / (64 * Math.PI * h ** 9);
    this.spikyGrad = -45 / (Math.PI * h ** 6);

    // 静止状態（立方格子）の密度を基準密度にする（質量 = 1）
    let rho = 0;
    let gsum = [0, 0, 0];
    let g2 = 0;
    const s = this.spacing;
    const R = Math.ceil(h / s);
    for (let i = -R; i <= R; i++) {
      for (let j = -R; j <= R; j++) {
        for (let k = -R; k <= R; k++) {
          const r = Math.hypot(i, j, k) * s;
          if (r >= h) continue;
          rho += this.poly6 * (h * h - r * r) ** 3;
          if (r > 0) {
            const gm = this.spikyGrad * (h - r) ** 2;
            const gx = (gm * i * s) / r;
            const gy = (gm * j * s) / r;
            const gz = (gm * k * s) / r;
            g2 += gx * gx + gy * gy + gz * gz;
            gsum[0] += gx;
            gsum[1] += gy;
            gsum[2] += gz;
          }
        }
      }
    }
    this.rho0 = rho;
    const invRho0 = 1 / rho;
    const gradSum = (g2 + gsum[0] ** 2 + gsum[1] ** 2 + gsum[2] ** 2) * invRho0 * invRho0;
    this.epsilon = gradSum * 0.08; // 制約の緩和（CFM）
    const dq = 0.25 * h;
    this.wDq = this.poly6 * (h * h - dq * dq) ** 3;
    this.kCorr = 0.012 / gradSum; // 人工圧力（粒子の凝集を防ぐ）
    this.xsph = 0.05;
    this.gravity = -9.81;
    this.substeps = 2;
    this.iterations = 2;

    // 手のコライダー（毎フレーム外部から設定）
    this.colliders = null;
    // アヒルなどの球コライダー
    this.spheres = [];

    this.onAbsorb = null; // (x, y, z, vx, vy, vz) => void
    this.waterHeightAt = null; // (x, z) => y
    this.spilled = 0;
  }

  clear() {
    this.count = 0;
  }

  spawn(x, y, z, vx, vy, vz) {
    if (this.count >= this.max) return false;
    const i = this.count++;
    const o = i * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.prev[o] = x;
    this.prev[o + 1] = y;
    this.prev[o + 2] = z;
    this.vel[o] = vx;
    this.vel[o + 1] = vy;
    this.vel[o + 2] = vz;
    this.age[i] = 0;
    this.floorTime[i] = 0;
    return true;
  }

  _remove(i) {
    const last = --this.count;
    if (i !== last) {
      const o = i * 3;
      const l = last * 3;
      for (let c = 0; c < 3; c++) {
        this.pos[o + c] = this.pos[l + c];
        this.prev[o + c] = this.prev[l + c];
        this.vel[o + c] = this.vel[l + c];
      }
      this.age[i] = this.age[last];
      this.floorTime[i] = this.floorTime[last];
    }
  }

  _hash(ix, iy, iz) {
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & (TABLE_SIZE - 1);
  }

  _buildGrid() {
    const n = this.count;
    const { pos, cellStart, sorted, hashOf, cellX, cellY, cellZ } = this;
    const inv = 1 / this.h;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const cx = Math.floor(pos[o] * inv);
      const cy = Math.floor(pos[o + 1] * inv);
      const cz = Math.floor(pos[o + 2] * inv);
      cellX[i] = cx;
      cellY[i] = cy;
      cellZ[i] = cz;
      const hsh = this._hash(cx, cy, cz);
      hashOf[i] = hsh;
      cellStart[hsh + 1]++;
    }
    for (let t = 0; t < TABLE_SIZE; t++) cellStart[t + 1] += cellStart[t];
    const cursor = this._cursor || (this._cursor = new Int32Array(TABLE_SIZE));
    cursor.set(cellStart.subarray(0, TABLE_SIZE));
    for (let i = 0; i < n; i++) sorted[cursor[hashOf[i]]++] = i;
  }

  _findNeighbors() {
    const n = this.count;
    const { pos, cellStart, sorted, nbr, nbrCount, cellX, cellY, cellZ } = this;
    const h2 = this.h * this.h;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const px = pos[o];
      const py = pos[o + 1];
      const pz = pos[o + 2];
      const cx = cellX[i];
      const cy = cellY[i];
      const cz = cellZ[i];
      let cnt = 0;
      const base = i * MAX_NEIGHBORS;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          for (let dz = -1; dz <= 1; dz++) {
            const nz = cz + dz;
            const hsh = this._hash(nx, ny, nz);
            const end = cellStart[hsh + 1];
            for (let s = cellStart[hsh]; s < end; s++) {
              const j = sorted[s];
              // ハッシュ衝突で別セルの粒子が混ざる（＝重複する）のを防ぐ
              if (j === i || cellX[j] !== nx || cellY[j] !== ny || cellZ[j] !== nz) continue;
              const q = j * 3;
              const rx = px - pos[q];
              const ry = py - pos[q + 1];
              const rz = pz - pos[q + 2];
              if (rx * rx + ry * ry + rz * rz < h2 && cnt < MAX_NEIGHBORS) nbr[base + cnt++] = j;
            }
          }
        }
      }
      nbrCount[i] = cnt;
    }
  }

  // 静的な形状（浴槽・床・壁）との衝突
  _collideStatic(i) {
    const { pos } = this;
    const o = i * 3;
    const r = this.radius;
    let x = pos[o];
    let y = pos[o + 1];
    let z = pos[o + 2];
    const sd = sdTub(x, z);
    const wallTop = TUB.rimY - TUB.wallT * 0.5;
    if (sd < 0) {
      // 浴槽の内側
      if (y < TUB.floorY + r) y = TUB.floorY + r;
      if (y < TUB.rimY && sd > -r) {
        const n = sdTubNormal(x, z, this._n2 || (this._n2 = [0, 0]));
        const push = -r - sd;
        x += n[0] * push;
        z += n[1] * push;
      }
    } else if (sd < TUB.wallT) {
      // 壁（上端は丸い縁）の上
      const cx = sd - TUB.wallT * 0.5;
      if (y < wallTop) {
        // 壁の側面か上へ押し出す
        const toTop = wallTop + Math.sqrt(Math.max(0, (TUB.wallT * 0.5 + r) ** 2 - cx * cx)) - y;
        const n = sdTubNormal(x, z, this._n2 || (this._n2 = [0, 0]));
        const toIn = sd + r;
        const toOut = TUB.wallT - sd + r;
        if (toTop < toIn && toTop < toOut) y += toTop;
        else if (toIn < toOut) {
          x -= n[0] * toIn;
          z -= n[1] * toIn;
        } else {
          x += n[0] * toOut;
          z += n[1] * toOut;
        }
      } else {
        const dy = y - wallTop;
        const d = Math.hypot(cx, dy);
        const R = TUB.wallT * 0.5 + r;
        if (d < R && d > 1e-6) {
          const n = sdTubNormal(x, z, this._n2 || (this._n2 = [0, 0]));
          const k = (R - d) / d;
          x += n[0] * cx * k;
          z += n[1] * cx * k;
          y += dy * k;
        }
      }
    } else if (sd < TUB.wallT + r && y < wallTop) {
      const n = sdTubNormal(x, z, this._n2 || (this._n2 = [0, 0]));
      const push = TUB.wallT + r - sd;
      x += n[0] * push;
      z += n[1] * push;
    }
    if (y < TUB.baseY + r) y = TUB.baseY + r;
    if (x < ROOM.leftWallX + r) x = ROOM.leftWallX + r;
    else if (x > ROOM.rightWallX - r) x = ROOM.rightWallX - r;
    if (z < ROOM.backWallZ + r) z = ROOM.backWallZ + r;
    else if (z > ROOM.frontWallZ - r) z = ROOM.frontWallZ - r;
    pos[o] = x;
    pos[o + 1] = y;
    pos[o + 2] = z;
  }

  // 手（カプセル群）との衝突。t はフレーム内の補間位置（0..1）
  _collideHand(i, t, friction) {
    const C = this.colliders;
    if (!C || C.count === 0) return;
    const { pos } = this;
    const o = i * 3;
    let x = pos[o];
    let y = pos[o + 1];
    let z = pos[o + 2];
    const pr = this.radius;
    // 粗い判定（バウンディング球）
    const bx = x - C.bound[0];
    const by = y - C.bound[1];
    const bz = z - C.bound[2];
    const br = C.bound[3] + pr;
    if (bx * bx + by * by + bz * bz > br * br) return;
    const A = C.a;
    const B = C.b;
    const PA = C.prevA;
    const PB = C.prevB;
    const s = 1 - t;
    for (let c = 0; c < C.count; c++) {
      const c3 = c * 3;
      const ax = PA[c3] * s + A[c3] * t;
      const ay = PA[c3 + 1] * s + A[c3 + 1] * t;
      const az = PA[c3 + 2] * s + A[c3 + 2] * t;
      const ex = PB[c3] * s + B[c3] * t - ax;
      const ey = PB[c3 + 1] * s + B[c3 + 1] * t - ay;
      const ez = PB[c3 + 2] * s + B[c3 + 2] * t - az;
      const px = x - ax;
      const py = y - ay;
      const pz = z - az;
      const l2 = ex * ex + ey * ey + ez * ez;
      let u = l2 > 0 ? (px * ex + py * ey + pz * ez) / l2 : 0;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
      const rr = C.r1[c] + (C.r2[c] - C.r1[c]) * u + pr;
      const dx = px - ex * u;
      const dy = py - ey * u;
      const dz = pz - ez * u;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 1e-6;
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      const pen = rr - d;
      x += nx * pen;
      y += ny * pen;
      z += nz * pen;
      if (friction > 0) {
        // 接触点での手の移動量に対する相対変位の接線成分を減らす（手と一緒に動く）
        const vax = C.va[c3] + (C.vb[c3] - C.va[c3]) * u;
        const vay = C.va[c3 + 1] + (C.vb[c3 + 1] - C.va[c3 + 1]) * u;
        const vaz = C.va[c3 + 2] + (C.vb[c3 + 2] - C.va[c3 + 2]) * u;
        const p = this.prev;
        const dt = this._dt;
        let rx = x - p[o] - vax * dt;
        let ry = y - p[o + 1] - vay * dt;
        let rz = z - p[o + 2] - vaz * dt;
        const rn = rx * nx + ry * ny + rz * nz;
        rx -= rn * nx;
        ry -= rn * ny;
        rz -= rn * nz;
        x -= rx * friction;
        y -= ry * friction;
        z -= rz * friction;
      }
    }
    pos[o] = x;
    pos[o + 1] = y;
    pos[o + 2] = z;
  }

  _collideSpheres(i) {
    const { pos } = this;
    const o = i * 3;
    for (const sp of this.spheres) {
      const dx = pos[o] - sp.x;
      const dy = pos[o + 1] - sp.y;
      const dz = pos[o + 2] - sp.z;
      const R = sp.r + this.radius;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < R * R && d2 > 1e-12) {
        const d = Math.sqrt(d2);
        const k = (R - d) / d;
        pos[o] += dx * k;
        pos[o + 1] += dy * k;
        pos[o + 2] += dz * k;
      }
    }
  }

  step(frameDt) {
    if (this.count === 0) return;
    const ns = this.substeps;
    const dt = Math.min(frameDt, 1 / 30) / ns;
    for (let s = 0; s < ns; s++) this._substep(dt, (s + 1) / ns);
  }

  _substep(dt, t) {
    this._dt = dt;
    const n = this.count;
    const { pos, prev, vel, lambda, delta, nbr, nbrCount, density } = this;
    const g = this.gravity;

    for (let i = 0; i < n; i++) {
      const o = i * 3;
      vel[o + 1] += g * dt;
      // 空気抵抗（ごくわずか）
      const drag = 1 - 0.15 * dt;
      vel[o] *= drag;
      vel[o + 1] *= drag;
      vel[o + 2] *= drag;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      this._collideStatic(i);
    }

    this._buildGrid();
    this._findNeighbors();

    const h = this.h;
    const h2 = h * h;
    const poly6 = this.poly6;
    const spiky = this.spikyGrad;
    const invRho0 = 1 / this.rho0;
    const eps = this.epsilon;
    const kCorr = this.kCorr;
    const invWdq = 1 / this.wDq;

    for (let it = 0; it < this.iterations; it++) {
      // λ
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        const px = pos[o];
        const py = pos[o + 1];
        const pz = pos[o + 2];
        let rho = poly6 * h2 * h2 * h2;
        let gx = 0;
        let gy = 0;
        let gz = 0;
        let g2 = 0;
        const base = i * MAX_NEIGHBORS;
        const cnt = nbrCount[i];
        for (let m = 0; m < cnt; m++) {
          const q = nbr[base + m] * 3;
          const rx = px - pos[q];
          const ry = py - pos[q + 1];
          const rz = pz - pos[q + 2];
          const r2 = rx * rx + ry * ry + rz * rz;
          if (r2 >= h2) continue;
          const w = h2 - r2;
          rho += poly6 * w * w * w;
          const r = Math.sqrt(r2);
          if (r > 1e-9) {
            const gm = (spiky * (h - r) * (h - r)) / r;
            const ax = gm * rx * invRho0;
            const ay = gm * ry * invRho0;
            const az = gm * rz * invRho0;
            gx += ax;
            gy += ay;
            gz += az;
            g2 += ax * ax + ay * ay + az * az;
          }
        }
        density[i] = rho;
        let C = rho * invRho0 - 1;
        // 近傍が少ない（細い水流・しぶき）ときは引き合う力を使わない。粒子が団子状に固まるのを防ぐ
        if (cnt < 10 && C < 0) C = 0;
        lambda[i] = -C / (g2 + gx * gx + gy * gy + gz * gz + eps);
      }
      // Δp
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        const px = pos[o];
        const py = pos[o + 1];
        const pz = pos[o + 2];
        const li = lambda[i];
        let dx = 0;
        let dy = 0;
        let dz = 0;
        const base = i * MAX_NEIGHBORS;
        const cnt = nbrCount[i];
        for (let m = 0; m < cnt; m++) {
          const j = nbr[base + m];
          const q = j * 3;
          const rx = px - pos[q];
          const ry = py - pos[q + 1];
          const rz = pz - pos[q + 2];
          const r2 = rx * rx + ry * ry + rz * rz;
          if (r2 >= h2 || r2 < 1e-18) continue;
          const r = Math.sqrt(r2);
          const w = h2 - r2;
          const ratio = poly6 * w * w * w * invWdq;
          const r4 = ratio * ratio * ratio * ratio;
          const sc = -kCorr * r4;
          const gm = (spiky * (h - r) * (h - r)) / r;
          const f = (li + lambda[j] + sc) * gm * invRho0;
          dx += f * rx;
          dy += f * ry;
          dz += f * rz;
        }
        delta[o] = dx;
        delta[o + 1] = dy;
        delta[o + 2] = dz;
      }
      const last = it === this.iterations - 1;
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        pos[o] += delta[o];
        pos[o + 1] += delta[o + 1];
        pos[o + 2] += delta[o + 2];
        this._collideStatic(i);
        this._collideHand(i, t, last ? 0.35 : 0);
        if (this.spheres.length) this._collideSpheres(i);
      }
    }

    // 速度更新
    const invDt = 1 / dt;
    const vmax = 4.5;
    const floorFriction = Math.exp(-10 * dt);
    const rr = this.radius * 1.05;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let vx = (pos[o] - prev[o]) * invDt;
      let vy = (pos[o + 1] - prev[o + 1]) * invDt;
      let vz = (pos[o + 2] - prev[o + 2]) * invDt;
      // 床・浴槽の底では摩擦で止まる
      const y = pos[o + 1];
      if (y < TUB.baseY + rr || (y < TUB.floorY + rr && sdTub(pos[o], pos[o + 2]) < 0)) {
        vx *= floorFriction;
        vz *= floorFriction;
      }
      const sp = Math.hypot(vx, vy, vz);
      if (sp > vmax) {
        const k = vmax / sp;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      vel[o] = vx;
      vel[o + 1] = vy;
      vel[o + 2] = vz;
    }
    // XSPH 粘性
    const c = this.xsph;
    if (c > 0) {
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        let ax = 0;
        let ay = 0;
        let az = 0;
        const base = i * MAX_NEIGHBORS;
        const cnt = nbrCount[i];
        for (let m = 0; m < cnt; m++) {
          const q = nbr[base + m] * 3;
          const rx = pos[o] - pos[q];
          const ry = pos[o + 1] - pos[q + 1];
          const rz = pos[o + 2] - pos[q + 2];
          const r2 = rx * rx + ry * ry + rz * rz;
          if (r2 >= h2) continue;
          const w = h2 - r2;
          const W = poly6 * w * w * w * invRho0;
          ax += (vel[q] - vel[o]) * W;
          ay += (vel[q + 1] - vel[o + 1]) * W;
          az += (vel[q + 2] - vel[o + 2]) * W;
        }
        delta[o] = ax;
        delta[o + 1] = ay;
        delta[o + 2] = az;
      }
      for (let i = 0; i < n * 3; i++) vel[i] += c * delta[i];
    }

    // 吸収・寿命
    for (let i = this.count - 1; i >= 0; i--) {
      const o = i * 3;
      const x = pos[o];
      const y = pos[o + 1];
      const z = pos[o + 2];
      this.age[i] += dt;
      if (sdTub(x, z) < 0 && this.waterHeightAt && y < this.waterHeightAt(x, z)) {
        if (this.onAbsorb) this.onAbsorb(x, y, z, vel[o], vel[o + 1], vel[o + 2]);
        this._remove(i);
        continue;
      }
      if (y < TUB.baseY + this.radius * 1.5) {
        this.floorTime[i] += dt;
        if (this.floorTime[i] > 2.5) {
          this.spilled += this.particleVolume;
          this._remove(i);
          continue;
        }
      }
      if (!(y > TUB.baseY - 1) || !(Math.abs(x) < 5) || !(Math.abs(z) < 5)) {
        this.spilled += this.particleVolume;
        this._remove(i);
      }
    }
  }
}

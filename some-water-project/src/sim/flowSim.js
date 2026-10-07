import { TUB, sdTub } from '../config.js';

// 深さ平均した 2D 非圧縮流（かき混ぜたときの水の流れ・渦）。
// MAC グリッド、MacCormack 移流、SOR による圧力投影。
// 移流で生じる圧力（遠心力など）から水面のくぼみ／盛り上がりを求める。
export class FlowSim {
  constructor(dx = 0.025) {
    this.dx = dx;
    const PAD = 2;
    const NX = Math.ceil((2 * TUB.halfX) / dx);
    const NZ = Math.ceil((2 * TUB.halfZ) / dx);
    const GX = NX + 2 * PAD;
    const GZ = NZ + 2 * PAD;
    this.GX = GX;
    this.GZ = GZ;
    const N = GX * GZ;
    this.N = N;
    this.x0 = -NX * dx * 0.5 - PAD * dx;
    this.z0 = -NZ * dx * 0.5 - PAD * dx;
    this.fluid = new Uint8Array(N);
    const list = [];
    for (let j = 0; j < GZ; j++) {
      for (let i = 0; i < GX; i++) {
        const cx = this.x0 + (i + 0.5) * dx;
        const cz = this.z0 + (j + 0.5) * dx;
        if (sdTub(cx, cz) < -0.25 * dx) {
          this.fluid[j * GX + i] = 1;
          list.push(j * GX + i);
        }
      }
    }
    this.fluidList = Int32Array.from(list);
    this.uOpen = new Uint8Array(N);
    this.wOpen = new Uint8Array(N);
    this.nOpen = new Uint8Array(N);
    for (const k of list) {
      if (this.fluid[k + 1]) this.uOpen[k] = 1;
      if (this.fluid[k + GX]) this.wOpen[k] = 1;
    }
    for (const k of list) {
      this.nOpen[k] = this.uOpen[k] + this.uOpen[k - 1] + this.wOpen[k] + this.wOpen[k - GX];
    }
    const F = () => new Float32Array(N);
    this.uR = F();
    this.wF = F();
    this.uHat = F();
    this.wHat = F();
    this.uTmp = F();
    this.wTmp = F();
    this.uMin = F();
    this.uMax = F();
    this.wMin = F();
    this.wMax = F();
    this.p1 = F();
    this.p2 = F();
    this.div = F();
    this.eta = F(); // 移流圧力による水面変位
    this.dragW = F();
    this.dragU = F();
    this.dragV = F();
    this.damping = 0.09;
    this.depth = 0.27;
  }

  reset() {
    for (const a of [this.uR, this.wF, this.p1, this.p2, this.eta, this.dragW, this.dragU, this.dragV]) a.fill(0);
  }

  _sample(arr, X, Z, ox, oz) {
    const { GX, GZ } = this;
    let fx = X - ox;
    let fz = Z - oz;
    if (fx < 0) fx = 0;
    else if (fx > GX - 1.001) fx = GX - 1.001;
    if (fz < 0) fz = 0;
    else if (fz > GZ - 1.001) fz = GZ - 1.001;
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const k = j * GX + i;
    const a = arr[k];
    const b = arr[k + 1];
    const c = arr[k + GX];
    const d = arr[k + GX + 1];
    this._lo = a < b ? a : b;
    if (c < this._lo) this._lo = c;
    if (d < this._lo) this._lo = d;
    this._hi = a > b ? a : b;
    if (c > this._hi) this._hi = c;
    if (d > this._hi) this._hi = d;
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  velocityAt(x, z, out) {
    const X = (x - this.x0) / this.dx;
    const Z = (z - this.z0) / this.dx;
    out[0] = this._sample(this.uR, X, Z, 1, 0.5);
    out[1] = this._sample(this.wF, X, Z, 0.5, 1);
    return out;
  }

  etaAt(x, z) {
    return this._sample(this.eta, (x - this.x0) / this.dx, (z - this.z0) / this.dx, 0.5, 0.5);
  }

  vorticityAt(x, z) {
    const X = (x - this.x0) / this.dx;
    const Z = (z - this.z0) / this.dx;
    const dwdx = (this._sample(this.wF, X + 1, Z, 0.5, 1) - this._sample(this.wF, X - 1, Z, 0.5, 1)) / (2 * this.dx);
    const dudz = (this._sample(this.uR, X, Z + 1, 1, 0.5) - this._sample(this.uR, X, Z - 1, 1, 0.5)) / (2 * this.dx);
    return dwdx - dudz;
  }

  // 手（物体）による抗力: frac は水柱のうち物体が占める割合、area はその面積
  addDrag(x, z, vx, vz, frac, area) {
    const i = Math.floor((x - this.x0) / this.dx);
    const j = Math.floor((z - this.z0) / this.dx);
    if (i < 0 || j < 0 || i >= this.GX || j >= this.GZ) return;
    const k = j * this.GX + i;
    if (!this.fluid[k]) return;
    const w = (frac * area) / (this.dx * this.dx);
    this.dragW[k] += w;
    this.dragU[k] += w * vx;
    this.dragV[k] += w * vz;
  }

  addMomentum(x, z, vx, vz, vol) {
    const i = Math.floor((x - this.x0) / this.dx);
    const j = Math.floor((z - this.z0) / this.dx);
    if (i < 0 || j < 0 || i >= this.GX || j >= this.GZ) return;
    const k = j * this.GX + i;
    if (!this.fluid[k]) return;
    const s = vol / (this.dx * this.dx * Math.max(0.03, this.depth));
    const { GX } = this;
    if (this.uOpen[k]) this.uR[k] += 0.5 * vx * s;
    if (this.uOpen[k - 1]) this.uR[k - 1] += 0.5 * vx * s;
    if (this.wOpen[k]) this.wF[k] += 0.5 * vz * s;
    if (this.wOpen[k - GX]) this.wF[k - GX] += 0.5 * vz * s;
  }

  step(dt, depth, g) {
    this.depth = depth;
    const { uR, wF, uOpen, wOpen, GX, fluidList, dragW, dragU, dragV } = this;

    // 抗力（手の速度へ引き寄せる）
    const kDrag = 30;
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      const w = dragW[k];
      if (w <= 0) continue;
      const tu = dragU[k] / w;
      const tv = dragV[k] / w;
      const a = 1 - Math.exp(-kDrag * Math.min(1, w) * dt);
      if (uOpen[k]) uR[k] += (tu - uR[k]) * a * 0.5;
      if (uOpen[k - 1]) uR[k - 1] += (tu - uR[k - 1]) * a * 0.5;
      if (wOpen[k]) wF[k] += (tv - wF[k]) * a * 0.5;
      if (wOpen[k - GX]) wF[k - GX] += (tv - wF[k - GX]) * a * 0.5;
      dragW[k] = 0;
      dragU[k] = 0;
      dragV[k] = 0;
    }

    this._project(this.p1, dt, 12);
    this._advect(dt);
    this._project(this.p2, dt, 18);

    const damp = Math.exp(-this.damping * dt);
    const vmax = (0.9 * this.dx) / dt;
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      let u = uR[k] * damp;
      let w = wF[k] * damp;
      if (u > vmax) u = vmax;
      else if (u < -vmax) u = -vmax;
      if (w > vmax) w = vmax;
      else if (w < -vmax) w = -vmax;
      uR[k] = u;
      wF[k] = w;
    }

    // 移流圧力 -> 水面（遠心力で渦の中心がくぼむ）
    const { p2, eta } = this;
    const a = 1 - Math.exp(-dt / 0.1);
    const invG = 1 / g;
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      let e = p2[k] * invG;
      if (e > 0.025) e = 0.025;
      else if (e < -0.025) e = -0.025;
      eta[k] += (e - eta[k]) * a;
    }
    // 壁セルへは最寄りの値を外挿（補間用）
    for (let j = 0; j < this.GZ; j++) {
      for (let i = 0; i < GX; i++) {
        const k = j * GX + i;
        if (this.fluid[k]) continue;
        let s = 0;
        let c = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= GX || nj >= this.GZ) continue;
            const nk = nj * GX + ni;
            if (this.fluid[nk]) {
              s += eta[nk];
              c++;
            }
          }
        }
        eta[k] = c ? s / c : 0;
      }
    }
  }

  _project(p, dt, iters) {
    const { uR, wF, uOpen, wOpen, nOpen, div, fluidList, GX, dx } = this;
    const scale = dx / dt; // (dx² / dt) * (1 / dx)
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      div[k] = (uR[k] - uR[k - 1] + wF[k] - wF[k - GX]) * scale;
    }
    const omega = 1.75;
    for (let it = 0; it < iters; it++) {
      for (let n = 0; n < fluidList.length; n++) {
        const k = fluidList[n];
        const no = nOpen[k];
        if (no === 0) continue;
        let s = 0;
        if (uOpen[k]) s += p[k + 1];
        if (uOpen[k - 1]) s += p[k - 1];
        if (wOpen[k]) s += p[k + GX];
        if (wOpen[k - GX]) s += p[k - GX];
        p[k] += omega * ((s - div[k]) / no - p[k]);
      }
    }
    let mean = 0;
    for (let n = 0; n < fluidList.length; n++) mean += p[fluidList[n]];
    mean /= fluidList.length;
    for (let n = 0; n < fluidList.length; n++) p[fluidList[n]] -= mean;
    const g = dt / dx;
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      if (uOpen[k]) uR[k] -= g * (p[k + 1] - p[k]);
      if (wOpen[k]) wF[k] -= g * (p[k + GX] - p[k]);
    }
  }

  _advect(dt) {
    const { uR, wF, uHat, wHat, uTmp, wTmp, uMin, uMax, wMin, wMax, uOpen, wOpen, fluidList, GX } = this;
    const s = dt / this.dx;
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      const i = k % GX;
      const j = (k / GX) | 0;
      if (uOpen[k]) {
        const X = i + 1;
        const Z = j + 0.5;
        const u = uR[k];
        const w = this._sample(wF, X, Z, 0.5, 1);
        uHat[k] = this._sample(uR, X - u * s, Z - w * s, 1, 0.5);
        uMin[k] = this._lo;
        uMax[k] = this._hi;
      }
      if (wOpen[k]) {
        const X = i + 0.5;
        const Z = j + 1;
        const u = this._sample(uR, X, Z, 1, 0.5);
        const w = wF[k];
        wHat[k] = this._sample(wF, X - u * s, Z - w * s, 0.5, 1);
        wMin[k] = this._lo;
        wMax[k] = this._hi;
      }
    }
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      const i = k % GX;
      const j = (k / GX) | 0;
      if (uOpen[k]) {
        const X = i + 1;
        const Z = j + 0.5;
        const u = uR[k];
        const w = this._sample(wF, X, Z, 0.5, 1);
        const back = this._sample(uHat, X + u * s, Z + w * s, 1, 0.5);
        let r = uHat[k] + 0.5 * (u - back);
        if (r < uMin[k]) r = uMin[k];
        else if (r > uMax[k]) r = uMax[k];
        uTmp[k] = r;
      }
      if (wOpen[k]) {
        const X = i + 0.5;
        const Z = j + 1;
        const u = this._sample(uR, X, Z, 1, 0.5);
        const w = wF[k];
        const back = this._sample(wHat, X + u * s, Z + w * s, 0.5, 1);
        let r = wHat[k] + 0.5 * (w - back);
        if (r < wMin[k]) r = wMin[k];
        else if (r > wMax[k]) r = wMax[k];
        wTmp[k] = r;
      }
    }
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      uR[k] = uOpen[k] ? uTmp[k] : 0;
      wF[k] = wOpen[k] ? wTmp[k] : 0;
    }
  }

  energy() {
    let e = 0;
    for (const k of this.fluidList) e += this.uR[k] * this.uR[k] + this.wF[k] * this.wF[k];
    return e * this.dx * this.dx;
  }
}


import * as THREE from 'three';
import { TUB, sdTub } from '../config.js';

// 手 ⇄ 水面 ⇄ 粒子 の相互作用
//  - 手が水中で占める体積（水柱ごとの区間）を求め、水位・波・流れに反映する
//  - 手のひらにたまった水を、手が水面を抜けた瞬間に粒子として生成する（すくう）
//  - 濡れた指先からしずくを落とす
//  - 粒子が水面に落ちたら体積・運動量・泡・波紋として水面へ戻す

const MAX_CHORDS = 20000;
const EFF_DEPTH = 0.055; // 深いところの動きほど水面への影響が小さくなる長さスケール
const SOURCE_GAIN = 0.85;

export class Coupling {
  constructor(water, fluid, hand, controller) {
    this.water = water;
    this.fluid = fluid;
    this.hand = hand;
    this.controller = controller;
    const N = water.N;
    this.cellHead = new Int32Array(N).fill(-1);
    this.touched = [];
    this.cLo = new Float32Array(MAX_CHORDS);
    this.cHi = new Float32Array(MAX_CHORDS);
    this.cVx = new Float32Array(MAX_CHORDS);
    this.cVz = new Float32Array(MAX_CHORDS);
    this.cNext = new Int32Array(MAX_CHORDS);
    this.nChords = 0;
    this._buf = [];

    const nL = hand.lattice.length / 3;
    this.prevBelow = new Uint8Array(nL);
    this.latticeWorld = new Float32Array(nL * 3);
    this.latticePrev = new Float32Array(nL * 3);
    this.latticeInit = false;

    this.tipWet = new Float32Array(8).fill(10);
    this.tipWasUnder = new Uint8Array(8);
    this._tips = [];
    this.scooped = 0;
    this.submergedFraction = 0;

    const Vp = fluid.particleVolume;
    fluid.waterHeightAt = (x, z) => water.heightAt(x, z);
    fluid.onAbsorb = (x, y, z, vx, vy, vz) => {
      water.addVolume(Vp);
      const speed = Math.max(0, -vy);
      // 着水: 体積ぶん盛り上がるが、速いしずくはくぼみ（クレーター）を作る
      water.addWaveVolume(x, z, Vp * (1 - Math.min(2.2, speed * 1.1)), 0.9);
      water.addMomentum(x, z, vx, vz, Vp);
      if (speed > 0.7) water.addFoam(x, z, Math.min(0.25, 0.04 * speed), 0.9);
    };
  }

  // ---- 手の体積 -----------------------------------------------------------

  computeHandColumns() {
    const W = this.water;
    const C = this.hand.colliders;
    for (const k of W.handCells) {
      W.hd[k] = 0;
      W.hdEff[k] = 0;
      W.obst[k] = 0;
      W.hvx[k] = 0;
      W.hvz[k] = 0;
    }
    W.handCells.length = 0;
    this.submergedFraction = 0;

    // 水面より十分上なら何もしない
    const top = W.level + 0.06;
    let lowest = Infinity;
    for (let c = 0; c < C.count; c++) {
      lowest = Math.min(lowest, C.a[c * 3 + 1] - C.r1[c], C.b[c * 3 + 1] - C.r2[c]);
    }
    if (lowest > top) return;

    const { cellHead, cLo, cHi, cVx, cVz, cNext, touched } = this;
    this.nChords = 0;
    const dx = W.dx;
    for (let c = 0; c < C.count; c++) {
      const c3 = c * 3;
      const ax = C.a[c3];
      const ay = C.a[c3 + 1];
      const az = C.a[c3 + 2];
      const ex = C.b[c3] - ax;
      const ey = C.b[c3 + 1] - ay;
      const ez = C.b[c3 + 2] - az;
      const len = Math.hypot(ex, ey, ez);
      const rmin = Math.min(C.r1[c], C.r2[c]);
      const n = Math.ceil(len / (rmin * 0.5)) + 1;
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const r = C.r1[c] + (C.r2[c] - C.r1[c]) * t;
        const cx = ax + ex * t;
        const cy = ay + ey * t;
        const cz = az + ez * t;
        if (cy - r > top) continue;
        const vx = C.va[c3] + (C.vb[c3] - C.va[c3]) * t;
        const vz = C.va[c3 + 2] + (C.vb[c3 + 2] - C.va[c3 + 2]) * t;
        const i0 = Math.floor(W.toGridX(cx - r) - 0.5);
        const i1 = Math.ceil(W.toGridX(cx + r) - 0.5);
        const j0 = Math.floor(W.toGridZ(cz - r) - 0.5);
        const j1 = Math.ceil(W.toGridZ(cz + r) - 0.5);
        for (let j = Math.max(0, j0); j <= Math.min(W.GZ - 1, j1); j++) {
          const pz = W.z0 + (j + 0.5) * dx;
          for (let i = Math.max(0, i0); i <= Math.min(W.GX - 1, i1); i++) {
            const k = j * W.GX + i;
            if (!W.fluid[k]) continue;
            const px = W.x0 + (i + 0.5) * dx;
            const d2 = (px - cx) ** 2 + (pz - cz) ** 2;
            if (d2 >= r * r) continue;
            if (this.nChords >= MAX_CHORDS) continue;
            const chord = Math.sqrt(r * r - d2);
            const id = this.nChords++;
            cLo[id] = cy - chord;
            cHi[id] = cy + chord;
            cVx[id] = vx;
            cVz[id] = vz;
            if (cellHead[k] < 0) touched.push(k);
            cNext[id] = cellHead[k];
            cellHead[k] = id;
          }
        }
      }
    }

    const buf = this._buf;
    let totalSub = 0;
    let total = 0;
    for (const k of touched) {
      const eta = W.level + W.eta[k];
      buf.length = 0;
      let wsum = 0;
      let vxs = 0;
      let vzs = 0;
      for (let id = cellHead[k]; id >= 0; id = cNext[id]) {
        buf.push(id);
        const lo = Math.max(cLo[id], TUB.floorY);
        const hi = Math.min(cHi[id], eta);
        const w = hi - lo;
        if (w > 0) {
          wsum += w;
          vxs += w * cVx[id];
          vzs += w * cVz[id];
        }
      }
      cellHead[k] = -1;
      buf.sort((a, b) => cLo[a] - cLo[b]);
      // 区間の和集合
      let d = 0;
      let eff = 0;
      let pierce = false;
      let curLo = cLo[buf[0]];
      let curHi = cHi[buf[0]];
      const flush = () => {
        if (curLo < eta - 0.002 && curHi > eta + 0.002) pierce = true;
        const lo = Math.max(curLo, TUB.floorY);
        const hi = Math.min(curHi, eta);
        total += curHi - curLo;
        if (hi > lo) {
          d += hi - lo;
          totalSub += hi - lo;
          eff += EFF_DEPTH * (Math.exp(-(eta - hi) / EFF_DEPTH) - Math.exp(-(eta - lo) / EFF_DEPTH));
        }
      };
      for (let m = 1; m < buf.length; m++) {
        const id = buf[m];
        if (cLo[id] <= curHi) {
          if (cHi[id] > curHi) curHi = cHi[id];
        } else {
          flush();
          curLo = cLo[id];
          curHi = cHi[id];
        }
      }
      flush();
      if (d > 0 || pierce) {
        W.handCells.push(k);
        W.hd[k] = d;
        W.hdEff[k] = eff * SOURCE_GAIN;
        W.obst[k] = pierce ? 1 : 0;
        if (wsum > 0) {
          W.hvx[k] = vxs / wsum;
          W.hvz[k] = vzs / wsum;
        }
      }
    }
    touched.length = 0;
    this.submergedFraction = total > 0 ? totalSub / total : 0;
  }

  // ---- すくう -------------------------------------------------------------

  spawnFromHand(dt, rng = Math.random) {
    const W = this.water;
    const F = this.fluid;
    const hand = this.hand;
    const L = hand.lattice;
    const nL = L.length / 3;
    const m = hand.bones[hand.boneByName.hand].matrixWorld.elements;
    const palm = this.controller.palmNormal(new THREE.Vector3());
    const palmUp = palm.y;
    const pr = F.radius;
    const lw = this.latticeWorld;
    const lp = this.latticePrev;
    lp.set(lw);
    for (let i = 0; i < nL; i++) {
      const x = L[i * 3];
      const y = L[i * 3 + 1];
      const z = L[i * 3 + 2];
      lw[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      lw[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      lw[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    if (!this.latticeInit) {
      lp.set(lw);
      this.latticeInit = true;
    }
    let spawned = 0;
    const inv = dt > 0 ? 1 / dt : 0;
    for (let i = 0; i < nL; i++) {
      const wx = lw[i * 3];
      const wy = lw[i * 3 + 1];
      const wz = lw[i * 3 + 2];
      const inside = sdTub(wx, wz) < -0.012;
      const below = inside && wy < W.heightAt(wx, wz) - 0.001;
      const was = this.prevBelow[i];
      this.prevBelow[i] = below ? 1 : 0;
      if (!was || below || !inside) continue;
      if (palmUp < 0.15 && rng() > 0.03) continue; // 手のひらが下向きならわずかなしずくだけ
      if (spawned > 300 || F.count >= F.max) continue;
      const sd = hand.sdfWorld(wx, wy, wz);
      if (sd < pr * 1.05) continue;
      const contained = palmUp > 0.15 && this.contained(wx, wy, wz);
      if (!contained && !(sd < 0.012 && rng() < 0.12)) continue;
      const vx = (wx - lp[i * 3]) * inv;
      const vy = (wy - lp[i * 3 + 1]) * inv;
      const vz = (wz - lp[i * 3 + 2]) * inv;
      if (F.spawn(wx, wy, wz, vx, vy, vz)) {
        W.addVolume(-F.particleVolume);
        W.addWaveVolume(wx, wz, -F.particleVolume, 1.0);
        spawned++;
      }
    }
    this.scooped += spawned;
    return spawned;
  }

  // 点が手のくぼみに囲まれているか（すくった水やゴミが手に残るかの判定）（水平 8 方向と真下にレイを飛ばす）
  contained(x, y, z) {
    const hand = this.hand;
    const maxDist = 0.11;
    const march = (dx, dy, dz) => {
      let t = 0;
      for (let s = 0; s < 22; s++) {
        const d = hand.sdfWorld(x + dx * t, y + dy * t, z + dz * t);
        if (d < 0.0015) return true;
        t += Math.max(d, 0.002);
        if (t > maxDist) return false;
      }
      return false;
    };
    if (!march(0, -1, 0)) return false;
    let hits = 0;
    let misses = 0;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      if (march(Math.cos(ang), 0, Math.sin(ang))) hits++;
      else if (++misses > 2) return false;
    }
    return hits >= 6;
  }

  // ---- しずく -------------------------------------------------------------

  drips(dt, rng = Math.random) {
    const W = this.water;
    const F = this.fluid;
    const tips = this.hand.fingertips(this._tips);
    const C = this.hand.colliders;
    tips.forEach((tip, n) => {
      const under = tip.y - tip.r < W.heightAt(tip.x, tip.z) && sdTub(tip.x, tip.z) < 0;
      if (under) {
        this.tipWet[n] = 0;
        this.tipWasUnder[n] = 1;
        return;
      }
      this.tipWet[n] += dt;
      if (!this.tipWasUnder[n]) return;
      const t = this.tipWet[n];
      if (t > 3) {
        this.tipWasUnder[n] = 0;
        return;
      }
      const p = dt * 4.0 * Math.exp(-t / 0.7);
      if (rng() > p) return;
      const x = tip.x + (rng() - 0.5) * 0.003;
      const y = tip.y - tip.r - F.radius * 1.3;
      const z = tip.z + (rng() - 0.5) * 0.003;
      if (this.hand.sdfWorld(x, y, z) < F.radius) return;
      const i3 = tip.i * 3;
      if (F.spawn(x, y, z, C.vb[i3], Math.min(0, C.vb[i3 + 1]), C.vb[i3 + 2])) {
        W.addVolume(-F.particleVolume);
      }
    });
  }
}

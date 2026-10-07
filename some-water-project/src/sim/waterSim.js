import { GRID, TUB, WATER, sdTub } from '../config.js';
import { FlowSim } from './flowSim.js';

// 浴槽の水面シミュレーション。
//
// 水面 = 水位 level + 波 h + 流れによる変位 etaFlow
//
//  - 水位 level: 浴槽内の水量と、手が水中で押しのけている体積から厳密に決まる（体積保存）。
//  - 波 h: 波長帯ごとに分けた「マルチバンド波動方程式」。
//    水の波は波長によって速さが違う（分散性: ω² = (g·k + σ/ρ·k³)·tanh(k·H)）。
//    入力（手の押しのけ・しずくの着水）をガウシアンピラミッドで帯域分割し、
//    各帯域をその波長に対応する位相速度で伝播させることで、
//    細かいさざ波はゆっくり、大きなうねりは速く広がる本物の水の挙動を再現する。
//    壁は鏡像（ノイマン）境界なので反射も自然。
//  - 流れ: FlowSim（2D 非圧縮流）。かき混ぜると渦ができ、遠心力で中心がくぼむ。
//  - 泡: 流れに乗って運ばれ、徐々に消える。

const SURFACE_TENSION = 0.072 / 1000; // σ/ρ [m³/s²]
const SURFACE_LAYER = 0.12; // 流れを計算する表層の厚さ [m]

export class WaterSim {
  constructor() {
    const { dx, NX, NZ, PAD } = GRID;
    this.dx = dx;
    this.NX = NX;
    this.NZ = NZ;
    this.PAD = PAD;
    const GX = NX + 2 * PAD;
    const GZ = NZ + 2 * PAD;
    this.GX = GX;
    this.GZ = GZ;
    const N = GX * GZ;
    this.N = N;
    this.x0 = -TUB.halfX - PAD * dx;
    this.z0 = -TUB.halfZ - PAD * dx;
    this.cellArea = dx * dx;
    this.g = WATER.g;

    this.fluid = new Uint8Array(N);
    const list = [];
    for (let j = 0; j < GZ; j++) {
      for (let i = 0; i < GX; i++) {
        if (sdTub(this.x0 + (i + 0.5) * dx, this.z0 + (j + 0.5) * dx) < 0) {
          this.fluid[j * GX + i] = 1;
          list.push(j * GX + i);
        }
      }
    }
    this.fluidList = Int32Array.from(list);
    this.area = list.length * this.cellArea;
    this.mirror = new Int32Array(N).fill(-1);
    this._buildMirror();

    // 帯域分割用のぼかし（累積 σ はセル単位でおよそ 1.4, 2, 4, 7.6, 16.4）。
    // 3 回のボックスブラーでガウシアンを近似（実行コストが半径に依存しない）。
    this.blurSteps = [
      { r: 1 },
      { r: 1 },
      { r: 3 },
      { r: 6 },
      { r: 14 },
    ];
    const sigmas = [];
    let acc = 0;
    for (const st of this.blurSteps) {
      st.var = ((2 * st.r + 1) ** 2 - 1) / 4;
      acc += st.var;
      sigmas.push(Math.sqrt(acc));
    }
    this.bandSigma = sigmas;
    const nb = this.bandSigma.length + 1;
    this.nBands = nb;
    // 各帯域を代表する波数 [rad/cell]（DoG の応答が最大になる波数）
    this.bandQ = [];
    for (let b = 0; b < nb; b++) {
      if (b === 0) this.bandQ.push(1.7);
      else if (b === nb - 1) this.bandQ.push(0.035);
      else {
        const sa = this.bandSigma[b - 1];
        const sb = this.bandSigma[b];
        this.bandQ.push(Math.sqrt((2 * Math.log((sb * sb) / (sa * sa))) / (sb * sb - sa * sa)));
      }
    }
    this.bandH = [];
    this.bandV = [];
    for (let b = 0; b < nb; b++) {
      this.bandH.push(new Float32Array(N));
      this.bandV.push(new Float32Array(N));
    }
    this.bandC = new Float32Array(nb);
    this.bandAlpha = new Float32Array(nb);
    this.bandMaxAmp = new Float32Array(nb);
    // 物体が直接作るのは物体の大きさ程度の波。格子スケールの成分は弱めて入れる
    this.bandGain = Float32Array.from({ length: nb }, (_, b) => (b === 0 ? 0.3 : b === 1 ? 0.75 : 1));


    this.src = new Float32Array(N);
    this.srcDirty = false;
    this.pyrA = new Float32Array(N);
    this.pyrB = new Float32Array(N);
    this.tmp = new Float32Array(N);

    this.flow = new FlowSim(0.025);
    this.etaFlow = new Float32Array(N);
    this.foam = new Float32Array(N);
    this.foamTmp = new Float32Array(N);
    this.eta = new Float32Array(N);

    // 手とのカップリング（coupling.js が毎フレーム書き込む）
    this.hd = new Float32Array(N);
    this.hdEff = new Float32Array(N);
    this.hdEffPrev = new Float32Array(N);
    this.hvx = new Float32Array(N);
    this.hvz = new Float32Array(N);
    this.obst = new Float32Array(N);
    this.handCells = [];

    this.texData = new Float32Array(N * 4);
    this.lite = false; // 軽量モード（遅い端末向け）
    this._v2 = [0, 0];
    this.reset();
  }

  reset() {
    this.volume = WATER.initialDepth * this.area;
    this.displaced = 0;
    this.level = TUB.floorY + WATER.initialDepth;
    for (let b = 0; b < this.nBands; b++) {
      this.bandH[b].fill(0);
      this.bandV[b].fill(0);
    }
    for (const a of [this.src, this.etaFlow, this.foam, this.eta, this.hd, this.hdEff, this.hdEffPrev, this.hvx,
      this.hvz, this.obst]) a.fill(0);
    this.handCells.length = 0;
    this.flow.reset();
    this.time = 0;
    this._updateBandSpeeds();
    this._composeSurface();
  }

  _buildMirror() {
    const { GX, GZ, N, fluid } = this;
    const near = new Int32Array(N).fill(-1);
    let frontier = [];
    for (const k of this.fluidList) {
      near[k] = k;
      frontier.push(k);
    }
    while (frontier.length) {
      const next = [];
      for (const k of frontier) {
        const i = k % GX;
        const j = (k / GX) | 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= GX || nj >= GZ) continue;
            const nk = nj * GX + ni;
            if (near[nk] >= 0) continue;
            near[nk] = near[k];
            next.push(nk);
          }
        }
      }
      frontier = next;
    }
    const ml = [];
    for (let k = 0; k < N; k++) {
      if (!fluid[k]) {
        this.mirror[k] = near[k];
        ml.push(k);
      }
    }
    this.mirrorList = Int32Array.from(ml);
  }

  _updateBandSpeeds() {
    const H = Math.max(0.02, this.level - TUB.floorY);
    for (let b = 0; b < this.nBands; b++) {
      const k = this.bandQ[b] / this.dx; // [rad/m]
      const w2 = (this.g * k + SURFACE_TENSION * k * k * k) * Math.tanh(k * H);
      this.bandC[b] = Math.sqrt(w2) / k;
      this.bandAlpha[b] = 0.2 + 4.5e-5 * k * k;
      // 砕波の限界（波の傾き k·a ≲ 0.3）
      this.bandMaxAmp[b] = 0.3 / k;
    }
  }

  // ---- サンプリング -------------------------------------------------------

  _sample(arr, X, Z) {
    const { GX, GZ } = this;
    let fx = X - 0.5;
    let fz = Z - 0.5;
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
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  toGridX(x) {
    return (x - this.x0) / this.dx;
  }
  toGridZ(z) {
    return (z - this.z0) / this.dx;
  }
  cellIndexAt(x, z) {
    const i = Math.floor(this.toGridX(x));
    const j = Math.floor(this.toGridZ(z));
    if (i < 0 || j < 0 || i >= this.GX || j >= this.GZ) return -1;
    return j * this.GX + i;
  }
  cellCenterX(k) {
    return this.x0 + ((k % this.GX) + 0.5) * this.dx;
  }
  cellCenterZ(k) {
    return this.z0 + (((k / this.GX) | 0) + 0.5) * this.dx;
  }

  heightAt(x, z) {
    return this.level + this._sample(this.eta, this.toGridX(x), this.toGridZ(z));
  }

  velocityAt(x, z, out) {
    return this.flow.velocityAt(x, z, out);
  }

  vorticityAt(x, z) {
    return this.flow.vorticityAt(x, z);
  }

  gradientAt(x, z, out) {
    const X = this.toGridX(x);
    const Z = this.toGridZ(z);
    out[0] = (this._sample(this.eta, X + 1, Z) - this._sample(this.eta, X - 1, Z)) / (2 * this.dx);
    out[1] = (this._sample(this.eta, X, Z + 1) - this._sample(this.eta, X, Z - 1)) / (2 * this.dx);
    return out;
  }

  // ---- 外部からの入力 -----------------------------------------------------

  addVolume(v) {
    this.volume += v;
  }

  // 体積 vol [m³] の局所的な盛り上がり（負ならくぼみ）を波の源として加える
  addWaveVolume(x, z, vol, radiusCells = 1.0) {
    const X = this.toGridX(x) - 0.5;
    const Z = this.toGridZ(z) - 0.5;
    const R = Math.ceil(radiusCells * 2);
    const ci = Math.round(X);
    const cj = Math.round(Z);
    const inv = 1 / (2 * radiusCells * radiusCells);
    let wsum = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let dj = -R; dj <= R; dj++) {
        for (let di = -R; di <= R; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.GX || j >= this.GZ) continue;
          const k = j * this.GX + i;
          if (!this.fluid[k]) continue;
          const ddx = i - X;
          const ddz = j - Z;
          const w = Math.exp(-(ddx * ddx + ddz * ddz) * inv);
          if (pass === 0) wsum += w;
          else this.src[k] += ((vol / this.cellArea) * w) / wsum;
        }
      }
      if (wsum <= 0) return;
    }
    this.srcDirty = true;
  }

  addFoam(x, z, amount, radiusCells = 1.0) {
    const X = this.toGridX(x) - 0.5;
    const Z = this.toGridZ(z) - 0.5;
    const R = Math.ceil(radiusCells * 2);
    const ci = Math.round(X);
    const cj = Math.round(Z);
    const inv = 1 / (2 * radiusCells * radiusCells);
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= this.GX || j >= this.GZ) continue;
        const k = j * this.GX + i;
        if (!this.fluid[k]) continue;
        const ddx = i - X;
        const ddz = j - Z;
        this.foam[k] = Math.min(1.5, this.foam[k] + amount * Math.exp(-(ddx * ddx + ddz * ddz) * inv));
      }
    }
  }

  addMomentum(x, z, vx, vz, vol) {
    this.flow.addMomentum(x, z, vx, vz, vol);
  }

  // ---- 時間発展 -----------------------------------------------------------

  step(dt) {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    const { fluidList } = this;

    // 1. 体積保存で水位を決める
    let D = 0;
    for (let n = 0; n < fluidList.length; n++) D += this.hd[fluidList[n]];
    D *= this.cellArea;
    this.displaced = D;
    const maxVol = (WATER.overflowY - TUB.floorY) * this.area - D;
    if (this.volume > maxVol) this.volume = maxVol; // オーバーフロー穴から排水
    this.level = TUB.floorY + (this.volume + D) / this.area;
    this._updateBandSpeeds();

    // 2. 手の押しのけ量の変化を波源に
    this._handSources();
    if (this.srcDirty) this._injectSources();

    // 3. 波（帯域ごとに CFL 条件からサブステップ数を決める）
    for (let b = 0; b < this.nBands; b++) {
      const c = this.bandC[b];
      const nSub = Math.max(1, Math.ceil((c * dt * Math.SQRT2) / (0.8 * this.dx)));
      for (let s = 0; s < nSub; s++) this._waveStep(b, dt / nSub);
    }
    this._applyObstruction();

    // 4. 流れ（表層 SURFACE_LAYER の流れとして扱う。手でかき混ぜて動くのは主に上の層）
    const depth = this.level - TUB.floorY;
    const layer = Math.min(depth, SURFACE_LAYER);
    for (const k of this.handCells) {
      if (this.hd[k] <= 0) continue;
      this.flow.addDrag(this.cellCenterX(k), this.cellCenterZ(k), this.hvx[k], this.hvz[k],
        Math.min(1, this.hd[k] / layer), this.cellArea);
    }
    // 軽量モードでは流れと泡を 1 フレームおきにまとめて進める
    this._slowDt = (this._slowDt || 0) + dt;
    this._frame = (this._frame || 0) + 1;
    if (!this.lite || this._frame % 2 === 0) {
      const sdt = Math.min(this._slowDt, 1 / 20);
      this._slowDt = 0;
      this.flow.step(sdt, layer, this.g);
      // 5. 泡
      this._foamStep(sdt);
    }

    // 6. 合成
    this._composeSurface();
  }

  _handSources() {
    const { src, hdEff, hdEffPrev, obst, GX, N } = this;
    // hdEffPrev に値が残っているセル（前フレームの手）と今フレームの手のセルの両方を処理
    const cells = this._srcCells || (this._srcCells = new Set());
    for (const k of this.handCells) cells.add(k);
    for (const k of cells) {
      const d = hdEff[k] - hdEffPrev[k];
      hdEffPrev[k] = hdEff[k];
      if (d !== 0) {
        src[k] += d;
        this.srcDirty = true;
      }
    }
    cells.clear();
    for (const k of this.handCells) if (hdEff[k] !== 0) cells.add(k);
    // 手が水面を貫いているセルの源は周囲の開いた水面へ移す
    for (const k of this.handCells) {
      if (obst[k] < 0.5 || src[k] === 0) continue;
      const amount = src[k];
      src[k] = 0;
      let wsum = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let dj = -4; dj <= 4; dj++) {
          for (let di = -4; di <= 4; di++) {
            const nk = k + dj * GX + di;
            if (nk < 0 || nk >= N || !this.fluid[nk] || obst[nk] > 0.5) continue;
            const w = Math.exp(-(di * di + dj * dj) / 6);
            if (pass === 0) wsum += w;
            else src[nk] += (amount * w) / wsum;
          }
        }
        if (wsum === 0) break;
      }
    }
  }

  _blurInto(src, dst, step) {
    this._boxInto(src, dst, step.r);
    this._boxInto(dst, dst, step.r);
    this._boxInto(dst, dst, step.r);
  }

  // 移動和によるボックスブラー（端はクランプ）。src と dst は同じ配列でもよい
  _boxInto(src, dst, r) {
    const { GX, GZ, tmp } = this;
    const inv = 1 / (2 * r + 1);
    for (let j = 0; j < GZ; j++) {
      const row = j * GX;
      let s = 0;
      for (let t = -r; t <= r; t++) s += src[row + Math.min(GX - 1, Math.max(0, t))];
      for (let i = 0; i < GX; i++) {
        tmp[row + i] = s * inv;
        const add = Math.min(GX - 1, i + r + 1);
        const rem = Math.max(0, i - r);
        s += src[row + add] - src[row + rem];
      }
    }
    for (let i = 0; i < GX; i++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += tmp[Math.min(GZ - 1, Math.max(0, t)) * GX + i];
      for (let j = 0; j < GZ; j++) {
        dst[j * GX + i] = s * inv;
        const add = Math.min(GZ - 1, j + r + 1);
        const rem = Math.max(0, j - r);
        s += tmp[add * GX + i] - tmp[rem * GX + i];
      }
    }
  }

  // 波源をガウシアンピラミッドで帯域分割して各帯域の高さに加える
  _injectSources() {
    const { src, fluidList, pyrA, pyrB, fluid, N } = this;
    // 平均成分は水位が担当する
    let mean = 0;
    for (let n = 0; n < fluidList.length; n++) mean += src[fluidList[n]];
    mean /= fluidList.length;
    for (let k = 0; k < N; k++) src[k] = fluid[k] ? src[k] - mean : 0;

    let prev = src;
    for (let b = 0; b < this.nBands; b++) {
      const H = this.bandH[b];
      if (b < this.nBands - 1) {
        const out = b % 2 === 0 ? pyrA : pyrB;
        this._blurInto(prev, out, this.blurSteps[b]);
        const gain = this.bandGain[b];
        for (let n = 0; n < fluidList.length; n++) {
          const k = fluidList[n];
          H[k] += (prev[k] - out[k]) * gain;
        }
        prev = out;
      } else {
        for (let n = 0; n < fluidList.length; n++) {
          const k = fluidList[n];
          H[k] += prev[k];
        }
      }
    }
    src.fill(0);
    this.srcDirty = false;
  }

  _fillMirror(arr) {
    const { mirrorList, mirror } = this;
    for (let n = 0; n < mirrorList.length; n++) {
      const k = mirrorList[n];
      arr[k] = arr[mirror[k]];
    }
  }

  _waveStep(b, dt) {
    const h = this.bandH[b];
    const v = this.bandV[b];
    const { fluidList, GX, fluid } = this;
    const c = this.bandC[b];
    const c2 = (c * c) / (this.dx * this.dx);
    const alpha = this.bandAlpha[b];
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      // 壁の向こうのセルは使わない（対称なノイマン境界: 壁で反射する）
      const hk = h[k];
      let l = 0;
      if (fluid[k - 1]) l += h[k - 1] - hk;
      if (fluid[k + 1]) l += h[k + 1] - hk;
      if (fluid[k - GX]) l += h[k - GX] - hk;
      if (fluid[k + GX]) l += h[k + GX] - hk;
      v[k] += dt * (c2 * l - alpha * v[k]);
    }
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      h[k] += dt * v[k];
    }
  }

  _applyObstruction() {
    const { obst, fluidList, foam } = this;
    for (let b = 0; b < this.nBands; b++) {
      const h = this.bandH[b];
      const v = this.bandV[b];
      if (this.handCells.length) {
        for (const k of this.handCells) {
          const o = obst[k] * 0.85;
          if (o > 0) {
            h[k] *= 1 - o;
            v[k] *= 1 - o;
          }
        }
      }
      // 砕波: 急すぎる波は振幅を頭打ちにし、失ったエネルギーは泡になる
      const A = this.bandMaxAmp[b];
      const half = A * 0.5;
      for (let n = 0; n < fluidList.length; n++) {
        const k = fluidList[n];
        const x = h[k];
        if (x > half || x < -half) {
          const sgn = x > 0 ? 1 : -1;
          const ax = x * sgn;
          const y = half + half * Math.tanh((ax - half) / half);
          if (ax > A) foam[k] = Math.min(1.5, foam[k] + (ax - A) / A * 0.08);
          h[k] = y * sgn;
          v[k] *= 0.9;
        }
      }
      let mean = 0;
      for (let n = 0; n < fluidList.length; n++) mean += h[fluidList[n]];
      mean /= fluidList.length;
      if (Math.abs(mean) > 1e-9) for (let n = 0; n < fluidList.length; n++) h[fluidList[n]] -= mean;
    }
  }

  _foamStep(dt) {
    const { foam, foamTmp, fluidList, obst, hvx, hvz } = this;
    const v = this._v2;
    this._fillMirror(foam);
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      const x = this.cellCenterX(k);
      const z = this.cellCenterZ(k);
      this.flow.velocityAt(x, z, v);
      foamTmp[k] = this._sample(foam, this.toGridX(x - v[0] * dt), this.toGridZ(z - v[1] * dt));
    }
    const decay = Math.exp(-0.3 * dt);
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      foam[k] = foamTmp[k] * decay;
    }
    // 水面を貫く手が速く動くと泡立つ
    for (const k of this.handCells) {
      if (obst[k] < 0.5) continue;
      this.flow.velocityAt(this.cellCenterX(k), this.cellCenterZ(k), v);
      const rel = Math.hypot(hvx[k] - v[0], hvz[k] - v[1]);
      if (rel > 0.15) {
        const amt = (rel - 0.15) * 2.0 * dt;
        for (let dj = -2; dj <= 2; dj++) {
          for (let di = -2; di <= 2; di++) {
            const nk = k + dj * this.GX + di;
            if (this.fluid[nk] && obst[nk] < 0.5) foam[nk] = Math.min(1.5, foam[nk] + amt);
          }
        }
      }
    }
  }

  _composeSurface() {
    const { eta, etaFlow, fluidList, texData, GX, GZ, foam } = this;
    const nb = this.nBands;
    for (let n = 0; n < fluidList.length; n++) {
      const k = fluidList[n];
      let s = 0;
      for (let b = 0; b < nb; b++) s += this.bandH[b][k];
      const ef = this.flow.etaAt(this.cellCenterX(k), this.cellCenterZ(k));
      etaFlow[k] = ef;
      eta[k] = s + ef;
    }
    this._fillMirror(eta);
    this._fillMirror(foam);
    const inv2dx = 1 / (2 * this.dx);
    for (let j = 0; j < GZ; j++) {
      for (let i = 0; i < GX; i++) {
        const k = j * GX + i;
        const l = i > 0 ? k - 1 : k;
        const r = i < GX - 1 ? k + 1 : k;
        const b = j > 0 ? k - GX : k;
        const f = j < GZ - 1 ? k + GX : k;
        const o = k * 4;
        texData[o] = eta[k];
        texData[o + 1] = (eta[r] - eta[l]) * inv2dx;
        texData[o + 2] = (eta[f] - eta[b]) * inv2dx;
        texData[o + 3] = foam[k];
      }
    }
  }

  stats() {
    let maxH = 0;
    for (const k of this.fluidList) maxH = Math.max(maxH, Math.abs(this.eta[k]));
    return { flowEnergy: this.flow.energy(), maxWave: maxH, level: this.level };
  }
}

// 画質の段階と、遅い端末を見分けて自動で軽くする仕組み

export const LEVELS = [
  { name: '高', pixelRatio: 1.5, shadows: true, shadowSize: 2048, causticsEvery: 1, blurIters: 3, simLite: false },
  { name: '中', pixelRatio: 1.0, shadows: true, shadowSize: 1024, causticsEvery: 2, blurIters: 2, simLite: false },
  { name: '低', pixelRatio: 0.7, shadows: false, shadowSize: 512, causticsEvery: 4, blurIters: 1, simLite: true },
];

const KEY = 'bathtub-gomisukui-quality';
const SLOW_FRAME = 1 / 40; // これより遅いフレームが続いたら軽くする
const WARMUP = 2.5; // 起動直後・切り替え直後は測らない [s]
const WINDOW = 2.0; // 平均をとる時間 [s]

export class Quality {
  // apply(level) で実際の設定を反映する
  constructor(apply, { coarse = false } = {}) {
    this.apply = apply;
    let saved = null;
    try {
      saved = window.localStorage.getItem(KEY);
    } catch {
      saved = null;
    }
    // 'auto' か '0' '1' '2'
    this.mode = saved === '0' || saved === '1' || saved === '2' ? saved : 'auto';
    this.level = this.mode === 'auto' ? (coarse ? 1 : 0) : Number(this.mode);
    this.onAutoChange = null;
    this._reset();
    this.apply(LEVELS[this.level]);
  }

  _reset() {
    this.warm = 0;
    this.acc = 0;
    this.frames = 0;
    this.time = 0;
  }

  label() {
    const n = LEVELS[this.level].name;
    return this.mode === 'auto' ? `自動（${n}）` : n;
  }

  // 自動 → 高 → 中 → 低 → 自動 …
  cycle() {
    const order = ['auto', '0', '1', '2'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    try {
      window.localStorage.setItem(KEY, this.mode);
    } catch {
      // 保存できなくても今回は切り替える
    }
    this.setLevel(this.mode === 'auto' ? this.level : Number(this.mode));
  }

  setLevel(level) {
    this.level = Math.max(0, Math.min(LEVELS.length - 1, level));
    this._reset();
    this.apply(LEVELS[this.level]);
  }

  // 毎フレーム、実際にかかった時間を渡す（タブが裏にあった時間などは除く）
  sample(rawDt) {
    if (this.mode !== 'auto' || rawDt > 1.5) return; // 裏タブから戻った直後などの長い間隔は除く
    if (this.warm < WARMUP) {
      this.warm += rawDt;
      return;
    }
    this.acc += rawDt;
    this.frames++;
    this.time += rawDt;
    if (this.time < WINDOW) return;
    const avg = this.acc / this.frames;
    this.acc = 0;
    this.frames = 0;
    this.time = 0;
    if (avg > SLOW_FRAME && this.level < LEVELS.length - 1) {
      this.setLevel(this.level + 1);
      if (this.onAutoChange) this.onAutoChange(LEVELS[this.level]);
    }
  }
}

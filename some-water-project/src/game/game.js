// ゴミすくいゲームの進行（タイマー・得点・コンボ・結果）

export const GAME_TIME = 75; // 秒
export const DEBRIS_COUNT = 12;
const COMBO_WINDOW = 0.7; // 同じひとすくいとみなす時間
const TIME_BONUS = 5; // 全部すくえたときの残り 1 秒あたりのボーナス

export const RANKS = [
  { min: 450, name: 'S', text: 'ピカピカ！' },
  { min: 300, name: 'A', text: 'きれいになった' },
  { min: 180, name: 'B', text: 'まずまず' },
  { min: 0, name: 'C', text: 'もうひと息' },
];

const BEST_KEY = 'bathtub-gomisukui-best';

export function loadBest() {
  try {
    return Number(window.localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest(v) {
  try {
    window.localStorage.setItem(BEST_KEY, String(v));
  } catch {
    // 保存できない環境（プライベートモードなど）では記録しない
  }
}

export class Game {
  constructor(debris) {
    this.debris = debris;
    this.state = 'title';
    this.best = loadBest();
    this.reset();
  }

  reset() {
    this.time = GAME_TIME;
    this.score = 0;
    this.collected = 0;
    this.maxCombo = 1;
    this.batch = 0;
    this.batchTime = -10;
    this.elapsed = 0;
    this.bonus = 0;
    this.cleared = false;
    this.newBest = false;
    this.misses = 0;
    this.catches = 0;
  }

  start(rng, avoid) {
    this.reset();
    this.debris.clear();
    this.debris.spawn(DEBRIS_COUNT, rng, avoid);
    this.total = this.debris.items.length;
    this.state = 'play';
  }

  // events: DebrisField.update の結果。得点の通知を返す
  update(dt, events) {
    const notes = [];
    if (this.state !== 'play') return notes;
    this.elapsed += dt;
    this.time = Math.max(0, this.time - dt);
    for (const e of events) {
      if (e.type !== 'collect') continue;
      if (this.elapsed - this.batchTime < COMBO_WINDOW) this.batch++;
      else this.batch = 1;
      this.batchTime = this.elapsed;
      this.maxCombo = Math.max(this.maxCombo, this.batch);
      const pts = e.item.def.points * this.batch;
      this.score += pts;
      this.collected++;
      notes.push({ item: e.item, points: pts, combo: this.batch });
    }
    if (this.debris.remaining() === 0 && this.collected > 0) this.finish(true);
    else if (this.time <= 0) this.finish(false);
    return notes;
  }

  finish(cleared) {
    this.cleared = cleared;
    this.bonus = cleared ? Math.ceil(this.time) * TIME_BONUS : 0;
    this.score += this.bonus;
    this.state = 'result';
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
      saveBest(this.best);
    }
  }

  rank() {
    return RANKS.find((r) => this.score >= r.min);
  }
}

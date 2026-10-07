// 小さな効果音（WebAudio で合成）。最初の操作で初めて音が出せるようになる。

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  _tone(freq, dur, { type = 'sine', gain = 0.5, slide = 1, delay = 0 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // 水の「ぽちゃ」
  _plop(gain = 0.4, pitch = 1) {
    this._tone(900 * pitch, 0.12, { gain, slide: 0.35 });
    this._tone(1700 * pitch, 0.06, { gain: gain * 0.4, slide: 0.5, delay: 0.015 });
  }

  catch() {
    this._plop(0.3, 1.2);
  }

  drop() {
    this._plop(0.35, 0.7);
  }

  collect(combo = 1) {
    const base = 660 * Math.pow(1.122, Math.min(combo - 1, 6));
    this._tone(base, 0.12, { type: 'triangle', gain: 0.4 });
    this._tone(base * 1.5, 0.18, { type: 'triangle', gain: 0.35, delay: 0.07 });
  }

  // スルッと抜けた: 下がっていく情けない音
  slip() {
    this._tone(700, 0.35, { type: 'sine', gain: 0.35, slide: 0.35 });
    this._tone(420, 0.3, { type: 'triangle', gain: 0.18, slide: 0.5, delay: 0.12 });
  }

  // ばしゃっ（ノイズを帯域通過）
  splash(power = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const dur = 0.25 + Math.min(0.3, power * 0.1);
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + Math.random() * 600;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = Math.min(0.5, 0.15 + power * 0.12);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this._plop(0.2, 0.6 + Math.random() * 0.3);
  }

  bubble() {
    this._tone(1800 + Math.random() * 800, 0.04, { gain: 0.12, slide: 1.6 });
  }

  tick() {
    this._tone(1200, 0.05, { type: 'square', gain: 0.12 });
  }

  start() {
    [523, 659, 784].forEach((f, i) => this._tone(f, 0.14, { type: 'triangle', gain: 0.3, delay: i * 0.09 }));
  }

  finish(cleared) {
    const notes = cleared ? [523, 659, 784, 1047] : [659, 523, 440];
    notes.forEach((f, i) => this._tone(f, 0.22, { type: 'triangle', gain: 0.32, delay: i * 0.12 }));
  }
}

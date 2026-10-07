import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaterSim } from '../src/sim/waterSim.js';
import { FluidSim } from '../src/sim/fluidSim.js';
import { Coupling } from '../src/sim/coupling.js';
import { HandModel } from '../src/hand/handModel.js';
import { HandController } from '../src/hand/handController.js';

const DT = 1 / 60;

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

test('水面: ランダムな外乱を与え続けても発散せず、体積が保存される', () => {
  const w = new WaterSim();
  const r = rng(3);
  const v0 = w.volume;
  for (let f = 0; f < 600; f++) {
    for (let n = 0; n < 4; n++) {
      w.addWaveVolume((r() - 0.5) * 1.2, (r() - 0.5) * 0.5, (r() - 0.5) * 4e-5, 1 + r() * 2);
      w.addMomentum((r() - 0.5) * 1.2, (r() - 0.5) * 0.5, (r() - 0.5) * 2, (r() - 0.5) * 2, 5e-5);
    }
    w.step(DT);
  }
  const { maxWave } = w.stats();
  assert.ok(Number.isFinite(maxWave), 'NaN が出ていない');
  assert.ok(maxWave < 0.05, `波の振幅が妥当 (${maxWave})`);
  assert.equal(w.volume, v0);
  let mean = 0;
  for (const k of w.fluidList) mean += w.eta[k];
  assert.ok(Math.abs(mean / w.fluidList.length) < 1e-4, '波は水位の上下に対称');
});

test('水面: さざ波は深水波らしい速さで広がる（分散性）', () => {
  const w = new WaterSim();
  w.addWaveVolume(0, 0, 2e-5, 1.5);
  for (let f = 0; f < 30; f++) w.step(DT);
  let best = 0;
  let at = 0;
  for (let x = 0; x < 0.6; x += 0.005) {
    const a = Math.abs(w.heightAt(x, 0) - w.level);
    if (a > best) {
      best = a;
      at = x;
    }
  }
  // 0.5 秒で波頭は 0.1〜0.35 m（浅水波 √(gH) ≈ 1.6 m/s ならもっと先へ行ってしまう）
  assert.ok(at > 0.1 && at < 0.35, `波頭の位置 ${at.toFixed(3)} m`);
});

test('水面: 水位は体積から決まり、オーバーフローより上には上がらない', () => {
  const w = new WaterSim();
  w.addVolume(w.area * 0.05);
  w.step(DT);
  assert.ok(Math.abs(w.level - 0.32) < 1e-6);
  w.addVolume(w.area * 1);
  w.step(DT);
  assert.ok(w.level <= 0.4100001);
});

test('流れ: かき混ぜた後に渦が残り、壁で速度がゼロになる', () => {
  const w = new WaterSim();
  for (let f = 0; f < 120; f++) {
    const a = f * DT * 4;
    w.handCells.length = 0;
    for (let dz = -0.02; dz <= 0.02; dz += 0.0125) {
      for (let dx = -0.02; dx <= 0.02; dx += 0.0125) {
        const k = w.cellIndexAt(0.15 * Math.cos(a) + dx, 0.12 * Math.sin(a) + dz);
        w.handCells.push(k);
        w.hd[k] = 0.08;
        w.hvx[k] = -0.6 * Math.sin(a);
        w.hvz[k] = 0.48 * Math.cos(a);
      }
    }
    w.step(DT);
    for (const k of w.handCells) w.hd[k] = 0;
  }
  w.handCells.length = 0;
  for (let f = 0; f < 60; f++) w.step(DT);
  assert.ok(w.vorticityAt(0, 0) > 0.2, `反時計回りの渦 (${w.vorticityAt(0, 0)})`);
  const fl = w.flow;
  for (const k of fl.fluidList) {
    if (!fl.uOpen[k]) assert.equal(fl.uR[k], 0);
  }
});

test('粒子: 器の中の水は静止し、密度がほぼ基準値になる', () => {
  const f = new FluidSim();
  // 円柱の器（カプセルで底と壁を作る）
  const caps = [];
  const cx = 0.3;
  const cy = 0.6;
  const cz = 0.6;
  for (let x = -0.05; x <= 0.05; x += 0.016) caps.push([[cx + x, cy, cz - 0.055], [cx + x, cy, cz + 0.055]]);
  for (let lvl = 0; lvl < 3; lvl++) {
    const y = cy + 0.012 + lvl * 0.016;
    for (let a = 0; a < 16; a++) {
      const a0 = (a / 16) * Math.PI * 2;
      const a1 = ((a + 1) / 16) * Math.PI * 2;
      caps.push([[cx + Math.cos(a0) * 0.045, y, cz + Math.sin(a0) * 0.045], [cx + Math.cos(a1) * 0.045, y, cz + Math.sin(a1) * 0.045]]);
    }
  }
  const n = caps.length;
  const C = {
    count: n,
    a: new Float32Array(n * 3),
    b: new Float32Array(n * 3),
    r1: new Float32Array(n).fill(0.01),
    r2: new Float32Array(n).fill(0.01),
    va: new Float32Array(n * 3),
    vb: new Float32Array(n * 3),
    bound: [cx, cy, cz, 0.1],
  };
  caps.forEach((c, i) => {
    C.a.set(c[0], i * 3);
    C.b.set(c[1], i * 3);
  });
  C.prevA = C.a;
  C.prevB = C.b;
  f.colliders = C;
  const s = f.spacing;
  for (let x = -0.028; x <= 0.028; x += s) {
    for (let z = -0.028; z <= 0.028; z += s) {
      for (let y = 0; y < 0.03; y += s) if (x * x + z * z < 0.028 * 0.028) f.spawn(cx + x, cy + 0.016 + y, cz + z, 0, 0, 0);
    }
  }
  const n0 = f.count;
  for (let i = 0; i < 150; i++) f.step(DT);
  assert.equal(f.count, n0, 'こぼれていない');
  let rho = 0;
  let speed = 0;
  for (let i = 0; i < f.count; i++) {
    rho += f.density[i] / f.rho0;
    speed += Math.hypot(f.vel[i * 3], f.vel[i * 3 + 1], f.vel[i * 3 + 2]);
  }
  assert.ok(Math.abs(rho / f.count - 1) < 0.08, `平均密度比 ${rho / f.count}`);
  assert.ok(speed / f.count < 0.02, `平均速さ ${speed / f.count}`);
});

test('手: 水をすくって持ち上げると手のひらに水が残り、全体の水量は保存される', () => {
  const hand = new HandModel();
  hand.buildMesh(0.004);
  const water = new WaterSim();
  const fluid = new FluidSim();
  const ctl = new HandController(hand, water);
  ctl.setPose('scoop');
  fluid.colliders = hand.colliders;
  const cpl = new Coupling(water, fluid, hand, ctl);
  const r = rng(11);
  const v0 = water.volume;
  ctl.setTargetXZ(0.05, 0.02);
  for (let f = 0; f < 270; f++) {
    const t = f * DT;
    ctl.diving = t > 0.5 && t < 2.0;
    ctl.update(DT);
    cpl.computeHandColumns();
    cpl.spawnFromHand(DT, r);
    cpl.drips(DT, r);
    water.step(DT);
    fluid.step(DT);
    if (t > 1.0 && t < 1.9) assert.ok(water.handCells.length > 50, '沈めた手が水を押しのけている');
  }
  assert.ok(fluid.count > 25, `手のひらに残った粒子 ${fluid.count}`);
  const total = water.volume + fluid.count * fluid.particleVolume + fluid.spilled;
  assert.ok(Math.abs(total - v0) < 1e-9, '体積保存');
});

test('ゲーム: ゴミの真下で手を沈めて持ち上げると回収され、得点が入る', async () => {
  const { DebrisField } = await import('../src/game/debris.js');
  const { Game } = await import('../src/game/game.js');
  const hand = new HandModel();
  hand.buildMesh(0.004);
  const water = new WaterSim();
  const fluid = new FluidSim();
  const ctl = new HandController(hand, water);
  ctl.setPose('scoop');
  fluid.colliders = hand.colliders;
  const coupling = new Coupling(water, fluid, hand, ctl);
  const debris = new DebrisField(rng(21));
  const game = new Game(debris);
  game.start(rng(5), []);
  // 中央付近のゴミを狙う
  const it = debris.items.reduce((a, i) => (Math.hypot(i.x, i.z) < Math.hypot(a.x, a.z) ? i : a));
  const tx = it.x;
  const tz = it.z;
  const ctx = { water, hand, controller: ctl, coupling };
  const events = [];
  for (let f = 0; f < 300; f++) {
    const t = f * DT;
    ctl.setTargetXZ(tx, tz);
    ctl.diving = t > 1.0 && t < 2.4;
    ctl.update(DT);
    coupling.computeHandColumns();
    water.step(DT);
    events.length = 0;
    debris.update(DT, ctx, events);
    game.update(DT, events);
  }
  assert.ok(it.state === 'collected' || it.state === 'gone', `ゴミの状態 ${it.state}`);
  assert.equal(game.collected >= 1, true);
  assert.ok(game.score >= it.def.points);
  assert.equal(debris.remaining(), debris.items.length - game.collected);
});

test('ゲーム: 時間切れで結果になり、全部すくうと時間ボーナスが入る', async () => {
  const { DebrisField } = await import('../src/game/debris.js');
  const { Game } = await import('../src/game/game.js');
  const debris = new DebrisField();
  const game = new Game(debris);
  game.start(rng(9), []);
  game.update(80, []);
  assert.equal(game.state, 'result');
  assert.equal(game.cleared, false);

  game.start(rng(9), []);
  game.update(10, []);
  const evs = debris.items.map((item) => {
    item.state = 'gone';
    return { type: 'collect', item };
  });
  game.update(0.1, evs);
  assert.equal(game.state, 'result');
  assert.equal(game.cleared, true);
  assert.ok(game.bonus > 0);
  assert.ok(game.maxCombo >= 2, '同時に回収するとコンボ');
});

test('ゲーム: 手の真ん中でとらえても、ときどきスルッと抜ける', async () => {
  const { DebrisField } = await import('../src/game/debris.js');
  const hand = new HandModel();
  hand.buildMesh(0.005);
  const outcomes = { collect: 0, slip: 0, other: 0 };
  for (let trial = 0; trial < 12; trial++) {
    const water = new WaterSim();
    const fluid = new FluidSim();
    const ctl = new HandController(hand, water);
    ctl.setPose('scoop');
    const coupling = new Coupling(water, fluid, hand, ctl);
    const r = rng(trial * 7919 + 13);
    const debris = new DebrisField(r);
    debris.spawn(12, r);
    const it = debris.items[trial % 12];
    const tx = it.x;
    const tz = it.z;
    let out = 'other';
    for (let f = 0; f < 330 && out === 'other'; f++) {
      const t = f * DT;
      ctl.setTargetXZ(tx, tz);
      ctl.diving = t > 0.6 && t < 2.0;
      ctl.update(DT);
      coupling.computeHandColumns();
      water.step(DT);
      for (const e of debris.update(DT, { water, hand, controller: ctl, coupling })) {
        if (e.item !== it) continue;
        if (e.type === 'collect') out = 'collect';
        if (e.type === 'slip' || e.type === 'drop') out = 'slip';
      }
    }
    outcomes[out]++;
  }
  assert.ok(outcomes.collect >= 3, `回収できることもある ${JSON.stringify(outcomes)}`);
  assert.ok(outcomes.slip >= 2, `抜けることもある ${JSON.stringify(outcomes)}`);
});

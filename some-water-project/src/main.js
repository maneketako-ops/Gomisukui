import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FAUCET_TIP, TUB } from './config.js';
import { WaterSim } from './sim/waterSim.js';
import { FluidSim } from './sim/fluidSim.js';
import { Coupling } from './sim/coupling.js';
import { HandModel } from './hand/handModel.js';
import { HandController } from './hand/handController.js';
import { buildBathroom } from './scene/bathroom.js';
import { Duck } from './scene/duck.js';
import { HeightTexture, Caustics, createWaterSurface } from './render/waterSurface.js';
import { FluidRenderer } from './render/fluidRenderer.js';
import { Pipeline } from './render/pipeline.js';
import { DebrisField, COLLECT_TIME } from './game/debris.js';
import { Fx } from './game/fx.js';
import { Game, GAME_TIME } from './game/game.js';
import { Sfx } from './game/sfx.js';
import { Quality } from './quality.js';

const app = document.getElementById('app');
const loading = document.getElementById('loading');

// ---- レンダラー・カメラ -----------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.autoClear = false;
renderer.setClearColor(0x1b1f22, 1);
app.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 20);
camera.position.set(0.22, 0.98, 0.98);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.0, 0.22, -0.02);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 0.45;
controls.maxDistance = 3.2;
controls.maxPolarAngle = 1.4;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
// カメラが水面より下に潜らないようにする
controls.addEventListener('change', () => {
  const minY = TUB.rimY + 0.04;
  if (camera.position.y < minY) camera.position.y = minY;
});
controls.update();

// ---- シミュレーション -------------------------------------------------------

const water = new WaterSim();
const fluid = new FluidSim();
const heightTex = new HeightTexture(water);

// ---- シーン -----------------------------------------------------------------

const scene = new THREE.Scene();
const waterScene = new THREE.Scene();

const lightDirProbe = new THREE.Vector3(0.55, 2.3, 0.75).normalize();
const caustics = new Caustics(heightTex, lightDirProbe);
const bath = buildBathroom(caustics.uniforms);
scene.add(bath.group);
const lightDir = bath.sun.position.clone().sub(bath.sun.target.position).normalize();
caustics.material.uniforms.lightTravel.value.copy(lightDir).negate();

const duck = new Duck();
scene.add(duck.object);

const debris = new DebrisField();
scene.add(debris.group);
const game = new Game(debris);
const sfx = new Sfx();

// 環境マップ: まず汎用の室内環境で照らし、浴室そのものをキューブマップに撮って反射に使う
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
const cubeCam = new THREE.CubeCamera(0.05, 20, cubeRT);
cubeCam.position.set(0.0, 0.32, 0.0);
scene.add(cubeCam);
function captureEnvironment() {
  const prev = duck.object.visible;
  duck.object.visible = false;
  caustics.render(renderer, water.level);
  cubeCam.update(renderer, scene);
  duck.object.visible = prev;
  const env = pmrem.fromCubemap(cubeRT.texture).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.55;
}
captureEnvironment();

const waterMesh = createWaterSurface(heightTex, cubeRT.texture, lightDir);
waterScene.add(waterMesh);
const fluidRenderer = new FluidRenderer(fluid.max, fluid.spacing * 0.95, cubeRT.texture, lightDir);
const pipeline = new Pipeline(renderer);
const fx = new Fx(lightDir);
fx.onPop = () => sfx.bubble();

// ---- 手（生成に少し時間がかかるので描画開始後に作る） -------------------

let hand = null;
let controller = null;
let coupling = null;
let wetness = 0;

function buildHand() {
  const t0 = performance.now();
  hand = new HandModel();
  // スマホでは少し粗いメッシュにして生成を速く
  hand.buildMesh(window.matchMedia('(pointer: coarse)').matches ? 0.0026 : 0.0022);
  scene.add(hand.mesh);
  controller = new HandController(hand, water);
  coupling = new Coupling(water, fluid, hand, controller);
  fluid.colliders = hand.colliders;
  controller.setTargetXZ(0.08, 0.04);
  controller.setShoulderFromCamera(camera);
  controller.armYaw = Math.atan2(controller.shoulder.x - 0.08, controller.shoulder.z - 0.04);
  controller.update(1 / 60);
  console.info(`hand mesh: ${hand.triangleCount} triangles in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ---- 入力 -------------------------------------------------------------------
//  パソコン: マウスで手を動かし、左クリック（または Space）を押している間だけ沈める
//  スマホ  : 画面をなぞって手を動かし、「すくう」ボタンを押している間だけ沈める
//            （指で手が隠れないよう、手は指の少し上に来る）

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
const TOUCH_LIFT = 64; // CSS px
let pointerInside = false;
let aimPointer = null;
let faucetOn = false;
const state = { pose: 'scoop', mode: 'title' };
const dive = { mouse: false, key: false, button: false };

const isCoarse = window.matchMedia('(pointer: coarse)').matches;
function setTouchUI(on) {
  document.body.classList.toggle('touch', on);
  updateModeUI();
}
document.body.classList.toggle('touch', isCoarse);

function setAim(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  pointerInside = true;
}

function aimHand() {
  if (!controller || !pointerInside) return;
  plane.constant = -water.level;
  raycaster.setFromCamera(ndc, camera);
  if (raycaster.ray.intersectPlane(plane, hit)) controller.setTargetXZ(hit.x, hit.z);
}

function applyDive() {
  if (controller) controller.diving = dive.mouse || dive.key || dive.button;
  diveBtn.classList.toggle('active', dive.button);
}

const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    if (!document.body.classList.contains('touch')) setTouchUI(true);
    if (aimPointer === null) {
      aimPointer = e.pointerId;
      setAim(e.clientX, e.clientY - TOUCH_LIFT);
    }
  } else {
    if (document.body.classList.contains('touch') && e.pointerType === 'mouse') setTouchUI(false);
    if (e.button === 0) {
      setAim(e.clientX, e.clientY);
      dive.mouse = true;
      applyDive();
      sfx.unlock();
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    if (e.pointerId === aimPointer) setAim(e.clientX, e.clientY - TOUCH_LIFT);
  } else setAim(e.clientX, e.clientY);
});
const endPointer = (e) => {
  if (e.pointerType === 'touch') {
    if (e.pointerId === aimPointer) aimPointer = null;
  } else if (e.button === 0) {
    dive.mouse = false;
    applyDive();
  }
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'touch') pointerInside = false;
});

const diveBtn = document.getElementById('diveBtn');
diveBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  diveBtn.setPointerCapture(e.pointerId);
  dive.button = true;
  applyDive();
  sfx.unlock();
});
const diveUp = () => {
  dive.button = false;
  applyDive();
};
diveBtn.addEventListener('pointerup', diveUp);
diveBtn.addEventListener('pointercancel', diveUp);
diveBtn.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('blur', () => {
  dive.mouse = dive.key = dive.button = false;
  applyDive();
  if (controller) {
    controller.pouring = false;
    controller.heightInput = 0;
    controller.yawInput = 0;
  }
});

function setPose(name) {
  state.pose = name;
  if (controller) controller.setPose(name);
  document.querySelectorAll('[data-pose]').forEach((b) => b.classList.toggle('active', b.dataset.pose === name));
}
document.querySelectorAll('[data-pose]').forEach((b) => b.addEventListener('click', () => setPose(b.dataset.pose)));

const pourBtn = document.getElementById('pourBtn');
const setPour = (v) => {
  if (controller) controller.pouring = v;
  pourBtn.classList.toggle('active', v);
};
pourBtn.addEventListener('pointerdown', () => setPour(true));
pourBtn.addEventListener('pointerup', () => setPour(false));
pourBtn.addEventListener('pointerleave', () => setPour(false));

const faucetBtn = document.getElementById('faucetBtn');
const setFaucet = (v) => {
  faucetOn = v;
  faucetBtn.classList.toggle('active', faucetOn);
};
faucetBtn.addEventListener('click', () => setFaucet(!faucetOn));

function reset() {
  water.reset();
  fluid.clear();
  fluid.spilled = 0;
  duck.reset();
  if (coupling) coupling.prevBelow.fill(0);
}
document.getElementById('resetBtn').addEventListener('click', reset);

const help = document.getElementById('help');
document.getElementById('helpToggle').addEventListener('click', () => {
  const mobile = window.matchMedia('(max-width: 640px)').matches;
  help.classList.toggle(mobile ? 'expanded' : 'collapsed');
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    if (e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    if (!dive.key) {
      dive.key = true;
      applyDive();
      sfx.unlock();
    }
    return;
  }
  if (e.repeat) return;
  if (state.mode === 'free') {
    const poses = { Digit1: 'scoop', Digit2: 'stir', Digit3: 'open', Digit4: 'fist' };
    if (poses[e.code]) setPose(poses[e.code]);
    if (e.code === 'KeyT') setPour(true);
    if (e.code === 'KeyF') setFaucet(!faucetOn);
    if (e.code === 'KeyR') reset();
  }
  if (e.code === 'Enter' && (state.mode === 'title' || state.mode === 'result')) startGame();
  if (e.code === 'Escape' && state.mode === 'play') toTitle();
  if (!controller) return;
  if (e.code === 'KeyQ') controller.heightInput = 1;
  if (e.code === 'KeyE') controller.heightInput = -1;
  if (e.code === 'KeyZ') controller.yawInput = 1;
  if (e.code === 'KeyX') controller.yawInput = -1;
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    dive.key = false;
    applyDive();
  }
  if (e.code === 'KeyT') setPour(false);
  if (!controller) return;
  if (e.code === 'KeyQ' || e.code === 'KeyE') controller.heightInput = 0;
  if (e.code === 'KeyZ' || e.code === 'KeyX') controller.yawInput = 0;
});

// ---- 画面（モード） ---------------------------------------------------------

const el = (id) => document.getElementById(id);
const ui = {
  title: el('title'),
  result: el('result'),
  hud: el('hud'),
  hint: el('hint'),
  panel: el('panel'),
  help: el('help'),
  popups: el('popups'),
  time: el('hudTime'),
  score: el('hudScore'),
  left: el('hudLeft'),
  best: el('bestScore'),
};
ui.best.textContent = game.best ? `${game.best} 点` : '–';

function updateModeUI() {
  const m = state.mode;
  const touch = document.body.classList.contains('touch');
  ui.title.hidden = m !== 'title';
  ui.result.hidden = m !== 'result';
  ui.hud.hidden = m !== 'play';
  ui.panel.hidden = m !== 'free';
  ui.help.hidden = m !== 'free';
  diveBtn.hidden = !(touch && (m === 'play' || m === 'free'));
  ui.hint.hidden = m !== 'play';
  ui.hint.textContent = touch
    ? '画面をなぞって手を移動。ボタンを押して沈め、離してすくう'
    : 'クリック（Space）している間 沈む → 離すとすくえる';
  controls.enabled = m === 'free';
}

function setMode(m) {
  state.mode = m;
  // 押したボタンにフォーカスが残ると Space でそのボタンが押されてしまうので外す
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  updateModeUI();
  applyCameraPreset();
}

function rng() {
  return Math.random();
}

function startGame() {
  sfx.unlock();
  reset();
  setFaucet(false);
  setPose('scoop');
  const avoid = [
    { x: duck.x, z: duck.z, r: 0.14 },
    { x: controller ? controller.pos.x : 0, z: controller ? controller.pos.z : 0, r: 0.12 },
  ];
  game.start(rng, avoid);
  lastSecond = GAME_TIME;
  setMode('play');
  sfx.start();
}

function toTitle() {
  game.state = 'title';
  debris.clear();
  ui.best.textContent = game.best ? `${game.best} 点` : '–';
  setMode('title');
}

function showResult() {
  if (state.mode !== 'play') return;
  game.state = 'result';
  const r = game.rank();
  el('resultHead').textContent = game.cleared ? 'ぜんぶすくえた！' : 'タイムアップ';
  el('resultRank').textContent = r.name;
  el('resultRankText').textContent = r.text;
  el('resultScore').textContent = game.score;
  el('resultCount').textContent = `${game.collected} / ${game.total}`;
  el('resultCombo').textContent = `×${game.maxCombo}`;
  el('resultCatch').textContent = game.catches || 0;
  el('resultMiss').textContent = game.misses || 0;
  el('resultBonus').textContent = game.bonus;
  el('resultBest').textContent = game.best;
  el('newBest').hidden = !game.newBest;
  const misses = game.misses || 0;
  shareText =
    `お風呂のゴミすくいで ${game.score}点（ランク${r.name}）！\n` +
    `${game.collected}/${game.total}個すくって、${misses}回スルッと逃げられた${misses >= 3 ? '…' : '！'}\n` +
    '#お風呂のゴミすくい';
  el('shareNote').hidden = true;
  setMode('result');
  sfx.finish(game.cleared);
}

el('startBtn').addEventListener('click', startGame);
el('retryBtn').addEventListener('click', startGame);
el('freeBtn').addEventListener('click', () => {
  debris.clear();
  game.state = 'free';
  setMode('free');
});
el('toTitleBtn').addEventListener('click', toTitle);

// ---- 結果のシェア -------------------------------------------------------------

const SHARE_URL = import.meta.env.VITE_SITE_URL || window.location.href.split('#')[0];
let shareText = '';
el('shareMore').hidden = typeof navigator.share !== 'function';
el('shareX').addEventListener('click', () => {
  const url = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(SHARE_URL)}`;
  const w = window.open(url, '_blank', 'noopener');
  if (!w) {
    // ポップアップが開けない環境では、文面をコピーして案内する
    const note = el('shareNote');
    note.hidden = false;
    note.textContent = `${shareText}\n${SHARE_URL}`;
    navigator.clipboard?.writeText(`${shareText}\n${SHARE_URL}`).then(
      () => toast('投稿文をコピーしました'),
      () => {},
    );
  }
});
el('shareMore').addEventListener('click', () => {
  navigator.share({ title: 'お風呂のゴミすくい', text: shareText, url: SHARE_URL }).catch(() => {});
});
el('panelTitleBtn').addEventListener('click', toTitle);
el('quitBtn').addEventListener('click', toTitle);

const projV = new THREE.Vector3();
function popup(x, y, z, html, cls) {
  projV.set(x, y, z).project(camera);
  if (projV.z > 1) return;
  const d = document.createElement('div');
  d.className = `popup ${cls || ''}`;
  d.innerHTML = html;
  d.style.left = `${((projV.x + 1) / 2) * window.innerWidth}px`;
  d.style.top = `${((1 - projV.y) / 2) * window.innerHeight}px`;
  ui.popups.appendChild(d);
  setTimeout(() => d.remove(), 1200);
}

let lastSecond = GAME_TIME;
function updateHud() {
  const t = Math.ceil(game.time);
  ui.time.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  ui.score.textContent = game.score;
  ui.left.textContent = debris.remaining();
  ui.hud.classList.toggle('low', game.time <= 10);
  if (t !== lastSecond) {
    lastSecond = t;
    if (t <= 5 && t > 0) sfx.tick();
  }
}

const debrisEvents = [];
const SLIP_WORDS = ['スルッ…', 'あっ…', '逃げた！', 'ツルン', 'おしい！'];
const DROP_WORDS = ['こぼれた…', 'あぁ…'];
let shake = 0;

// 本物の水しぶき（粒子の水）を飛ばす。体積は浴槽の水から借りる
function spray(x, y, z, n, speed, spread = 1) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.005 + Math.random() * 0.02 * spread;
    const up = speed * (0.6 + Math.random() * 0.7);
    if (
      fluid.spawn(
        x + Math.cos(a) * r,
        y + 0.008,
        z + Math.sin(a) * r,
        Math.cos(a) * speed * 0.45 * spread * Math.random(),
        up,
        Math.sin(a) * speed * 0.45 * spread * Math.random(),
      )
    )
      water.addVolume(-fluid.particleVolume);
  }
}

function vibrate(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // 振動に対応していない端末
  }
}

function runGame(dt) {
  if (!controller) return;
  debrisEvents.length = 0;
  if (debris.items.length) debris.update(dt, { water, hand, controller, coupling }, debrisEvents);
  for (const e of debrisEvents) {
    const it = e.item;
    if (e.type === 'held') {
      if (game.state === 'play') game.catches = (game.catches || 0) + 1;
      sfx.catch();
      fx.catch(it.x, it.y, it.z);
      popup(it.x, it.y + 0.02, it.z, 'キャッチ', 'catch');
    } else if (e.type === 'slip' || e.type === 'drop') {
      const words = e.type === 'slip' ? SLIP_WORDS : DROP_WORDS;
      sfx.slip();
      fx.slip(it.x, it.y, it.z);
      popup(it.x, it.y + 0.02, it.z, words[Math.floor(Math.random() * words.length)], 'slip');
      shake = Math.max(shake, 0.006);
      vibrate([15, 40, 15]);
      if (game.state === 'play') game.misses = (game.misses || 0) + 1;
    } else if (e.type === 'land') {
      const sp = Math.min(2.5, e.speed);
      if (sp > 0.4) {
        spray(it.x, water.heightAt(it.x, it.z), it.z, Math.round(4 + sp * 6), 0.5 + sp * 0.4);
        water.addFoam(it.x, it.z, 0.4, 1.4);
        sfx.splash(sp);
      }
    } else if (e.type === 'collect' && game.state !== 'play') sfx.collect(1);
  }
  if (game.state !== 'play') return;
  const notes = game.update(dt, debrisEvents);
  for (const n of notes) {
    const it = n.item;
    const combo = n.combo > 1;
    fx.burst(it.x, it.y, it.z, combo ? 1.6 + n.combo * 0.3 : 1);
    popup(it.x, it.y + 0.03, it.z, `+${n.points}<small>${it.def.label}</small>`, combo ? 'combo' : 'get');
    if (combo) banner(`${n.combo}コンボ！`, 'combo');
    sfx.collect(n.combo);
    shake = Math.max(shake, combo ? 0.012 : 0.005);
    vibrate(combo ? 50 : 25);
    ui.score.classList.remove('bump');
    void ui.score.offsetWidth;
    ui.score.classList.add('bump');
  }
  updateHud();
  if (game.state === 'result') {
    if (game.cleared) {
      fx.celebrate();
      banner('ぜんぶすくえた！', 'clear');
    } else banner('タイムアップ', 'timeup');
    setTimeout(showResult, 1300);
    game.state = 'result-wait';
  }
}

function banner(text, cls) {
  const b = document.getElementById('banner');
  b.textContent = text;
  b.className = cls;
  void b.offsetWidth;
  b.classList.add('show');
}

// 手に乗っているゴミの「キープ」リング
const ringEls = new Map();
const ringTpl = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="bg" cx="22" cy="22" r="18"/><circle class="fg" cx="22" cy="22" r="18" pathLength="100"/></svg>';
function updateRings() {
  const seen = new Set();
  for (const it of debris.items) {
    if (it.state !== 'held') continue;
    seen.add(it);
    let elR = ringEls.get(it);
    if (!elR) {
      elR = document.createElement('div');
      elR.className = 'keep-ring';
      elR.innerHTML = ringTpl;
      ui.popups.appendChild(elR);
      ringEls.set(it, elR);
    }
    projV.set(it.x, it.y, it.z).project(camera);
    elR.style.left = `${((projV.x + 1) / 2) * window.innerWidth}px`;
    elR.style.top = `${((1 - projV.y) / 2) * window.innerHeight}px`;
    const prog = Math.min(1, it.liftTime / COLLECT_TIME);
    elR.style.setProperty('--p', prog.toFixed(3));
    elR.classList.toggle('wobbly', it.cup.t < 1.3);
  }
  for (const [it, elR] of ringEls) {
    if (seen.has(it)) continue;
    elR.classList.add(it.state === 'collected' || it.state === 'gone' ? 'done' : 'broken');
    setTimeout(() => elR.remove(), 450);
    ringEls.delete(it);
  }
}

// ---- サイズ -----------------------------------------------------------------

const drawSize = new THREE.Vector2();
const freeCam = { pos: camera.position.clone(), target: controls.target.clone() };

// ゲーム中は浴槽全体が見える固定の視点。縦長の画面では浴槽を縦に見る
function applyCameraPreset() {
  const portrait = camera.aspect < 0.9;
  camera.fov = portrait ? 50 : 40;
  if (state.mode === 'free') {
    const k = camera.aspect < 1.2 ? Math.min(2.0, Math.pow(1.2 / camera.aspect, 0.55)) : 1;
    controls.target.copy(freeCam.target);
    camera.position.copy(freeCam.target).addScaledVector(freeCam.pos.clone().sub(freeCam.target), k);
  } else if (portrait) {
    controls.target.set(-0.06, 0.2, 0.0);
    const k = Math.min(1.5, Math.max(1, 0.62 / camera.aspect));
    camera.position.set(-0.06 + 1.0 * k, 0.2 + 1.45 * k, 0.0);
  } else {
    controls.target.set(0.0, 0.2, -0.03);
    const k = camera.aspect < 1.4 ? Math.pow(1.4 / camera.aspect, 0.8) : 1;
    camera.position.set(0.0, 0.2 + 1.18 * k, -0.03 + 0.78 * k);
  }
  camera.updateProjectionMatrix();
  controls.update();
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  applyCameraPreset();
  renderer.getDrawingBufferSize(drawSize);
  pipeline.setSize(drawSize.x, drawSize.y);
  fluidRenderer.setSize(drawSize.x, drawSize.y);
}
window.addEventListener('resize', resize);

// ---- 画質（遅い端末では自動で軽くする） -------------------------------------

let causticsEvery = 1;
function applyQuality(q) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
  if (renderer.shadowMap.enabled !== q.shadows) {
    renderer.shadowMap.enabled = q.shadows;
    scene.traverse((o) => {
      if (o.material) o.material.needsUpdate = true;
    });
  }
  const sh = bath.sun.shadow;
  if (sh.mapSize.x !== q.shadowSize) {
    sh.mapSize.set(q.shadowSize, q.shadowSize);
    if (sh.map) {
      sh.map.dispose();
      sh.map = null;
    }
  }
  fluidRenderer.blurIters = q.blurIters;
  water.lite = q.simLite;
  causticsEvery = q.causticsEvery;
  resize();
}
const quality = new Quality(applyQuality, { coarse: window.matchMedia('(pointer: coarse)').matches });
const qualityBtn = document.getElementById('qualityBtn');
const updateQualityLabel = () => (qualityBtn.textContent = `画質：${quality.label()}`);
updateQualityLabel();
quality.onAutoChange = (q) => {
  updateQualityLabel();
  toast(`動作が重いので画質を「${q.name}」にしました`);
};
qualityBtn.addEventListener('click', () => {
  quality.cycle();
  updateQualityLabel();
});

function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
}

// ---- 蛇口（粒子は新しく加わる水。着水すると水量に加算される） --------------

let faucetAccum = 0;
let faucetFlow = 0;
function runFaucet(dt) {
  faucetFlow += ((faucetOn ? 1 : 0) - faucetFlow) * (1 - Math.exp(-5 * dt));
  for (const [i, h] of bath.handles.entries()) h.rotation.x = faucetFlow * (i === 0 ? 1.2 : -1.2);
  if (faucetFlow < 0.02) return;
  faucetAccum += 280 * faucetFlow * dt;
  // フレーム内の発生時刻に応じて位置をずらし、途切れない水流にする
  const n = Math.floor(faucetAccum);
  faucetAccum -= n;
  for (let i = 0; i < n; i++) {
    const age = ((i + Math.random()) / Math.max(1, n)) * dt;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.0045;
    const vx = 0.08 + (Math.random() - 0.5) * 0.02;
    const vy = -0.55 - Math.random() * 0.05;
    const vz = (Math.random() - 0.5) * 0.02;
    fluid.spawn(
      FAUCET_TIP.x + Math.cos(a) * r + vx * age,
      FAUCET_TIP.y + vy * age - 4.9 * age * age,
      FAUCET_TIP.z + Math.sin(a) * r + vz * age,
      vx,
      vy - 9.81 * age,
      vz,
    );
  }
}

// ---- ループ -----------------------------------------------------------------

const timer = new THREE.Timer();
timer.connect(document);
let fpsAcc = 0;
let fpsFrames = 0;
let statTimer = 0;
const statEls = {
  level: document.getElementById('statLevel'),
  hand: document.getElementById('statHand'),
  particles: document.getElementById('statParticles'),
  fps: document.getElementById('statFps'),
};

function countInHand() {
  if (!hand) return 0;
  let n = 0;
  const p = fluid.pos;
  for (let i = 0; i < fluid.count; i++) {
    if (hand.sdfWorld(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) < 0.03) n++;
  }
  return n;
}

function updateStats(dt) {
  if (state.mode !== 'free') return;
  fpsAcc += dt;
  fpsFrames++;
  statTimer += dt;
  if (statTimer < 0.25) return;
  statTimer = 0;
  statEls.level.textContent = `${(water.level * 100).toFixed(1)} cm`;
  statEls.hand.textContent = `${Math.round(countInHand() * fluid.particleVolume * 1e6)} mL`;
  statEls.particles.textContent = `${fluid.count}`;
  statEls.fps.textContent = `${Math.round(fpsFrames / fpsAcc)}`;
  fpsAcc = 0;
  fpsFrames = 0;
}

function simulate(dt) {
  if (controller) {
    aimHand();
    controller.setShoulderFromCamera(camera);
    controller.update(dt);
    const wasIn = coupling.submergedFraction > 0.02;
    coupling.computeHandColumns();
    // 勢いよく手を突っ込むと水しぶき
    if (!wasIn && coupling.submergedFraction > 0.02 && controller.vel.y < -0.25) {
      const p = controller.pos;
      spray(p.x, water.level, p.z, Math.round(10 + -controller.vel.y * 25), 0.5 - controller.vel.y * 0.8, 2);
      water.addFoam(p.x, p.z, 0.5, 2.5);
      sfx.splash(-controller.vel.y * 2);
    }
    coupling.spawnFromHand(dt);
    coupling.drips(dt);
    // 濡れると肌につやが出て、乾くと戻る
    if (coupling.submergedFraction > 0.02) wetness = 1;
    else wetness = Math.max(0, wetness - dt / 8);
    hand.material.roughness = 0.52 - 0.3 * wetness;
    hand.material.clearcoat = 0.75 * wetness;
  }
  runFaucet(dt);
  fluid.spheres.length = 0;
  fluid.spheres.push(duck.collider());

  water.step(dt);
  fluid.step(dt);
  duck.update(dt, water, hand);
  runGame(dt);
  fx.update(dt, { level: water.level, hand });
}

const shakeOffset = new THREE.Vector3();
let renderFrame = 0;
function render() {
  heightTex.update();
  controls.update();
  // 画面の揺れ
  shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  camera.position.add(shakeOffset);
  shake *= 0.86;
  renderFrame++;
  if (renderFrame % causticsEvery === 0) caustics.render(renderer, water.level);
  pipeline.renderOpaque(scene, camera);
  fluidRenderer.update(fluid);
  fluidRenderer.prepare(renderer, camera);
  pipeline.beginScreen();
  const u = waterMesh.material.uniforms;
  u.level.value = water.level;
  u.sceneColor.value = pipeline.sceneRT.texture;
  u.sceneDepth.value = pipeline.sceneRT.depthTexture;
  u.resolution.value.copy(drawSize);
  u.cameraNear.value = camera.near;
  u.cameraFar.value = camera.far;
  u.camProj.value.copy(camera.projectionMatrix);
  u.time.value = water.time;
  renderer.render(waterScene, camera);
  fluidRenderer.composite(renderer, camera, pipeline.sceneRT.texture);
  fx.render(renderer, camera, drawSize.y);
  camera.position.sub(shakeOffset);
  updateRings();
  document.body.classList.toggle('hurry', state.mode === 'play' && game.state === 'play' && game.time <= 10);
}

let paused = false;
function frame(time) {
  timer.update(time);
  const raw = timer.getDelta();
  if (!paused) simulate(Math.min(raw, 1 / 30));
  render();
  updateStats(raw);
  if (!paused && document.visibilityState === 'visible' && state.mode !== 'free') quality.sample(raw);
  requestAnimationFrame(frame);
}

// 最初の 1 フレームを描いてから手を生成する
requestAnimationFrame(() => {
  setTimeout(() => {
    try {
      buildHand();
      setPose(state.pose);
      setMode('title');
      loading.classList.add('hidden');
    } catch (err) {
      console.error(err);
      loading.classList.add('error');
      loading.querySelector('p').textContent = `手の生成に失敗しました: ${err.message}`;
    }
  }, 30);
  frame();
});

// デバッグ・自動テスト用（シミュレーションを決まった刻みで進められる）
window.__bath = {
  water,
  fluid,
  duck,
  get hand() {
    return hand;
  },
  get controller() {
    return controller;
  },
  setPose,
  reset,
  debris,
  game,
  fx,
  startGame,
  toTitle,
  setMode,
  camera,
  controls,
  pause(v = true) {
    paused = v;
  },
  advance(seconds, dt = 1 / 60) {
    for (let t = 0; t < seconds - 1e-9; t += dt) simulate(dt);
  },
  render,
};

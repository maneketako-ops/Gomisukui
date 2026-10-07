import * as THREE from 'three';
import { TUB, sdTub } from '../config.js';

// 演出: きらきら（加算合成のスプライト）、しゃぼん玉（薄膜干渉の虹色）、湯気。
// 水面・粒子の水を描いたあとに、画面の深度に対して重ねて描く。

const MAX_SPARKS = 900;
const MAX_BUBBLES = 40;
const MAX_STEAM = 36;

const sparkVertex = /* glsl */ `
  attribute vec3 color;
  attribute float size;
  attribute float alpha;
  uniform float pointScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vColor = color;
    vAlpha = alpha;
    gl_PointSize = size * pointScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const sparkFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    if (r > 1.0) discard;
    // 丸い光 + 十字の光芒
    float core = exp(-r * r * 9.0);
    float rays = (exp(-abs(c.x) * 18.0) + exp(-abs(c.y) * 18.0)) * (1.0 - r) * 0.6;
    float a = (core + rays) * vAlpha;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

const steamFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = dot(c, c);
    if (r > 1.0) discard;
    float a = (1.0 - r) * (1.0 - r) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`;

const bubbleVertex = /* glsl */ `
  attribute float phase;
  varying vec3 vN;
  varying vec3 vW;
  varying float vPhase;
  void main() {
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vPhase = phase;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const bubbleFragment = /* glsl */ `
  uniform float time;
  uniform vec3 lightDir;
  varying vec3 vN;
  varying vec3 vW;
  varying float vPhase;
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    vec3 N = normalize(vN);
    float c = abs(dot(N, V));
    float fres = pow(1.0 - c, 2.5);
    // 膜の厚みが場所と時間でゆらぐ → 干渉色
    float thick = 1.6 + 1.2 * sin(vW.y * 90.0 + time * 1.7 + vPhase) + 0.8 * sin((vW.x + vW.z) * 70.0 - time * 1.1);
    vec3 film = 0.5 + 0.5 * cos(6.2831 * (thick * (1.0 - c * 0.6) + vec3(0.0, 0.33, 0.67)));
    vec3 H = normalize(lightDir + V);
    float spec = pow(max(dot(N, H), 0.0), 160.0) * 3.0;
    vec3 col = film * (0.35 + fres) + spec;
    float a = clamp(0.06 + fres * 0.75 + spec, 0.0, 1.0);
    gl_FragColor = vec4(col, a);
  }
`;

export class Fx {
  constructor(lightDir) {
    this.scene = new THREE.Scene();
    this.time = 0;

    // ---- きらきら
    this.sparks = [];
    const sg = new THREE.BufferGeometry();
    this.sPos = new Float32Array(MAX_SPARKS * 3);
    this.sCol = new Float32Array(MAX_SPARKS * 3);
    this.sSize = new Float32Array(MAX_SPARKS);
    this.sAlpha = new Float32Array(MAX_SPARKS);
    sg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sCol, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('size', new THREE.BufferAttribute(this.sSize, 1).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('alpha', new THREE.BufferAttribute(this.sAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    sg.setDrawRange(0, 0);
    this.sparkUniforms = { pointScale: { value: 500 } };
    this.sparkMesh = new THREE.Points(
      sg,
      new THREE.ShaderMaterial({
        uniforms: this.sparkUniforms,
        vertexShader: sparkVertex,
        fragmentShader: sparkFragment,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.sparkMesh.frustumCulled = false;
    this.scene.add(this.sparkMesh);

    // ---- 湯気
    this.steam = [];
    const tg = new THREE.BufferGeometry();
    this.tPos = new Float32Array(MAX_STEAM * 3);
    this.tCol = new Float32Array(MAX_STEAM * 3).fill(1);
    this.tSize = new Float32Array(MAX_STEAM);
    this.tAlpha = new Float32Array(MAX_STEAM);
    tg.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('color', new THREE.BufferAttribute(this.tCol, 3));
    tg.setAttribute('size', new THREE.BufferAttribute(this.tSize, 1).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('alpha', new THREE.BufferAttribute(this.tAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.steamMesh = new THREE.Points(
      tg,
      new THREE.ShaderMaterial({
        uniforms: this.sparkUniforms,
        vertexShader: sparkVertex,
        fragmentShader: steamFragment,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.steamMesh.frustumCulled = false;
    this.scene.add(this.steamMesh);
    for (let i = 0; i < MAX_STEAM; i++) this.steam.push(this._newSteam(Math.random() * 6));

    // ---- しゃぼん玉
    this.bubbles = [];
    const bg = new THREE.SphereGeometry(1, 28, 18);
    this.bPhase = new Float32Array(MAX_BUBBLES);
    bg.setAttribute('phase', new THREE.InstancedBufferAttribute(this.bPhase, 1));
    this.bubbleUniforms = { time: { value: 0 }, lightDir: { value: lightDir.clone() } };
    this.bubbleMesh = new THREE.InstancedMesh(
      bg,
      new THREE.ShaderMaterial({
        uniforms: this.bubbleUniforms,
        vertexShader: bubbleVertex,
        fragmentShader: bubbleFragment,
        transparent: true,
        depthWrite: false,
      }),
      MAX_BUBBLES,
    );
    this.bubbleMesh.count = 0;
    this.bubbleMesh.frustumCulled = false;
    this.scene.add(this.bubbleMesh);
    this.ambientBubbleTimer = 1;
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this.onPop = null; // しゃぼん玉が割れたとき (x, y, z)
  }

  // ---- 発生 -----------------------------------------------------------------

  spark(x, y, z, vx, vy, vz, { color = [1, 0.9, 0.5], size = 0.02, life = 0.8, gravity = -1.5, drag = 1.5 } = {}) {
    if (this.sparks.length >= MAX_SPARKS) this.sparks.shift();
    this.sparks.push({ x, y, z, vx, vy, vz, color, size, life, age: 0, gravity, drag });
  }

  // 回収時: 金色と白の光がはじける
  burst(x, y, z, power = 1) {
    const n = Math.round(40 * power);
    const golds = [
      [1, 0.85, 0.35],
      [1, 1, 0.9],
      [0.55, 0.9, 1],
      [1, 0.6, 0.8],
    ];
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(1 - Math.random() * 1.6);
      const sp = (0.3 + Math.random() * 0.7) * (0.8 + power * 0.3);
      this.spark(
        x,
        y,
        z,
        Math.cos(th) * Math.sin(ph) * sp,
        Math.cos(ph) * sp + 0.25,
        Math.sin(th) * Math.sin(ph) * sp,
        {
          color: golds[i % golds.length],
          size: 0.012 + Math.random() * 0.022 * power,
          life: 0.5 + Math.random() * 0.7,
          gravity: -1.2,
        },
      );
    }
    // 輪っか
    const ring = Math.round(24 * power);
    for (let i = 0; i < ring; i++) {
      const th = (i / ring) * Math.PI * 2;
      this.spark(x, y, z, Math.cos(th) * 0.55, 0.05, Math.sin(th) * 0.55, {
        color: [1, 1, 1],
        size: 0.016,
        life: 0.35,
        gravity: 0,
        drag: 4,
      });
    }
    for (let i = 0; i < Math.round(3 * power); i++) this.addBubble(x + (Math.random() - 0.5) * 0.06, y, z + (Math.random() - 0.5) * 0.06, 0.008 + Math.random() * 0.01);
  }

  // スルッと抜けた: 青い水しぶきの光
  slip(x, y, z) {
    for (let i = 0; i < 18; i++) {
      const th = Math.random() * Math.PI * 2;
      const sp = 0.2 + Math.random() * 0.35;
      this.spark(x, y, z, Math.cos(th) * sp, 0.3 + Math.random() * 0.4, Math.sin(th) * sp, {
        color: [0.6, 0.85, 1],
        size: 0.008 + Math.random() * 0.01,
        life: 0.5 + Math.random() * 0.3,
        gravity: -3,
      });
    }
  }

  // キャッチ: 小さな白い光の輪
  catch(x, y, z) {
    for (let i = 0; i < 14; i++) {
      const th = (i / 14) * Math.PI * 2;
      this.spark(x, y, z, Math.cos(th) * 0.25, 0.12, Math.sin(th) * 0.25, {
        color: [0.85, 1, 1],
        size: 0.01,
        life: 0.4,
        gravity: 0,
        drag: 3,
      });
    }
  }

  // 全部すくえた: しゃぼん玉と光の雨
  celebrate() {
    for (let i = 0; i < 26; i++) {
      const x = (Math.random() * 2 - 1) * (TUB.halfX - 0.1);
      const z = (Math.random() * 2 - 1) * (TUB.halfZ - 0.1);
      this.addBubble(x, 0.3 + Math.random() * 0.2, z, 0.012 + Math.random() * 0.02);
    }
    for (let i = 0; i < 160; i++) {
      const x = (Math.random() * 2 - 1) * TUB.halfX;
      const z = (Math.random() * 2 - 1) * TUB.halfZ;
      this.spark(x, 0.75 + Math.random() * 0.4, z, 0, -0.2 - Math.random() * 0.3, 0, {
        color: [[1, 0.85, 0.3], [0.5, 0.9, 1], [1, 0.55, 0.75], [1, 1, 1]][i % 4],
        size: 0.015 + Math.random() * 0.02,
        life: 1.6 + Math.random(),
        gravity: -0.3,
        drag: 0.3,
      });
    }
  }

  addBubble(x, y, z, r) {
    if (this.bubbles.length >= MAX_BUBBLES) return;
    this.bubbles.push({
      x,
      y,
      z,
      r,
      vx: (Math.random() - 0.5) * 0.05,
      vy: 0.03 + Math.random() * 0.05,
      vz: (Math.random() - 0.5) * 0.05,
      life: 6 + Math.random() * 7,
      age: 0,
      phase: Math.random() * 100,
      wob: Math.random() * 10,
    });
  }

  _newSteam(age = 0) {
    return {
      x: (Math.random() * 2 - 1) * (TUB.halfX - 0.05),
      y: 0.28,
      z: (Math.random() * 2 - 1) * (TUB.halfZ - 0.05),
      vx: (Math.random() - 0.5) * 0.02,
      vy: 0.04 + Math.random() * 0.05,
      life: 5 + Math.random() * 4,
      age,
      size: 0.2 + Math.random() * 0.25,
    };
  }

  // ---- 更新 -----------------------------------------------------------------

  update(dt, { level, hand }) {
    this.time += dt;
    this.bubbleUniforms.time.value = this.time;

    // きらきら
    const S = this.sparks;
    for (let i = S.length - 1; i >= 0; i--) {
      const p = S[i];
      p.age += dt;
      if (p.age >= p.life) {
        S.splice(i, 1);
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy = p.vy * d + p.gravity * dt;
      p.vz *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
    for (let i = 0; i < S.length; i++) {
      const p = S[i];
      const t = p.age / p.life;
      this.sPos[i * 3] = p.x;
      this.sPos[i * 3 + 1] = p.y;
      this.sPos[i * 3 + 2] = p.z;
      this.sCol.set(p.color, i * 3);
      this.sSize[i] = p.size * (1 - t * 0.5);
      this.sAlpha[i] = (1 - t) * (0.6 + 0.4 * Math.sin(p.age * 40 + i));
    }
    const g = this.sparkMesh.geometry;
    for (const k of ['position', 'color', 'size', 'alpha']) g.attributes[k].needsUpdate = true;
    g.setDrawRange(0, S.length);

    // 湯気
    for (let i = 0; i < this.steam.length; i++) {
      let p = this.steam[i];
      p.age += dt;
      if (p.age > p.life) p = this.steam[i] = this._newSteam();
      p.x += (p.vx + Math.sin(this.time * 0.4 + i) * 0.01) * dt;
      p.y += p.vy * dt;
      const t = p.age / p.life;
      this.tPos[i * 3] = p.x;
      this.tPos[i * 3 + 1] = Math.max(p.y, level + 0.02);
      this.tPos[i * 3 + 2] = p.z;
      this.tSize[i] = p.size * (0.6 + t);
      this.tAlpha[i] = 0.09 * Math.sin(Math.PI * t);
    }
    const tg = this.steamMesh.geometry;
    for (const k of ['position', 'size', 'alpha']) tg.attributes[k].needsUpdate = true;

    // しゃぼん玉（ときどき水面から生まれる）
    this.ambientBubbleTimer -= dt;
    if (this.ambientBubbleTimer <= 0) {
      this.ambientBubbleTimer = 1.2 + Math.random() * 2;
      const x = (Math.random() * 2 - 1) * (TUB.halfX - 0.12);
      const z = (Math.random() * 2 - 1) * (TUB.halfZ - 0.1);
      if (sdTub(x, z) < -0.05) this.addBubble(x, level + 0.01, z, 0.01 + Math.random() * 0.018);
    }
    const B = this.bubbles;
    for (let i = B.length - 1; i >= 0; i--) {
      const b = B[i];
      b.age += dt;
      b.wob += dt;
      b.vx += Math.sin(b.wob * 1.3) * 0.02 * dt;
      b.vz += Math.cos(b.wob * 1.1) * 0.02 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      let pop = b.age > b.life;
      if (!pop && hand && hand.sdfWorld(b.x, b.y, b.z) < b.r) pop = true;
      if (pop) {
        this._pop(b);
        B.splice(i, 1);
      }
    }
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      const grow = Math.min(1, b.age / 0.3);
      this._s.setScalar(b.r * grow);
      this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.phase);
      this._m.compose(new THREE.Vector3(b.x, b.y, b.z), this._q, this._s);
      this.bubbleMesh.setMatrixAt(i, this._m);
      this.bPhase[i] = b.phase;
    }
    this.bubbleMesh.count = B.length;
    this.bubbleMesh.instanceMatrix.needsUpdate = true;
    this.bubbleMesh.geometry.attributes.phase.needsUpdate = true;
  }

  _pop(b) {
    for (let i = 0; i < 10; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI;
      const sp = 0.25 + Math.random() * 0.2;
      this.spark(b.x, b.y, b.z, Math.cos(th) * Math.sin(ph) * sp, Math.cos(ph) * sp, Math.sin(th) * Math.sin(ph) * sp, {
        color: [0.8, 0.95, 1],
        size: 0.006,
        life: 0.3,
        gravity: -2,
      });
    }
    if (this.onPop) this.onPop(b.x, b.y, b.z);
  }

  render(renderer, camera, heightPx) {
    this.sparkUniforms.pointScale.value = heightPx * camera.projectionMatrix.elements[5] * 0.5;
    renderer.render(this.scene, camera);
  }
}

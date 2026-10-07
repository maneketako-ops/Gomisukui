import * as THREE from 'three';
import { FAUCET_TIP, ROOM, TUB } from '../config.js';

// 浴室（浴槽・床・壁・蛇口・照明）

// 浴槽内寸の輪郭（角丸長方形）を、中心 c と外向き法線 n の列として返す。
// 輪郭からのオフセット d の点は c + n * (R + d)
function tubContour() {
  const R = TUB.cornerR;
  const ax = TUB.halfX - R;
  const az = TUB.halfZ - R;
  const pts = [];
  const pushLine = (x0, z0, x1, z1, nx, nz, segs) => {
    for (let s = 0; s < segs; s++) {
      const t = s / segs;
      pts.push({ cx: x0 + (x1 - x0) * t, cz: z0 + (z1 - z0) * t, nx, nz });
    }
  };
  const pushArc = (cx, cz, a0, a1, segs) => {
    for (let s = 0; s < segs; s++) {
      const a = a0 + ((a1 - a0) * s) / segs;
      pts.push({ cx, cz, nx: Math.cos(a), nz: Math.sin(a) });
    }
  };
  const cs = 16;
  // 奥の辺の中央から反時計回り（上から見て）
  pushLine(0, -az, ax, -az, 0, -1, 10);
  pushArc(ax, -az, -Math.PI / 2, 0, cs);
  pushLine(ax, -az, ax, az, 1, 0, 3);
  pushArc(ax, az, 0, Math.PI / 2, cs);
  pushLine(ax, az, -ax, az, 0, 1, 20);
  pushArc(-ax, az, Math.PI / 2, Math.PI, cs);
  pushLine(-ax, az, -ax, -az, -1, 0, 3);
  pushArc(-ax, -az, Math.PI, Math.PI * 1.5, cs);
  pushLine(-ax, -az, 0, -az, 0, -1, 10);
  pts.push({ ...pts[0] });
  return pts;
}

// 浴槽の断面（d: 内壁からの外向きオフセット, y）
function tubProfile() {
  const fil = TUB.bottomFillet;
  const rimR = TUB.wallT * 0.5;
  const prof = [];
  const arc = (cd, cy, r, a0, a1, segs) => {
    for (let s = 0; s <= segs; s++) {
      const a = a0 + ((a1 - a0) * s) / segs;
      prof.push([cd + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(-fil, TUB.floorY + fil, fil, -Math.PI / 2, 0, 8);
  const wallTop = TUB.rimY - rimR;
  for (let s = 1; s <= 6; s++) prof.push([0, TUB.floorY + fil + ((wallTop - TUB.floorY - fil) * s) / 6]);
  arc(rimR, wallTop, rimR, Math.PI, 0, 14);
  const bot = TUB.baseY + 0.012;
  for (let s = 1; s <= 6; s++) prof.push([TUB.wallT, wallTop + ((bot - wallTop) * s) / 6]);
  arc(TUB.wallT - 0.012, bot, 0.012, 0, -Math.PI / 2, 4);
  return prof;
}

function buildTubGeometry() {
  const contour = tubContour();
  const prof = tubProfile();
  const R = TUB.cornerR;
  const nu = contour.length;
  const nv = prof.length;
  const pos = new Float32Array(nu * nv * 3);
  const nor = new Float32Array(nu * nv * 3);
  for (let u = 0; u < nu; u++) {
    const c = contour[u];
    for (let v = 0; v < nv; v++) {
      const [d, y] = prof[v];
      const o = (u * nv + v) * 3;
      pos[o] = c.cx + c.nx * (R + d);
      pos[o + 1] = y;
      pos[o + 2] = c.cz + c.nz * (R + d);
      // 断面の接線 (dd, dy) から法線 (-dy, dd)
      const a = prof[Math.max(0, v - 1)];
      const b = prof[Math.min(nv - 1, v + 1)];
      const td = b[0] - a[0];
      const ty = b[1] - a[1];
      const l = Math.hypot(td, ty) || 1;
      const nd = -ty / l;
      const ny = td / l;
      nor[o] = c.nx * nd;
      nor[o + 1] = ny;
      nor[o + 2] = c.nz * nd;
    }
  }
  const idx = [];
  for (let u = 0; u < nu - 1; u++) {
    for (let v = 0; v < nv - 1; v++) {
      const a = u * nv + v;
      const b = (u + 1) * nv + v;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  fixWinding(geo);

  // 底面（輪郭を内側へ fillet 分だけ縮めた角丸長方形）
  const fpos = [0, TUB.floorY, 0];
  for (let u = 0; u < nu; u++) {
    const c = contour[u];
    const rr = R - TUB.bottomFillet;
    fpos.push(c.cx + c.nx * rr, TUB.floorY, c.cz + c.nz * rr);
  }
  const fidx = [];
  for (let u = 1; u < nu; u++) fidx.push(0, u, u + 1 > nu ? 1 : u + 1);
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
  fgeo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(fpos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  fgeo.setIndex(fidx);
  fixWinding(fgeo);
  return { wall: geo, floor: fgeo };
}

// 三角形の向きを頂点法線に合わせる
function fixWinding(geo) {
  const p = geo.attributes.position.array;
  const n = geo.attributes.normal.array;
  const ind = geo.index.array;
  for (let t = 0; t < ind.length; t += 3) {
    const a = ind[t] * 3;
    const b = ind[t + 1] * 3;
    const c = ind[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * (n[a] + n[b] + n[c]) + cy * (n[a + 1] + n[b + 1] + n[c + 1]) + cz * (n[a + 2] + n[b + 2] + n[c + 2]) < 0) {
      const tmp = ind[t + 1];
      ind[t + 1] = ind[t + 2];
      ind[t + 2] = tmp;
    }
  }
}

function tileTexture({ size = 1024, tiles = 6, color = '#eef0ee', grout = '#c9ccca', jitter = 6, groutW = 6, seed = 1 }) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = grout;
  g.fillRect(0, 0, size, size);
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const base = new THREE.Color(color);
  const ts = size / tiles;
  for (let j = 0; j < tiles; j++) {
    for (let i = 0; i < tiles; i++) {
      const v = (rnd() - 0.5) * jitter * 0.01;
      const col = base.clone().offsetHSL(0, 0, v);
      const x = i * ts + groutW * 0.5;
      const y = j * ts + groutW * 0.5;
      const w = ts - groutW;
      const grd = g.createLinearGradient(x, y, x + w, y + w);
      grd.addColorStop(0, `#${col.clone().offsetHSL(0, 0, 0.02).getHexString()}`);
      grd.addColorStop(1, `#${col.clone().offsetHSL(0, 0, -0.02).getHexString()}`);
      g.fillStyle = grd;
      const r = groutW * 0.8;
      g.beginPath();
      g.roundRect(x, y, w, w, r);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// 水中の床・壁に集光模様（コースティクス）を乗せる
export function addCaustics(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCausticWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCausticWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCausticWorld;
        uniform sampler2D causticsTex;
        uniform vec4 causticsXform;
        uniform float causticsLevel;
        uniform float causticsFloorY;
        uniform float causticsStrength;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          vec2 cuv = (vCausticWorld.xz - causticsXform.xy) * causticsXform.zw;
          float inside = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
          float under = smoothstep(causticsLevel + 0.004, causticsLevel - 0.004, vCausticWorld.y) * inside;
          float nearFloor = 0.45 + 0.55 * exp(-max(vCausticWorld.y - causticsFloorY, 0.0) / 0.07);
          float c = texture2D(causticsTex, cuv).r;
          float k = under * nearFloor * causticsStrength;
          reflectedLight.directDiffuse *= mix(1.0, c, k);
          reflectedLight.directSpecular *= mix(1.0, c, k);
        }`,
      );
  };
}

export function buildBathroom(causticsUniforms) {
  const group = new THREE.Group();

  // 浴槽
  const tubGeo = buildTubGeometry();
  const tubMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(0.95, 0.95, 0.93, THREE.SRGBColorSpace),
    roughness: 0.22,
    clearcoat: 0.7,
    clearcoatRoughness: 0.08,
  });
  addCaustics(tubMat, causticsUniforms);
  const tubWall = new THREE.Mesh(tubGeo.wall, tubMat);
  const tubFloor = new THREE.Mesh(tubGeo.floor, tubMat);
  for (const m of [tubWall, tubFloor]) {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  tubFloor.castShadow = false;

  // 床
  const floorTex = tileTexture({ tiles: 4, color: '#8d9497', grout: '#6c7275', jitter: 8, groutW: 8, seed: 7 });
  floorTex.repeat.set(10, 10);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.42, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(1.0, TUB.baseY, 1.0);
  floor.receiveShadow = true;
  group.add(floor);

  // 壁（白いタイル）
  const wallTex = tileTexture({ tiles: 8, color: '#f2f3f1', grout: '#d7dad8', jitter: 3, groutW: 7, seed: 3 });
  const wallMat = (rx, ry) => {
    const t = wallTex.clone();
    t.needsUpdate = true;
    t.repeat.set(rx, ry);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.25 });
  };
  const H = 2.5;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(6, H), wallMat(5, H / 1.2));
  back.position.set(1.0, TUB.baseY + H / 2, ROOM.backWallZ);
  back.receiveShadow = true;
  group.add(back);
  const left = new THREE.Mesh(new THREE.PlaneGeometry(6, H), wallMat(5, H / 1.2));
  left.rotation.y = Math.PI / 2;
  left.position.set(ROOM.leftWallX, TUB.baseY + H / 2, 1.0);
  left.receiveShadow = true;
  group.add(left);
  const right = new THREE.Mesh(new THREE.PlaneGeometry(6, H), wallMat(5, H / 1.2));
  right.rotation.y = -Math.PI / 2;
  right.position.set(ROOM.rightWallX, TUB.baseY + H / 2, 1.0);
  group.add(right);
  const front = new THREE.Mesh(new THREE.PlaneGeometry(6, H), wallMat(5, H / 1.2));
  front.rotation.y = Math.PI;
  front.position.set(1.0, TUB.baseY + H / 2, ROOM.frontWallZ);
  group.add(front);
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ color: 0xe9ebea, roughness: 0.8 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(1.0, TUB.baseY + H, 1.0);
  group.add(ceiling);

  // 天井照明と曇りガラスの窓（水面に映り込む）
  const lamp = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 40),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(5.5, 5.2, 4.6) }),
  );
  lamp.rotation.x = Math.PI / 2;
  lamp.position.set(0.15, TUB.baseY + H - 0.01, 0.35);
  group.add(lamp);
  const win = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.55),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.7, 3.1) }),
  );
  win.position.set(0.05, 1.45, ROOM.backWallZ + 0.003);
  group.add(win);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xdedfdc, roughness: 0.4 });
  for (const [w, h, x, y] of [
    [0.96, 0.03, 0.05, 1.735],
    [0.96, 0.03, 0.05, 1.165],
    [0.03, 0.6, -0.415, 1.45],
    [0.03, 0.6, 0.515, 1.45],
    [0.03, 0.55, 0.05, 1.45],
  ]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.025), frameMat);
    f.position.set(x, y, ROOM.backWallZ + 0.012);
    group.add(f);
  }

  // 蛇口（クロム）
  const chrome = new THREE.MeshPhysicalMaterial({ color: 0xf2f4f6, metalness: 1, roughness: 0.08 });
  const tip = FAUCET_TIP;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(ROOM.leftWallX, tip.y + 0.06, tip.z),
    new THREE.Vector3(ROOM.leftWallX + 0.08, tip.y + 0.065, tip.z),
    new THREE.Vector3(tip.x - 0.035, tip.y + 0.055, tip.z),
    new THREE.Vector3(tip.x - 0.004, tip.y + 0.03, tip.z),
    new THREE.Vector3(tip.x, tip.y + 0.004, tip.z),
  ]);
  const spout = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.014, 20, false), chrome);
  spout.castShadow = true;
  group.add(spout);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0145, 0.012, 20), chrome);
  nozzle.position.set(tip.x, tip.y + 0.006, tip.z);
  group.add(nozzle);
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.012, 32), chrome);
  plate.rotation.z = Math.PI / 2;
  plate.position.set(ROOM.leftWallX + 0.006, tip.y + 0.06, tip.z);
  group.add(plate);
  const handles = [];
  for (const dz of [-0.13, 0.13]) {
    const h = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.05, 20), chrome);
    stem.rotation.z = Math.PI / 2;
    stem.position.x = 0.025;
    h.add(stem);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.022, 24, 16), chrome);
    knob.scale.set(0.6, 1, 1);
    knob.position.x = 0.052;
    h.add(knob);
    const cap = new THREE.Mesh(
      new THREE.CircleGeometry(0.008, 20),
      new THREE.MeshBasicMaterial({ color: dz < 0 ? 0xd23b3b : 0x3b6fd2 }),
    );
    cap.rotation.y = Math.PI / 2;
    cap.position.x = 0.0655;
    h.add(cap);
    h.position.set(ROOM.leftWallX, tip.y + 0.06, tip.z + dz);
    h.traverse((o) => (o.castShadow = true));
    group.add(h);
    handles.push(h);
  }

  // 照明
  const hemi = new THREE.HemisphereLight(0xf4f6ff, 0x8a8f94, 0.5);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.6);
  sun.position.set(0.55, 2.3, 0.75);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -1.1;
  sc.right = 1.1;
  sc.top = 0.9;
  sc.bottom = -0.9;
  sc.near = 0.5;
  sc.far = 4;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.01;
  sun.shadow.radius = 3;
  group.add(sun);
  group.add(sun.target);
  const fill = new THREE.PointLight(0xffe9d2, 1.2, 4, 2);
  fill.position.set(1.4, 1.6, 1.6);
  group.add(fill);

  return { group, sun, tubMaterial: tubMat, handles };
}

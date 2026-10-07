import * as THREE from 'three';
import { TUB, sdTub, sdTubNormal } from '../config.js';

// 水面のメッシュとシェーダー、および浴槽の底に落ちる集光模様（コースティクス）

// 浴槽内寸を覆う格子。外にはみ出す頂点は輪郭上へ寄せて、縁にぴったり沿わせる
export function buildWaterGeometry(res, inflate = 0.004) {
  const nx = Math.round((2 * TUB.halfX) / res);
  const nz = Math.round((2 * TUB.halfZ) / res);
  const pos = [];
  const outside = [];
  const n = [0, 0];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      let x = -TUB.halfX - inflate + (i / nx) * (2 * TUB.halfX + 2 * inflate);
      let z = -TUB.halfZ - inflate + (j / nz) * (2 * TUB.halfZ + 2 * inflate);
      const sd = sdTub(x, z);
      outside.push(sd > inflate ? 1 : 0);
      if (sd > inflate) {
        // 輪郭へ射影（数回反復）
        for (let it = 0; it < 4; it++) {
          const s = sdTub(x, z) - inflate;
          sdTubNormal(x, z, n);
          x -= n[0] * s;
          z -= n[1] * s;
        }
      }
      pos.push(x, 0, z);
    }
  }
  const idx = [];
  const w = nx + 1;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * w + i;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (outside[a] && outside[b] && outside[c] && outside[d]) continue;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.3, 0), 1.2);
  return geo;
}

export class HeightTexture {
  constructor(water) {
    this.water = water;
    const { GX, GZ } = water;
    this.data = new Uint16Array(GX * GZ * 4);
    this.texture = new THREE.DataTexture(this.data, GX, GZ, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    // ワールド xz -> テクスチャ uv
    this.xform = new THREE.Vector4(water.x0, water.z0, 1 / (GX * water.dx), 1 / (GZ * water.dx));
  }

  update() {
    const src = this.water.texData;
    const dst = this.data;
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < src.length; i++) dst[i] = toHalf(src[i]);
    this.texture.needsUpdate = true;
  }
}

const surfaceVertex = /* glsl */ `
  uniform sampler2D heightTex;
  uniform vec4 gridXform;
  uniform float level;
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vec2 uv = (position.xz - gridXform.xy) * gridXform.zw;
    vec4 t = texture2D(heightTex, uv);
    vec3 p = vec3(position.x, level + t.r, position.z);
    vWorld = p;
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const surfaceFragment = /* glsl */ `
  #include <packing>
  uniform sampler2D heightTex;
  uniform sampler2D sceneColor;
  uniform sampler2D sceneDepth;
  uniform samplerCube envMap;
  uniform vec2 resolution;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform vec3 lightDir;
  uniform vec3 lightColor;
  uniform vec3 absorption;
  uniform vec3 scatterColor;
  uniform float time;
  uniform vec2 texel;
  uniform mat4 camProj;
  varying vec3 vWorld;
  varying vec2 vUv;

  float viewDepthAt(vec2 uv) {
    return -perspectiveDepthToViewZ(texture2D(sceneDepth, uv).x, cameraNear, cameraFar);
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  // 泡の模様（小さな泡がつながったような細胞状ノイズ）
  float bubbles(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float d = 1.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = vec2(hash(i + g), hash(i + g + 17.3));
        o = 0.5 + 0.4 * sin(time * 0.6 + 6.2831 * o);
        d = min(d, length(g + o - f));
      }
    return d;
  }

  void main() {
    // 法線（グリッドのなめらかな勾配 + 4 点平均で少しだけ平滑化）
    vec4 t = texture2D(heightTex, vUv);
    vec2 gsum = t.gb * 2.0;
    gsum += texture2D(heightTex, vUv + vec2(texel.x, 0.0)).gb * 0.5;
    gsum += texture2D(heightTex, vUv - vec2(texel.x, 0.0)).gb * 0.5;
    gsum += texture2D(heightTex, vUv + vec2(0.0, texel.y)).gb * 0.5;
    gsum += texture2D(heightTex, vUv - vec2(0.0, texel.y)).gb * 0.5;
    vec2 grad = gsum / 4.0;
    vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));

    vec3 toCam = cameraPosition - vWorld;
    float camDist = length(toCam);
    vec3 V = toCam / camDist;
    if (dot(N, V) < 0.02) N = normalize(N + V * (0.02 - dot(N, V)));
    float cosT = clamp(dot(N, V), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

    // 反射
    vec3 R = reflect(-V, N);
    vec3 refl = textureCube(envMap, R).rgb;
    vec3 H = normalize(lightDir + V);
    float spec = pow(max(dot(N, H), 0.0), 900.0) * 9.0 + pow(max(dot(N, H), 0.0), 120.0) * 0.25;

    // 屈折（画面空間）。水中の物体ほど大きくずれる
    vec2 suv = gl_FragCoord.xy / resolution;
    vec4 viewPos = viewMatrix * vec4(vWorld, 1.0);
    float fragDepth = -viewPos.z;
    float sceneD = viewDepthAt(suv);
    float thick0 = max(sceneD - fragDepth, 0.0);
    vec3 refrDir = refract(-V, N, 1.0 / 1.333);
    vec3 target = vWorld + refrDir * min(thick0 * 0.9, 0.35);
    vec4 clip = camProj * viewMatrix * vec4(target, 1.0);
    vec2 ruv = clamp(clip.xy / clip.w * 0.5 + 0.5, vec2(0.001), vec2(0.999));
    float rd = viewDepthAt(ruv);
    if (rd < fragDepth) { ruv = suv; rd = sceneD; }
    vec3 refr = texture2D(sceneColor, ruv).rgb;
    // 水中の光路長（視線方向）に応じた吸収と散乱
    float pathLen = max(rd - fragDepth, 0.0) * camDist / max(fragDepth, 1e-3);
    vec3 trans = exp(-absorption * pathLen);
    refr = refr * trans + scatterColor * (1.0 - trans);

    vec3 col = mix(refr, refl, F) + lightColor * spec * (0.3 + F);

    // 泡
    float foam = clamp(t.a, 0.0, 1.5);
    if (foam > 0.01) {
      vec2 fp = vWorld.xz * 140.0;
      float b = bubbles(fp);
      float b2 = bubbles(fp * 0.45 + 7.0);
      float n = vnoise(vWorld.xz * 25.0 + time * 0.2);
      float mask = smoothstep(0.0, 1.0, foam * (1.2 - b * 0.9) * (0.6 + 0.6 * n) + foam * 0.35 * (1.0 - b2));
      mask = clamp(mask, 0.0, 0.92);
      vec3 foamCol = vec3(0.92) * (0.55 + 0.45 * max(dot(N, lightDir), 0.0)) + refl * 0.15;
      col = mix(col, foamCol, mask);
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createWaterSurface(heightTex, envMap, lightDir) {
  const geo = buildWaterGeometry(0.00625);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      heightTex: { value: heightTex.texture },
      gridXform: { value: heightTex.xform },
      level: { value: 0.27 },
      sceneColor: { value: null },
      sceneDepth: { value: null },
      envMap: { value: envMap },
      resolution: { value: new THREE.Vector2(1, 1) },
      cameraNear: { value: 0.05 },
      cameraFar: { value: 20 },
      lightDir: { value: lightDir.clone() },
      lightColor: { value: new THREE.Color(1.0, 0.96, 0.9) },
      absorption: { value: new THREE.Vector3(2.2, 0.62, 0.38) },
      scatterColor: { value: new THREE.Color(0.03, 0.085, 0.095) },
      time: { value: 0 },
      texel: { value: new THREE.Vector2(1 / heightTex.water.GX, 1 / heightTex.water.GZ) },
      camProj: { value: new THREE.Matrix4() },
    },
    vertexShader: surfaceVertex,
    fragmentShader: surfaceFragment,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

// ---- コースティクス ------------------------------------------------------

const causticsVertex = /* glsl */ `
  uniform sampler2D heightTex;
  uniform vec4 gridXform;
  uniform float level;
  uniform float floorY;
  uniform vec3 lightTravel;
  uniform vec4 floorXform;
  varying vec3 vOld;
  varying vec3 vNew;
  void main() {
    vec2 uv = (position.xz - gridXform.xy) * gridXform.zw;
    vec4 t = texture2D(heightTex, uv);
    vec3 N = normalize(vec3(-t.g, 1.0, -t.b));
    vec3 P = vec3(position.x, level + t.r, position.z);
    vec3 P0 = vec3(position.x, level, position.z);
    vec3 Rn = refract(lightTravel, N, 1.0 / 1.333);
    vec3 R0 = refract(lightTravel, vec3(0.0, 1.0, 0.0), 1.0 / 1.333);
    vNew = P + Rn * ((floorY - P.y) / Rn.y);
    vOld = P0 + R0 * ((floorY - P0.y) / R0.y);
    vec2 fuv = (vNew.xz - floorXform.xy) * floorXform.zw;
    gl_Position = vec4(fuv * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const causticsFragment = /* glsl */ `
  varying vec3 vOld;
  varying vec3 vNew;
  void main() {
    float oldArea = length(cross(dFdx(vOld), dFdy(vOld)));
    float newArea = length(cross(dFdx(vNew), dFdy(vNew)));
    float ratio = oldArea / max(newArea, 1e-12);
    gl_FragColor = vec4(min(ratio, 8.0), 0.0, 0.0, 1.0);
  }
`;

export class Caustics {
  constructor(heightTex, lightDir) {
    const size = [512, 256];
    this.target = new THREE.WebGLRenderTarget(size[0], size[1], {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const m = 0.02;
    const minX = -TUB.halfX - m;
    const minZ = -TUB.halfZ - m;
    const sx = 2 * (TUB.halfX + m);
    const sz = 2 * (TUB.halfZ + m);
    this.xform = new THREE.Vector4(minX, minZ, 1 / sx, 1 / sz);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        heightTex: { value: heightTex.texture },
        gridXform: { value: heightTex.xform },
        level: { value: 0.27 },
        floorY: { value: TUB.floorY },
        lightTravel: { value: lightDir.clone().negate() },
        floorXform: { value: this.xform },
      },
      vertexShader: causticsVertex,
      fragmentShader: causticsFragment,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(buildWaterGeometry(0.005, 0.0), this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.uniforms = {
      causticsTex: { value: this.target.texture },
      causticsXform: { value: this.xform },
      causticsLevel: { value: 0.27 },
      causticsFloorY: { value: TUB.floorY },
      causticsStrength: { value: 1.0 },
    };
  }

  render(renderer, level) {
    this.material.uniforms.level.value = level;
    this.uniforms.causticsLevel.value = level;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
  }
}

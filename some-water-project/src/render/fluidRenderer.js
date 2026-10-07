import * as THREE from 'three';

// 粒子の水を「つながった水」として描く画面空間流体レンダリング。
// 1. 粒子を球として深度だけ描く  2. 深度をバイラテラルフィルタでなめらかにする
// 3. 厚みを加算で描く  4. 法線を復元して屈折・反射・吸収で合成（gl_FragDepth で奥行きも正しく）

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const depthVertex = /* glsl */ `
  uniform float radius;
  uniform float pointScale;
  varying vec3 vViewCenter;
  void main() {
    vec4 vp = modelViewMatrix * vec4(position, 1.0);
    vViewCenter = vp.xyz;
    gl_PointSize = max(2.0, radius * pointScale / -vp.z);
    gl_Position = projectionMatrix * vp;
  }
`;

const depthFragment = /* glsl */ `
  uniform float radius;
  uniform mat4 projMat;
  varying vec3 vViewCenter;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    c.y = -c.y;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float nz = sqrt(1.0 - r2);
    vec3 p = vViewCenter + vec3(c * radius, nz * radius);
    vec4 clip = projMat * vec4(p, 1.0);
    gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
    gl_FragColor = vec4(-p.z, 0.0, 0.0, 1.0);
  }
`;

const thicknessFragment = /* glsl */ `
  varying vec3 vViewCenter;
  uniform float radius;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float t = sqrt(1.0 - r2) * 2.0 * radius;
    gl_FragColor = vec4(t, 0.0, 0.0, 1.0);
  }
`;

const blurFragment = /* glsl */ `
  uniform sampler2D tDepth;
  uniform vec2 dir;
  uniform float worldRadius;
  uniform float pxPerUnit;
  uniform float depthFalloff;
  varying vec2 vUv;
  void main() {
    float d = texture2D(tDepth, vUv).r;
    if (d <= 0.0) { gl_FragColor = vec4(0.0); return; }
    float rpx = clamp(worldRadius * pxPerUnit / d, 1.0, 24.0);
    float sigma = rpx * 0.5;
    float sum = d;
    float wsum = 1.0;
    for (int i = 1; i <= 24; i++) {
      float fi = float(i);
      if (fi > rpx) break;
      float wr = exp(-fi * fi / (2.0 * sigma * sigma));
      for (int s = -1; s <= 1; s += 2) {
        float v = texture2D(tDepth, vUv + dir * fi * float(s)).r;
        if (v <= 0.0) continue;
        float dz = (v - d) / depthFalloff;
        float w = wr * exp(-dz * dz);
        sum += v * w;
        wsum += w;
      }
    }
    gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
  }
`;

const compositeFragment = /* glsl */ `
  uniform sampler2D tDepth;
  uniform sampler2D tThick;
  uniform sampler2D sceneColor;
  uniform samplerCube envMap;
  uniform mat4 camProj;
  uniform mat4 camWorld;
  uniform vec2 texel;
  uniform vec3 lightDirView;
  uniform vec3 lightColor;
  uniform vec3 absorption;
  varying vec2 vUv;

  vec3 viewPos(vec2 uv, float d) {
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc.x * d / camProj[0][0], ndc.y * d / camProj[1][1], -d);
  }

  void main() {
    float d = texture2D(tDepth, vUv).r;
    if (d <= 0.0) discard;
    vec3 p = viewPos(vUv, d);
    // 法線（段差の小さい側の差分を使う）
    float dxp = texture2D(tDepth, vUv + vec2(texel.x, 0.0)).r;
    float dxn = texture2D(tDepth, vUv - vec2(texel.x, 0.0)).r;
    float dyp = texture2D(tDepth, vUv + vec2(0.0, texel.y)).r;
    float dyn = texture2D(tDepth, vUv - vec2(0.0, texel.y)).r;
    vec3 ddx = viewPos(vUv + vec2(texel.x, 0.0), dxp > 0.0 ? dxp : d) - p;
    vec3 ddx2 = p - viewPos(vUv - vec2(texel.x, 0.0), dxn > 0.0 ? dxn : d);
    if (abs(ddx2.z) < abs(ddx.z)) ddx = ddx2;
    vec3 ddy = viewPos(vUv + vec2(0.0, texel.y), dyp > 0.0 ? dyp : d) - p;
    vec3 ddy2 = p - viewPos(vUv - vec2(0.0, texel.y), dyn > 0.0 ? dyn : d);
    if (abs(ddy2.z) < abs(ddy.z)) ddy = ddy2;
    vec3 n = normalize(cross(ddx, ddy));
    vec3 v = normalize(-p);
    if (dot(n, v) < 0.0) n = -n;

    float thick = texture2D(tThick, vUv).r;
    float cosT = clamp(dot(n, v), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

    vec3 nW = normalize((camWorld * vec4(n, 0.0)).xyz);
    vec3 vW = normalize((camWorld * vec4(v, 0.0)).xyz);
    vec3 refl = textureCube(envMap, reflect(-vW, nW)).rgb;

    vec2 ruv = clamp(vUv + n.xy * (0.006 + thick * 0.8), vec2(0.001), vec2(0.999));
    vec3 bg = texture2D(sceneColor, ruv).rgb;
    vec3 trans = exp(-absorption * thick * 3.0);
    vec3 col = bg * trans + vec3(0.05, 0.12, 0.13) * (1.0 - trans) * 0.6;

    vec3 h = normalize(lightDirView + v);
    float spec = pow(max(dot(n, h), 0.0), 500.0) * 7.0 + pow(max(dot(n, h), 0.0), 60.0) * 0.2;
    col = mix(col, refl, F) + lightColor * spec;

    vec4 clip = camProj * vec4(p, 1.0);
    gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class FluidRenderer {
  constructor(maxParticles, radius, envMap, lightDir) {
    this.radius = radius;
    this.lightDir = lightDir.clone();
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(maxParticles * 3);
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

    const common = { radius: { value: radius }, pointScale: { value: 1 }, projMat: { value: new THREE.Matrix4() } };
    this.depthMat = new THREE.ShaderMaterial({
      uniforms: common,
      vertexShader: depthVertex,
      fragmentShader: depthFragment,
    });
    this.thickMat = new THREE.ShaderMaterial({
      uniforms: common,
      vertexShader: depthVertex,
      fragmentShader: thicknessFragment,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, this.depthMat);
    this.points.frustumCulled = false;
    this.pointsScene = new THREE.Scene();
    this.pointsScene.add(this.points);

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        dir: { value: new THREE.Vector2() },
        worldRadius: { value: radius * 3.0 },
        pxPerUnit: { value: 1 },
        depthFalloff: { value: radius * 3.0 },
      },
      vertexShader: quadVertex,
      fragmentShader: blurFragment,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        tThick: { value: null },
        sceneColor: { value: null },
        envMap: { value: envMap },
        camProj: { value: new THREE.Matrix4() },
        camWorld: { value: new THREE.Matrix4() },
        texel: { value: new THREE.Vector2() },
        lightDirView: { value: new THREE.Vector3() },
        lightColor: { value: new THREE.Color(1.0, 0.96, 0.9) },
        absorption: { value: new THREE.Vector3(2.2, 0.62, 0.38) },
      },
      vertexShader: quadVertex,
      fragmentShader: compositeFragment,
      depthTest: true,
      depthWrite: true,
    });
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(quadGeo, this.blurMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.count = 0;
    this.blurIters = 3;
    this._makeTargets(2, 2);
  }

  _makeTargets(w, h) {
    const opts = {
      // 深度は half だと量子化で縞模様が出るので 32bit
      type: THREE.FloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    };
    this.depthRT = new THREE.WebGLRenderTarget(w, h, { ...opts, depthBuffer: true });
    this.blurA = new THREE.WebGLRenderTarget(w, h, opts);
    this.blurB = new THREE.WebGLRenderTarget(w, h, opts);
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.thickRT = new THREE.WebGLRenderTarget(hw, hh, { ...opts, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.w = w;
    this.h = h;
  }

  setSize(w, h) {
    if (w === this.w && h === this.h) return;
    for (const rt of [this.depthRT, this.blurA, this.blurB, this.thickRT]) rt.dispose();
    this._makeTargets(w, h);
  }

  update(fluid) {
    const n = fluid.count;
    this.positions.set(fluid.pos.subarray(0, n * 3));
    this.posAttr.needsUpdate = true;
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, n * 3);
    this.geometry.setDrawRange(0, n);
    this.count = n;
  }

  // 深度・厚みの前処理（オフスクリーン）
  prepare(renderer, camera) {
    if (this.count === 0) return;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const pointScale = this.h * camera.projectionMatrix.elements[5];
    this.depthMat.uniforms.pointScale.value = pointScale;
    this.depthMat.uniforms.projMat.value.copy(camera.projectionMatrix);

    renderer.setClearColor(0x000000, 0);
    // 深度
    this.points.material = this.depthMat;
    renderer.setRenderTarget(this.depthRT);
    renderer.clear(true, true, false);
    renderer.render(this.pointsScene, camera);
    // 厚み（半解像度）
    this.depthMat.uniforms.pointScale.value = pointScale * 0.5;
    this.points.material = this.thickMat;
    renderer.setRenderTarget(this.thickRT);
    renderer.clear(true, false, false);
    renderer.render(this.pointsScene, camera);
    this.depthMat.uniforms.pointScale.value = pointScale;

    // なめらかに（3 往復）
    this.quad.material = this.blurMat;
    const u = this.blurMat.uniforms;
    u.pxPerUnit.value = (this.h * 0.5) * camera.projectionMatrix.elements[5];
    let src = this.depthRT;
    for (let it = 0; it < this.blurIters; it++) {
      u.tDepth.value = src.texture;
      u.dir.value.set(1 / this.w, 0);
      renderer.setRenderTarget(this.blurA);
      renderer.render(this.quadScene, this.quadCam);
      u.tDepth.value = this.blurA.texture;
      u.dir.value.set(0, 1 / this.h);
      renderer.setRenderTarget(this.blurB);
      renderer.render(this.quadScene, this.quadCam);
      src = this.blurB;
    }
    this.smoothed = src;
    renderer.setClearColor(prevClear, prevAlpha);
  }

  // 画面へ合成（現在のレンダーターゲットへ）
  composite(renderer, camera, sceneColorTex) {
    if (this.count === 0) return;
    const u = this.compositeMat.uniforms;
    u.tDepth.value = this.smoothed.texture;
    u.tThick.value = this.thickRT.texture;
    u.sceneColor.value = sceneColorTex;
    u.camProj.value.copy(camera.projectionMatrix);
    u.camWorld.value.copy(camera.matrixWorld);
    u.texel.value.set(1 / this.w, 1 / this.h);
    u.lightDirView.value.copy(this.lightDir).transformDirection(camera.matrixWorldInverse);
    this.quad.material = this.compositeMat;
    renderer.render(this.quadScene, this.quadCam);
  }
}

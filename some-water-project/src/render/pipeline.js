import * as THREE from 'three';

// 描画の流れ:
//  1. 不透明なシーン（浴室・浴槽・手・アヒル）を HDR のレンダーターゲットへ（色 + 深度）
//  2. それを画面へコピー（gl_FragDepth で深度も書き戻す）
//  3. 水面を描く（1 の色と深度を使って屈折・吸収）
//  4. 粒子の水を合成

const copyVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const copyFragment = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(tColor, vUv);
    gl_FragDepth = texture2D(tDepth, vUv).x;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.sceneRT = null;
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null } },
      vertexShader: copyVertex,
      fragmentShader: copyFragment,
      depthTest: true,
      depthWrite: true,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize(w, h) {
    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h) return;
    if (this.sceneRT) this.sceneRT.dispose();
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.FloatType;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthTexture,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.copyMat.uniforms.tColor.value = this.sceneRT.texture;
    this.copyMat.uniforms.tDepth.value = this.sceneRT.depthTexture;
  }

  renderOpaque(scene, camera) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, true);
    r.render(scene, camera);
  }

  beginScreen() {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.clear(true, true, true);
    r.render(this.quadScene, this.quadCam);
  }
}

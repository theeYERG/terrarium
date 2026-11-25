// Post-processing chain: HDR scene -> bloom -> tilt-shift (miniature look) -> tone map.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// Tilt-shift: blur grows with distance from a horizontal focus band. Done in two
// separable passes. Strength fades to 0 for a clean image when disabled.
const TiltShift = (horizontal: boolean) => ({
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 1 },
    uFocus: { value: 0.52 },
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount, uFocus;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      float d = abs(vUv.y - uFocus);
      float r = smoothstep(0.14, 0.55, d) * 3.2 * uAmount;
      vec2 dir = ${horizontal ? 'vec2(uTexel.x, 0.0)' : 'vec2(0.0, uTexel.y)'} * r;
      vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
      sum += texture2D(tDiffuse, vUv + dir * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv - dir * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv + dir * 3.2307692308) * 0.0702702703;
      sum += texture2D(tDiffuse, vUv - dir * 3.2307692308) * 0.0702702703;
      gl_FragColor = sum;
    }`,
});

export class PostFX {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  tiltH: ShaderPass;
  tiltV: ShaderPass;
  private renderer: THREE.WebGLRenderer;
  tiltShift = true;
  private tiltAmount = 1;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.6, 0.5, 1.35);
    this.composer.addPass(this.bloom);
    this.tiltH = new ShaderPass(TiltShift(true));
    this.tiltV = new ShaderPass(TiltShift(false));
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    for (const p of [this.tiltH, this.tiltV]) p.uniforms.uTexel.value.set(1 / (w * pr), 1 / (h * pr));
  }

  render(dt: number) {
    const target = this.tiltShift ? 1 : 0;
    this.tiltAmount += (target - this.tiltAmount) * Math.min(1, dt * 5);
    const on = this.tiltAmount > 0.01;
    this.tiltH.enabled = on;
    this.tiltV.enabled = on;
    this.tiltH.uniforms.uAmount.value = this.tiltAmount;
    this.tiltV.uniforms.uAmount.value = this.tiltAmount;
    this.composer.render(dt);
  }
}

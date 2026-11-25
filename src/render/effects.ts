// Visual-only effects: gas sprites (fire, smoke, steam), CPU particles (sparks, splashes,
// puffs, embers), instanced flying debris, and a pool of point lights for lava/fire glow.

import * as THREE from 'three';
import { M, MATERIALS, MAT_COUNT } from '../sim/materials.ts';

const linColors: THREE.Color[] = [];
for (let m = 0; m < MAT_COUNT; m++) linColors.push(new THREE.Color(MATERIALS[m].color));

// ───────────────────────────── gas sprites ─────────────────────────────

const GAS_VERT = /* glsl */ `
attribute float aCode;
uniform float uScale;
uniform float uTime;
uniform float uFire;
varying float vLife;
varying float vKind;
varying float vSeed;
float h(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  vKind = floor(aCode);
  vLife = fract(aCode);
  vSeed = h(position);
  vec3 p = position;
  // gentle wobble so the 30 Hz grid motion reads as soft drifting
  p.x += sin(uTime * 1.7 + vSeed * 30.0) * 0.35;
  p.z += cos(uTime * 1.3 + vSeed * 20.0) * 0.35;
  p.y += sin(uTime * 2.1 + vSeed * 12.0) * 0.2;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float size;
  if (vKind < 0.5) size = (0.9 + vLife * 0.9) * (0.8 + 0.4 * sin(uTime * 18.0 + vSeed * 50.0));
  else if (vKind < 1.5) size = 2.4 + (1.0 - vLife) * 2.6;
  else size = 2.2 + (1.0 - vLife) * 2.4;
  gl_PointSize = size * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const GAS_FRAG = /* glsl */ `
uniform float uFire;
uniform float uNight;
varying float vLife;
varying float vKind;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float soft = smoothstep(0.5, 0.0, d);
  if (vKind < 0.5) {
    vec3 col = mix(vec3(1.0, 0.12, 0.01), vec3(1.0, 0.55, 0.1), vLife);
    col = mix(col, vec3(1.0, 0.8, 0.35), smoothstep(0.8, 1.0, vLife) * 0.5);
    gl_FragColor = vec4(col * (1.3 + vLife * 1.6), soft * soft * (0.22 + vLife * 0.38));
  } else if (vKind < 1.5) {
    vec3 col = mix(vec3(0.18, 0.18, 0.2), vec3(0.32, 0.32, 0.34), vSeed) * (1.0 - uNight * 0.6);
    gl_FragColor = vec4(col, soft * 0.42 * min(1.0, vLife * 2.5));
  } else {
    vec3 col = vec3(0.92, 0.95, 1.0) * (1.0 - uNight * 0.65);
    gl_FragColor = vec4(col, soft * 0.3 * min(1.0, vLife * 2.0));
  }
}`;

export class GasRenderer {
  fire: THREE.Points;
  smoke: THREE.Points;
  uniforms = { uScale: { value: 600 }, uTime: { value: 0 }, uNight: { value: 0 }, uFire: { value: 1 } };

  constructor(scene: THREE.Scene) {
    const mk = (additive: boolean) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      g.setAttribute('aCode', new THREE.BufferAttribute(new Float32Array(1), 1));
      const m = new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: GAS_VERT, fragmentShader: GAS_FRAG,
        transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const p = new THREE.Points(g, m);
      p.frustumCulled = false;
      p.renderOrder = additive ? 3 : 2;
      scene.add(p);
      return p;
    };
    this.smoke = mk(false);
    this.fire = mk(true);
  }

  set(gas: Float32Array) {
    const n = gas.length / 4;
    let nf = 0;
    for (let k = 0; k < n; k++) if (gas[k * 4 + 3] < 1) nf++;
    const fp = new Float32Array(nf * 3), fc = new Float32Array(nf);
    const sp = new Float32Array((n - nf) * 3), sc = new Float32Array(n - nf);
    let a = 0, b = 0;
    for (let k = 0; k < n; k++) {
      const code = gas[k * 4 + 3];
      if (code < 1) {
        fp[a * 3] = gas[k * 4]; fp[a * 3 + 1] = gas[k * 4 + 1]; fp[a * 3 + 2] = gas[k * 4 + 2]; fc[a++] = code;
      } else {
        sp[b * 3] = gas[k * 4]; sp[b * 3 + 1] = gas[k * 4 + 1]; sp[b * 3 + 2] = gas[k * 4 + 2]; sc[b++] = code;
      }
    }
    const put = (p: THREE.Points, pos: Float32Array, code: Float32Array) => {
      const g = p.geometry;
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aCode', new THREE.BufferAttribute(code, 1));
      g.setDrawRange(0, code.length);
    };
    put(this.fire, fp, fc);
    put(this.smoke, sp, sc);
  }
}

// ───────────────────────────── particles ─────────────────────────────

const PART_VERT = /* glsl */ `
attribute vec4 aColor;
attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const PART_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float soft = smoothstep(0.5, 0.05, d);
  gl_FragColor = vec4(vColor.rgb, vColor.a * soft);
}`;

class ParticlePool {
  max: number;
  n = 0;
  pos: Float32Array; vel: Float32Array; col: Float32Array; size: Float32Array;
  life: Float32Array; maxLife: Float32Array; grav: Float32Array; grow: Float32Array; baseA: Float32Array;
  points: THREE.Points;
  private geo: THREE.BufferGeometry;

  constructor(scene: THREE.Scene, max: number, additive: boolean, uniforms: Record<string, THREE.IUniform>) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.baseA = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: PART_VERT, fragmentShader: PART_FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 5 : 4;
    scene.add(this.points);
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, a: number, size: number, life: number, grav: number, grow = 0) {
    if (this.n >= this.max) return;
    const k = this.n++;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    this.col[k * 4] = r; this.col[k * 4 + 1] = g; this.col[k * 4 + 2] = b; this.col[k * 4 + 3] = a;
    this.baseA[k] = a;
    this.size[k] = size;
    this.life[k] = life;
    this.maxLife[k] = life;
    this.grav[k] = grav;
    this.grow[k] = grow;
  }

  update(dt: number) {
    for (let k = 0; k < this.n; k++) {
      this.life[k] -= dt;
      if (this.life[k] <= 0) {
        const last = --this.n;
        if (k !== last) this.copy(last, k);
        k--;
        continue;
      }
      const o = k * 3;
      this.vel[o + 1] -= this.grav[k] * dt;
      const drag = this.grav[k] < 0 ? 0.96 : 0.99;
      this.vel[o] *= drag; this.vel[o + 1] *= drag; this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      this.size[k] += this.grow[k] * dt;
      const t = this.life[k] / this.maxLife[k];
      this.col[k * 4 + 3] = this.baseA[k] * Math.min(1, t * 2.5);
    }
    this.geo.setDrawRange(0, this.n);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  }

  private copy(from: number, to: number) {
    for (let i = 0; i < 3; i++) {
      this.pos[to * 3 + i] = this.pos[from * 3 + i];
      this.vel[to * 3 + i] = this.vel[from * 3 + i];
    }
    for (let i = 0; i < 4; i++) this.col[to * 4 + i] = this.col[from * 4 + i];
    this.size[to] = this.size[from];
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.grav[to] = this.grav[from];
    this.grow[to] = this.grow[from];
    this.baseA[to] = this.baseA[from];
  }
}

export class Particles {
  sparks: ParticlePool;
  puffs: ParticlePool;
  uniforms = { uScale: { value: 600 } };

  constructor(scene: THREE.Scene) {
    this.sparks = new ParticlePool(scene, 4000, true, this.uniforms);
    this.puffs = new ParticlePool(scene, 2500, false, this.uniforms);
  }

  update(dt: number) {
    this.sparks.update(dt);
    this.puffs.update(dt);
  }

  explosion(x: number, y: number, z: number, r: number) {
    const R = Math.random;
    const n = Math.min(260, 60 + r * 30);
    for (let i = 0; i < n; i++) {
      const u = R() * 2 - 1, a = R() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const sp = 8 + R() * 22 * (r / 4);
      const hot = R();
      this.sparks.spawn(x, y, z, Math.cos(a) * s * sp, Math.abs(u) * sp + 4, Math.sin(a) * s * sp,
        4, 1.2 + hot * 1.8, 0.2 + hot * 0.4, 1, 0.35 + R() * 0.35, 0.5 + R() * 1.0, 18);
    }
    // flash
    this.sparks.spawn(x, y, z, 0, 0, 0, 6, 4, 2, 1, r * 4, 0.18, 0, r * 12);
    for (let i = 0; i < Math.min(60, 14 + r * 6); i++) {
      const a = R() * Math.PI * 2;
      const sp = 2 + R() * 4;
      const g = 0.25 + R() * 0.2;
      this.puffs.spawn(x + (R() - 0.5) * r, y + (R() - 0.5) * r, z + (R() - 0.5) * r,
        Math.cos(a) * sp, 2 + R() * 4, Math.sin(a) * sp, g, g, g * 1.05, 0.55, 2.5 + R() * 2, 2 + R() * 2.5, -1.5, 2.2);
    }
  }

  splash(x: number, y: number, z: number, color = [0.5, 0.75, 1.0]) {
    const R = Math.random;
    for (let i = 0; i < 18; i++) {
      const a = R() * Math.PI * 2, sp = 2 + R() * 4;
      this.puffs.spawn(x, y, z, Math.cos(a) * sp, 4 + R() * 6, Math.sin(a) * sp, color[0], color[1], color[2], 0.75, 0.35 + R() * 0.3, 0.6 + R() * 0.4, 22);
    }
  }

  sizzle(x: number, y: number, z: number) {
    const R = Math.random;
    for (let i = 0; i < 14; i++) {
      this.puffs.spawn(x + (R() - 0.5) * 2, y, z + (R() - 0.5) * 2, (R() - 0.5) * 2, 3 + R() * 3, (R() - 0.5) * 2,
        0.95, 0.97, 1, 0.45, 1.2 + R(), 1.2 + R() * 1.2, -2, 1.6);
    }
    for (let i = 0; i < 8; i++) {
      this.sparks.spawn(x, y, z, (R() - 0.5) * 6, 3 + R() * 5, (R() - 0.5) * 6, 3, 1.2, 0.3, 1, 0.25, 0.4 + R() * 0.3, 15);
    }
  }

  ember(x: number, y: number, z: number) {
    const R = Math.random;
    this.sparks.spawn(x + (R() - 0.5) * 3, y + R() * 2, z + (R() - 0.5) * 3, (R() - 0.5) * 1.5, 2 + R() * 3, (R() - 0.5) * 1.5,
      2.4, 0.8, 0.15, 1, 0.12 + R() * 0.08, 1.0 + R() * 1.4, -0.6);
  }

  dust(x: number, y: number, z: number, m: number) {
    const R = Math.random;
    const c = linColors[m] ?? linColors[M.DIRT];
    for (let i = 0; i < 4; i++) {
      this.puffs.spawn(x + (R() - 0.5), y + R() * 0.5, z + (R() - 0.5), (R() - 0.5) * 2, 1 + R() * 2, (R() - 0.5) * 2,
        c.r, c.g, c.b, 0.5, 0.5 + R() * 0.4, 0.5 + R() * 0.4, 4, 0.6);
    }
  }
}

// ───────────────────────────── debris ─────────────────────────────

export class DebrisRenderer {
  mesh: THREE.InstancedMesh;
  private data: Float32Array = new Float32Array(0);
  private age = 0;
  private dummy = new THREE.Object3D();
  private colors: THREE.Color[] = [];
  static MAX = 12000;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(0.94, 0.94, 0.94);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\nvec3 glowC = max(diffuseColor.rgb - 1.0, vec3(0.0));\ndiffuseColor.rgb = min(diffuseColor.rgb, vec3(1.0));')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += glowC;');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, DebrisRenderer.MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    for (let m = 0; m < MAT_COUNT; m++) {
      const c = new THREE.Color(MATERIALS[m].color);
      if (m === M.LAVA) c.setRGB(4.5, 1.1, 0.15);
      if (m === M.EMBER || m === M.FIRE) c.setRGB(4, 1.4, 0.3);
      this.colors.push(c);
    }
    // touch instanceColor once so the buffer exists
    this.mesh.setColorAt(0, this.colors[1]);
    scene.add(this.mesh);
  }

  set(data: Float32Array) {
    this.data = data;
    this.age = 0;
    const n = Math.min(DebrisRenderer.MAX, data.length / 7);
    for (let k = 0; k < n; k++) {
      const m = data[k * 7 + 6];
      const c = this.colors[m] ?? this.colors[1];
      this.mesh.setColorAt(k, c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number, time: number) {
    this.age = Math.min(this.age + dt, 0.1);
    const d = this.data;
    const n = Math.min(DebrisRenderer.MAX, d.length / 7);
    const t = this.age;
    for (let k = 0; k < n; k++) {
      const o = k * 7;
      const x = d[o] + d[o + 3] * t, y = d[o + 1] + d[o + 4] * t - 15 * t * t, z = d[o + 2] + d[o + 5] * t;
      this.dummy.position.set(x, y, z);
      const spin = Math.abs(d[o + 3]) + Math.abs(d[o + 5]) > 2 ? 1 : 0;
      this.dummy.rotation.set(spin * (time * 3 + k), spin * (time * 2.3 + k * 1.7), 0);
      const s = d[o + 6] === M.WATER || d[o + 6] === M.LAVA ? 0.75 : 1;
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(k, this.dummy.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get count() {
    return this.mesh.count;
  }
}

// ───────────────────────────── glow lights ─────────────────────────────

export class GlowLights {
  lights: THREE.PointLight[] = [];
  private targets: { x: number; y: number; z: number; i: number; fire: number }[] = [];

  constructor(scene: THREE.Scene, n = 6) {
    for (let k = 0; k < n; k++) {
      const l = new THREE.PointLight(0xff7a30, 0, 34, 1.6);
      l.position.set(64, -100, 64);
      this.lights.push(l);
      scene.add(l);
    }
  }

  set(data: number[]) {
    this.targets = [];
    for (let k = 0; k + 4 < data.length + 1 && k / 5 < this.lights.length; k += 5) {
      // nudge off the voxel grid: a light exactly on a face makes a zero-length light vector (NaN)
      this.targets.push({ x: data[k] + 0.37, y: data[k + 1] + 0.41, z: data[k + 2] + 0.29, i: data[k + 3], fire: data[k + 4] });
    }
  }

  update(dt: number, time: number) {
    for (let k = 0; k < this.lights.length; k++) {
      const l = this.lights[k];
      const t = this.targets[k];
      const target = t ? t.i : 0;
      const flick = t && t.fire ? 0.75 + 0.25 * Math.sin(time * 17 + k * 3) * Math.sin(time * 7.3 + k) : 0.92 + 0.08 * Math.sin(time * 2 + k);
      const goal = target * 32 * flick;
      l.intensity += (goal - l.intensity) * Math.min(1, dt * 6);
      if (t) {
        if (l.intensity < 0.5) l.position.set(t.x, t.y, t.z);
        else l.position.lerp(new THREE.Vector3(t.x, t.y, t.z), Math.min(1, dt * 4));
        l.color.set(t.fire ? 0xff8a3a : 0xff6420);
      }
    }
  }
}

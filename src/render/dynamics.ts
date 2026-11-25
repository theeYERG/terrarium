// Everything that moves between voxel updates: rigid bodies (grains, rocks, tumbling
// chunks), liquid droplets and gas puffs. The worker sends their state at 30 Hz; here
// bodies are interpolated (lerp + slerp between the last two ticks) and particles are
// extrapolated along their velocity, so motion is smooth at any frame rate.

import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { M } from '../sim/materials.ts';
import { hash3, PALETTE } from '../sim/mesher.ts';
import type { ChunkSpawn } from '../sim/physics.ts';
import { GRAIN_RADIUS, rockPoints, ROCK_VARIANTS } from '../sim/shapes.ts';

const KIND_GRAIN = 0, KIND_ROCK = 1, KIND_CHUNK = 2, KIND_TREE = 3;

export function matColor(m: number, shade = 1): THREE.Color {
  const p = PALETTE[m] ?? [0x999999, 0x888888, 0x777777];
  return new THREE.Color(p[shade] ?? p[1]);
}

/** Tracks when the last worker frame arrived, for interpolation. */
export class TickClock {
  last = performance.now();
  interval = 1000 / 30;
  arrived() {
    const now = performance.now();
    const gap = now - this.last;
    if (gap > 5 && gap < 200) this.interval = this.interval * 0.85 + gap * 0.15;
    this.last = now;
  }
  /** 0..1 progress from the previous tick's state to the newest one */
  alpha() {
    return Math.min(1, Math.max(0, (performance.now() - this.last) / this.interval));
  }
  /** seconds since the newest state, for extrapolating particles */
  since() {
    return Math.min(0.08, (performance.now() - this.last) / 1000);
  }
}

interface BodyView {
  kind: number; mat: number; shape: number;
  /** last rendered (interpolated) position and scale, for tests / debugging */
  cur?: THREE.Vector3; curQ?: THREE.Quaternion; curScale?: number;
  p0: THREE.Vector3; p1: THREE.Vector3; q0: THREE.Quaternion; q1: THREE.Quaternion;
  s0: number; s1: number;
  seen: boolean;
  mesh?: THREE.Mesh;
}

const flatMat = (opts: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, metalness: 0, ...opts });

export class BodyRenderer {
  group = new THREE.Group();
  views = new Map<number, BodyView>();
  private grains: THREE.InstancedMesh;
  private rocks: THREE.InstancedMesh[] = [];
  private chunkShapes = new Map<number, ChunkSpawn>();
  private dummy = new THREE.Object3D();
  private tmpP = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private colors = new Map<number, THREE.Color[]>();
  treePose = new Map<number, { p: THREE.Vector3; q: THREE.Quaternion }>();

  constructor(scene: THREE.Scene) {
    this.grains = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(GRAIN_RADIUS * 1.05, 0), flatMat(), 400);
    this.setup(this.grains);
    for (let v = 0; v < ROCK_VARIANTS; v++) {
      const pts = rockPoints(v);
      const arr: THREE.Vector3[] = [];
      for (let k = 0; k < pts.length; k += 3) arr.push(new THREE.Vector3(pts[k], pts[k + 1], pts[k + 2]));
      const g = new ConvexGeometry(arr);
      g.computeVertexNormals();
      const im = new THREE.InstancedMesh(g, flatMat(), 200);
      this.setup(im);
      this.rocks.push(im);
    }
    scene.add(this.group);
  }

  private setup(im: THREE.InstancedMesh) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.setColorAt(0, new THREE.Color());
    this.group.add(im);
  }

  private colorOf(m: number, id: number): THREE.Color {
    let list = this.colors.get(m);
    if (!list) { list = [0, 1, 2].map((s) => matColor(m, s)); this.colors.set(m, list); }
    return list[id % 3];
  }

  addChunkShapes(list: ChunkSpawn[]) {
    for (const c of list) this.chunkShapes.set(c.id, c);
  }

  private buildChunk(id: number): THREE.Mesh | undefined {
    const spec = this.chunkShapes.get(id);
    if (!spec) return undefined;
    const geoms: THREE.BufferGeometry[] = [];
    const base = new THREE.DodecahedronGeometry(0.74, 0).toNonIndexed();
    const n = spec.mats.length;
    const m4 = new THREE.Matrix4();
    const e = new THREE.Euler();
    for (let k = 0; k < n; k++) {
      const x = spec.cells[k * 3] / 4, y = spec.cells[k * 3 + 1] / 4, z = spec.cells[k * 3 + 2] / 4;
      const h = hash3(k, id, 7);
      const g = base.clone();
      e.set(h * 6.3, hash3(k, 3, id) * 6.3, 0);
      m4.makeRotationFromEuler(e).setPosition(x, y, z);
      g.applyMatrix4(m4);
      const c = matColor(spec.mats[k], Math.floor(h * 3));
      const cols = new Float32Array(g.attributes.position.count * 3);
      for (let v = 0; v < cols.length; v += 3) { cols[v] = c.r; cols[v + 1] = c.g; cols[v + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      geoms.push(g);
    }
    const merged = mergeGeometries(geoms, false);
    if (!merged) return undefined;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, flatMat({ vertexColors: true }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.chunkShapes.delete(id);
    return mesh;
  }

  /** New state from the worker: id, kind, mat, x,y,z, qx,qy,qz,qw, scale, shape */
  set(data: Float32Array) {
    for (const v of this.views.values()) v.seen = false;
    for (let o = 0; o < data.length; o += 12) {
      const id = data[o];
      let v = this.views.get(id);
      const p = new THREE.Vector3(data[o + 3], data[o + 4], data[o + 5]);
      const q = new THREE.Quaternion(data[o + 6], data[o + 7], data[o + 8], data[o + 9]);
      if (!v) {
        v = { kind: data[o + 1], mat: data[o + 2], shape: data[o + 11], p0: p.clone(), p1: p, q0: q.clone(), q1: q, s0: data[o + 10], s1: data[o + 10], seen: true };
        if (v.kind === KIND_CHUNK) v.mesh = this.buildChunk(id);
        this.views.set(id, v);
      } else {
        // continue from where the body is drawn right now, so a tick arriving early or late
        // never makes it jump
        v.p0.copy(v.cur ?? v.p1);
        v.q0.copy(v.curQ ?? v.q1);
        v.s0 = v.curScale ?? v.s1;
        v.p1.copy(p); v.q1.copy(q); v.s1 = data[o + 10];
        v.seen = true;
      }
    }
    for (const [id, v] of this.views) {
      if (v.seen) continue;
      if (v.mesh) { this.group.remove(v.mesh); v.mesh.geometry.dispose(); (v.mesh.material as THREE.Material).dispose(); }
      if (v.kind === KIND_TREE) this.treePose.delete(v.shape);
      this.views.delete(id);
    }
  }

  update(alpha: number) {
    let ng = 0;
    const nr = new Array(ROCK_VARIANTS).fill(0);
    for (const [id, v] of this.views) {
      const p = this.tmpP.lerpVectors(v.p0, v.p1, alpha);
      const q = this.tmpQ.slerpQuaternions(v.q0, v.q1, alpha);
      const s = v.s0 + (v.s1 - v.s0) * alpha;
      (v.cur ??= new THREE.Vector3()).copy(p);
      (v.curQ ??= new THREE.Quaternion()).copy(q);
      v.curScale = s;
      if (v.kind === KIND_TREE) {
        let tp = this.treePose.get(v.shape);
        if (!tp) { tp = { p: new THREE.Vector3(), q: new THREE.Quaternion() }; this.treePose.set(v.shape, tp); }
        tp.p.copy(p); tp.q.copy(q);
        continue;
      }
      if (v.kind === KIND_CHUNK) {
        if (v.mesh) {
          v.mesh.position.copy(p);
          v.mesh.quaternion.copy(q);
          v.mesh.scale.setScalar(Math.max(0.001, 0.6 + 0.4 * s));
        }
        continue;
      }
      this.dummy.position.copy(p);
      this.dummy.quaternion.copy(q);
      if (v.kind === KIND_GRAIN) {
        this.dummy.scale.setScalar(Math.max(0.001, s));
        this.dummy.updateMatrix();
        this.grains.setMatrixAt(ng, this.dummy.matrix);
        this.grains.setColorAt(ng, this.colorOf(v.mat, id));
        ng++;
      } else if (v.kind === KIND_ROCK) {
        const variant = Math.floor(v.shape / 1000) % ROCK_VARIANTS;
        const size = (v.shape % 1000) / 100;
        this.dummy.scale.setScalar(Math.max(0.001, size * s));
        this.dummy.updateMatrix();
        const im = this.rocks[variant];
        im.setMatrixAt(nr[variant], this.dummy.matrix);
        im.setColorAt(nr[variant], this.colorOf(v.mat, id));
        nr[variant]++;
      }
    }
    this.finish(this.grains, ng);
    this.rocks.forEach((im, k) => this.finish(im, nr[k]));
  }

  private finish(im: THREE.InstancedMesh, n: number) {
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  get count() {
    return this.views.size;
  }
}

// ───────────────────────────── droplets ─────────────────────────────

export class DropRenderer {
  private water: THREE.InstancedMesh;
  private lava: THREE.InstancedMesh;
  data: Float32Array = new Float32Array(0);
  private dummy = new THREE.Object3D();
  private up = new THREE.Vector3(0, 1, 0);
  private dir = new THREE.Vector3();
  private cWater = new THREE.Color(0x8fd0ea);
  private cOil = new THREE.Color(0x3a2a18);
  private cAcid = new THREE.Color(0x9cf04a);

  constructor(scene: THREE.Scene) {
    const g = new THREE.IcosahedronGeometry(0.2, 0);
    this.water = new THREE.InstancedMesh(g, flatMat({ transparent: true, opacity: 0.7, roughness: 0.25, envMapIntensity: 0.4 }), 6000);
    this.lava = new THREE.InstancedMesh(g, flatMat({ color: 0xff7020, emissive: 0xff5010, emissiveIntensity: 2.5 }), 2000);
    for (const im of [this.water, this.lava]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      scene.add(im);
    }
    this.water.setColorAt(0, this.cWater);
    this.water.renderOrder = 2;
  }

  set(data: Float32Array) {
    this.data = data;
  }

  update(t: number) {
    const d = this.data;
    let nw = 0, nl = 0;
    for (let o = 0; o < d.length; o += 8) {
      const vx = d[o + 3], vy = d[o + 4] - 30 * t, vz = d[o + 5];
      this.dummy.position.set(d[o] + vx * t, d[o + 1] + d[o + 4] * t - 15 * t * t, d[o + 2] + vz * t);
      const sp = Math.hypot(vx, vy, vz);
      if (sp > 0.01) this.dummy.quaternion.setFromUnitVectors(this.up, this.dir.set(vx / sp, vy / sp, vz / sp));
      // bigger blobs for heavier drops, gently stretched along their motion
      // fat, overlapping, stretched drops so a stream reads as a ribbon of water
      const s = 0.8 + Math.min(1.2, d[o + 7] * 10);
      this.dummy.scale.set(s, s * (1 + Math.min(1.6, sp * 0.07)), s);
      this.dummy.updateMatrix();
      const type = d[o + 6];
      if (type === M.LAVA) {
        if (nl < 2000) this.lava.setMatrixAt(nl++, this.dummy.matrix);
      } else if (nw < 6000) {
        this.water.setMatrixAt(nw, this.dummy.matrix);
        this.water.setColorAt(nw, type === M.OIL ? this.cOil : type === M.ACID ? this.cAcid : this.cWater);
        nw++;
      }
    }
    this.water.count = nw;
    this.lava.count = nl;
    this.water.instanceMatrix.needsUpdate = true;
    if (this.water.instanceColor) this.water.instanceColor.needsUpdate = true;
    this.lava.instanceMatrix.needsUpdate = true;
  }

  get count() {
    return this.data.length / 8;
  }
}

// ───────────────────────────── gas puffs ─────────────────────────────

export const PUFF_VERT = /* glsl */ `
attribute vec3 iColor;
attribute float iAlpha;
attribute float iEmit;
varying vec3 vColor;
varying float vAlpha;
varying float vEmit;
varying vec3 vView;
void main() {
  vColor = iColor; vAlpha = iAlpha; vEmit = iEmit;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
export const PUFF_FRAG = /* glsl */ `
uniform vec3 uLightDir; // view space
uniform vec3 uLight;
uniform vec3 uAmbient;
varying vec3 vColor;
varying float vAlpha;
varying float vEmit;
varying vec3 vView;
void main() {
  // faceted: one normal per triangle from screen-space derivatives
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  float d = max(dot(n, uLightDir), 0.0);
  vec3 lit = vColor * (uAmbient + uLight * d);
  vec3 col = mix(lit, vColor, vEmit);
  gl_FragColor = vec4(col, vAlpha);
}`;

export class GasRenderer {
  private smoke: THREE.InstancedMesh;
  private fire: THREE.InstancedMesh;
  private data: Float32Array = new Float32Array(0);
  private dummy = new THREE.Object3D();
  uniforms = {
    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uLight: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: new THREE.Color(0.5, 0.5, 0.55) },
  };

  constructor(scene: THREE.Scene) {
    const mk = (max: number, additive: boolean) => {
      const g = new THREE.IcosahedronGeometry(0.5, 0);
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iEmit', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
      const m = new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const im = new THREE.InstancedMesh(g, m, max);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      im.renderOrder = additive ? 4 : 3;
      scene.add(im);
      return im;
    };
    this.smoke = mk(5000, false);
    this.fire = mk(3000, true);
  }

  set(data: Float32Array) {
    this.data = data;
  }

  update(t: number, time: number, night: number, camera: THREE.Camera, sunDir: THREE.Vector3, sunColor: THREE.Color) {
    this.uniforms.uLightDir.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
    this.uniforms.uLight.value.copy(sunColor);
    this.uniforms.uAmbient.value.setRGB(0.45 + 0.25 * (1 - night), 0.47 + 0.25 * (1 - night), 0.55 + 0.2 * (1 - night)).multiplyScalar(1 - night * 0.55);
    const d = this.data;
    let ns = 0, nf = 0;
    const sA = this.smoke.geometry.attributes, fA = this.fire.geometry.attributes;
    const sCol = sA.iColor.array as Float32Array, sAl = sA.iAlpha.array as Float32Array, sEm = sA.iEmit.array as Float32Array;
    const fCol = fA.iColor.array as Float32Array, fAl = fA.iAlpha.array as Float32Array, fEm = fA.iEmit.array as Float32Array;
    for (let o = 0; o < d.length; o += 9) {
      const type = d[o + 6], age = Math.min(1, d[o + 7] + t * 0.4), seed = d[o + 8];
      this.dummy.position.set(d[o] + d[o + 3] * t, d[o + 1] + d[o + 4] * t, d[o + 2] + d[o + 5] * t);
      this.dummy.rotation.set(seed + time * 0.4, seed * 1.7 + time * 0.3, seed * 0.3);
      const fadeIn = smooth(0, 0.12, age), fadeOut = 1 - smooth(0.45, 1, age);
      if (type === 0 || type === 3) {
        // fire: shrinks and reddens as it rises; sparks are tiny and bright
        const s = type === 3 ? 0.18 : (0.75 * (1 - age) + 0.2) * (0.85 + 0.3 * Math.sin(time * 14 + seed * 9));
        this.dummy.scale.setScalar(s);
        this.dummy.updateMatrix();
        if (nf >= 3000) continue;
        this.fire.setMatrixAt(nf, this.dummy.matrix);
        const k = nf * 3;
        const hot = 1 - age;
        fCol[k] = 1.5 + hot * 0.6; fCol[k + 1] = 0.35 + hot * 0.75; fCol[k + 2] = 0.06 + hot * 0.1;
        fAl[nf] = (type === 3 ? 0.9 : 0.42) * fadeOut * smooth(0, 0.08, age);
        fEm[nf] = 1;
        nf++;
      } else {
        const steam = type === 2;
        const s = (steam ? 0.4 + age * 1.3 : 0.5 + age * 2.0) * easeOut(Math.min(1, age * 2.5 + 0.3));
        this.dummy.scale.setScalar(s);
        this.dummy.updateMatrix();
        if (ns >= 5000) continue;
        this.smoke.setMatrixAt(ns, this.dummy.matrix);
        const k = ns * 3;
        const g = steam ? 0.97 : 0.36 + (seed % 1) * 0.12;
        sCol[k] = g; sCol[k + 1] = g; sCol[k + 2] = g * (steam ? 1.02 : 1.05);
        sAl[ns] = (steam ? 0.28 : 0.55) * fadeIn * fadeOut;
        sEm[ns] = steam ? 0.35 : 0;
        ns++;
      }
    }
    for (const [im, n] of [[this.smoke, ns], [this.fire, nf]] as const) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      const a = im.geometry.attributes;
      a.iColor.needsUpdate = true; a.iAlpha.needsUpdate = true; a.iEmit.needsUpdate = true;
    }
  }

  get count() {
    return this.data.length / 9;
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function easeOut(t: number) {
  return 1 - (1 - t) * (1 - t);
}

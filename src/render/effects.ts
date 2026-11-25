// Visual-only effects: CPU particles (sparks, splashes, spray, embers, dust, transition
// puffs) and a pool of point lights for lava/fire glow.

import * as THREE from 'three';
import { M, MATERIALS, MAT_COUNT } from '../sim/materials.ts';
import { PUFF_FRAG, PUFF_VERT } from './dynamics.ts';

const linColors: THREE.Color[] = [];
for (let m = 0; m < MAT_COUNT; m++) linColors.push(new THREE.Color(MATERIALS[m].color));

// ───────────────────────────── particles ─────────────────────────────

/**
 * Short-lived visual particles drawn as faceted low poly shapes (octahedra for sparks,
 * icosahedra for puffs) so they match the rest of the art style.
 */
class ParticlePool {
  max: number;
  n = 0;
  pos: Float32Array; vel: Float32Array; col: Float32Array; size: Float32Array;
  life: Float32Array; maxLife: Float32Array; grav: Float32Array; grow: Float32Array; baseA: Float32Array;
  mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private additive: boolean;

  constructor(scene: THREE.Scene, max: number, additive: boolean, uniforms: Record<string, THREE.IUniform>) {
    this.max = max;
    this.additive = additive;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.baseA = new Float32Array(max);
    const g = additive ? new THREE.OctahedronGeometry(0.5, 0) : new THREE.IcosahedronGeometry(0.5, 0);
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iEmit', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(g, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 6 : 5;
    scene.add(this.mesh);
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

  update(dt: number, time = 0) {
    const A = this.mesh.geometry.attributes;
    const iCol = A.iColor.array as Float32Array, iAl = A.iAlpha.array as Float32Array, iEm = A.iEmit.array as Float32Array;
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
      // ease in quickly, ease out over the last part of the life
      const fade = Math.min(1, (1 - t) * 8) * Math.min(1, t * 2.5);
      this.dummy.position.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      this.dummy.rotation.set(k * 1.3 + time * 2, k * 0.7 + time * 1.5, 0);
      this.dummy.scale.setScalar(Math.max(0.001, this.size[k] * (this.additive ? 0.6 + 0.4 * t : 1)));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(k, this.dummy.matrix);
      iCol[k * 3] = this.col[k * 4]; iCol[k * 3 + 1] = this.col[k * 4 + 1]; iCol[k * 3 + 2] = this.col[k * 4 + 2];
      iAl[k] = this.baseA[k] * fade;
      iEm[k] = this.additive ? 1 : 0.15;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    A.iColor.needsUpdate = true; A.iAlpha.needsUpdate = true; A.iEmit.needsUpdate = true;
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
  private time = 0;

  constructor(scene: THREE.Scene, shading: Record<string, THREE.IUniform>) {
    this.sparks = new ParticlePool(scene, 3000, true, shading);
    this.puffs = new ParticlePool(scene, 2500, false, shading);
  }

  update(dt: number) {
    this.time += dt;
    this.sparks.update(dt, this.time);
    this.puffs.update(dt, this.time);
  }

  explosion(x: number, y: number, z: number, r: number) {
    const R = Math.random;
    const n = Math.min(90, 26 + r * 10);
    for (let i = 0; i < n; i++) {
      const u = R() * 2 - 1, a = R() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const sp = 8 + R() * 18 * (r / 4);
      const hot = R();
      this.sparks.spawn(x, y, z, Math.cos(a) * s * sp, Math.abs(u) * sp + 4, Math.sin(a) * s * sp,
        1.6 + hot * 0.6, 0.45 + hot * 0.55, 0.08 + hot * 0.12, 0.9, 0.22 + R() * 0.22, 0.45 + R() * 0.8, 18);
    }
    // a quick soft flash (fades in 0.15 s)
    this.sparks.spawn(x, y, z, 0, 0, 0, 1.4, 0.75, 0.3, 0.55, r * 1.6, 0.15, 0, r * 7);
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
    for (let i = 0; i < 8; i++) {
      const a = R() * Math.PI * 2, sp = 2 + R() * 3;
      this.puffs.spawn(x, y, z, Math.cos(a) * sp, 3 + R() * 5, Math.sin(a) * sp, color[0], color[1], color[2], 0.45, 0.25 + R() * 0.2, 0.45 + R() * 0.3, 22);
    }
  }

  sizzle(x: number, y: number, z: number) {
    const R = Math.random;
    for (let i = 0; i < 5; i++) {
      this.puffs.spawn(x + (R() - 0.5) * 2, y, z + (R() - 0.5) * 2, (R() - 0.5) * 2, 2.5 + R() * 2.5, (R() - 0.5) * 2,
        0.95, 0.97, 1, 0.3, 0.8 + R() * 0.6, 0.9 + R() * 0.8, -2, 1.2);
    }
    for (let i = 0; i < 4; i++) {
      this.sparks.spawn(x, y, z, (R() - 0.5) * 6, 3 + R() * 5, (R() - 0.5) * 6, 1.6, 0.6, 0.15, 0.9, 0.16, 0.35 + R() * 0.3, 15);
    }
  }

  /** a soft puff for state changes (melting, freezing...) */
  puff(x: number, y: number, z: number, color: number) {
    const R = Math.random;
    const c = new THREE.Color(color);
    for (let i = 0; i < 7; i++) {
      this.puffs.spawn(x + (R() - 0.5), y + R() * 0.4, z + (R() - 0.5), (R() - 0.5) * 1.5, 1 + R() * 1.5, (R() - 0.5) * 1.5,
        c.r, c.g, c.b, 0.45, 0.6 + R() * 0.5, 0.6 + R() * 0.5, -0.5, 1.4);
    }
  }

  /** soft spray drifting off falling water */
  mist(x: number, y: number, z: number, night: number) {
    const R = Math.random;
    const b = 0.95 - night * 0.6;
    this.puffs.spawn(x + (R() - 0.5) * 1.5, y, z + (R() - 0.5) * 1.5, (R() - 0.5) * 1.2, -1 - R() * 2, (R() - 0.5) * 1.2,
      b, b, b * 1.04, 0.16, 1.4 + R() * 1.4, 1.2 + R() * 1.2, -0.5, 1.6);
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

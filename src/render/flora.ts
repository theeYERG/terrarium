// Low poly trees and decorations (rocks, grass tufts, flowers, bushes).
// Trees sway, char and shrink while burning, and follow their physics body when they fall.
// Decorations quietly shrink away when the ground under them changes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DecorSpec } from '../sim/generate.ts';
import { M } from '../sim/materials.ts';
import { mulberry32 } from '../sim/noise.ts';
import type { TerrainManager } from './terrain.ts';

const TREE_FALLEN = 3, TREE_GONE = 4, TREE_BURNT = 2;

function ni(g: THREE.BufferGeometry) {
  return g.index ? g.toNonIndexed() : g;
}

function jitter(g: THREE.BufferGeometry, amt: number, rnd: () => number) {
  // move shared positions consistently so the low poly surface doesn't crack
  const p = g.attributes.position;
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = seen.get(key);
    if (!d) { d = [(rnd() - 0.5) * amt, (rnd() - 0.5) * amt, (rnd() - 0.5) * amt]; seen.set(key, d); }
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
}

function paint(g: THREE.BufferGeometry, base: THREE.Color, vary: number, rnd: () => number) {
  // one colour per triangle, slightly varied: the low poly look
  const ng = ni(g);
  const n = ng.attributes.position.count;
  const cols = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let t = 0; t < n; t += 3) {
    c.copy(base).multiplyScalar(1 - vary / 2 + rnd() * vary);
    for (let k = 0; k < 3; k++) { cols[(t + k) * 3] = c.r; cols[(t + k) * 3 + 1] = c.g; cols[(t + k) * 3 + 2] = c.b; }
  }
  ng.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  ng.computeVertexNormals();
  return ng;
}

function stripToPosColor(g: THREE.BufferGeometry) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'color' && k !== 'normal') g.deleteAttribute(k);
  return g;
}

interface TreeView {
  id: number;
  group: THREE.Group;
  crown: THREE.Mesh;
  trunk: THREE.Mesh;
  crownMat: THREE.MeshStandardMaterial;
  trunkMat: THREE.MeshStandardMaterial;
  seed: number;
  kind: number;
  h: number;
  base: THREE.Vector3;
  state: number;
  burn: number;
  onFire: boolean;
  vanish: number;
}

export class TreeRenderer {
  group = new THREE.Group();
  private trees = new Map<number, TreeView>();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  clear() {
    for (const t of this.trees.values()) this.removeView(t);
    this.trees.clear();
  }

  private removeView(t: TreeView) {
    this.group.remove(t.group);
    t.crown.geometry.dispose(); t.trunk.geometry.dispose();
    t.crownMat.dispose(); t.trunkMat.dispose();
  }

  private build(id: number, kind: number, h: number, seed: number, x: number, y: number, z: number): TreeView {
    const rnd = mulberry32(seed);
    const crownParts: THREE.BufferGeometry[] = [];
    let trunkH = h * 0.55;
    const leaf = new THREE.Color(kind === 1 ? 0x4f9a58 : kind === 2 ? 0x9bd06a : 0x6cb556);
    if (kind === 1) {
      // pine: stacked cones
      trunkH = h * 0.35;
      const layers = 3 + Math.floor(rnd() * 2);
      for (let k = 0; k < layers; k++) {
        const f = k / layers;
        const r = (1 - f * 0.65) * h * 0.26;
        const ch = h * 0.36;
        const g = new THREE.ConeGeometry(r, ch, 7, 1);
        g.translate(0, h * 0.3 + f * h * 0.55 + ch * 0.5, 0);
        g.rotateY(rnd() * 3);
        crownParts.push(g);
      }
    } else if (kind === 2) {
      const g = new THREE.IcosahedronGeometry(h * 0.3, 1);
      g.scale(1, 1.15, 1);
      g.translate(0, h * 0.7, 0);
      crownParts.push(g);
    } else {
      // oak: a few chunky blobs
      const blobs = 3 + Math.floor(rnd() * 2);
      for (let k = 0; k < blobs; k++) {
        const r = h * (0.2 + rnd() * 0.1);
        const g = new THREE.IcosahedronGeometry(r, 0);
        const a = rnd() * Math.PI * 2, d = k === 0 ? 0 : h * 0.17;
        g.translate(Math.cos(a) * d, h * (0.66 + rnd() * 0.14), Math.sin(a) * d);
        crownParts.push(g);
      }
    }
    let crownG = mergeGeometries(crownParts.map((g) => stripToPosColor(ni(g))), false)!;
    jitter(crownG, h * 0.045, rnd);
    crownG = paint(crownG, leaf, 0.22, rnd);
    let trunkG: THREE.BufferGeometry = new THREE.CylinderGeometry(0.16 + h * 0.012, 0.26 + h * 0.02, trunkH + 0.4, 6, 1);
    trunkG.translate(0, (trunkH + 0.4) / 2 - 0.3, 0);
    trunkG = paint(stripToPosColor(ni(trunkG)), new THREE.Color(kind === 2 ? 0xd8d0c0 : 0x7a5235), 0.2, rnd);
    const crownMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
    const trunkMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
    const crown = new THREE.Mesh(crownG, crownMat);
    const trunk = new THREE.Mesh(trunkG, trunkMat);
    for (const m of [crown, trunk]) { m.castShadow = true; m.receiveShadow = true; }
    const group = new THREE.Group();
    group.add(trunk, crown);
    group.position.set(x, y, z);
    group.rotation.y = rnd() * Math.PI * 2;
    this.group.add(group);
    return { id, group, crown, trunk, crownMat, trunkMat, seed, kind, h, base: new THREE.Vector3(x, y, z), state: 0, burn: 0, onFire: false, vanish: 0 };
  }

  /** id, state, burn, onFire, x, y, z, kind, h, seed per tree */
  set(data: Float32Array) {
    const seen = new Set<number>();
    for (let o = 0; o < data.length; o += 10) {
      const id = data[o];
      seen.add(id);
      let t = this.trees.get(id);
      if (!t) {
        t = this.build(id, data[o + 7], data[o + 8], data[o + 9], data[o + 4], data[o + 5], data[o + 6]);
        this.trees.set(id, t);
      }
      t.state = data[o + 1];
      t.burn = data[o + 2];
      t.onFire = data[o + 3] > 0.5;
    }
    for (const [id, t] of this.trees) if (!seen.has(id)) { this.removeView(t); this.trees.delete(id); }
  }

  update(dt: number, time: number, poses: Map<number, { p: THREE.Vector3; q: THREE.Quaternion }>) {
    const char = new THREE.Color(0x2a2220);
    for (const t of this.trees.values()) {
      if (t.state === TREE_GONE) {
        t.vanish = Math.min(1, t.vanish + dt * 2);
        t.group.scale.setScalar(Math.max(0.001, 1 - t.vanish));
        t.group.visible = t.vanish < 1;
        continue;
      }
      if (t.state === TREE_FALLEN) {
        const pose = poses.get(t.id);
        if (pose) {
          t.group.position.copy(pose.p);
          t.group.quaternion.copy(pose.q);
        }
      } else {
        // a gentle sway from the wind, stronger at the top
        const s = Math.sin(time * 0.9 + t.seed) * 0.025 + Math.sin(time * 2.1 + t.seed * 2) * 0.008;
        t.crown.rotation.set(s, 0, s * 0.7);
      }
      // charring: colours fade toward charcoal, the crown shrinks away as it burns
      const b = t.burn;
      t.crownMat.color.setRGB(1, 1, 1).lerp(char, Math.min(1, b * 1.6));
      t.trunkMat.color.setRGB(1, 1, 1).lerp(char, Math.min(1, b * 1.2));
      const crownScale = t.state === TREE_BURNT ? 0 : 1 - Math.max(0, b - 0.35) / 0.65 * 0.95;
      const cs = t.crown.scale.x + (Math.max(0.001, crownScale) - t.crown.scale.x) * Math.min(1, dt * 4);
      t.crown.scale.setScalar(cs);
      t.crown.visible = cs > 0.01;
      if (t.onFire) {
        const f = 0.35 + 0.25 * Math.sin(time * 11 + t.seed) * Math.sin(time * 5.3);
        t.crownMat.emissive.setRGB(0.9 * f, 0.3 * f, 0.05 * f);
        t.trunkMat.emissive.setRGB(0.5 * f, 0.15 * f, 0.02 * f);
      } else {
        t.crownMat.emissive.setRGB(0, 0, 0);
        t.trunkMat.emissive.multiplyScalar(0.95);
      }
    }
  }
}

// ───────────────────────────── decorations ─────────────────────────────

const FLOWER_COLORS = [0xf7e36a, 0xf08ab0, 0xffffff, 0xa98af0];

export class DecorRenderer {
  private meshes: THREE.InstancedMesh[] = [];
  private specs: DecorSpec[] = [];
  private scale = new Float32Array(0);
  private alive = new Uint8Array(0);
  private dummy = new THREE.Object3D();
  private checkT = 0;
  private dirty = true;
  private terrain: TerrainManager;

  constructor(scene: THREE.Scene, terrain: TerrainManager) {
    this.terrain = terrain;
    const rnd = mulberry32(42);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
    // 0 rock
    let rock: THREE.BufferGeometry = new THREE.DodecahedronGeometry(0.6, 0);
    rock.scale(1, 0.7, 1);
    rock = stripToPosColor(ni(rock));
    jitter(rock, 0.25, rnd);
    rock = paint(rock, new THREE.Color(0xffffff), 0.18, rnd);
    // 1 grass tuft: a few thin blades
    const blades: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      const g = new THREE.ConeGeometry(0.07, 0.5 + rnd() * 0.3, 3, 1);
      g.translate(0, 0.25, 0);
      g.rotateZ((rnd() - 0.5) * 0.6);
      g.rotateX((rnd() - 0.5) * 0.6);
      g.translate((rnd() - 0.5) * 0.25, 0, (rnd() - 0.5) * 0.25);
      blades.push(stripToPosColor(ni(g)));
    }
    const tuft = paint(mergeGeometries(blades, false)!, new THREE.Color(0xffffff), 0.2, rnd);
    // 2 flower: stem + head
    const stem = new THREE.CylinderGeometry(0.02, 0.025, 0.45, 3);
    stem.translate(0, 0.22, 0);
    const stemP = paint(stripToPosColor(ni(stem)), new THREE.Color(0x4e8f3e), 0.1, rnd);
    const head = new THREE.IcosahedronGeometry(0.1, 0);
    head.translate(0, 0.47, 0);
    const headP = paint(stripToPosColor(ni(head)), new THREE.Color(0xffffff), 0.1, rnd);
    const flower = mergeGeometries([stemP, headP], false)!;
    // 3 bush
    let bush = stripToPosColor(ni(new THREE.IcosahedronGeometry(0.55, 0)));
    bush.scale(1, 0.75, 1);
    jitter(bush, 0.15, rnd);
    bush = paint(bush, new THREE.Color(0xffffff), 0.22, rnd);
    for (const g of [rock, tuft, flower, bush]) {
      const im = new THREE.InstancedMesh(g, mat, 800);
      im.castShadow = true;
      im.receiveShadow = true;
      im.count = 0;
      im.frustumCulled = false;
      im.setColorAt(0, new THREE.Color());
      scene.add(im);
      this.meshes.push(im);
    }
  }

  set(specs: DecorSpec[]) {
    this.specs = specs;
    this.scale = new Float32Array(specs.length).fill(1);
    this.alive = new Uint8Array(specs.length).fill(1);
    this.dirty = true;
  }

  update(dt: number) {
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.4;
      const t = this.terrain;
      for (let k = 0; k < this.specs.length; k++) {
        if (!this.alive[k]) continue;
        const s = this.specs[k];
        const gx = s.cell & 127, gz = (s.cell >> 7) & 127, gy = s.cell >> 14;
        const ground = t.matAt(gx, gy, gz);
        const fill = t.fillAt(gx, gy, gz);
        const above = t.matAt(Math.floor(s.x), Math.floor(s.y + 0.4), Math.floor(s.z));
        let ok = ground !== M.AIR && fill >= 96 && (above === M.AIR || t.fillAt(Math.floor(s.x), Math.floor(s.y + 0.4), Math.floor(s.z)) < 110);
        if (above === M.WATER || above === M.LAVA || above === M.OIL || above === M.ACID) ok = false;
        if ((s.k === 1 || s.k === 2) && ground !== M.GRASS) ok = false;
        if (!ok) { this.alive[k] = 0; this.dirty = true; }
      }
    }
    let animating = false;
    for (let k = 0; k < this.specs.length; k++) {
      if (!this.alive[k] && this.scale[k] > 0) {
        this.scale[k] = Math.max(0, this.scale[k] - dt * 3);
        animating = true;
      }
    }
    if (!this.dirty && !animating) return;
    this.dirty = false;
    const counts = [0, 0, 0, 0];
    const c = new THREE.Color();
    for (let k = 0; k < this.specs.length; k++) {
      const s = this.specs[k];
      const sc = this.scale[k];
      if (sc <= 0) continue;
      const e = sc * sc * (3 - 2 * sc);
      this.dummy.position.set(s.x, s.y, s.z);
      this.dummy.rotation.set(0, s.r, 0);
      this.dummy.scale.setScalar(s.s * e);
      this.dummy.updateMatrix();
      const im = this.meshes[s.k];
      const n = counts[s.k]++;
      im.setMatrixAt(n, this.dummy.matrix);
      if (s.k === 0) c.set([0x9aa0a6, 0x8a8f96, 0xb4aa98][s.v % 3]);
      else if (s.k === 1) c.set([0x86c95c, 0x74b84f, 0x96d468][s.v % 3]);
      else if (s.k === 2) c.set(FLOWER_COLORS[s.v % 4]);
      else c.set([0x5fa84c, 0x6fb757][s.v % 2]);
      im.setColorAt(n, c);
    }
    this.meshes.forEach((im, k) => {
      im.count = counts[k];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    });
  }
}

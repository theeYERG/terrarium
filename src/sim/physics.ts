// Rigid-body physics (Rapier) for everything that tumbles: powder grains, explosion rocks,
// chunks of terrain that broke loose, and trees that were knocked over.
//
// The terrain is a set of per-chunk trimesh colliders built from the same surface-nets
// triangles the renderer draws. When a grain or rock comes to rest it shrinks away while
// its fill is deposited back into the voxel grid, so piles grow smoothly. Tumbling chunks
// are written back cell by cell when they settle.

import RAPIER from '@dimforge/rapier3d-compat';
import { CHUNKS, LAYER, SX, SY, SZ } from './constants.ts';
import { M, MATERIALS, State, T_DENSITY, T_STATE } from './materials.ts';
import { GRAIN_RADIUS, rockPoints, rockSize, ROCK_VARIANTS } from './shapes.ts';
import { SOLID_FILL, World } from './world.ts';

export const KIND_GRAIN = 0, KIND_ROCK = 1, KIND_CHUNK = 2, KIND_TREE = 3;
export const MAX_GRAINS = 240, MAX_ROCKS = 160, MAX_CHUNKS = 8;

const G_TERRAIN = 1, G_GRAIN = 2, G_BODY = 4;
const groups = (member: number, filter: number) => (member << 16) | filter;

interface BodyRec {
  id: number;
  kind: number;
  mat: number;
  amount: number; // fill units carried (grain / rock)
  shape: number; // rock variant / tree id
  size: number;
  body: RAPIER.RigidBody | null;
  age: number;
  still: number;
  merge: number; // 0 = active, >0 merging progress 0..1
  deposited: number;
  px: number; py: number; pz: number; q: [number, number, number, number];
  cells?: Int16Array; // chunk: local offsets x,y,z per cell
  cellMat?: Uint8Array;
  cellFill?: Uint8Array;
  temp: number;
}

export interface ChunkSpawn {
  id: number;
  cells: Int16Array;
  mats: Uint8Array;
}

let ready: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!ready) ready = RAPIER.init();
  return ready;
}

export class Physics {
  w: World;
  world: RAPIER.World;
  private terrain: (RAPIER.Collider | null)[] = new Array(CHUNKS).fill(null);
  private terrainSum = new Float64Array(CHUNKS);
  bodies: BodyRec[] = [];
  private nextId = 1;
  grains = 0;
  rocks = 0;
  chunks = 0;
  /** new chunk bodies whose shape the renderer needs (sent once) */
  newChunks: ChunkSpawn[] = [];
  onTreeSettled: (treeId: number) => void = () => {};
  stepMs = 0;

  constructor(w: World) {
    this.w = w;
    this.world = new RAPIER.World({ x: 0, y: -28, z: 0 });
    this.world.timestep = 1 / 30;
  }

  reset() {
    for (const b of this.bodies) if (b.body) this.world.removeRigidBody(b.body);
    this.bodies = [];
    this.grains = this.rocks = this.chunks = 0;
    this.newChunks = [];
  }

  /** Swap in a chunk's terrain collider (skips identical geometry). */
  setTerrain(c: number, soup: Float32Array | null) {
    let sum = soup ? soup.length : 0;
    if (soup) for (let k = 0; k < soup.length; k += 7) sum += soup[k] * (k % 13 + 1);
    if (sum === this.terrainSum[c] && (soup !== null) === (this.terrain[c] !== null)) return;
    this.terrainSum[c] = sum;
    const old = this.terrain[c];
    if (old) this.world.removeCollider(old, true);
    this.terrain[c] = null;
    if (!soup || soup.length < 9) return;
    const idx = new Uint32Array(soup.length / 3);
    for (let k = 0; k < idx.length; k++) idx[k] = k;
    const desc = RAPIER.ColliderDesc.trimesh(soup, idx)
      .setFriction(0.85)
      .setCollisionGroups(groups(G_TERRAIN, G_GRAIN | G_BODY));
    this.terrain[c] = this.world.createCollider(desc);
    // bodies resting on the old surface should notice the change
    for (const b of this.bodies) if (b.body && b.body.isSleeping()) b.body.wakeUp();
  }

  canSpawn(kind: number) {
    if (kind === KIND_GRAIN) return this.grains < MAX_GRAINS;
    if (kind === KIND_ROCK) return this.rocks < MAX_ROCKS;
    return this.chunks < MAX_CHUNKS;
  }

  private rec(kind: number, mat: number, amount: number, shape: number, size: number, temp: number): BodyRec {
    return {
      id: this.nextId++, kind, mat, amount, shape, size, body: null, age: 0, still: 0, merge: 0, deposited: 0,
      px: 0, py: 0, pz: 0, q: [0, 0, 0, 1], temp,
    };
  }

  spawnGrain(x: number, y: number, z: number, vx: number, vy: number, vz: number, mat: number, amount: number, temp: number) {
    if (!this.canSpawn(KIND_GRAIN)) return false;
    const r = this.rec(KIND_GRAIN, mat, amount, 0, GRAIN_RADIUS, temp);
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinvel(vx, vy, vz)
      .setAngvel({ x: (Math.random() - 0.5) * 4, y: 0, z: (Math.random() - 0.5) * 4 })
      .setLinearDamping(0.05).setAngularDamping(0.6).setCcdEnabled(true);
    const body = this.world.createRigidBody(desc);
    const col = RAPIER.ColliderDesc.ball(GRAIN_RADIUS).setFriction(MATERIALS[mat].state === State.POWDER ? 0.95 : 0.7)
      .setRestitution(0.12).setDensity(Math.max(0.3, T_DENSITY[mat] / 1000))
      .setCollisionGroups(groups(G_GRAIN, G_TERRAIN | G_BODY));
    this.world.createCollider(col, body);
    r.body = body;
    this.bodies.push(r);
    this.grains++;
    return true;
  }

  spawnRock(x: number, y: number, z: number, vx: number, vy: number, vz: number, mat: number, amount: number, temp: number) {
    if (!this.canSpawn(KIND_ROCK)) return false;
    const variant = Math.floor(Math.random() * ROCK_VARIANTS);
    const size = rockSize(amount);
    const r = this.rec(KIND_ROCK, mat, amount, variant, size, temp);
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinvel(vx, vy, vz)
      .setAngvel({ x: (Math.random() - 0.5) * 9, y: (Math.random() - 0.5) * 9, z: (Math.random() - 0.5) * 9 })
      .setLinearDamping(0.04).setAngularDamping(0.25).setCcdEnabled(true);
    const body = this.world.createRigidBody(desc);
    const pts = rockPoints(variant);
    for (let k = 0; k < pts.length; k++) pts[k] *= size;
    const col = (RAPIER.ColliderDesc.convexHull(pts) ?? RAPIER.ColliderDesc.ball(size))
      .setFriction(0.8).setRestitution(0.25).setDensity(Math.max(0.3, T_DENSITY[mat] / 1000))
      .setCollisionGroups(groups(G_BODY, G_TERRAIN | G_GRAIN | G_BODY));
    this.world.createCollider(col, body);
    r.body = body;
    this.bodies.push(r);
    this.rocks++;
    return true;
  }

  /** A connected piece of terrain that lost its support: one tumbling rigid body. */
  spawnChunk(cells: number[], vx = 0, vy = 0, vz = 0): boolean {
    if (!this.canSpawn(KIND_CHUNK) || cells.length === 0) return false;
    const w = this.w;
    let cx = 0, cy = 0, cz = 0;
    for (const i of cells) { cx += (i & 127) + 0.5; cz += ((i >> 7) & 127) + 0.5; cy += (i >> 14) + 0.5; }
    cx /= cells.length; cy /= cells.length; cz /= cells.length;
    const r = this.rec(KIND_CHUNK, M.STONE, 0, 0, 1, 20);
    const n = cells.length;
    r.cells = new Int16Array(n * 3);
    r.cellMat = new Uint8Array(n);
    r.cellFill = new Uint8Array(n);
    // offsets are stored relative to the centroid, scaled x4 to keep the half cell
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(cx, cy, cz).setLinvel(vx, vy, vz)
      .setAngvel({ x: (Math.random() - 0.5) * 0.6, y: (Math.random() - 0.5) * 0.4, z: (Math.random() - 0.5) * 0.6 })
      .setLinearDamping(0.02).setAngularDamping(0.15).setCcdEnabled(true);
    const body = this.world.createRigidBody(desc);
    for (let k = 0; k < n; k++) {
      const i = cells[k];
      const x = (i & 127) + 0.5 - cx, z = ((i >> 7) & 127) + 0.5 - cz, y = (i >> 14) + 0.5 - cy;
      r.cells[k * 3] = Math.round(x * 4); r.cells[k * 3 + 1] = Math.round(y * 4); r.cells[k * 3 + 2] = Math.round(z * 4);
      r.cellMat[k] = w.mat[i] === M.GRASS ? M.GRASS : w.mat[i];
      r.cellFill[k] = w.fill[i];
      const he = 0.5 * Math.max(0.55, w.fill[i] / 255);
      const col = RAPIER.ColliderDesc.cuboid(he, he, he).setTranslation(x, y, z)
        .setFriction(0.8).setRestitution(0.1).setDensity(Math.max(0.3, T_DENSITY[w.mat[i]] / 1000))
        .setCollisionGroups(groups(G_BODY, G_TERRAIN | G_GRAIN | G_BODY));
      this.world.createCollider(col, body);
    }
    r.body = body;
    this.bodies.push(r);
    this.chunks++;
    this.newChunks.push({ id: r.id, cells: r.cells, mats: r.cellMat });
    return true;
  }

  /** A tree that lost its footing or got blasted: trunk + crown, tumbling. */
  spawnTree(treeId: number, x: number, y: number, z: number, h: number, kind: number, ix: number, iy: number, iz: number): number {
    const r = this.rec(KIND_TREE, M.WOOD, 0, treeId, h, 20);
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinearDamping(0.1).setAngularDamping(0.3).setCcdEnabled(true);
    const body = this.world.createRigidBody(desc);
    const g = groups(G_BODY, G_TERRAIN | G_GRAIN | G_BODY);
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(h * 0.45, 0.28).setTranslation(0, h * 0.45, 0).setDensity(0.7).setFriction(0.9).setCollisionGroups(g), body);
    const crownR = kind === 1 ? h * 0.22 : h * 0.3;
    this.world.createCollider(RAPIER.ColliderDesc.ball(crownR).setTranslation(0, h * (kind === 1 ? 0.6 : 0.72), 0).setDensity(0.25).setFriction(0.9).setCollisionGroups(g), body);
    body.applyImpulse({ x: ix, y: iy, z: iz }, true);
    // tip it over from the top
    body.applyTorqueImpulse({ x: iz * h * 0.15, y: 0, z: -ix * h * 0.15 }, true);
    r.body = body;
    this.bodies.push(r);
    return r.id;
  }

  /** Push everything within r of (x,y,z) away (explosions). */
  blast(x: number, y: number, z: number, r: number, power: number) {
    for (const b of this.bodies) {
      if (!b.body || b.merge) continue;
      const t = b.body.translation();
      const dx = t.x - x, dy = t.y - y, dz = t.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > r * 2.5 || d < 1e-3) continue;
      const f = power * (1 - d / (r * 2.5)) * b.body.mass();
      b.body.applyImpulse({ x: dx / d * f, y: (dy / d + 0.6) * f, z: dz / d * f }, true);
    }
  }

  step(deposit: (x: number, y: number, z: number, mat: number, amount: number, temp: number) => number) {
    const t0 = performance.now();
    const w = this.w;
    const dt = 1 / 30;
    // liquids: drag for everything, buoyancy for light things (wood, ice, snow floats)
    for (const b of this.bodies) {
      if (!b.body || b.merge) continue;
      const p = b.body.translation();
      const ix = Math.floor(p.x), iy = Math.floor(p.y), iz = Math.floor(p.z);
      if (ix < 0 || iz < 0 || ix >= SX || iz >= SZ || iy < 0 || iy >= SY) continue;
      const ci = ix + iz * SX + iy * LAYER;
      const lm = w.mat[ci];
      if (T_STATE[lm] !== State.LIQUID) continue;
      const v = b.body.linvel();
      const drag = lm === M.LAVA ? 0.75 : 0.88;
      b.body.setLinvel({ x: v.x * drag, y: v.y * drag, z: v.z * drag }, true);
      const rho = b.kind === KIND_TREE ? 600 : T_DENSITY[b.mat];
      const lift = T_DENSITY[lm] / Math.max(200, rho);
      const m = b.body.mass();
      b.body.applyImpulse({ x: 0, y: 28 * dt * m * Math.min(1.6, lift) * Math.min(1, w.mass[ci]), z: 0 }, true);
    }
    this.world.step();

    for (let k = 0; k < this.bodies.length; k++) {
      const b = this.bodies[k];
      b.age += dt;
      if (b.merge) {
        // shrinking into the ground; deposit the fill in a few steps
        b.merge = Math.min(1, b.merge + dt / 0.3);
        const want = b.amount * Math.min(1, b.merge * 1.25);
        if (b.kind !== KIND_CHUNK && want > b.deposited) {
          const left = deposit(b.px, b.py, b.pz, b.mat, want - b.deposited, b.temp);
          b.deposited = want - left;
        }
        if (b.merge >= 1 && (b.deposited >= b.amount - 0.5 || b.age > 30 || b.kind === KIND_CHUNK)) { this.drop(k); k--; }
        else if (b.merge >= 1) b.age += 0.5; // couldn't place it all yet: retry shortly
        continue;
      }
      const body = b.body!;
      const p = body.translation();
      const q = body.rotation();
      b.px = p.x; b.py = p.y; b.pz = p.z; b.q = [q.x, q.y, q.z, q.w];
      if (p.y < -40) { this.drop(k); k--; continue; }
      const v = body.linvel(), av = body.angvel();
      const speed = Math.hypot(v.x, v.y, v.z), spin = Math.hypot(av.x, av.y, av.z);
      const restV = b.kind === KIND_CHUNK || b.kind === KIND_TREE ? 0.35 : 0.5;
      if (body.isSleeping() || (speed < restV && spin < 1.2)) b.still += dt; else b.still = 0;
      const settle = b.kind === KIND_GRAIN ? 0.25 : b.kind === KIND_ROCK ? 0.45 : 1.0;
      // things that never quite stop (rolling forever, stuck in a liquid) merge anyway eventually
      const tooOld = b.kind === KIND_GRAIN ? 10 : b.kind === KIND_ROCK ? 16 : 22;
      if (b.kind === KIND_TREE) {
        if (b.still > 1.5 && !body.isSleeping()) body.sleep();
        if (b.still > 1.5 && b.deposited === 0) { b.deposited = 1; this.onTreeSettled(b.shape); }
        continue;
      }
      if (b.still > settle || b.age > tooOld) this.beginMerge(k);
    }
    this.stepMs = performance.now() - t0;
  }

  private beginMerge(k: number) {
    const b = this.bodies[k];
    if (b.kind === KIND_CHUNK) {
      this.bakeChunk(b);
    }
    if (b.body) { this.world.removeRigidBody(b.body); b.body = null; }
    b.merge = 0.001;
  }

  /** Write a settled chunk back into the grid, cell by cell, at its new pose. */
  private bakeChunk(b: BodyRec) {
    const w = this.w;
    const [qx, qy, qz, qw] = b.q;
    const n = b.cellMat!.length;
    for (let k = 0; k < n; k++) {
      const lx = b.cells![k * 3] / 4, ly = b.cells![k * 3 + 1] / 4, lz = b.cells![k * 3 + 2] / 4;
      // rotate the offset by the body's quaternion: v' = v + w*t + q×t, t = 2 q×v
      const tx = 2 * (qy * lz - qz * ly), ty = 2 * (qz * lx - qx * lz), tz = 2 * (qx * ly - qy * lx);
      const rx = lx + qw * tx + (qy * tz - qz * ty);
      const ry = ly + qw * ty + (qz * tx - qx * tz);
      const rz = lz + qw * tz + (qx * ty - qy * tx);
      let x = Math.floor(b.px + rx), y = Math.floor(b.py + ry), z = Math.floor(b.pz + rz);
      if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0) continue;
      for (let tries = 0; tries < 4 && y < SY; tries++, y++) {
        const i = x + z * SX + y * LAYER;
        const m = w.mat[i];
        if (m === M.AIR || T_STATE[m] === State.GAS || T_STATE[m] === State.LIQUID) {
          const mm = b.cellMat![k] === M.GRASS && tries > 0 ? M.DIRT : b.cellMat![k];
          w.set(i, mm, undefined, 0, 0, b.cellFill![k]);
          w.changeT[i] = w.time - 0.3; // start mid-blend: the chunk fades into the terrain
          break;
        }
      }
    }
  }

  private drop(k: number) {
    const b = this.bodies[k];
    if (b.body) this.world.removeRigidBody(b.body);
    if (b.kind === KIND_GRAIN) this.grains--;
    else if (b.kind === KIND_ROCK) this.rocks--;
    else if (b.kind === KIND_CHUNK) this.chunks--;
    this.bodies[k] = this.bodies[this.bodies.length - 1];
    this.bodies.pop();
  }

  removeTreeBody(treeId: number) {
    for (let k = 0; k < this.bodies.length; k++) {
      const b = this.bodies[k];
      if (b.kind === KIND_TREE && b.shape === treeId) { this.drop(k); return; }
    }
  }

  /** id, kind, mat, x,y,z, qx,qy,qz,qw, scale, shape (12 floats per body) */
  pack(): Float32Array {
    const out = new Float32Array(this.bodies.length * 12);
    let o = 0;
    for (const b of this.bodies) {
      out[o] = b.id; out[o + 1] = b.kind; out[o + 2] = b.mat;
      out[o + 3] = b.px; out[o + 4] = b.py; out[o + 5] = b.pz;
      out[o + 6] = b.q[0]; out[o + 7] = b.q[1]; out[o + 8] = b.q[2]; out[o + 9] = b.q[3];
      const shrink = b.merge ? 1 - easeInOut(b.merge) : 1;
      out[o + 10] = shrink;
      out[o + 11] = b.kind === KIND_ROCK ? b.shape * 1000 + Math.round(b.size * 100) : b.shape;
      o += 12;
    }
    return out;
  }

  bodyAt(x: number, y: number, z: number, r: number): boolean {
    for (const b of this.bodies) if (Math.hypot(b.px - x, b.py - y, b.pz - z) < r) return true;
    return false;
  }
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function isSolidCell(w: World, i: number) {
  const st = T_STATE[w.mat[i]];
  return (st === State.SOLID || st === State.POWDER) && w.fill[i] >= SOLID_FILL;
}

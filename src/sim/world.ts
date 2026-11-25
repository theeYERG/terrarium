// The voxel world: typed arrays plus the low-level mutation helpers every system uses.
//
// v2 data model
//   mat    material id per cell
//   fill   0..255 how much of a terrain cell is filled (surface nets iso = 128)
//   mass   0..~1.2 liquid mass for liquid cells (water, oil, lava, acid)
//   fluxX / fluxZ  liquid flow through the +x / +z face of each cell (virtual pipes)
//   prevMat + changeT  the material before the last change and when it happened, so the
//                      renderer can lerp colours instead of popping
//   foam   0..255 surf / splash foam on liquid cells, decays over time

import { ambientTemp, CHUNKS, CX, CZ, LAYER, SX, SY, SZ, VOLUME } from './constants.ts';
import { M, MATERIALS, State, T_STATE, T_STRUCT } from './materials.ts';
import { FastRandom } from './noise.ts';

export const F_SOURCE = 1; // permanent emitter / self-heating (lava pocket)
export const F_SETTLED = 2; // powder at rest
export const F_BURNING = 4; // terrain cell on fire (wood, leaves, grass, oil soaked...)
export const F_TRICKLE = 8; // gentle spring

export const AWAKE_TICKS = 6;
export const SOLID_FILL = 128; // a terrain cell blocks things once it's at least half full

export interface SimEvent {
  t: 'boom' | 'sizzle' | 'splash' | 'ignite' | 'puff';
  x: number; y: number; z: number;
  r?: number;
  c?: number; // colour (hex) for puffs
}

function isTerrainState(st: number) {
  return st === State.SOLID || st === State.POWDER;
}

export class World {
  mat = new Uint8Array(VOLUME);
  fill = new Uint8Array(VOLUME);
  temp = new Float32Array(VOLUME);
  life = new Uint8Array(VOLUME);
  flags = new Uint8Array(VOLUME);
  mass = new Float32Array(VOLUME);
  fluxX = new Float32Array(VOLUME);
  fluxZ = new Float32Array(VOLUME);
  prevMat = new Uint8Array(VOLUME);
  changeT = new Float32Array(VOLUME);
  foam = new Uint8Array(VOLUME);

  awake = new Uint8Array(CHUNKS);
  /** bit 1: terrain mesh needs rebuilding, bit 2: liquid mesh */
  dirty = new Uint8Array(CHUNKS);
  hot = new Float32Array(CHUNKS);

  ambient = new Float32Array(SY);
  tick = 0;
  time = 0; // simulated seconds
  rng = new FastRandom(1234567);

  /** Cells where a structural voxel disappeared this tick: seeds for the collapse check. */
  removedStruct: number[] = [];
  /** Freshly formed solids (e.g. quenched lava) that must prove they're supported. */
  newSolids: number[] = [];
  events: SimEvent[] = [];
  /** Pending explosions: x, y, z, radius */
  explosions: number[] = [];
  seed = 0;

  constructor() {
    for (let y = 0; y < SY; y++) this.ambient[y] = ambientTemp(y);
  }

  defaultTemp(m: number, y: number): number {
    const d = MATERIALS[m].defaultTemp;
    if (d !== null) return d;
    if (m === M.WATER) return Math.max(this.ambient[y], 4);
    return this.ambient[y];
  }

  /** Mark a cell's chunk (and touching neighbour chunks) awake and in need of a remesh. */
  wake(i: number, bits = 3): void {
    const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
    const cx = x >> 4, cz = z >> 4, cy = y >> 4;
    const c = cx + cz * CX + cy * CX * CZ;
    this.awake[c] = AWAKE_TICKS;
    this.dirty[c] |= bits;
    // surface nets reads one cell beyond the chunk on each side
    const lx = x & 15, ly = y & 15, lz = z & 15;
    if (lx <= 1 && cx > 0) this.touch(c - 1, bits);
    else if (lx >= 14 && cx < CX - 1) this.touch(c + 1, bits);
    if (lz <= 1 && cz > 0) this.touch(c - CX, bits);
    else if (lz >= 14 && cz < CZ - 1) this.touch(c + CX, bits);
    if (ly <= 1 && cy > 0) this.touch(c - CX * CZ, bits);
    else if (ly >= 14 && cy < 3) this.touch(c + CX * CZ, bits);
  }

  /** A liquid moved: only the liquid surface needs remeshing. */
  wakeLiquid(i: number): void {
    this.wake(i, 2);
  }

  /** Something here is warmer / colder than ambient: run heat conduction for this chunk. */
  markHot(i: number): void {
    const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
    const c = (x >> 4) + (z >> 4) * CX + (y >> 4) * CX * CZ;
    if (this.hot[c] < 10) this.hot[c] = 10;
  }

  /** Only keep the chunk simulating (no remesh needed). */
  keepAwake(i: number): void {
    const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
    this.awake[(x >> 4) + (z >> 4) * CX + (y >> 4) * CX * CZ] = AWAKE_TICKS;
  }

  private touch(c: number, bits: number) {
    this.awake[c] = AWAKE_TICKS;
    this.dirty[c] |= bits;
  }

  /** Neighbouring powders may now be able to slide: clear their resting flag. */
  disturb(i: number): void {
    const f = this.flags;
    const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
    if (x > 0) f[i - 1] &= ~F_SETTLED;
    if (x < SX - 1) f[i + 1] &= ~F_SETTLED;
    if (z > 0) f[i - SX] &= ~F_SETTLED;
    if (z < SZ - 1) f[i + SX] &= ~F_SETTLED;
    if (y < SY - 1) {
      const u = i + LAYER;
      f[u] &= ~F_SETTLED;
      if (x > 0) f[u - 1] &= ~F_SETTLED;
      if (x < SX - 1) f[u + 1] &= ~F_SETTLED;
      if (z > 0) f[u - SX] &= ~F_SETTLED;
      if (z < SZ - 1) f[u + SX] &= ~F_SETTLED;
    }
  }

  /**
   * Replace a cell's material. temp === undefined keeps the current temperature.
   * amount: fill (0..255) for terrain materials, mass (0..1) for liquids.
   */
  set(i: number, m: number, temp?: number, life = 0, flags = 0, amount = -1): void {
    const old = this.mat[i];
    if (T_STRUCT[old] && !T_STRUCT[m] && this.removedStruct.length < 20000) this.removedStruct.push(i);
    if (old !== m) {
      // remember the old look so the renderer can blend from it
      this.prevMat[i] = old === M.AIR || T_STATE[old] === State.GAS ? m : old;
      this.changeT[i] = old === M.AIR ? -10 : this.time;
    }
    this.mat[i] = m;
    const st = T_STATE[m];
    if (st === State.LIQUID) {
      this.mass[i] = amount >= 0 ? amount : 1;
      this.fill[i] = 0;
    } else if (st === State.SOLID || st === State.POWDER) {
      this.fill[i] = amount >= 0 ? amount : 255;
      this.mass[i] = 0;
    } else {
      this.fill[i] = 0;
      this.mass[i] = 0;
    }
    if (st !== State.LIQUID) { this.fluxX[i] = 0; this.fluxZ[i] = 0; }
    const terrainChange = isTerrainState(T_STATE[old]) || isTerrainState(st);
    if (temp !== undefined) {
      this.temp[i] = temp;
      const y = i >> 14;
      if (Math.abs(temp - this.ambient[y]) > 2) this.markHot(i);
    }
    this.life[i] = life;
    this.flags[i] = flags;
    this.wake(i, terrainChange ? 3 : 2);
    if (old !== m) this.disturb(i);
  }

  /** Change how full a terrain cell is; removes it below a small threshold. */
  setFill(i: number, f: number): void {
    const v = f < 0 ? 0 : f > 255 ? 255 : Math.round(f);
    if (v < 14) {
      if (this.mat[i] !== M.AIR) this.set(i, M.AIR);
      return;
    }
    if (this.fill[i] === v) return;
    const wasSolid = this.fill[i] >= SOLID_FILL;
    this.fill[i] = v;
    if (wasSolid && v < SOLID_FILL && T_STRUCT[this.mat[i]] && this.removedStruct.length < 20000) this.removedStruct.push(i);
    this.wake(i);
    this.disturb(i);
  }

  /** Fresh material at its default temperature. */
  place(i: number, m: number, flags = 0, amount = -1): void {
    const y = i >> 14;
    this.set(i, m, this.defaultTemp(m, y), 0, flags, amount);
  }

  /** Swap two cells completely (used for density sorting of liquids). */
  swap(a: number, b: number): void {
    const s = <T extends { [k: number]: number }>(arr: T) => { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; };
    s(this.mat); s(this.fill); s(this.temp); s(this.life); s(this.flags); s(this.mass);
    this.fluxX[a] = this.fluxX[b] = this.fluxZ[a] = this.fluxZ[b] = 0;
    this.wake(a);
    this.wake(b);
  }

  clear(): void {
    this.mat.fill(0);
    this.fill.fill(0);
    this.life.fill(0);
    this.flags.fill(0);
    this.mass.fill(0);
    this.fluxX.fill(0);
    this.fluxZ.fill(0);
    this.prevMat.fill(0);
    this.changeT.fill(-10);
    this.foam.fill(0);
    for (let y = 0; y < SY; y++) this.temp.fill(this.ambient[y], y * LAYER, (y + 1) * LAYER);
    this.awake.fill(AWAKE_TICKS);
    this.dirty.fill(3);
    this.hot.fill(0);
    this.removedStruct.length = 0;
    this.newSolids.length = 0;
    this.explosions.length = 0;
  }

  markAllDirty(): void {
    this.awake.fill(AWAKE_TICKS);
    this.dirty.fill(3);
  }

  event(e: SimEvent): void {
    if (this.events.length < 96) this.events.push(e);
  }

  /** Is this cell something solid that blocks movement? */
  blocks(i: number): boolean {
    const m = this.mat[i];
    const st = T_STATE[m];
    return (st === State.SOLID || st === State.POWDER) && this.fill[i] >= SOLID_FILL;
  }

  inBoundsXYZ(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ;
  }
}

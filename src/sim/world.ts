// The voxel world: typed arrays plus the low-level mutation helpers every system uses.
// All mutations go through set()/swap() so chunk wake-up and remesh flags stay correct.

import { ambientTemp, CHUNKS, CX, CZ, LAYER, SX, SY, SZ, VOLUME } from './constants.ts';
import { M, MATERIALS, T_STRUCT } from './materials.ts';
import { FastRandom } from './noise.ts';

export const F_SOURCE = 1; // permanent emitter / self-heating (lava pocket)
export const F_SETTLED = 2; // powder at rest (angle of repose); cleared when a neighbour moves
export const F_FUEL = 4; // fire that is consuming a fuel voxel (does not drift)
export const F_GRASS = 8; // fire that was grass: leaves dirt behind

export const AWAKE_TICKS = 6;

export interface SimEvent {
  t: 'boom' | 'sizzle' | 'splash' | 'ignite' | 'shatter';
  x: number; y: number; z: number;
  r?: number;
}

export class World {
  mat = new Uint8Array(VOLUME);
  temp = new Float32Array(VOLUME);
  life = new Uint8Array(VOLUME);
  flags = new Uint8Array(VOLUME);
  stamp = new Uint8Array(VOLUME);

  awake = new Uint8Array(CHUNKS);
  dirty = new Uint8Array(CHUNKS);
  hot = new Float32Array(CHUNKS);
  /** count of moving / reacting cells per chunk in the last tick (for stats + sleeping) */
  activity = new Uint16Array(CHUNKS);

  ambient = new Float32Array(SY);
  tick = 0;
  curStamp = 1;
  rng = new FastRandom(1234567);

  /** Cells where a structural voxel disappeared this tick: seeds for the collapse check. */
  removedStruct: number[] = [];
  events: SimEvent[] = [];
  /** Pending explosions: x, y, z, radius */
  explosions: number[] = [];
  seed = 0;

  constructor() {
    for (let y = 0; y < SY; y++) this.ambient[y] = ambientTemp(y);
  }

  defaultTemp(m: number, y: number): number {
    const d = MATERIALS[m].defaultTemp;
    return d === null ? this.ambient[y] : d;
  }

  /** Mark a cell's chunk (and the touching neighbour chunks) awake and in need of a remesh. */
  wake(i: number): void {
    const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
    const cx = x >> 4, cz = z >> 4, cy = y >> 4;
    const c = cx + cz * CX + cy * CX * CZ;
    this.awake[c] = AWAKE_TICKS;
    this.dirty[c] = 1;
    const lx = x & 15, ly = y & 15, lz = z & 15;
    if (lx === 0 && cx > 0) this.touch(c - 1);
    else if (lx === 15 && cx < CX - 1) this.touch(c + 1);
    if (lz === 0 && cz > 0) this.touch(c - CX);
    else if (lz === 15 && cz < CZ - 1) this.touch(c + CX);
    if (ly === 0 && cy > 0) this.touch(c - CX * CZ);
    else if (ly === 15 && cy < 3) this.touch(c + CX * CZ);
  }

  private touch(c: number) {
    this.awake[c] = AWAKE_TICKS;
    this.dirty[c] = 1;
  }

  /** Neighbouring powders may now be able to roll: clear their resting flag. */
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
      // diagonals above can now roll down into the hole
      if (x > 0) f[u - 1] &= ~F_SETTLED;
      if (x < SX - 1) f[u + 1] &= ~F_SETTLED;
      if (z > 0) f[u - SX] &= ~F_SETTLED;
      if (z < SZ - 1) f[u + SX] &= ~F_SETTLED;
    }
  }

  /** Replace a cell's material. temp === undefined keeps the current temperature. */
  set(i: number, m: number, temp?: number, life = 0, flags = 0): void {
    const old = this.mat[i];
    if (T_STRUCT[old] && !T_STRUCT[m] && this.removedStruct.length < 20000) this.removedStruct.push(i);
    this.mat[i] = m;
    if (temp !== undefined) this.temp[i] = temp;
    this.life[i] = life;
    this.flags[i] = flags;
    this.stamp[i] = this.curStamp;
    this.wake(i);
    if (old !== m) this.disturb(i);
  }

  /** Fresh material at its default temperature. */
  place(i: number, m: number, flags = 0): void {
    const y = i >> 14;
    const mm = MATERIALS[m];
    let life = 0;
    if (mm.life[1] > 0) life = mm.life[0] + this.rng.int(mm.life[1] - mm.life[0] + 1);
    this.set(i, m, this.defaultTemp(m, y), life, flags);
  }

  /** Swap two cells (movement). Both are stamped as moved this tick. */
  swap(a: number, b: number): void {
    const mat = this.mat, temp = this.temp, life = this.life, flags = this.flags;
    const m = mat[a]; mat[a] = mat[b]; mat[b] = m;
    const t = temp[a]; temp[a] = temp[b]; temp[b] = t;
    const l = life[a]; life[a] = life[b]; life[b] = l;
    const f = flags[a]; flags[a] = flags[b] & ~F_SETTLED; flags[b] = f & ~F_SETTLED;
    this.stamp[a] = this.curStamp;
    this.stamp[b] = this.curStamp;
    this.wake(a);
    this.wake(b);
    this.disturb(a);
  }

  clear(): void {
    this.mat.fill(0);
    this.life.fill(0);
    this.flags.fill(0);
    this.stamp.fill(0);
    for (let y = 0; y < SY; y++) this.temp.fill(this.ambient[y], y * LAYER, (y + 1) * LAYER);
    this.awake.fill(AWAKE_TICKS);
    this.dirty.fill(1);
    this.hot.fill(0);
    this.removedStruct.length = 0;
    this.explosions.length = 0;
  }

  markAllDirty(): void {
    this.awake.fill(AWAKE_TICKS);
    this.dirty.fill(1);
  }

  event(e: SimEvent): void {
    if (this.events.length < 64) this.events.push(e);
  }

  isAir(i: number): boolean {
    return this.mat[i] === M.AIR;
  }
}

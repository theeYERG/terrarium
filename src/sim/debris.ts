// Flying voxels: explosion debris, collapsing chunks and rained solids.
// Simulated as point masses with gravity; when they hit something they turn back into voxels.

import { LAYER, SX, SY, SZ } from './constants.ts';
import { State, T_DENSITY, T_MOVABLE, T_STATE } from './materials.ts';
import type { World } from './world.ts';

export const MAX_DEBRIS = 12000;
const GRAVITY = 30; // cells / s²

export class Debris {
  px = new Float32Array(MAX_DEBRIS);
  py = new Float32Array(MAX_DEBRIS);
  pz = new Float32Array(MAX_DEBRIS);
  vx = new Float32Array(MAX_DEBRIS);
  vy = new Float32Array(MAX_DEBRIS);
  vz = new Float32Array(MAX_DEBRIS);
  mat = new Uint8Array(MAX_DEBRIS);
  temp = new Float32Array(MAX_DEBRIS);
  count = 0;
  landed = 0;
  private w: World;

  constructor(w: World) {
    this.w = w;
  }

  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, m: number, t: number): boolean {
    if (this.count >= MAX_DEBRIS) return false;
    const k = this.count++;
    this.px[k] = x; this.py[k] = y; this.pz[k] = z;
    this.vx[k] = vx; this.vy[k] = vy; this.vz[k] = vz;
    this.mat[k] = m;
    this.temp[k] = t;
    return true;
  }

  clear() {
    this.count = 0;
  }

  private remove(k: number) {
    const last = --this.count;
    if (k !== last) {
      this.px[k] = this.px[last]; this.py[k] = this.py[last]; this.pz[k] = this.pz[last];
      this.vx[k] = this.vx[last]; this.vy[k] = this.vy[last]; this.vz[k] = this.vz[last];
      this.mat[k] = this.mat[last];
      this.temp[k] = this.temp[last];
    }
  }

  private cellAt(x: number, y: number, z: number): number {
    // -1: out of world (free space), otherwise the index
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= SX || iy >= SY || iz >= SZ) return -1;
    return ix + iz * SX + iy * LAYER;
  }

  step(dt: number): void {
    const w = this.w;
    for (let k = 0; k < this.count; k++) {
      let vx = this.vx[k], vy = this.vy[k], vz = this.vz[k];
      vy -= GRAVITY * dt;
      const m = this.mat[k];
      const isLiquid = T_STATE[m] === State.LIQUID;
      // inside a liquid: heavy drag
      const here = this.cellAt(this.px[k], this.py[k], this.pz[k]);
      if (here >= 0 && T_STATE[w.mat[here]] === State.LIQUID) {
        if (vy < -6 && w.events.length < 40 && w.rng.next() < 0.25) {
          w.event({ t: 'splash', x: this.px[k], y: this.py[k] + 0.5, z: this.pz[k] });
        }
        vx *= 0.8; vy *= 0.8; vz *= 0.8;
      } else {
        vx *= 0.995; vz *= 0.995;
      }
      const speed = Math.max(Math.abs(vx), Math.abs(vy), Math.abs(vz)) * dt;
      const steps = Math.max(1, Math.ceil(speed / 0.8));
      let x = this.px[k], y = this.py[k], z = this.pz[k];
      let landed = false;
      for (let s = 0; s < steps; s++) {
        const nx = x + (vx * dt) / steps, ny = y + (vy * dt) / steps, nz = z + (vz * dt) / steps;
        const c = this.cellAt(nx, ny, nz);
        if (c >= 0) {
          const cm = w.mat[c];
          // solids sink through liquids, unless they're lighter (ice and wood float)
          const blocked = !T_MOVABLE[cm] && (isLiquid || T_STATE[cm] !== State.LIQUID || T_DENSITY[m] < T_DENSITY[cm]);
          if (blocked) {
            landed = this.land(k, x, y, z);
            break;
          }
        }
        x = nx; y = ny; z = nz;
      }
      if (landed) {
        this.remove(k);
        k--;
        continue;
      }
      if (y < -40) {
        this.remove(k);
        k--;
        continue;
      }
      this.px[k] = x; this.py[k] = y; this.pz[k] = z;
      this.vx[k] = vx; this.vy[k] = vy; this.vz[k] = vz;
    }
  }

  /** Turn particle k into a voxel at (or near) the given position. */
  private land(k: number, x: number, y: number, z: number): boolean {
    const w = this.w;
    const m = this.mat[k];
    let c = this.cellAt(x, y, z);
    if (c < 0) return true; // left the world
    for (let tries = 0; tries < 4; tries++) {
      const cm = w.mat[c];
      if (T_MOVABLE[cm]) {
        w.set(c, m, this.temp[k]);
        this.landed++;
        return true;
      }
      if (T_STATE[cm] === State.LIQUID && T_STATE[m] !== State.LIQUID) {
        // displace the liquid upward
        let up = c + LAYER;
        let n = 0;
        while (up < SX * SZ * SY && !T_MOVABLE[w.mat[up]] && n < 24) { up += LAYER; n++; }
        if (up < SX * SZ * SY && T_MOVABLE[w.mat[up]]) {
          w.set(up, cm, w.temp[c]);
          w.set(c, m, this.temp[k]);
          this.landed++;
          return true;
        }
      }
      c += LAYER;
      if (c >= SX * SZ * SY) return true;
    }
    return true;
  }

  /** Pack for the renderer: x, y, z, vx, vy, vz, mat */
  pack(): Float32Array {
    const out = new Float32Array(this.count * 7);
    for (let k = 0; k < this.count; k++) {
      const o = k * 7;
      out[o] = this.px[k]; out[o + 1] = this.py[k]; out[o + 2] = this.pz[k];
      out[o + 3] = this.vx[k]; out[o + 4] = this.vy[k]; out[o + 5] = this.vz[k];
      out[o + 6] = this.mat[k];
    }
    return out;
  }
}

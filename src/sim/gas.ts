// Fire, smoke, steam and sparks as free particles (v2). They drift, rise, swirl and fade;
// fire heats the cells it passes through (that's how it spreads), water puts it out,
// steam cools and condenses back into falling drops, sparks fall and light fuel.

import { LAYER, SX, SY, SZ } from './constants.ts';
import type { Liquids } from './liquids.ts';
import { M, State, T_FLAM, T_IGNITE, T_STATE } from './materials.ts';
import { SOLID_FILL, World } from './world.ts';

export const GAS_FIRE = 0, GAS_SMOKE = 1, GAS_STEAM = 2, GAS_SPARK = 3;
export const MAX_GAS = 5000;

// buoyancy, drag, base life
const BUOY = [10, 3.2, 4.5, -22];
const DRAG = [2.2, 1.1, 1.0, 0.3];

export class Gas {
  w: World;
  liquids: Liquids | null = null;
  x = new Float32Array(MAX_GAS); y = new Float32Array(MAX_GAS); z = new Float32Array(MAX_GAS);
  vx = new Float32Array(MAX_GAS); vy = new Float32Array(MAX_GAS); vz = new Float32Array(MAX_GAS);
  type = new Uint8Array(MAX_GAS);
  life = new Float32Array(MAX_GAS);
  max = new Float32Array(MAX_GAS);
  temp = new Float32Array(MAX_GAS);
  seed = new Float32Array(MAX_GAS);
  n = 0;
  fireCount = 0;

  constructor(w: World) {
    this.w = w;
  }

  clear() {
    this.n = 0;
  }

  spawn(t: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, life = -1) {
    if (this.n >= MAX_GAS) {
      // full: recycle the oldest smoke rather than dropping new fire
      if (t !== GAS_FIRE) return;
      let k = 0;
      for (; k < this.n; k++) if (this.type[k] === GAS_SMOKE) break;
      if (k >= this.n) return;
      this.removeAt(k);
    }
    const r = this.w.rng;
    const k = this.n++;
    this.x[k] = x; this.y[k] = y; this.z[k] = z;
    this.vx[k] = vx + (r.next() - 0.5) * 0.6;
    this.vy[k] = vy + (t === GAS_SPARK ? 2 + r.next() * 3 : r.next() * 0.8);
    this.vz[k] = vz + (r.next() - 0.5) * 0.6;
    this.type[k] = t;
    const base = t === GAS_FIRE ? 0.55 + r.next() * 0.6 : t === GAS_SMOKE ? 2.5 + r.next() * 2.5 : t === GAS_STEAM ? 2.2 + r.next() * 2 : 1 + r.next() * 1.5;
    this.life[k] = this.max[k] = life > 0 ? life : base;
    this.temp[k] = t === GAS_FIRE ? 800 : t === GAS_STEAM ? 110 : t === GAS_SPARK ? 700 : 60;
    this.seed[k] = r.next() * 100;
  }

  private removeAt(k: number) {
    const l = --this.n;
    if (k === l) return;
    this.x[k] = this.x[l]; this.y[k] = this.y[l]; this.z[k] = this.z[l];
    this.vx[k] = this.vx[l]; this.vy[k] = this.vy[l]; this.vz[k] = this.vz[l];
    this.type[k] = this.type[l]; this.life[k] = this.life[l]; this.max[k] = this.max[l];
    this.temp[k] = this.temp[l]; this.seed[k] = this.seed[l];
  }

  step(dt: number) {
    const w = this.w;
    const { mat, fill, temp } = w;
    const time = w.time;
    let fires = 0;
    for (let k = 0; k < this.n; k++) {
      const t = this.type[k];
      this.life[k] -= dt;
      if (this.life[k] <= 0) {
        if (t === GAS_FIRE && w.rng.next() < 0.3) {
          // flames end as a wisp of smoke
          this.type[k] = GAS_SMOKE;
          this.life[k] = this.max[k] = 1.6 + w.rng.next() * 1.6;
          this.temp[k] = 120;
        } else if (t === GAS_STEAM && this.liquids && w.rng.next() < 0.35) {
          this.liquids.spawnDrop(M.WATER, this.x[k], this.y[k], this.z[k], this.vx[k] * 0.3, 0, this.vz[k] * 0.3, 0.05, 40);
          this.removeAt(k); k--; continue;
        } else { this.removeAt(k); k--; continue; }
      }
      const s = this.seed[k];
      // buoyancy + gentle swirl (smooth noise from sines) + drag
      this.vy[k] += BUOY[this.type[k]] * dt;
      const sw = this.type[k] === GAS_SPARK ? 0.3 : 2.4;
      this.vx[k] += Math.sin(time * 1.3 + s + this.y[k] * 0.35) * sw * dt;
      this.vz[k] += Math.cos(time * 1.1 + s * 1.7 + this.x[k] * 0.3) * sw * dt;
      const dr = Math.exp(-DRAG[this.type[k]] * dt);
      this.vx[k] *= dr; this.vz[k] *= dr;
      if (this.type[k] !== GAS_SPARK) this.vy[k] *= dr;
      const nx = this.x[k] + this.vx[k] * dt, ny = this.y[k] + this.vy[k] * dt, nz = this.z[k] + this.vz[k] * dt;
      const cx = Math.floor(nx), cy = Math.floor(ny), cz = Math.floor(nz);
      if (cx < 0 || cz < 0 || cx >= SX || cz >= SZ || cy < 0) {
        if (cy < -20) { this.removeAt(k); k--; continue; }
        this.x[k] = nx; this.y[k] = ny; this.z[k] = nz;
        continue;
      }
      if (cy >= SY) {
        // leaving the top of the world: fade out quickly
        this.life[k] = Math.min(this.life[k], 0.4);
        this.x[k] = nx; this.y[k] = ny; this.z[k] = nz;
        continue;
      }
      const ci = cx + cz * SX + cy * LAYER;
      const m = mat[ci];
      const st = T_STATE[m];
      if ((st === State.SOLID || st === State.POWDER) && fill[ci] >= SOLID_FILL) {
        if (this.type[k] === GAS_SPARK) {
          if (T_FLAM[m] > 0) temp[ci] = Math.max(temp[ci], T_IGNITE[m] + 40);
          w.keepAwake(ci);
          this.removeAt(k); k--; continue;
        }
        // slide along ceilings / walls
        this.vy[k] = Math.min(0, this.vy[k]) * -0.2;
        this.vx[k] += (w.rng.next() - 0.5) * 3;
        this.vz[k] += (w.rng.next() - 0.5) * 3;
        continue;
      }
      if (st === State.LIQUID) {
        if (this.type[k] === GAS_FIRE || this.type[k] === GAS_SPARK) {
          if (m === M.WATER) { this.type[k] = GAS_STEAM; this.life[k] = this.max[k] = 1.2; this.temp[k] = 105; }
          else if (m === M.OIL) w.flags[ci] |= 4; // F_BURNING: the oil catches
        }
      }
      this.x[k] = nx; this.y[k] = ny; this.z[k] = nz;

      const tt = this.type[k];
      if (tt === GAS_FIRE) {
        fires++;
        // heat the cell we're in and the ones around it; that's how fire spreads
        const heat = 0.18;
        const target = 780;
        temp[ci] += (target - temp[ci]) * heat;
        if (cy > 0) { const b = ci - LAYER; temp[b] += (target - temp[b]) * heat * 0.6; w.keepAwake(b); }
        if (cx > 0) { const b = ci - 1; temp[b] += (target - temp[b]) * heat * 0.35; }
        if (cx < SX - 1) { const b = ci + 1; temp[b] += (target - temp[b]) * heat * 0.35; }
        if (cz > 0) { const b = ci - SX; temp[b] += (target - temp[b]) * heat * 0.35; }
        if (cz < SZ - 1) { const b = ci + SX; temp[b] += (target - temp[b]) * heat * 0.35; }
        w.keepAwake(ci);
        w.markHot(ci);
      } else if (tt === GAS_STEAM) {
        this.temp[k] += (w.ambient[cy] - this.temp[k]) * dt * 0.35;
      }
    }
    this.fireCount = fires;
  }

  /** x,y,z,vx,vy,vz,type,age(0..1),seed per particle */
  pack(): Float32Array {
    const out = new Float32Array(this.n * 9);
    for (let k = 0; k < this.n; k++) {
      const o = k * 9;
      out[o] = this.x[k]; out[o + 1] = this.y[k]; out[o + 2] = this.z[k];
      out[o + 3] = this.vx[k]; out[o + 4] = this.vy[k]; out[o + 5] = this.vz[k];
      out[o + 6] = this.type[k];
      out[o + 7] = 1 - this.life[k] / this.max[k];
      out[o + 8] = this.seed[k];
    }
    return out;
  }
}

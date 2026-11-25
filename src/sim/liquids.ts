// Liquids, v2.
//
// Pools and lakes: every liquid cell holds a continuous mass (0..1). Mass falls into the
// cell below, then spreads sideways through "virtual pipes": each face keeps a flux that
// accelerates with the difference in head (mass + the column just above it) and keeps
// part of its momentum, so water levels out, sloshes and makes waves, and flows downhill
// continuously. Viscosity (gain, momentum, minimum head difference) differs per liquid.
//
// Falling liquid: as soon as a liquid cell has nothing under it, its mass turns into
// droplet particles (gravity + cohesion + XSPH smoothing) that merge back into the cells
// where they land. That's what makes waterfalls and pours look like continuous streams.

import { CHUNKS, CS, CX, CZ, LAYER, SX, SY, SZ, VOLUME } from './constants.ts';
import { M, State, T_DENSITY, T_FLAM, T_IGNITE, T_STATE } from './materials.ts';
import { F_BURNING, F_SOURCE, SOLID_FILL, World } from './world.ts';

// gain, momentum kept per tick, minimum head difference before anything moves
const FLOW: Record<number, [number, number, number]> = {
  [M.WATER]: [0.24, 0.88, 0.006],
  [M.ACID]: [0.22, 0.86, 0.006],
  [M.OIL]: [0.13, 0.82, 0.02],
  [M.LAVA]: [0.035, 0.5, 0.11],
};
const GAIN = new Float32Array(32), KEEP = new Float32Array(32), MINH = new Float32Array(32);
// a liquid only creeps onto dry ground while its puddle is at least this deep (surface tension);
// without this a small spill would spread into an endless film and vanish
const SPREAD: Record<number, number> = { [M.WATER]: 0.09, [M.ACID]: 0.09, [M.OIL]: 0.12, [M.LAVA]: 0.3 };
const MIN_SPREAD = new Float32Array(32);
for (const k of Object.keys(SPREAD)) MIN_SPREAD[+k] = SPREAD[+k];
for (const k of Object.keys(FLOW)) { const m = +k; GAIN[m] = FLOW[m][0]; KEEP[m] = FLOW[m][1]; MINH[m] = FLOW[m][2]; }

export const MAX_DROPS = 6000;
const DROP_MASS = 0.06;
const GRAVITY = 30;

export interface LiquidHooks {
  steam(x: number, y: number, z: number, n: number): void;
  smoke(x: number, y: number, z: number): void;
}

export class Liquids {
  w: World;
  hooks: LiquidHooks;
  private out = new Float32Array(VOLUME);
  private scale = new Float32Array(VOLUME);
  private touched: number[] = [];
  private sizzleCooldown = 0;
  // droplets
  px = new Float32Array(MAX_DROPS); py = new Float32Array(MAX_DROPS); pz = new Float32Array(MAX_DROPS);
  vx = new Float32Array(MAX_DROPS); vy = new Float32Array(MAX_DROPS); vz = new Float32Array(MAX_DROPS);
  pm = new Float32Array(MAX_DROPS); pt = new Uint8Array(MAX_DROPS); ptemp = new Float32Array(MAX_DROPS);
  n = 0;
  private hashHead = new Int32Array(1 << 14);
  private next = new Int32Array(MAX_DROPS);
  /** total liquid mass moved last tick (stats / audio) */
  activity = 0;

  constructor(w: World, hooks: LiquidHooks) {
    this.w = w;
    this.hooks = hooks;
  }

  clearDrops() {
    this.n = 0;
  }

  /** One liquid tick over the awake chunks. */
  step(chunks: Int32Array, nChunks: number) {
    const w = this.w;
    if (this.sizzleCooldown > 0) this.sizzleCooldown--;
    this.activity = 0;
    for (let k = 0; k < nChunks; k++) this.vertical(chunks[k]);
    this.touched.length = 0;
    for (let k = 0; k < nChunks; k++) this.flux(chunks[k]);
    // per-source scaling so no cell sends more than it has
    const t = this.touched;
    for (let k = 0; k < t.length; k++) {
      const i = t[k];
      const o = this.out[i];
      this.scale[i] = o > w.mass[i] && o > 0 ? w.mass[i] / o : 1;
    }
    for (let k = 0; k < nChunks; k++) this.apply(chunks[k]);
    for (let k = 0; k < t.length; k++) this.out[t[k]] = 0;
    this.stepDrops(1 / 30);
  }

  // ───────────────────────── vertical: fall, compress, react ─────────────────────────
  private vertical(c: number) {
    const w = this.w;
    const { mat, mass, temp, foam } = w;
    const ox = (c % CX) * CS, oz = (Math.floor(c / CX) % CZ) * CS, oy = Math.floor(c / (CX * CZ)) * CS;
    for (let y = oy; y < oy + CS; y++) {
      for (let z = oz; z < oz + CS; z++) {
        let i = ox + z * SX + y * LAYER;
        for (let x = ox; x < ox + CS; x++, i++) {
          const L = mat[i];
          if (foam[i] > 0) foam[i] = foam[i] > 5 ? foam[i] - 5 : 0;
          if (T_STATE[L] !== State.LIQUID) continue;
          let m = mass[i];
          if (m < 0.012 && !(w.flags[i] & F_SOURCE)) { w.set(i, M.AIR); continue; }
          if (y === 0) { w.set(i, M.AIR); continue; }
          if (this.react(i, x, y, z, L)) continue;
          m = mass[i];
          const j = i - LAYER;
          const mj = mat[j];
          if (mj === M.AIR || (T_STATE[mj] === State.GAS)) {
            // nothing underneath: this mass becomes falling droplets
            this.emitDrops(i, x, y, z, L, m);
            w.set(i, M.AIR);
            continue;
          }
          if (mj === L) {
            const room = 1 - mass[j];
            if (room > 0.0005) {
              const t = Math.min(m, room);
              mass[j] += t;
              m -= t;
              w.wakeLiquid(j);
              if (m < 0.012) { w.set(i, M.AIR); continue; }
            }
          } else if (T_STATE[mj] === State.LIQUID && T_DENSITY[mj] < T_DENSITY[L] && w.rng.next() < 0.25) {
            // heavier liquid sinks through a lighter one (oil floats on water)
            w.swap(i, j);
            continue;
          }
          // compression: push extra mass up
          if (m > 1.02 && y < SY - 1) {
            const u = i + LAYER;
            const mu = mat[u];
            const extra = m - 1;
            if (mu === M.AIR) { w.set(u, L, temp[i], 0, 0, extra); m = 1; }
            else if (mu === L) { mass[u] += extra; m = 1; w.wakeLiquid(u); }
          }
          mass[i] = m;
        }
      }
    }
  }

  /** Reactions with neighbours. Returns true if the cell is gone. */
  private react(i: number, x: number, y: number, z: number, L: number): boolean {
    const w = this.w;
    const { mat, mass, temp } = w;
    const rng = w.rng;
    if (L === M.LAVA) {
      for (let k = 0; k < 6; k++) {
        const n = nb(i, x, y, z, k);
        if (n < 0) continue;
        const nm = mat[n];
        if (nm === M.WATER || nm === M.ICE || nm === M.SNOW) {
          // quench: the water flashes to steam, the lava skins over and hardens
          const boil = nm === M.WATER ? Math.min(mass[n], 0.3) : 0;
          if (nm === M.WATER) {
            mass[n] -= boil;
            if (mass[n] < 0.02) w.set(n, M.AIR);
            else w.wakeLiquid(n);
          } else {
            w.setFill(n, w.fill[n] - 80);
          }
          this.hooks.steam(x + 0.5, y + 0.8, z + 0.5, 2);
          temp[i] -= 220;
          if (this.sizzleCooldown === 0) {
            w.event({ t: 'sizzle', x: x + 0.5, y: y + 1, z: z + 0.5 });
            this.sizzleCooldown = 3;
          }
        } else if (T_FLAM[nm] > 0) {
          temp[n] = Math.max(temp[n], T_IGNITE[nm] + 40);
          w.markHot(n);
        }
      }
      if (rng.next() < 0.01) this.hooks.smoke(x + 0.5, y + 1, z + 0.5);
    } else if (L === M.ACID) {
      const n = nb(i, x, y, z, rng.int(6));
      if (n >= 0) {
        const nm = mat[n];
        const st = T_STATE[nm];
        if ((st === State.SOLID || st === State.POWDER) && nm !== M.GLASS) {
          const resist = nm === M.OBSIDIAN ? 0.85 : nm === M.METAL ? 0.7 : nm === M.STONE ? 0.4 : 0;
          if (rng.next() < 0.5 * (1 - resist)) {
            w.setFill(n, w.fill[n] - 22);
            mass[i] -= 0.02;
            if (rng.next() < 0.15) this.hooks.smoke(x + 0.5, y + 0.8, z + 0.5);
            if (mass[i] < 0.012) { w.set(i, M.AIR); return true; }
          }
        } else if (nm === M.WATER && rng.next() < 0.02) {
          w.set(i, M.WATER, undefined, 0, 0, mass[i]);
          return true;
        }
      }
    } else if (L === M.WATER) {
      const n = nb(i, x, y, z, rng.int(6));
      if (n >= 0) {
        const nm = mat[n];
        if (nm === M.DIRT && rng.next() < 0.03) {
          w.set(n, M.MUD, undefined, 0, 0, w.fill[n]);
          mass[i] -= 0.15;
          if (mass[i] < 0.012) { w.set(i, M.AIR); return true; }
        } else if (w.flags[n] & F_BURNING) {
          w.flags[n] &= ~F_BURNING;
          this.hooks.steam(x + 0.5, y + 0.8, z + 0.5, 1);
        }
      }
    } else if (L === M.OIL && (w.flags[i] & F_BURNING)) {
      mass[i] -= 0.006;
      if (mass[i] < 0.012) { w.set(i, M.AIR); return true; }
    }
    return false;
  }

  // ───────────────────────── sideways flux (virtual pipes) ─────────────────────────
  /** Head for the sideways flow: the cell's own level. Each layer levels out on its own;
   *  overfull cells push their extra upward, so stacks still settle flat. */
  private head(i: number): number {
    return Math.min(1.25, this.w.mass[i]);
  }

  private flux(c: number) {
    const w = this.w;
    const { mat, fluxX, fluxZ } = w;
    const out = this.out, touched = this.touched;
    const ox = (c % CX) * CS, oz = (Math.floor(c / CX) % CZ) * CS, oy = Math.floor(c / (CX * CZ)) * CS;
    for (let y = oy; y < oy + CS; y++) {
      for (let z = oz; z < oz + CS; z++) {
        let i = ox + z * SX + y * LAYER;
        for (let x = ox; x < ox + CS; x++, i++) {
          const a = mat[i];
          const aLiq = T_STATE[a] === State.LIQUID;
          for (let face = 0; face < 2; face++) {
            if (face === 0 ? x >= SX - 1 : z >= SZ - 1) continue;
            const n = face === 0 ? i + 1 : i + SX;
            const b = mat[n];
            const bLiq = T_STATE[b] === State.LIQUID;
            const arr = face === 0 ? fluxX : fluxZ;
            if (!aLiq && !bLiq) { arr[i] = 0; continue; }
            let L: number;
            if (aLiq && bLiq) {
              if (a !== b) { arr[i] = 0; continue; }
              L = a;
            } else {
              const other = aLiq ? b : a;
              if (other !== M.AIR && T_STATE[other] !== State.GAS) { arr[i] = 0; continue; }
              L = aLiq ? a : b;
            }
            // a cell that is about to fall doesn't push sideways
            const ha = aLiq && y > 0 && mat[i - LAYER] !== M.AIR ? this.head(i) : 0;
            const hb = bLiq && y > 0 && mat[n - LAYER] !== M.AIR ? this.head(n) : 0;
            const dh = ha - hb;
            let f = arr[i] * KEEP[L];
            if (Math.abs(dh) > MINH[L]) f += GAIN[L] * dh;
            if (Math.abs(f) < 0.0004) f = 0;
            if (f > 0 && !aLiq) f = 0;
            if (f < 0 && !bLiq) f = 0;
            // onto dry ground (an empty cell with something solid under it) only from a deep enough puddle
            if (f > 0 && !bLiq && ha < MIN_SPREAD[L] && y > 0 && mat[n - LAYER] !== M.AIR) f = 0;
            if (f < 0 && !aLiq && hb < MIN_SPREAD[L] && y > 0 && mat[i - LAYER] !== M.AIR) f = 0;
            arr[i] = f;
            if (f > 0) { if (out[i] === 0) touched.push(i); out[i] += f; }
            else if (f < 0) { if (out[n] === 0) touched.push(n); out[n] -= f; }
          }
        }
      }
    }
  }

  private apply(c: number) {
    const w = this.w;
    const { mat, mass, fluxX, fluxZ, temp } = w;
    const scale = this.scale;
    const ox = (c % CX) * CS, oz = (Math.floor(c / CX) % CZ) * CS, oy = Math.floor(c / (CX * CZ)) * CS;
    for (let y = oy; y < oy + CS; y++) {
      for (let z = oz; z < oz + CS; z++) {
        let i = ox + z * SX + y * LAYER;
        for (let x = ox; x < ox + CS; x++, i++) {
          for (let face = 0; face < 2; face++) {
            const arr = face === 0 ? fluxX : fluxZ;
            const f = arr[i];
            if (f === 0) continue;
            const n = face === 0 ? i + 1 : i + SX;
            const src = f > 0 ? i : n, dst = f > 0 ? n : i;
            const L = mat[src];
            if (T_STATE[L] !== State.LIQUID) { arr[i] = 0; continue; }
            const amt = Math.min(mass[src], Math.abs(f) * scale[src]);
            arr[i] = f > 0 ? amt : -amt;
            if (amt <= 0) continue;
            mass[src] -= amt;
            if (mat[dst] === L) mass[dst] += amt;
            else if (mat[dst] === M.AIR || T_STATE[mat[dst]] === State.GAS) w.set(dst, L, temp[src], 0, 0, amt);
            else { mass[src] += amt; arr[i] = 0; continue; }
            this.activity += amt;
            if (amt > 0.0015) { w.wakeLiquid(src); w.wakeLiquid(dst); } else { w.keepAwake(src); }
            if (amt > 0.05) w.foam[dst] = Math.max(w.foam[dst], Math.min(255, amt * 900));
          }
        }
      }
    }
  }

  // ───────────────────────── droplets ─────────────────────────
  private emitDrops(i: number, x: number, y: number, z: number, L: number, m: number) {
    const w = this.w;
    // carry the sideways flow into the drops so streams arc off ledges
    const fx = (w.fluxX[i] + (x > 0 ? w.fluxX[i - 1] : 0));
    const fz = (w.fluxZ[i] + (z > 0 ? w.fluxZ[i - SX] : 0));
    const k = Math.max(1, Math.min(6, Math.ceil(m / DROP_MASS)));
    const each = m / k;
    for (let q = 0; q < k; q++) {
      this.spawnDrop(L, x + 0.2 + w.rng.next() * 0.6, y + 0.1 + w.rng.next() * 0.7, z + 0.2 + w.rng.next() * 0.6,
        fx * 14 + (w.rng.next() - 0.5) * 0.6, -1 - w.rng.next(), fz * 14 + (w.rng.next() - 0.5) * 0.6, each, w.temp[i]);
    }
  }

  spawnDrop(L: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, m: number, t: number) {
    if (this.n >= MAX_DROPS) {
      // out of particles: drop it straight into the cell below so nothing is lost
      this.deposit(Math.floor(x), Math.floor(y), Math.floor(z), L, m, t);
      return;
    }
    const k = this.n++;
    this.px[k] = x; this.py[k] = y; this.pz[k] = z;
    this.vx[k] = vx; this.vy[k] = vy; this.vz[k] = vz;
    this.pm[k] = m; this.pt[k] = L; this.ptemp[k] = t;
  }

  /** Put liquid mass into the grid at (x,y,z), stacking upward if that spot is taken. */
  deposit(x: number, y: number, z: number, L: number, m: number, t: number): boolean {
    const w = this.w;
    if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0) return false;
    // water that's roughly at air temperature just takes the local temperature
    if (L === M.WATER && y < SY && Math.abs(t - w.ambient[Math.min(SY - 1, y)]) < 40) t = w.ambient[Math.min(SY - 1, y)];
    for (let yy = Math.min(SY - 1, y); yy < Math.min(SY, y + 8); yy++) {
      const i = x + z * SX + yy * LAYER;
      const mm = w.mat[i];
      if (mm === L) { w.mass[i] += m; w.wakeLiquid(i); return true; }
      if (mm === M.AIR || T_STATE[mm] === State.GAS) { w.set(i, L, t, 0, 0, m); return true; }
      if (T_STATE[mm] === State.LIQUID && L === M.LAVA && mm === M.WATER) {
        // lava drop into water: hiss, and a lump of obsidian forms
        w.mass[i] -= Math.min(w.mass[i], 0.25);
        this.hooks.steam(x + 0.5, yy + 1, z + 0.5, 2);
        w.set(i, M.OBSIDIAN, 500, 0, 0, Math.min(255, Math.round(80 + m * 400)));
        w.newSolids.push(i);
        return true;
      }
    }
    return false;
  }

  private remove(k: number) {
    const l = --this.n;
    if (k === l) return;
    this.px[k] = this.px[l]; this.py[k] = this.py[l]; this.pz[k] = this.pz[l];
    this.vx[k] = this.vx[l]; this.vy[k] = this.vy[l]; this.vz[k] = this.vz[l];
    this.pm[k] = this.pm[l]; this.pt[k] = this.pt[l]; this.ptemp[k] = this.ptemp[l];
  }

  private stepDrops(dt: number) {
    const w = this.w;
    const n = this.n;
    if (n === 0) return;
    const { px, py, pz, vx, vy, vz } = this;
    // spatial hash for cohesion / XSPH
    this.hashHead.fill(-1);
    const H = (ix: number, iy: number, iz: number) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & 16383;
    for (let k = 0; k < n; k++) {
      const h = H(Math.floor(px[k]), Math.floor(py[k]), Math.floor(pz[k]));
      this.next[k] = this.hashHead[h];
      this.hashHead[h] = k;
    }
    for (let k = 0; k < n; k++) {
      // cohesion + velocity smoothing with close neighbours keeps streams together
      let ax = 0, ay = 0, az = 0, sx = 0, sy = 0, sz = 0, cnt = 0;
      const ix = Math.floor(px[k]), iy = Math.floor(py[k]), iz = Math.floor(pz[k]);
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        let j = this.hashHead[H(ix + dx, iy + dy, iz + dz)];
        let guard = 0;
        while (j >= 0 && guard++ < 24) {
          if (j !== k) {
            const ex = px[j] - px[k], ey = py[j] - py[k], ez = pz[j] - pz[k];
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 < 1.2) {
              const d = Math.sqrt(d2) + 1e-4;
              const s = d < 0.35 ? -(0.35 - d) * 6 : (d - 0.35) * 0.9; // repel very close, attract a bit
              ax += ex / d * s; ay += ey / d * s; az += ez / d * s;
              sx += vx[j] - vx[k]; sy += vy[j] - vy[k]; sz += vz[j] - vz[k];
              cnt++;
            }
          }
          j = this.next[j];
        }
      }
      if (cnt) {
        const inv = 1 / cnt;
        vx[k] += ax * dt * 4 + sx * inv * 0.12; vy[k] += ay * dt * 4 + sy * inv * 0.12; vz[k] += az * dt * 4 + sz * inv * 0.12;
      }
    }
    for (let k = 0; k < this.n; k++) {
      vy[k] -= GRAVITY * dt;
      vx[k] *= 0.995; vz[k] *= 0.995;
      const L = this.pt[k];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(vx[k]), Math.abs(vy[k]), Math.abs(vz[k])) * dt / 0.7));
      let landed = false;
      for (let s = 0; s < steps && !landed; s++) {
        const nx = px[k] + vx[k] * dt / steps, ny = py[k] + vy[k] * dt / steps, nz = pz[k] + vz[k] * dt / steps;
        const cx = Math.floor(nx), cy = Math.floor(ny), cz = Math.floor(nz);
        if (cx >= 0 && cz >= 0 && cx < SX && cz < SZ && cy >= 0 && cy < SY) {
          const ci = cx + cz * SX + cy * LAYER;
          const m = w.mat[ci];
          const st = T_STATE[m];
          const solid = (st === State.SOLID || st === State.POWDER) && w.fill[ci] >= SOLID_FILL;
          const pool = st === State.LIQUID && (w.mass[ci] > 0.45 || m !== L);
          if (solid || pool) {
            const speed = Math.abs(vy[k]) + Math.abs(vx[k]) * 0.5 + Math.abs(vz[k]) * 0.5;
            // land in the last free cell we were in (or in the pool itself)
            const lx = Math.floor(px[k]), ly = Math.floor(py[k]), lz = Math.floor(pz[k]);
            if (pool && m === L) { w.mass[ci] += this.pm[k]; w.wakeLiquid(ci); w.foam[ci] = Math.min(255, w.foam[ci] + speed * 12); }
            else if (pool && L === M.LAVA && m === M.WATER) this.deposit(cx, cy, cz, L, this.pm[k], this.ptemp[k]);
            else this.deposit(lx, Math.max(0, ly), lz, L, this.pm[k], this.ptemp[k]);
            if (speed > 9 && w.rng.next() < 0.08) w.event({ t: 'splash', x: nx, y: ny + 0.6, z: nz, r: Math.min(3, speed / 12) });
            landed = true;
          }
        }
        if (!landed) { px[k] = nx; py[k] = ny; pz[k] = nz; }
      }
      if (landed || py[k] < -40) { this.remove(k); k--; }
    }
  }

  /** x,y,z,vx,vy,vz,type,mass per droplet */
  pack(): Float32Array {
    const out = new Float32Array(this.n * 8);
    for (let k = 0; k < this.n; k++) {
      const o = k * 8;
      out[o] = this.px[k]; out[o + 1] = this.py[k]; out[o + 2] = this.pz[k];
      out[o + 3] = this.vx[k]; out[o + 4] = this.vy[k]; out[o + 5] = this.vz[k];
      out[o + 6] = this.pt[k]; out[o + 7] = this.pm[k];
    }
    return out;
  }
}

function nb(i: number, x: number, y: number, z: number, k: number): number {
  switch (k) {
    case 0: return x > 0 ? i - 1 : -1;
    case 1: return x < SX - 1 ? i + 1 : -1;
    case 2: return z > 0 ? i - SX : -1;
    case 3: return z < SZ - 1 ? i + SX : -1;
    case 4: return y > 0 ? i - LAYER : -1;
    default: return y < SY - 1 ? i + LAYER : -1;
  }
}

export { nb };
export const LIQUID_CHUNKS = CHUNKS;

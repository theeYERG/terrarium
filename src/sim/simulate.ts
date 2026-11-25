// The cellular automaton. One call to step() advances the world by one tick:
//   1. movement + reactions for every cell in awake chunks (random chunk order,
//      random scan direction, bottom-up, each cell moves at most once per tick)
//   2. heat conduction + phase changes in chunks that are awake or warm
//   3. slow "random ticks" over the whole world (grass growth, mud drying)
//   4. explosions, flying debris and structural collapse

import { BASE_TPS, CHUNKS, CS, CX, CY, CZ, LAYER, SX, SY, SZ, VOLUME } from './constants.ts';
import { Debris } from './debris.ts';
import { glowLevel } from './mesher.ts';
import {
  M, MATERIALS, State, T_COND, T_DENSITY, T_FLAM, T_FREEZE, T_FREEZE_TO, T_IGNITE, T_MELT, T_MELT_TO,
  T_MOVABLE, T_OPAQUE, T_RELAX, T_STATE,
} from './materials.ts';
import { Structure } from './structure.ts';
import { AWAKE_TICKS, F_FUEL, F_GRASS, F_SETTLED, F_SOURCE, World } from './world.ts';

// 8 horizontal directions (dx, dz) – diagonals included so liquids spread round, not square.
const H8X = [1, -1, 0, 0, 1, 1, -1, -1];
const H8Z = [0, 0, 1, -1, 1, -1, 1, -1];

export interface TickStats {
  awake: number;
  heated: number;
  tickMs: number;
}

export class Simulator {
  w: World;
  debris: Debris;
  structure: Structure;
  stats: TickStats = { awake: 0, heated: 0, tickMs: 0 };
  private order = new Int32Array(CHUNKS);
  private heatMask = new Uint8Array(CHUNKS);
  private sizzleCooldown = 0;
  /** fire cells per chunk counted in the last tick (for lights + audio) */
  fireCount = new Uint16Array(CHUNKS);
  fireSum = new Float32Array(CHUNKS * 3);

  constructor(w: World) {
    this.w = w;
    this.debris = new Debris(w);
    this.structure = new Structure(w, this.debris);
  }

  step(): void {
    const t0 = performance.now();
    const w = this.w;
    w.tick++;
    w.curStamp = (w.curStamp % 255) + 1;
    if (this.sizzleCooldown > 0) this.sizzleCooldown--;
    this.fireCount.fill(0);
    this.fireSum.fill(0);

    // explosions requested by tools or gunpowder last tick
    let booms = 0;
    while (w.explosions.length && booms < 10) {
      const r = w.explosions.pop()!, z = w.explosions.pop()!, y = w.explosions.pop()!, x = w.explosions.pop()!;
      this.explode(x, y, z, r);
      booms++;
    }

    // 1. movement
    let n = 0;
    for (let c = 0; c < CHUNKS; c++) if (w.awake[c]) this.order[n++] = c;
    for (let i = n - 1; i > 0; i--) {
      const j = w.rng.int(i + 1);
      const t = this.order[i]; this.order[i] = this.order[j]; this.order[j] = t;
    }
    for (let k = 0; k < n; k++) this.updateChunk(this.order[k]);
    this.stats.awake = n;

    // 2. heat: awake chunks, warm chunks and their neighbours
    this.heatMask.fill(0);
    for (let c = 0; c < CHUNKS; c++) {
      if (w.awake[c] || w.hot[c] > 1) {
        this.heatMask[c] = 1;
        if (w.hot[c] > 6) {
          const cx = c % CX, cz = Math.floor(c / CX) % CZ, cy = Math.floor(c / (CX * CZ));
          if (cx > 0) this.heatMask[c - 1] = 1;
          if (cx < CX - 1) this.heatMask[c + 1] = 1;
          if (cz > 0) this.heatMask[c - CX] = 1;
          if (cz < CZ - 1) this.heatMask[c + CX] = 1;
          if (cy > 0) this.heatMask[c - CX * CZ] = 1;
          if (cy < CY - 1) this.heatMask[c + CX * CZ] = 1;
        }
      }
    }
    let heated = 0;
    for (let c = 0; c < CHUNKS; c++) if (this.heatMask[c]) { this.heatChunk(c); heated++; }
    this.stats.heated = heated;

    // 3. random ticks
    this.randomTicks(2500);

    // 4. debris + collapse
    this.debris.step(1 / BASE_TPS);
    this.structure.run();

    for (let c = 0; c < CHUNKS; c++) if (w.awake[c]) w.awake[c]--;
    this.stats.tickMs = performance.now() - t0;
  }

  // ───────────────────────────── movement ─────────────────────────────

  private updateChunk(c: number) {
    const w = this.w;
    const mat = w.mat, stamp = w.stamp;
    const cur = w.curStamp;
    const ccx = c % CX, ccz = Math.floor(c / CX) % CZ, ccy = Math.floor(c / (CX * CZ));
    const ox = ccx * CS, oy = ccy * CS, oz = ccz * CS;
    const r = w.rng.u32();
    const flipX = r & 1, flipZ = r & 2, swapXZ = r & 4;
    let keepAwake = false;
    for (let ly = 0; ly < CS; ly++) {
      const y = oy + ly;
      for (let a = 0; a < CS; a++) {
        for (let b = 0; b < CS; b++) {
          let lx = swapXZ ? a : b, lz = swapXZ ? b : a;
          if (flipX) lx = CS - 1 - lx;
          if (flipZ) lz = CS - 1 - lz;
          const x = ox + lx, z = oz + lz;
          const i = x + z * SX + y * LAYER;
          const m = mat[i];
          if (m === M.AIR) continue;
          const st = T_STATE[m];
          if (st === State.SOLID) {
            if (m === M.SPRING) { this.spring(i, x, y, z); keepAwake = true; }
            continue;
          }
          if (stamp[i] === cur) continue;
          if (st === State.POWDER) { if (this.powder(i, x, y, z, m)) keepAwake = true; }
          else if (st === State.LIQUID) this.liquid(i, x, y, z, m);
          else if (st === State.GAS) { this.gas(i, x, y, z, m); keepAwake = true; }
        }
      }
    }
    if (keepAwake && w.awake[c] < 2) w.awake[c] = 2;
  }

  /** A spring pushes water into every open side, every tick. */
  private spring(i: number, x: number, y: number, z: number) {
    const w = this.w;
    const rate = w.life[i] === 1 ? 0.06 : 0.8; // life=1 marks a gentle trickle
    for (let k = 0; k < 5; k++) {
      let n = -1;
      if (k === 0 && y < SY - 1) n = i + LAYER;
      else if (k === 1 && x > 0) n = i - 1;
      else if (k === 2 && x < SX - 1) n = i + 1;
      else if (k === 3 && z > 0) n = i - SX;
      else if (k === 4 && z < SZ - 1) n = i + SX;
      if (n >= 0 && w.mat[n] === M.AIR && w.rng.next() < rate) w.place(n, M.WATER);
    }
  }

  /** Can a falling cell of material m enter cell j? (empty / gas, or a lighter liquid) */
  private canEnter(m: number, j: number, sinkChance: number): boolean {
    const t = this.w.mat[j];
    if (T_MOVABLE[t]) return true;
    if (T_STATE[t] === State.LIQUID && T_DENSITY[t] < T_DENSITY[m]) return this.w.rng.next() < sinkChance;
    return false;
  }

  /** Returns true if the powder is still "live" (not settled) */
  private powder(i: number, x: number, y: number, z: number, m: number): boolean {
    const w = this.w;
    const mat = w.mat;
    const rng = w.rng;
    const mm = MATERIALS[m];

    if (m === M.EMBER) {
      const l = w.life[i];
      if (l <= 1) { w.set(i, M.AIR); return true; }
      w.life[i] = l - 1;
      // light anything flammable we touch, fizzle in water
      const n = this.randomNeighbour(i, x, y, z);
      if (n >= 0) {
        const nm = mat[n];
        if (T_FLAM[nm] > 0) w.temp[n] = Math.max(w.temp[n], T_IGNITE[nm] + 30);
        else if (nm === M.WATER) { w.set(i, M.STEAM, 105, 40); return true; }
      }
    }

    if (mm.viscosity > 0 && rng.next() < mm.viscosity) return true;

    // fall (up to 2 cells per tick)
    if (y === 0) { w.set(i, M.AIR); return true; }
    const below = i - LAYER;
    if (this.canEnter(m, below, 0.35)) {
      w.swap(i, below);
      if (y >= 2 && T_MOVABLE[mat[below - LAYER]]) w.swap(below, below - LAYER);
      return true;
    }
    if (w.flags[i] & F_SETTLED) return false;

    // roll down the slope
    if (rng.next() < mm.diag) {
      const start = rng.int(4);
      for (let k = 0; k < 4; k++) {
        const d = (start + k) & 3;
        const nx = x + H8X[d], nz = z + H8Z[d];
        if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ) continue;
        const side = nx + nz * SX + y * LAYER;
        const t = side - LAYER;
        const sm = mat[side];
        if ((T_MOVABLE[sm] || T_STATE[sm] === State.LIQUID) && this.canEnter(m, t, 0.5)) {
          w.swap(i, t);
          return true;
        }
      }
      // slide two cells: gives sand its shallower ~34° slope
      if (mm.slide > 0 && rng.next() < mm.slide) {
        const d = rng.int(4);
        const nx = x + H8X[d], nz = z + H8Z[d];
        const fx = x + 2 * H8X[d], fz = z + 2 * H8Z[d];
        if (fx >= 0 && fz >= 0 && fx < SX && fz < SZ) {
          const side = nx + nz * SX + y * LAYER;
          const far = fx + fz * SX + (y - 1) * LAYER;
          if (T_MOVABLE[mat[side]] && T_MOVABLE[mat[far]] && T_MOVABLE[mat[far + LAYER]]) {
            w.swap(i, side);
            return true;
          }
        }
      }
    }
    // resting grains only settle for good some of the time; the rest keep testing
    // the slope for a while, which is what lets piles relax below 45°
    if (rng.next() < Math.max(0.05, 1 - mm.slide * 2.4)) w.flags[i] |= F_SETTLED;
    return false;
  }

  private liquid(i: number, x: number, y: number, z: number, m: number) {
    const w = this.w;
    const mat = w.mat;
    const rng = w.rng;
    const mm = MATERIALS[m];

    // reactions
    if (m === M.LAVA) {
      if (this.lavaReact(i, x, y, z)) return;
    } else if (m === M.ACID) {
      if (this.acidReact(i, x, y, z)) return;
    } else if (m === M.WATER) {
      const n = this.randomNeighbour(i, x, y, z);
      if (n >= 0 && mat[n] === M.DIRT && rng.next() < 0.03) {
        w.set(n, M.MUD);
        if (rng.next() < 0.5) { w.set(i, M.AIR); return; }
      }
    }

    if (mm.viscosity > 0 && rng.next() < mm.viscosity) {
      if (m === M.LAVA) w.awake[this.chunkOf(x, y, z)] = AWAKE_TICKS;
      return;
    }

    // fall
    if (y === 0) { w.set(i, M.AIR); return; }
    const below = i - LAYER;
    if (this.canEnter(m, below, 0.3)) {
      w.swap(i, below);
      if (y >= 2 && T_MOVABLE[mat[below - LAYER]]) w.swap(below, below - LAYER);
      return;
    }

    // diagonal down
    const start = rng.int(8);
    for (let k = 0; k < 8; k++) {
      const d = (start + k) & 7;
      const nx = x + H8X[d], nz = z + H8Z[d];
      if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ) continue;
      const side = nx + nz * SX + y * LAYER;
      if (!T_MOVABLE[mat[side]]) continue;
      if (d >= 4) {
        // diagonal: needs one of the two orthogonal paths open, so it can't leak through corners
        if (!T_MOVABLE[mat[nx + z * SX + y * LAYER]] && !T_MOVABLE[mat[x + nz * SX + y * LAYER]]) continue;
      }
      if (T_MOVABLE[mat[side - LAYER]]) {
        w.swap(i, side - LAYER);
        return;
      }
    }

    // spread sideways, stopping early at a drop so it pours off edges
    const disp = mm.dispersion;
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = rng.int(8);
      const dx = H8X[d], dz = H8Z[d];
      let last = -1;
      let px = x, pz = z;
      for (let s = 1; s <= disp; s++) {
        px += dx; pz += dz;
        if (px < 0 || pz < 0 || px >= SX || pz >= SZ) break;
        const j = px + pz * SX + y * LAYER;
        if (!T_MOVABLE[mat[j]]) {
          // a lighter liquid next to us: displace it (oil gets pushed aside by water)
          const t = mat[j];
          if (s === 1 && T_STATE[t] === State.LIQUID && T_DENSITY[t] < T_DENSITY[m] && rng.next() < 0.2) last = j;
          break;
        }
        if (d >= 4 && !T_MOVABLE[mat[px - dx + pz * SX + y * LAYER]] && !T_MOVABLE[mat[px + (pz - dz) * SX + y * LAYER]]) break;
        last = j;
        if (T_MOVABLE[mat[j - LAYER]]) break;
      }
      if (last >= 0) {
        w.swap(i, last);
        return;
      }
    }

    // A lone droplet can't spread thinner than one voxel, so in a cellular automaton it
    // would wander forever. Real water would spread into a film / soak in / evaporate,
    // so isolated surface droplets fade away (quickly when sitting on top of a lake).
    if (m === M.WATER && y < SY - 1 && T_MOVABLE[mat[i + LAYER]]) {
      const onWater = y > 0 && mat[i - LAYER] === M.WATER;
      if (rng.next() < (onWater ? 0.05 : 0.012)) {
        let wet = 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + H8X[d], nz = z + H8Z[d];
          if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ) continue;
          if (mat[nx + nz * SX + y * LAYER] === M.WATER) wet++;
        }
        if (wet === 0 || (onWater && wet === 1)) w.set(i, M.AIR);
      }
    }
  }

  private lavaReact(i: number, x: number, y: number, z: number): boolean {
    const w = this.w;
    const mat = w.mat;
    for (let k = 0; k < 6; k++) {
      const n = this.neighbour(i, x, y, z, k);
      if (n < 0) continue;
      const nm = mat[n];
      if ((nm === M.WATER || nm === M.ICE || nm === M.SNOW) && w.rng.next() < 0.3) {
        // quench: lava hardens into obsidian, water flashes to steam (not instantly, so
        // poured lava plunges in a little way before it freezes)
        w.set(i, M.OBSIDIAN, 520);
        if (w.newSolids.length < 4000) w.newSolids.push(i); // sinks if it isn't resting on anything
        w.set(n, M.STEAM, 140, 120 + w.rng.int(120));
        if (this.sizzleCooldown === 0) {
          w.event({ t: 'sizzle', x: x + 0.5, y: y + 1, z: z + 0.5 });
          this.sizzleCooldown = 3;
        }
        return true;
      }
      if (T_FLAM[nm] > 0) w.temp[n] = Math.max(w.temp[n], T_IGNITE[nm] + 50);
    }
    return false;
  }

  private acidReact(i: number, x: number, y: number, z: number): boolean {
    const w = this.w;
    const rng = w.rng;
    const n = this.randomNeighbour(i, x, y, z);
    if (n < 0) return false;
    const nm = w.mat[n];
    if (nm === M.AIR || nm === M.ACID || T_STATE[nm] === State.GAS) return false;
    const resist = MATERIALS[nm].acidResist;
    if (rng.next() < 0.12 * (1 - resist)) {
      if (nm === M.WATER) {
        if (rng.next() < 0.1) w.set(i, M.WATER); // diluted
        return false;
      }
      w.set(n, rng.next() < 0.35 ? M.SMOKE : M.AIR, undefined, 40 + rng.int(60));
      if (rng.next() < 0.3) { w.set(i, M.AIR); return true; }
    }
    return false;
  }

  private gas(i: number, x: number, y: number, z: number, m: number) {
    const w = this.w;
    const mat = w.mat;
    const rng = w.rng;
    const c = this.chunkOf(x, y, z);

    if (m === M.FIRE) {
      this.fireCount[c]++;
      this.fireSum[c * 3] += x; this.fireSum[c * 3 + 1] += y; this.fireSum[c * 3 + 2] += z;
      if (this.fire(i, x, y, z)) return;
      if (w.flags[i] & F_FUEL) return; // burning fuel stays where it is
    } else {
      const l = w.life[i];
      if (l <= 1) {
        // steam that ran out of time high up rains back down sometimes
        if (m === M.STEAM && rng.next() < 0.25 && w.temp[i] < 100) w.set(i, M.WATER);
        else w.set(i, M.AIR);
        return;
      }
      w.life[i] = l - 1;
    }

    // rise
    if (rng.next() < (m === M.FIRE ? 0.75 : 0.55)) {
      if (y < SY - 1) {
        const up = i + LAYER;
        const um = mat[up];
        if (um === M.AIR) { w.swap(i, up); return; }
        if (T_STATE[um] === State.LIQUID && rng.next() < 0.5) { w.swap(i, up); return; } // bubble
      } else if (rng.next() < 0.05) {
        w.set(i, M.AIR);
        return;
      }
    }
    // drift
    if (rng.next() < 0.45) {
      const d = rng.int(8);
      const nx = x + H8X[d], nz = z + H8Z[d];
      if (nx >= 0 && nz >= 0 && nx < SX && nz < SZ) {
        let j = nx + nz * SX + y * LAYER;
        if (y < SY - 1 && rng.next() < 0.5 && mat[j + LAYER] === M.AIR) j += LAYER;
        if (mat[j] === M.AIR) w.swap(i, j);
      }
    }
  }

  /** returns true if the fire cell was consumed */
  private fire(i: number, x: number, y: number, z: number): boolean {
    const w = this.w;
    const mat = w.mat;
    const rng = w.rng;
    const fueled = (w.flags[i] & F_FUEL) !== 0;
    const l = w.life[i];
    if (!fueled || rng.next() < 0.5) {
      if (l <= 1) {
        if (w.flags[i] & F_GRASS) w.set(i, M.DIRT, 320);
        else if (rng.next() < (fueled ? 0.35 : 0.12)) w.set(i, M.SMOKE, undefined, 90 + rng.int(90));
        else w.set(i, M.AIR);
        return true;
      }
      w.life[i] = l - 1;
    }
    w.temp[i] = Math.max(w.temp[i], fueled ? 950 : 800);

    // heat / ignite neighbours, get put out by water
    for (let k = 0; k < 6; k++) {
      const n = this.neighbour(i, x, y, z, k);
      if (n < 0) continue;
      const nm = mat[n];
      if (nm === M.WATER) {
        w.set(n, M.STEAM, 120, 80 + rng.int(80));
        w.set(i, M.SMOKE, undefined, 60 + rng.int(60));
        if (this.sizzleCooldown === 0) {
          w.event({ t: 'sizzle', x: x + 0.5, y: y + 0.5, z: z + 0.5 });
          this.sizzleCooldown = 4;
        }
        return true;
      }
      const f = T_FLAM[nm];
      if (f > 0) {
        w.temp[n] += (900 - w.temp[n]) * 0.05 * (fueled ? 1 : 0.6);
        if (rng.next() < f * 0.04) w.temp[n] = Math.max(w.temp[n], T_IGNITE[nm] + 10);
      } else if (nm === M.AIR) {
        w.temp[n] += (700 - w.temp[n]) * 0.1;
      }
    }

    if (fueled) {
      // flames lick upward, smoke and the odd ember
      if (y < SY - 1) {
        const up = i + LAYER;
        if (mat[up] === M.AIR && rng.next() < 0.45) w.place(up, M.FIRE);
        else if (rng.next() < 0.05) {
          const d = rng.int(4);
          const nx = x + H8X[d], nz = z + H8Z[d];
          if (nx >= 0 && nz >= 0 && nx < SX && nz < SZ) {
            const j = nx + nz * SX + (y + 1) * LAYER;
            if (mat[j] === M.AIR) w.place(j, rng.next() < 0.85 ? M.SMOKE : M.EMBER);
          }
        }
      }
    }
    return false;
  }

  // ───────────────────────────── heat ─────────────────────────────

  private heatChunk(c: number) {
    const w = this.w;
    const mat = w.mat, temp = w.temp, flags = w.flags, amb = w.ambient;
    const rng = w.rng;
    const ccx = c % CX, ccz = Math.floor(c / CX) % CZ, ccy = Math.floor(c / (CX * CZ));
    const ox = ccx * CS, oy = ccy * CS, oz = ccz * CS;
    let maxDev = 0;
    for (let ly = 0; ly < CS; ly++) {
      const y = oy + ly;
      const a = amb[y];
      const aDn = y > 0 ? amb[y - 1] - a : 0;
      const aUp = y < SY - 1 ? amb[y + 1] - a : 0;
      for (let lz = 0; lz < CS; lz++) {
        const z = oz + lz;
        let i = ox + z * SX + y * LAYER;
        for (let lx = 0; lx < CS; lx++, i++) {
          const x = ox + lx;
          const m = mat[i];
          const T = temp[i];
          const k = T_COND[m];
          let sum = 0;
          // 6-neighbour exchange with the weaker conductor's rate
          if (x > 0) { const n = i - 1; const kn = T_COND[mat[n]]; sum += (kn < k ? kn : k) * (temp[n] - T); }
          if (x < SX - 1) { const n = i + 1; const kn = T_COND[mat[n]]; sum += (kn < k ? kn : k) * (temp[n] - T); }
          if (z > 0) { const n = i - SX; const kn = T_COND[mat[n]]; sum += (kn < k ? kn : k) * (temp[n] - T); }
          if (z < SZ - 1) { const n = i + SX; const kn = T_COND[mat[n]]; sum += (kn < k ? kn : k) * (temp[n] - T); }
          // vertical exchange works on the deviation from ambient, so the altitude
          // lapse rate is a steady state instead of a constant heat flow
          if (y > 0) { const n = i - LAYER; const kn = T_COND[mat[n]]; sum += (kn < k ? kn : k) * (temp[n] - aDn - T); }
          if (y < SY - 1) { const n = i + LAYER; const kn = T_COND[mat[n]]; sum += (kn < k ? kn : k) * (temp[n] - aUp - T); }
          let nt = T + sum * 0.3;
          nt += (a - nt) * T_RELAX[m];
          if (m === M.LAVA && (flags[i] & F_SOURCE) && nt < 1200) nt = 1200;
          if (m === M.AIR && nt > 2600) nt = 2600;
          temp[i] = nt;
          const dev = nt > a ? nt - a : a - nt;
          if (dev > maxDev) maxDev = dev;
          if (m === M.AIR) continue;

          // glow changes need a remesh
          if ((T > 480 || nt > 480) && T_OPAQUE[m] && glowLevel(m, T) !== glowLevel(m, nt)) w.dirty[c] = 1;

          // phase changes
          if (nt > T_MELT[m]) {
            if (rng.next() < 0.25) this.melt(i, m, nt);
          } else if (nt < T_FREEZE[m]) {
            if (m === M.LAVA && (flags[i] & F_SOURCE)) { /* never */ }
            else if (m === M.STEAM) { if (rng.next() < 0.015) w.set(i, M.WATER, 60); }
            else if (rng.next() < 0.2) {
              w.set(i, T_FREEZE_TO[m], m === M.WATER ? -1 : nt);
              if (m === M.LAVA && w.newSolids.length < 4000) w.newSolids.push(i);
            }
          }
          const f = T_FLAM[m];
          if (f > 0 && nt >= T_IGNITE[m] && rng.next() < f * 0.35) this.ignite(i, m);
        }
      }
    }
    w.hot[c] = maxDev;
  }

  private melt(i: number, m: number, t: number) {
    const w = this.w;
    const to = T_MELT_TO[m];
    if (m === M.WATER) {
      w.set(i, M.STEAM, 105, MATERIALS[M.STEAM].life[0] + w.rng.int(140)); // latent heat
    } else if (m === M.ICE || m === M.SNOW) {
      w.set(i, M.WATER, 1);
    } else if (m === M.MUD) {
      w.set(i, M.DIRT, t);
      const y = i >> 14;
      if (y < SY - 1 && w.mat[i + LAYER] === M.AIR) w.place(i + LAYER, M.STEAM);
    } else if (to === M.SMOKE) {
      w.set(i, M.SMOKE, t, 80);
    } else {
      w.set(i, to, t, to === M.FIRE ? 20 : 0);
    }
  }

  ignite(i: number, m: number) {
    const w = this.w;
    const rng = w.rng;
    if (m === M.GUNPOWDER) {
      const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
      w.set(i, M.FIRE, 1200, 6);
      w.explosions.push(x + 0.5, y + 0.5, z + 0.5, 2.6 + rng.next());
      return;
    }
    const bt = MATERIALS[m].burnTime;
    const life = Math.min(255, Math.max(4, Math.round(bt * (0.6 + rng.next() * 0.8))));
    let flags = F_FUEL;
    if (m === M.GRASS) flags |= F_GRASS;
    w.set(i, M.FIRE, 950, life, flags);
    if (rng.next() < 0.05) {
      const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
      w.event({ t: 'ignite', x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    }
  }

  // ───────────────────────────── random ticks ─────────────────────────────

  private randomTicks(count: number) {
    const w = this.w;
    const mat = w.mat, rng = w.rng;
    for (let s = 0; s < count; s++) {
      const i = rng.u32() % VOLUME;
      const m = mat[i];
      if (m !== M.DIRT && m !== M.GRASS && m !== M.MUD) continue;
      const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
      if (m === M.MUD) {
        let wet = false;
        for (let k = 0; k < 6; k++) { const n = this.neighbour(i, x, y, z, k); if (n >= 0 && mat[n] === M.WATER) wet = true; }
        if (!wet && rng.next() < 0.35) w.set(i, M.DIRT);
        continue;
      }
      const above = y < SY - 1 ? mat[i + LAYER] : M.AIR;
      if (m === M.GRASS) {
        if (T_OPAQUE[above] && above !== M.LEAVES) w.set(i, M.DIRT);
        continue;
      }
      // dirt: grow grass if lit, near grass and near water
      if (!T_MOVABLE[above]) continue;
      if (!this.isLit(x, y, z)) continue;
      let nearGrass = false;
      for (let dy = -1; dy <= 1 && !nearGrass; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= SY) continue;
        for (let d = 0; d < 8; d++) {
          const nx = x + H8X[d], nz = z + H8Z[d];
          if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ) continue;
          if (mat[nx + nz * SX + yy * LAYER] === M.GRASS) { nearGrass = true; break; }
        }
      }
      if (!nearGrass) continue;
      if (this.nearWater(x, y, z, 6)) w.set(i, M.GRASS);
    }
  }

  private isLit(x: number, y: number, z: number): boolean {
    const mat = this.w.mat;
    for (let yy = y + 1; yy < Math.min(SY, y + 20); yy++) {
      const m = mat[x + z * SX + yy * LAYER];
      if (T_OPAQUE[m] && m !== M.LEAVES) return false;
    }
    return true;
  }

  private nearWater(x: number, y: number, z: number, r: number): boolean {
    const mat = this.w.mat, rng = this.w.rng;
    for (let s = 0; s < 40; s++) {
      const nx = x + rng.int(2 * r + 1) - r, ny = y + rng.int(5) - 3, nz = z + rng.int(2 * r + 1) - r;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= SX || ny >= SY || nz >= SZ) continue;
      const m = mat[nx + nz * SX + ny * LAYER];
      if (m === M.WATER || m === M.MUD || m === M.SPRING) return true;
    }
    return false;
  }

  // ───────────────────────────── explosions ─────────────────────────────

  explode(cx: number, cy: number, cz: number, r: number) {
    const w = this.w;
    const rng = w.rng;
    const mat = w.mat;
    const R = r * 1.5;
    const RG = r * 2.2; // gunpowder further out still gets set off
    const x0 = Math.max(0, Math.floor(cx - RG)), x1 = Math.min(SX - 1, Math.ceil(cx + RG));
    const y0 = Math.max(0, Math.floor(cy - RG)), y1 = Math.min(SY - 1, Math.ceil(cy + RG));
    const z0 = Math.max(0, Math.floor(cz - RG)), z1 = Math.min(SZ - 1, Math.ceil(cz + RG));
    let thrown = 0;
    const maxThrown = 900;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > RG) continue;
          const i = x + z * SX + y * LAYER;
          const m = mat[i];
          const d = dist / r;
          if (dist > R && m !== M.GUNPOWDER) {
            if (m === M.GRASS && dist < RG && rng.next() < 0.7) w.set(i, M.DIRT); // scorched rim
            continue;
          }
          if (m === M.GUNPOWDER) {
            // nearby powder isn't blown away, it goes off too: chain reaction
            w.temp[i] = Math.max(w.temp[i], 450);
            continue;
          }
          // heat shell
          w.temp[i] += 650 * Math.max(0, 1 - dist / R);
          if (d > 1 || m === M.AIR) {
            if (m === M.AIR && d < 0.8 && rng.next() < 0.18) w.place(i, rng.next() < 0.6 ? M.FIRE : M.SMOKE);
            continue;
          }
          const mm = MATERIALS[m];
          if (mm.state === State.GAS) continue;
          const power = 1.25 - d * 0.55 - mm.hardness + (rng.next() - 0.5) * 0.3;
          if (power <= 0) continue;
          // fling some of it as debris, vaporise the rest
          const len = dist || 1;
          if (thrown < maxThrown && (d > 0.35 || rng.next() < 0.3) && rng.next() < 0.55) {
            const sp = (10 + rng.next() * 16) * (1.1 - d * 0.5);
            w.set(i, M.AIR);
            const throwMat = m === M.GRASS ? M.DIRT : m;
            if (this.debris.add(x + 0.5, y + 0.5, z + 0.5, (dx / len) * sp + (rng.next() - 0.5) * 4,
              (dy / len) * sp + 8 + rng.next() * 8, (dz / len) * sp + (rng.next() - 0.5) * 4, throwMat, w.temp[i])) thrown++;
          } else if (m === M.WATER && rng.next() < 0.5) {
            w.set(i, M.STEAM, 110, 60 + rng.int(60));
          } else {
            w.set(i, rng.next() < 0.08 ? M.FIRE : M.AIR, 800, 10);
          }
        }
      }
    }
    w.event({ t: 'boom', x: cx, y: cy, z: cz, r });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private chunkOf(x: number, y: number, z: number) {
    return (x >> 4) + (z >> 4) * CX + (y >> 4) * CX * CZ;
  }

  neighbour(i: number, x: number, y: number, z: number, k: number): number {
    switch (k) {
      case 0: return x > 0 ? i - 1 : -1;
      case 1: return x < SX - 1 ? i + 1 : -1;
      case 2: return z > 0 ? i - SX : -1;
      case 3: return z < SZ - 1 ? i + SX : -1;
      case 4: return y > 0 ? i - LAYER : -1;
      default: return y < SY - 1 ? i + LAYER : -1;
    }
  }

  private randomNeighbour(i: number, x: number, y: number, z: number): number {
    return this.neighbour(i, x, y, z, this.w.rng.int(6));
  }
}

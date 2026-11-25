// The simulation tick (v2). One call to step() advances the world by 1/30 s:
//   1. explosions (soft craters, flung rocks, splashes, fire, knocked-over trees)
//   2. terrain cells in awake chunks: springs, powders (settle, roll, fall as grains),
//      burning fuel
//   3. liquids (mass flow + droplets)
//   4. heat conduction + phase changes (each with a colour blend or a puff, never a pop)
//   5. slow random ticks (grass growth, mud drying)
//   6. gas particles, trees, rigid bodies, structural collapse

import { BASE_TPS, CHUNKS, CS, CX, CY, CZ, LAYER, SX, SY, SZ, VOLUME } from './constants.ts';
import { Gas, GAS_FIRE, GAS_SMOKE, GAS_SPARK, GAS_STEAM } from './gas.ts';
import { Liquids, nb } from './liquids.ts';
import { glowLevel } from './mesher.ts';
import {
  M, MATERIALS, State, T_COND, T_FLAM, T_FREEZE, T_IGNITE, T_MELT, T_MELT_TO, T_RELAX, T_STATE,
} from './materials.ts';
import { KIND_GRAIN, KIND_ROCK, Physics } from './physics.ts';
import { Structure } from './structure.ts';
import { Trees } from './trees.ts';
import { F_BURNING, F_SETTLED, F_SOURCE, F_TRICKLE, SOLID_FILL, World } from './world.ts';

const H4X = [1, -1, 0, 0];
const H4Z = [0, 0, 1, -1];

export interface TickStats {
  awake: number;
  heated: number;
  tickMs: number;
  liquidMs: number;
  physicsMs: number;
}

const IS_POWDER = new Uint8Array(32);
for (const m of MATERIALS) IS_POWDER[m.id] = m.state === State.POWDER ? 1 : 0;

export class Simulator {
  w: World;
  liquids: Liquids;
  gas: Gas;
  physics: Physics;
  trees: Trees;
  structure: Structure;
  stats: TickStats = { awake: 0, heated: 0, tickMs: 0, liquidMs: 0, physicsMs: 0 };
  private order = new Int32Array(CHUNKS);
  private heatMask = new Uint8Array(CHUNKS);
  private glowSeen = new Uint8Array(VOLUME);

  constructor(w: World) {
    this.w = w;
    this.gas = new Gas(w);
    this.liquids = new Liquids(w, {
      steam: (x, y, z, n) => { for (let k = 0; k < n; k++) this.gas.spawn(GAS_STEAM, x + (w.rng.next() - 0.5), y, z + (w.rng.next() - 0.5), 0, 2); },
      smoke: (x, y, z) => this.gas.spawn(GAS_SMOKE, x, y, z, 0, 1),
    });
    this.gas.liquids = this.liquids;
    this.physics = new Physics(w);
    this.trees = new Trees(w, this.gas, this.physics);
    this.structure = new Structure(w, this.physics);
  }

  resetDynamics() {
    this.liquids.clearDrops();
    this.gas.clear();
    this.physics.reset();
  }

  step(): void {
    const t0 = performance.now();
    const w = this.w;
    const dt = 1 / BASE_TPS;
    w.tick++;
    w.time += dt;

    let booms = 0;
    while (w.explosions.length && booms < 8) {
      const r = w.explosions.pop()!, z = w.explosions.pop()!, y = w.explosions.pop()!, x = w.explosions.pop()!;
      this.explode(x, y, z, r);
      booms++;
    }

    // awake chunks in random order
    let n = 0;
    for (let c = 0; c < CHUNKS; c++) if (w.awake[c]) this.order[n++] = c;
    for (let i = n - 1; i > 0; i--) {
      const j = w.rng.int(i + 1);
      const t = this.order[i]; this.order[i] = this.order[j]; this.order[j] = t;
    }
    for (let k = 0; k < n; k++) this.terrainChunk(this.order[k]);
    this.stats.awake = n;

    const tl = performance.now();
    this.liquids.step(this.order, n);
    this.stats.liquidMs = performance.now() - tl;

    // heat: awake chunks, warm chunks and their neighbours
    this.heatMask.fill(0);
    for (let c = 0; c < CHUNKS; c++) {
      // only chunks with real temperature differences need conduction
      if (w.hot[c] > 0.6) {
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
    // each warm chunk conducts every other tick (with a doubled, clamped step), half of them per tick
    for (let c = 0; c < CHUNKS; c++) {
      if (!this.heatMask[c]) continue;
      if ((c + w.tick) & 1) continue;
      this.heatChunk(c);
      heated++;
    }
    this.stats.heated = heated;

    this.randomTicks(2500);
    this.gas.step(dt);
    this.trees.update(dt);
    const tp = performance.now();
    this.physics.step((x, y, z, m, a, t) => this.depositFill(x, y, z, m, a, t));
    this.structure.run();
    this.stats.physicsMs = performance.now() - tp;

    for (let c = 0; c < CHUNKS; c++) if (w.awake[c]) w.awake[c]--;
    this.stats.tickMs = performance.now() - t0;
  }

  /**
   * Add terrain fill where a grain or rock came to rest. The fill goes into the lowest open
   * spot among the nearby columns, so material spills down the sides of a pile instead of
   * stacking into a tower. Returns whatever didn't fit.
   */
  depositFill(x: number, y: number, z: number, m: number, amount: number, temp: number): number {
    if (amount > 40) {
      // half in the middle, the rest shared with the four neighbouring columns
      let rest = this.depositAt(x, y, z, m, amount * 0.5, temp);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) rest += this.depositAt(x + dx, y, z + dz, m, amount * 0.125, temp);
      return rest > 0.5 ? this.depositAt(x, y, z, m, rest, temp) : 0;
    }
    return this.depositAt(x, y, z, m, amount, temp);
  }

  private depositAt(x: number, y: number, z: number, m: number, amount: number, temp: number): number {
    const w = this.w;
    let left = amount;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    if (bx < 0 || bz < 0 || bx >= SX || bz >= SZ || by < 0) return 0;
    const open = (i: number) => {
      const mm = w.mat[i];
      return mm === M.AIR || T_STATE[mm] === State.GAS || T_STATE[mm] === State.LIQUID || (mm === m && w.fill[i] < 250);
    };
    // lowest open cell in a column, starting near the body's height
    const lowest = (cx: number, cz: number): number => {
      let yy = Math.min(SY - 1, by + 1);
      // climb out if we start inside solid ground
      let guard = 0;
      while (yy < SY - 1 && !open(cx + cz * SX + yy * LAYER) && guard++ < 6) yy++;
      if (!open(cx + cz * SX + yy * LAYER)) return 999;
      while (yy > 0 && open(cx + cz * SX + (yy - 1) * LAYER) && by - yy < 10) yy--;
      return yy;
    };
    for (let attempt = 0; attempt < 4 && left > 0.5; attempt++) {
      const r = attempt < 2 ? 1 : 2;
      let tx = bx, tz = bz, ty = lowest(bx, bz);
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (!dx && !dz) continue;
        const cx = bx + dx, cz = bz + dz;
        if (cx < 0 || cz < 0 || cx >= SX || cz >= SZ) continue;
        const yy = lowest(cx, cz);
        // only spill sideways when it's clearly lower (that's the angle of repose)
        if (yy + 1 < ty) { ty = yy; tx = cx; tz = cz; }
      }
      if (ty >= SY) break;
      for (let k = 0; k < 2 && left > 0.5 && ty + k < SY; k++) {
        const i = tx + tz * SX + (ty + k) * LAYER;
        const cm = w.mat[i];
        if (cm === m) {
          const add = Math.min(255 - w.fill[i], left);
          if (add > 0) { w.setFill(i, w.fill[i] + add); left -= add; }
        } else if (cm === M.AIR || T_STATE[cm] === State.GAS) {
          const add = Math.min(255, left);
          w.set(i, m, temp, 0, 0, Math.max(14, add));
          left -= add;
        } else if (T_STATE[cm] === State.LIQUID) {
          // displace the liquid upward
          const lm = w.mass[i], lt = w.mat[i], lT = w.temp[i];
          const add = Math.min(255, left);
          w.set(i, m, temp, 0, 0, Math.max(14, add));
          left -= add;
          this.liquids.deposit(tx, ty + k + 1, tz, lt, lm, lT);
        }
      }
    }
    return left;
  }

  // ───────────────────────────── terrain cells ─────────────────────────────

  private terrainChunk(c: number) {
    const w = this.w;
    const { mat, flags } = w;
    const ox = (c % CX) * CS, oz = (Math.floor(c / CX) % CZ) * CS, oy = Math.floor(c / (CX * CZ)) * CS;
    let keep = false;
    for (let y = oy; y < oy + CS; y++) {
      for (let z = oz; z < oz + CS; z++) {
        let i = ox + z * SX + y * LAYER;
        for (let x = ox; x < ox + CS; x++, i++) {
          const m = mat[i];
          if (m === M.AIR) continue;
          if (m === M.SPRING) { this.spring(i, x, y, z); keep = true; continue; }
          if (flags[i] & F_BURNING) { this.burn(i, x, y, z, m); keep = true; continue; }
          if (IS_POWDER[m]) { if (this.powder(i, x, y, z, m)) keep = true; }
        }
      }
    }
    if (keep && w.awake[c] < 2) w.awake[c] = 2;
  }

  private spring(i: number, x: number, y: number, z: number) {
    const w = this.w;
    const rate = (w.flags[i] & F_TRICKLE) ? 0.035 : 0.22;
    for (let k = 0; k < 5; k++) {
      const n = k === 4 ? (y < SY - 1 ? i + LAYER : -1) : nb(i, x, y, z, k);
      if (n < 0) continue;
      const m = w.mat[n];
      if (m === M.AIR) w.place(n, M.WATER, 0, rate);
      else if (m === M.WATER && w.mass[n] < 1.05) { w.mass[n] += rate; w.wakeLiquid(n); }
    }
  }

  /** Powders: settle into partial cells below, roll off slopes and drop as physics grains. */
  private powder(i: number, x: number, y: number, z: number, m: number): boolean {
    const w = this.w;
    const { mat, fill } = w;
    if (y === 0) { w.set(i, M.AIR); return true; }
    const j = i - LAYER;
    const mj = mat[j];
    const f = fill[i];
    // compact into a partly filled cell of the same powder below
    if (mj === m && fill[j] < 255) {
      const room = 255 - fill[j];
      let t = Math.min(f, room, 40);
      // never leave a sliver too thin to exist (it would just vanish): move all of it or wait
      if (f - t < 14) { if (room >= f) t = f; else t = Math.max(0, f - 14); }
      if (t <= 0) return false;
      w.setFill(j, fill[j] + t);
      if (f - t <= 0) w.set(i, M.AIR); else w.setFill(i, f - t);
      return true;
    }
    const open = mj === M.AIR || T_STATE[mj] === State.GAS || T_STATE[mj] === State.LIQUID;
    if (open) {
      // nothing underneath: becomes a real falling grain
      if (this.physics.spawnGrain(x + 0.5, y + 0.4, z + 0.5, (w.rng.next() - 0.5) * 0.4, -1, (w.rng.next() - 0.5) * 0.4, m, f, w.temp[i])) {
        w.set(i, M.AIR);
        return true;
      }
      // too many grains in flight: slump down smoothly instead
      if (mj === M.AIR) {
        let t = Math.min(f, 70);
        if (f - t < 14) t = f;
        w.set(j, m, w.temp[i], 0, 0, Math.max(14, t));
        if (f - t <= 0) w.set(i, M.AIR); else w.setFill(i, f - t);
        return true;
      }
      return false;
    }
    if (w.flags[i] & F_SETTLED) return false;
    // on a slope: roll down the side if the material isn't sticky enough to hold
    const mm = MATERIALS[m];
    if (w.rng.next() < mm.diag && f > 90) {
      const start = w.rng.int(4);
      for (let k = 0; k < 4; k++) {
        const d = (start + k) & 3;
        const nx = x + H4X[d], nz = z + H4Z[d];
        if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ) continue;
        const side = nx + nz * SX + y * LAYER;
        const down = side - LAYER;
        const sm = mat[side], dm = mat[down];
        const sideOpen = sm === M.AIR || T_STATE[sm] === State.GAS;
        // only roll down into open air: wet sand at a shoreline stays put
        const downOpen = (dm === M.AIR || T_STATE[dm] === State.GAS) && (y < 2 || !w.blocks(down - LAYER) || mat[down - LAYER] === M.AIR);
        const aboveOpen = y + 1 >= SY || mat[i + LAYER] === M.AIR;
        if (sideOpen && downOpen && aboveOpen) {
          if (this.physics.spawnGrain(x + 0.5 + H4X[d] * 0.35, y + 0.55, z + 0.5 + H4Z[d] * 0.35, H4X[d] * 2.2, 0.4, H4Z[d] * 2.2, m, f, w.temp[i])) {
            w.set(i, M.AIR);
            return true;
          }
        }
      }
    }
    w.flags[i] |= F_SETTLED;
    return false;
  }

  /** A burning terrain cell: flames, smoke, sparks; slowly consumed. */
  private burn(i: number, x: number, y: number, z: number, m: number) {
    const w = this.w;
    const rng = w.rng;
    const g = this.gas;
    // put out by water next to it
    for (let k = 0; k < 6; k++) {
      const n = nb(i, x, y, z, k);
      if (n >= 0 && w.mat[n] === M.WATER) { w.flags[i] &= ~F_BURNING; g.spawn(GAS_STEAM, x + 0.5, y + 1, z + 0.5); return; }
    }
    const top = y < SY - 1 ? i + LAYER : -1;
    const exposed = top >= 0 && (w.mat[top] === M.AIR || T_STATE[w.mat[top]] === State.GAS);
    const strength = T_FLAM[m] + 0.2;
    if (rng.next() < (exposed ? 0.55 : 0.2) * strength) g.spawn(GAS_FIRE, x + rng.next(), y + 0.8 + rng.next() * 0.4, z + rng.next(), 0, 1.2);
    if (rng.next() < 0.05 * strength) g.spawn(GAS_SMOKE, x + 0.5, y + 1.4, z + 0.5, 0, 1.5);
    if (rng.next() < 0.006) g.spawn(GAS_SPARK, x + 0.5, y + 1, z + 0.5, (rng.next() - 0.5) * 3, 1, (rng.next() - 0.5) * 3);
    w.temp[i] = Math.max(w.temp[i], 650);
    w.life[i] = Math.min(255, w.life[i] + 1);
    if (m === M.GRASS) {
      // grass burns off and leaves the dirt behind (colour blends from green to brown)
      if (w.life[i] > 40) { w.set(i, M.DIRT, 260, 0, 0, w.fill[i]); }
    } else if (m === M.OIL) {
      // handled by the liquid side (mass burns away)
    } else {
      const rate = m === M.LEAVES ? 9 : m === M.WOOD ? 1.6 : m === M.GUNPOWDER ? 255 : 4;
      const nf = w.fill[i] - rate;
      if (nf < 14) { w.set(i, M.AIR, 400); g.spawn(GAS_SMOKE, x + 0.5, y + 0.8, z + 0.5, 0, 1.5); }
      else w.setFill(i, nf);
    }
  }

  // ───────────────────────────── heat ─────────────────────────────

  private heatChunk(c: number) {
    const w = this.w;
    const { mat, temp, flags } = w;
    const amb = w.ambient;
    const rng = w.rng;
    const ox = (c % CX) * CS, oz = (Math.floor(c / CX) % CZ) * CS, oy = Math.floor(c / (CX * CZ)) * CS;
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
          // fast path: this cell and its neighbours are all sitting at ambient -> nothing to do
          if (T === a && (x === 0 || temp[i - 1] === a) && (x === SX - 1 || temp[i + 1] === a) &&
            (z === 0 || temp[i - SX] === a) && (z === SZ - 1 || temp[i + SX] === a) &&
            (y === 0 || temp[i - LAYER] === a + aDn) && (y === SY - 1 || temp[i + LAYER] === a + aUp)) continue;
          const k = T_COND[m];
          let sum = 0, ws = 0;
          if (x > 0) { const n = i - 1; const kn = T_COND[mat[n]]; const kk = kn < k ? kn : k; sum += kk * (temp[n] - T); ws += kk; }
          if (x < SX - 1) { const n = i + 1; const kn = T_COND[mat[n]]; const kk = kn < k ? kn : k; sum += kk * (temp[n] - T); ws += kk; }
          if (z > 0) { const n = i - SX; const kn = T_COND[mat[n]]; const kk = kn < k ? kn : k; sum += kk * (temp[n] - T); ws += kk; }
          if (z < SZ - 1) { const n = i + SX; const kn = T_COND[mat[n]]; const kk = kn < k ? kn : k; sum += kk * (temp[n] - T); ws += kk; }
          if (y > 0) { const n = i - LAYER; const kn = T_COND[mat[n]]; const kk = kn < k ? kn : k; sum += kk * (temp[n] - aDn - T); ws += kk; }
          if (y < SY - 1) { const n = i + LAYER; const kn = T_COND[mat[n]]; const kk = kn < k ? kn : k; sum += kk * (temp[n] - aUp - T); ws += kk; }
          // doubled step (runs every other tick); if the neighbours' total weight would
          // overshoot (good conductors like metal), scale it back so it stays stable
          let d = sum * 0.6;
          const wt = ws * 0.6;
          if (wt > 0.85) d *= 0.85 / wt;
          let nt = T + d;
          nt += (a - nt) * Math.min(0.5, T_RELAX[m] * 2);
          // snap to ambient once it's indistinguishable, so the fast path above kicks in
          if (nt - a < 0.05 && a - nt < 0.05) nt = a;
          if (m === M.LAVA && (flags[i] & F_SOURCE) && nt < 1200) nt = 1200;
          if (m === M.AIR && nt > 2600) nt = 2600;
          temp[i] = nt;
          const dev = nt > a ? nt - a : a - nt;
          if (dev > maxDev) maxDev = dev;
          if (m === M.AIR) continue;

          // glow changes need a remesh (quantised so a slowly cooling rock doesn't remesh every tick)
          const gq = Math.min(31, glowLevel(m, nt) >> 3);
          if (gq !== this.glowSeen[i]) { this.glowSeen[i] = gq; w.dirty[c] |= 1; }

          const st = T_STATE[m];
          if (st === State.LIQUID) {
            if (m === M.WATER) {
              if (nt > 100) {
                // boiling: the water turns into steam bit by bit
                w.mass[i] -= 0.04;
                temp[i] = 100;
                if (rng.next() < 0.6) this.gas.spawn(GAS_STEAM, x + rng.next(), y + 0.9, z + rng.next(), 0, 2);
                if (w.mass[i] < 0.02) w.set(i, M.AIR, 105); else w.wakeLiquid(i);
              } else if (nt < -0.5 && rng.next() < 0.08) {
                w.set(i, M.ICE, nt, 0, 0, Math.max(40, Math.min(255, Math.round(w.mass[i] * 255))));
                w.event({ t: 'puff', x: x + 0.5, y: y + 0.8, z: z + 0.5, c: 0xdff4ff });
              }
            } else if (m === M.LAVA) {
              if (!(flags[i] & F_SOURCE) && nt < 750 && rng.next() < 0.15) {
                // lava crusts over into obsidian (the shader blends the glow out)
                w.set(i, M.OBSIDIAN, nt, 0, 0, Math.max(60, Math.min(255, Math.round(w.mass[i] * 255))));
                if (w.newSolids.length < 4000) w.newSolids.push(i);
              }
            } else if (m === M.ACID && nt > 300) {
              this.gas.spawn(GAS_SMOKE, x + 0.5, y + 0.8, z + 0.5, 0, 1.5);
              w.set(i, M.AIR, nt);
            }
            if (T_FLAM[m] > 0 && nt >= T_IGNITE[m] && !(flags[i] & F_BURNING) && rng.next() < T_FLAM[m] * 0.3) flags[i] |= F_BURNING;
            continue;
          }

          if (nt > T_MELT[m]) {
            if (rng.next() < 0.2) this.melt(i, x, y, z, m, nt);
            continue;
          }
          if (nt < T_FREEZE[m]) continue;
          const f = T_FLAM[m];
          if (f > 0 && nt >= T_IGNITE[m] && !(flags[i] & F_BURNING) && rng.next() < f * 0.35) this.ignite(i, x, y, z, m);
        }
      }
    }
    w.hot[c] = maxDev;
  }

  private melt(i: number, x: number, y: number, z: number, m: number, t: number) {
    const w = this.w;
    const to = T_MELT_TO[m];
    const f = w.fill[i] / 255;
    if (T_STATE[to] === State.LIQUID) {
      // a solid turning into liquid: same amount of stuff, now flowing
      const amount = m === M.SNOW ? f * 0.45 : f;
      w.set(i, to, m === M.ICE || m === M.SNOW ? 1 : t, 0, 0, Math.max(0.05, amount));
      w.event({ t: 'puff', x: x + 0.5, y: y + 0.8, z: z + 0.5, c: to === M.LAVA ? 0xff8040 : 0xe8f6ff });
    } else if (to === M.SMOKE || T_STATE[to] === State.GAS) {
      this.gas.spawn(GAS_SMOKE, x + 0.5, y + 0.6, z + 0.5);
      w.set(i, M.AIR, t);
    } else {
      // solid to solid (sand -> glass, mud -> dirt): keep the shape, blend the colour
      w.set(i, to, t, 0, 0, w.fill[i]);
      if (m === M.MUD) this.gas.spawn(GAS_STEAM, x + 0.5, y + 1, z + 0.5);
    }
  }

  ignite(i: number, x: number, y: number, z: number, m: number) {
    const w = this.w;
    if (m === M.GUNPOWDER) {
      w.set(i, M.AIR, 1200);
      w.explosions.push(x + 0.5, y + 0.5, z + 0.5, 2.4 + w.rng.next());
      return;
    }
    w.flags[i] |= F_BURNING;
    w.life[i] = 0;
    w.temp[i] = Math.max(w.temp[i], 600);
    w.keepAwake(i);
    if (w.rng.next() < 0.05) w.event({ t: 'ignite', x: x + 0.5, y: y + 0.5, z: z + 0.5 });
  }

  // ───────────────────────────── random ticks ─────────────────────────────

  private randomTicks(count: number) {
    const w = this.w;
    const { mat, rng } = w;
    for (let s = 0; s < count; s++) {
      const i = rng.u32() % VOLUME;
      const m = mat[i];
      if (m !== M.DIRT && m !== M.GRASS && m !== M.MUD) continue;
      const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
      if (m === M.MUD) {
        let wet = false;
        for (let k = 0; k < 6; k++) { const n = nb(i, x, y, z, k); if (n >= 0 && mat[n] === M.WATER) wet = true; }
        if (!wet && rng.next() < 0.35) w.set(i, M.DIRT, undefined, 0, 0, w.fill[i]);
        continue;
      }
      const above = y < SY - 1 ? i + LAYER : -1;
      const am = above >= 0 ? mat[above] : M.AIR;
      if (m === M.GRASS) {
        if (above >= 0 && T_STATE[am] !== State.EMPTY && T_STATE[am] !== State.GAS && w.fill[above] >= SOLID_FILL) w.set(i, M.DIRT, undefined, 0, 0, w.fill[i]);
        continue;
      }
      if (am !== M.AIR || w.fill[i] < 150) continue;
      if (!this.isLit(x, y, z)) continue;
      let nearGrass = false;
      for (let dy = -1; dy <= 1 && !nearGrass; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= SY) continue;
        for (let d = 0; d < 4; d++) {
          const nx = x + H4X[d], nz = z + H4Z[d];
          if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ) continue;
          if (mat[nx + nz * SX + yy * LAYER] === M.GRASS) { nearGrass = true; break; }
        }
      }
      if (nearGrass && this.nearWater(x, y, z, 6)) w.set(i, M.GRASS, undefined, 0, 0, w.fill[i]);
    }
  }

  private isLit(x: number, y: number, z: number): boolean {
    const { mat, fill } = this.w;
    for (let yy = y + 1; yy < Math.min(SY, y + 20); yy++) {
      const i = x + z * SX + yy * LAYER;
      const st = T_STATE[mat[i]];
      if ((st === State.SOLID || st === State.POWDER) && fill[i] >= SOLID_FILL) return false;
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
    const { mat } = w;
    const R = r * 1.35;
    const RG = r * 2.2;
    const x0 = Math.max(0, Math.floor(cx - RG)), x1 = Math.min(SX - 1, Math.ceil(cx + RG));
    const y0 = Math.max(0, Math.floor(cy - RG)), y1 = Math.min(SY - 1, Math.ceil(cy + RG));
    const z0 = Math.max(0, Math.floor(cz - RG)), z1 = Math.min(SZ - 1, Math.ceil(cz + RG));
    let rocks = 0;
    const maxRocks = Math.min(45, 14 + r * 6);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > RG) continue;
          const i = x + z * SX + y * LAYER;
          const m = mat[i];
          if (m === M.GUNPOWDER) { w.temp[i] = Math.max(w.temp[i], 450); w.keepAwake(i); w.markHot(i); continue; }
          if (dist > R) {
            if (m === M.GRASS && rng.next() < 0.6 * (1 - (dist - R) / (RG - R))) w.set(i, M.DIRT, undefined, 0, 0, w.fill[i]);
            continue;
          }
          w.temp[i] += 520 * Math.max(0, 1 - dist / R);
          w.markHot(i);
          const st = T_STATE[m];
          const len = dist || 1;
          if (st === State.SOLID || st === State.POWDER) {
            // soft crater: strongest in the middle, fading out to the rim
            const core = 1 - smooth(R * 0.45, R, dist);
            const eat = Math.min(1.2, core * (1.35 - MATERIALS[m].hardness) * 1.25);
            const f = w.fill[i];
            const removed = f * eat;
            if (f - removed < 30) {
              if (rocks < maxRocks && rng.next() < 0.45 && dist > R * 0.25) {
                const sp = (10 + rng.next() * 12) * (1.05 - dist / R * 0.4);
                if (this.physics.spawnRock(x + 0.5, y + 0.5, z + 0.5, dx / len * sp + (rng.next() - 0.5) * 3, dy / len * sp + 7 + rng.next() * 6, dz / len * sp + (rng.next() - 0.5) * 3,
                  m === M.GRASS ? M.DIRT : m, Math.min(255, f), w.temp[i])) rocks++;
              }
              w.set(i, M.AIR);
            } else {
              w.setFill(i, f - removed);
            }
          } else if (st === State.LIQUID) {
            // liquids splash outward as droplets
            const sp = 6 + rng.next() * 8;
            this.liquids.spawnDrop(m, x + 0.5, y + 0.5, z + 0.5, dx / len * sp, Math.abs(dy / len) * sp + 5, dz / len * sp, w.mass[i], w.temp[i]);
            w.set(i, M.AIR);
          } else if (m === M.AIR && dist < R * 0.8) {
            if (rng.next() < 0.12) this.gas.spawn(GAS_FIRE, x + 0.5, y + 0.5, z + 0.5, dx / len * 4, 3, dz / len * 4);
            else if (rng.next() < 0.08) this.gas.spawn(GAS_SMOKE, x + 0.5, y + 0.5, z + 0.5, dx / len * 3, 2, dz / len * 3);
          }
        }
      }
    }
    for (let k = 0; k < 6; k++) this.gas.spawn(GAS_SPARK, cx, cy, cz, (rng.next() - 0.5) * 16, 6 + rng.next() * 8, (rng.next() - 0.5) * 16);
    this.physics.blast(cx, cy, cz, r, 9);
    this.trees.knock(cx, cy, cz, r);
    w.event({ t: 'boom', x: cx, y: cy, z: cz, r });
  }

  /** Spawn a solid piece from a tool (pour) as a physics object. */
  pourSolid(x: number, y: number, z: number, m: number, amount: number) {
    const w = this.w;
    if (IS_POWDER[m]) return this.physics.spawnGrain(x, y, z, 0, -3 - w.rng.next() * 3, 0, m, amount, w.defaultTemp(m, Math.floor(y)));
    return this.physics.spawnRock(x, y, z, 0, -3 - w.rng.next() * 3, 0, m, amount, w.defaultTemp(m, Math.floor(y)));
  }

  get grainCount() {
    return this.physics.bodies.filter((b) => b.kind === KIND_GRAIN || b.kind === KIND_ROCK).length;
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export { GAS_FIRE, GAS_SMOKE, GAS_SPARK, GAS_STEAM };

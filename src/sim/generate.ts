// Procedural floating island: smooth layered terrain (fractional fill so surface nets gives
// soft slopes), a snowy peak, a sandy lake fed by a spring, a waterfall channel off the
// edge, a cave with a lava pocket, and trees / rocks / plants as separate low poly models.

import { idx, inBounds, LAYER, SX, SY, SZ } from './constants.ts';
import { M } from './materials.ts';
import { mulberry32, Noise } from './noise.ts';
import { F_SOURCE, F_TRICKLE, World } from './world.ts';

export interface TreeSpec {
  id: number;
  x: number; y: number; z: number; // base (on the ground)
  h: number; // height
  kind: 0 | 1 | 2; // oak, pine, birch-ish round
  seed: number;
}

/** Decorations: 0 rock, 1 grass tuft, 2 flower, 3 bush */
export interface DecorSpec {
  k: number;
  x: number; y: number; z: number;
  s: number; // scale
  r: number; // rotation
  v: number; // variant / colour
  cell: number; // the ground cell it sits on
}

export interface IslandInfo {
  center: [number, number, number];
  lake: [number, number, number];
  mountain: [number, number, number];
  waterfall: [number, number, number];
  cave: [number, number, number];
  trees: TreeSpec[];
  decor: DecorSpec[];
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function generateIsland(world: World, seed: number): IslandInfo {
  world.clear();
  world.seed = seed;
  const n = new Noise(seed);
  const rnd = mulberry32(seed ^ 0xabcdef);
  const { mat, fill, mass, temp, flags } = world;

  const cx = SX / 2, cz = SZ / 2;
  const WL = 34; // lake water level (top water cell)

  // Feature placement
  const aM = rnd() * Math.PI * 2;
  const mx = cx + Math.cos(aM) * 17, mz = cz + Math.sin(aM) * 17;
  const aL = aM + Math.PI + (rnd() - 0.5) * 0.9;
  const lx = cx + Math.cos(aL) * 19, lz = cz + Math.sin(aL) * 19;
  const lakeR = 12.5 + rnd() * 2;
  const chA = aL + (rnd() - 0.5) * 0.5;
  const chDx = Math.cos(chA), chDz = Math.sin(chA);

  const topF = new Float32Array(SX * SZ).fill(-1);
  const botF = new Float32Array(SX * SZ).fill(-1);
  const kind = new Uint8Array(SX * SZ); // 0 land, 1 lake, 2 beach, 3 channel
  const lakeFloor = new Int16Array(SX * SZ);

  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const dx = x - cx, dz = z - cz;
      const dist = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);
      const R = 49 + 6 * n.noise2(Math.cos(ang) * 1.3 + 10, Math.sin(ang) * 1.3 + 10) + 3 * n.fbm2(x * 0.05, z * 0.05, 2);
      const rr = dist / R;
      if (rr > 1) continue;

      let h = 36 + 4 * n.fbm2(x * 0.022, z * 0.022, 4) + 1.2 * n.fbm2(x * 0.09 + 50, z * 0.09, 2);
      const dm = Math.hypot(x - mx, z - mz);
      h += 21 * Math.exp(-(dm * dm) / (2 * 10.5 * 10.5)) * (0.72 + 0.4 * n.ridge2(x * 0.07, z * 0.07, 3));
      h -= smoothstep(0.72, 1.0, rr) * 8;

      const dl = Math.hypot(x - lx, z - lz);
      const lr = lakeR + 1.6 * n.noise2(x * 0.12 + 7, z * 0.12);
      const rimW = smoothstep(lr * 1.8, lr * 1.1, dl);
      h = h * (1 - rimW) + Math.max(h, WL + 1.6 + 1.5 * n.noise2(x * 0.2, z * 0.2)) * rimW;
      let k = 0;
      if (dl < lr) {
        const floor = Math.floor(WL - 1 - 6.5 * (1 - (dl / lr) ** 2) + n.noise2(x * 0.3, z * 0.3));
        lakeFloor[x + z * SX] = floor;
        h = floor + 0.4;
        k = 1;
      } else if (dl < lr + 2.8 && h < WL + 2.6) {
        k = 2;
      }

      const px = x - lx, pz = z - lz;
      const t = px * chDx + pz * chDz;
      const perp = Math.abs(-px * chDz + pz * chDx);
      if (k !== 1 && t > lr * 0.5 && perp < 2.3 + t * 0.02) {
        h = Math.min(h, WL - 1 + 0.4);
        k = 3;
      }

      h = Math.min(SY - 4, h);
      let b = 30 - Math.pow(Math.max(0, 1 - rr), 0.62) * 27 + 2.5 * n.fbm2(x * 0.09, z * 0.09, 2) - 3 * Math.max(0, n.noise2(x * 0.18, z * 0.18));
      b = Math.max(1, Math.min(h - 3, b));
      topF[x + z * SX] = h;
      botF[x + z * SX] = b;
      kind[x + z * SX] = k;
    }
  }

  // Fill columns with fractional surfaces: fill = 0.5 + signed vertical distance (clamped)
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const c = x + z * SX;
      const h = topF[c];
      if (h < 0) continue;
      const k = kind[c];
      const b = botF[c];
      const surf = h + 0.6; // surface height in world units
      const hi = Math.floor(h);
      const dirtDepth = 3 + Math.floor(1.5 + 1.5 * n.noise2(x * 0.1, z * 0.1));
      const gravelPatch = n.noise2(x * 0.11 + 30, z * 0.11) > 0.25 && hi > 41 && hi < 49;
      for (let y = Math.floor(b) - 1; y <= hi + 1; y++) {
        if (y < 0 || y >= SY) continue;
        const cyc = y + 0.5;
        const f = Math.max(0, Math.min(1, 0.5 + Math.min(surf - cyc, cyc - b)));
        if (f < 0.06) continue;
        const d = Math.max(0, hi - y);
        let m: number = M.STONE;
        if (k === 1) m = d < 2 ? M.SAND : d < 3 ? M.GRAVEL : M.STONE;
        else if (k === 2) m = d < 3 ? M.SAND : M.STONE;
        else if (k === 3) m = d < 1 ? M.GRAVEL : M.STONE;
        else if (hi >= 50) m = M.STONE;
        else if (gravelPatch && d < 2) m = M.GRAVEL;
        else if (hi >= 47) m = d === 0 && n.noise2(x * 0.3, z * 0.3) > 0 ? M.GRASS : d < 2 ? M.DIRT : M.STONE;
        else m = d === 0 ? M.GRASS : d < dirtDepth ? M.DIRT : M.STONE;
        if (m === M.STONE && n.fbm3(x * 0.11, y * 0.11, z * 0.11, 2) > 0.45) m = M.METAL;
        const i = idx(x, y, z);
        mat[i] = m;
        fill[i] = Math.round(f * 255);
      }
      // snow caps (fractional too)
      if (hi >= 50) {
        const depth = hi >= 55 ? 1.6 : 0.9;
        const sTop = surf + depth;
        for (let y = hi; y <= Math.min(SY - 1, hi + 3); y++) {
          const i = idx(x, y, z);
          const f = Math.max(0, Math.min(1, 0.5 + (sTop - (y + 0.5))));
          if (f < 0.06) continue;
          if (mat[i] === M.AIR || fill[i] < f * 255) {
            if (mat[i] === M.AIR || mat[i] === M.STONE) { mat[i] = M.SNOW; fill[i] = Math.round(Math.max(f, fill[i] / 255) * 255); }
          }
        }
      }
      // water
      if (k === 1) for (let y = lakeFloor[c] + 1; y <= WL; y++) { const i = idx(x, y, z); mat[i] = M.WATER; mass[i] = 1; fill[i] = 0; }
      if (k === 3 && hi === WL - 1) { const i = idx(x, WL, z); mat[i] = M.WATER; mass[i] = 0.7; fill[i] = 0; }
    }
  }

  // Springs: a trickle on the mountain, the main one at the head of the waterfall channel
  {
    const steps = 60;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const x = Math.round(lx + (mx - lx) * f), z = Math.round(lz + (mz - lz) * f);
      const hi = Math.floor(topF[x + z * SX]);
      if (hi >= WL + 7 && hi < 48) {
        const i = idx(x, hi, z);
        mat[i] = M.SPRING; fill[i] = 255; flags[i] = F_TRICKLE;
        break;
      }
    }
    for (let t = lakeR + 1; t < lakeR + 8; t += 1) {
      const x = Math.round(lx + chDx * t), z = Math.round(lz + chDz * t);
      if (x < 1 || z < 1 || x >= SX - 1 || z >= SZ - 1) break;
      if (kind[x + z * SX] === 3) {
        for (const [ox, oz] of [[0, 0], [-Math.round(chDz), Math.round(chDx)], [Math.round(chDz), -Math.round(chDx)]]) {
          const c = x + ox + (z + oz) * SX;
          if (kind[c] === 3) { const i = idx(x + ox, WL - 1, z + oz); mat[i] = M.SPRING; fill[i] = 255; }
        }
        break;
      }
    }
  }

  // Cave: chamber under the mountain with a lava pocket, tunnel climbing out to the cliff.
  // Carving lowers fill smoothly with distance so the walls come out round.
  const ccx = mx + (cx - mx) * 0.15, ccz = mz + (cz - mz) * 0.15, ccy = 21;
  const carve = (px: number, py: number, pz: number, r: number, floorY = -1) => {
    const R = r + 1;
    for (let y = Math.floor(py - R); y <= py + R; y++) {
      if (y < floorY) continue;
      for (let z = Math.floor(pz - R); z <= pz + R; z++) {
        for (let x = Math.floor(px - R); x <= px + R; x++) {
          if (!inBounds(x, y, z)) continue;
          const d = Math.sqrt((x + 0.5 - px) ** 2 + ((y + 0.5 - py) * 1.25) ** 2 + (z + 0.5 - pz) ** 2);
          const i = idx(x, y, z);
          const m = mat[i];
          if (m === M.AIR || m === M.WATER || m === M.SPRING) continue;
          const keep = Math.max(0, Math.min(1, 0.5 + (d - r)));
          const f = Math.min(fill[i], Math.round(keep * 255));
          if (f < 16) { mat[i] = M.AIR; fill[i] = 0; } else fill[i] = f;
        }
      }
    }
  };
  carve(ccx, ccy, ccz, 7, ccy - 4);
  const caveMouth: [number, number, number] = [ccx, ccy, ccz];
  {
    let ox = -(cx - mx), oz = -(cz - mz);
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol; oz /= ol;
    let px = ccx, py = ccy - 1, pz = ccz;
    let a = Math.atan2(oz, ox);
    let outside = 0;
    for (let s = 0; s < 140 && outside < 5; s++) {
      a += (n.noise2(s * 0.08, 3.3)) * 0.12;
      px += Math.cos(a) * 0.8;
      pz += Math.sin(a) * 0.8;
      py = Math.min(29, py + 0.07);
      carve(px, py, pz, 2.6 + 0.6 * n.noise2(s * 0.2, 9), py - 2);
      const rx = Math.round(px), rz = Math.round(pz);
      const ci = rx + rz * SX;
      if (rx < 0 || rx >= SX || rz < 0 || rz >= SZ || topF[ci] < 0 || botF[ci] > py) {
        if (outside === 0) { caveMouth[0] = px; caveMouth[1] = py; caveMouth[2] = pz; }
        outside++;
      }
    }
  }
  for (let y = ccy - 7; y <= ccy - 4; y++) {
    for (let z = Math.floor(ccz - 6); z <= ccz + 6; z++) {
      for (let x = Math.floor(ccx - 6); x <= ccx + 6; x++) {
        const d = Math.hypot(x - ccx, z - ccz);
        const r = 4.6 - (ccy - 4 - y) * 0.7;
        const i = idx(x, y, z);
        if (d < r) {
          mat[i] = M.LAVA; mass[i] = y === ccy - 4 ? 0.8 : 1; fill[i] = 0; flags[i] = F_SOURCE;
        } else if (d < r + 1.2 && mat[i] === M.STONE && rnd() < 0.7) {
          mat[i] = M.OBSIDIAN;
        }
      }
    }
  }

  // Temperatures
  for (let y = 0; y < SY; y++) {
    const amb = world.ambient[y];
    for (let i = y * LAYER; i < (y + 1) * LAYER; i++) {
      const m = mat[i];
      temp[i] = m === M.LAVA ? 1200 : m === M.SNOW ? Math.min(amb, -2) : amb;
    }
  }

  // ── Trees (models, not voxels)
  const surfaceY = (x: number, z: number) => {
    for (let y = SY - 1; y >= 0; y--) {
      const i = idx(x, y, z);
      if (mat[i] !== M.AIR && mat[i] !== M.WATER && fill[i] >= 128) {
        // fractional height inside the cell for a snug fit
        return y + Math.min(1, fill[i] / 255);
      }
    }
    return -1;
  };
  const topMat = (x: number, z: number) => {
    for (let y = SY - 1; y >= 0; y--) { const i = idx(x, y, z); if (mat[i] !== M.AIR) return [mat[i], i]; }
    return [0, -1];
  };
  const trees: TreeSpec[] = [];
  for (let attempt = 0; attempt < 500 && trees.length < 26; attempt++) {
    const x = 4 + Math.floor(rnd() * (SX - 8)), z = 4 + Math.floor(rnd() * (SZ - 8));
    const c = x + z * SX;
    const h = topF[c];
    if (h < WL + 1 || h > 49 || kind[c] !== 0) continue;
    const [tm] = topMat(x, z);
    if (tm !== M.GRASS && tm !== M.DIRT) continue;
    if (Math.hypot(x - cx, z - cz) > 41) continue;
    if (Math.hypot(x - lx, z - lz) < lakeR + 4) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 6.5)) continue;
    let ok = true;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (Math.abs(topF[x + ox + (z + oz) * SX] - h) > 1.2) ok = false;
    if (!ok) continue;
    const pine = h > 43 || rnd() < 0.3;
    const kindT: 0 | 1 | 2 = pine ? 1 : rnd() < 0.25 ? 2 : 0;
    trees.push({
      id: trees.length + 1, x: x + 0.5, y: surfaceY(x, z) - 0.15, z: z + 0.5,
      h: pine ? 8 + rnd() * 3 : 5.5 + rnd() * 2.5, kind: kindT, seed: Math.floor(rnd() * 1e6),
    });
  }

  // ── Decorations: rocks, grass tufts, flowers, bushes
  const decor: DecorSpec[] = [];
  const nearTree = (x: number, z: number, r: number) => trees.some((t) => Math.hypot(t.x - x, t.z - z) < r);
  for (let attempt = 0; attempt < 6000 && decor.length < 520; attempt++) {
    const x = 2 + Math.floor(rnd() * (SX - 4)), z = 2 + Math.floor(rnd() * (SZ - 4));
    const c = x + z * SX;
    if (topF[c] < 0 || kind[c] === 1 || kind[c] === 3) continue;
    const [tm, ti] = topMat(x, z);
    if (ti < 0) continue;
    const y = surfaceY(x, z);
    if (y < 0) continue;
    const fx = x + 0.2 + rnd() * 0.6, fz = z + 0.2 + rnd() * 0.6;
    const roll = rnd();
    if ((tm === M.STONE || tm === M.GRAVEL || tm === M.SNOW || (tm === M.GRASS && roll < 0.04)) && rnd() < 0.18) {
      decor.push({ k: 0, x: fx, y: y - 0.2, z: fz, s: 0.5 + rnd() * 0.9, r: rnd() * 6.28, v: Math.floor(rnd() * 3), cell: ti });
    } else if (tm === M.GRASS && !nearTree(fx, fz, 1.2)) {
      if (roll < 0.62) decor.push({ k: 1, x: fx, y: y - 0.1, z: fz, s: 0.6 + rnd() * 0.6, r: rnd() * 6.28, v: Math.floor(rnd() * 3), cell: ti });
      else if (roll < 0.86) decor.push({ k: 2, x: fx, y: y - 0.05, z: fz, s: 0.5 + rnd() * 0.4, r: rnd() * 6.28, v: Math.floor(rnd() * 4), cell: ti });
      else if (rnd() < 0.5) decor.push({ k: 3, x: fx, y: y - 0.25, z: fz, s: 0.7 + rnd() * 0.6, r: rnd() * 6.28, v: Math.floor(rnd() * 2), cell: ti });
    } else if (tm === M.SAND && rnd() < 0.06) {
      decor.push({ k: 0, x: fx, y: y - 0.25, z: fz, s: 0.35 + rnd() * 0.4, r: rnd() * 6.28, v: 2, cell: ti });
    }
  }

  let fx = lx, fz = lz;
  for (let t = 0; t < 80; t++) {
    const x = Math.round(lx + chDx * t), z = Math.round(lz + chDz * t);
    if (x < 0 || z < 0 || x >= SX || z >= SZ || topF[x + z * SX] < 0) break;
    fx = x; fz = z;
  }
  world.changeT.fill(-10);
  world.markAllDirty();
  return {
    waterfall: [fx, WL, fz],
    cave: caveMouth,
    center: [cx, WL, cz],
    lake: [lx, WL, lz],
    mountain: [mx, 50, mz],
    trees,
    decor,
  };
}

// Procedural floating island: layered terrain, snowy peak, lake fed by a spring,
// a waterfall channel off the edge, trees, a cave with a lava pocket and metal veins.

import { idx, inBounds, LAYER, SX, SY, SZ } from './constants.ts';
import { M } from './materials.ts';
import { mulberry32, Noise } from './noise.ts';
import { F_SOURCE, World } from './world.ts';

export interface IslandInfo {
  center: [number, number, number];
  lake: [number, number, number];
  mountain: [number, number, number];
  waterfall: [number, number, number];
  cave: [number, number, number];
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
  const { mat, temp, flags } = world;

  const cx = SX / 2, cz = SZ / 2;
  const WL = 34; // lake water level

  // Feature placement
  const aM = rnd() * Math.PI * 2;
  const mx = cx + Math.cos(aM) * 17, mz = cz + Math.sin(aM) * 17;
  const aL = aM + Math.PI + (rnd() - 0.5) * 0.9;
  const lx = cx + Math.cos(aL) * 19, lz = cz + Math.sin(aL) * 19;
  const lakeR = 12.5 + rnd() * 2;
  // channel heads outward from the lake, away from the mountain
  const chA = aL + (rnd() - 0.5) * 0.5;
  const chDx = Math.cos(chA), chDz = Math.sin(chA);

  const top = new Int16Array(SX * SZ).fill(-1);
  const bot = new Int16Array(SX * SZ).fill(-1);
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

      let h = 36 + 4 * n.fbm2(x * 0.022, z * 0.022, 4) + 1.5 * n.fbm2(x * 0.09 + 50, z * 0.09, 2);
      const dm = Math.hypot(x - mx, z - mz);
      h += 21 * Math.exp(-(dm * dm) / (2 * 10.5 * 10.5)) * (0.72 + 0.4 * n.ridge2(x * 0.07, z * 0.07, 3));
      h -= smoothstep(0.72, 1.0, rr) * 8;

      // Lake basin + flattened rim
      const dl = Math.hypot(x - lx, z - lz);
      const lr = lakeR + 1.6 * n.noise2(x * 0.12 + 7, z * 0.12);
      const rimW = smoothstep(lr * 1.8, lr * 1.1, dl);
      h = h * (1 - rimW) + Math.max(h, WL + 1.6 + 1.5 * n.noise2(x * 0.2, z * 0.2)) * rimW;
      let k = 0;
      if (dl < lr) {
        const floor = Math.floor(WL - 1 - 6.5 * (1 - (dl / lr) ** 2) + n.noise2(x * 0.3, z * 0.3));
        lakeFloor[x + z * SX] = floor;
        h = floor;
        k = 1;
      } else if (dl < lr + 2.8 && h < WL + 2.6) {
        k = 2;
      }

      // Waterfall channel
      const px = x - lx, pz = z - lz;
      const t = px * chDx + pz * chDz;
      const perp = Math.abs(-px * chDz + pz * chDx);
      if (k !== 1 && t > lr * 0.5 && perp < 2.3 + t * 0.02) {
        h = Math.min(h, WL - 1);
        k = 3;
      }

      const hi = Math.min(SY - 4, Math.floor(h));
      let b = 30 - Math.pow(Math.max(0, 1 - rr), 0.62) * 27 + 2.5 * n.fbm2(x * 0.09, z * 0.09, 2) - 3 * Math.max(0, n.noise2(x * 0.18, z * 0.18));
      b = Math.max(1, Math.min(hi - 3, Math.floor(b)));
      top[x + z * SX] = hi;
      bot[x + z * SX] = b;
      kind[x + z * SX] = k;
    }
  }

  // Fill columns
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const c = x + z * SX;
      const hi = top[c];
      if (hi < 0) continue;
      const b = bot[c];
      const k = kind[c];
      const dirtDepth = 3 + Math.floor(1.5 + 1.5 * n.noise2(x * 0.1, z * 0.1));
      const gravelPatch = n.noise2(x * 0.11 + 30, z * 0.11) > 0.25 && hi > 41 && hi < 49;
      for (let y = b; y <= hi; y++) {
        const d = hi - y;
        let m: number = M.STONE;
        if (k === 1) m = d < 2 ? M.SAND : d < 3 ? M.GRAVEL : M.STONE;
        else if (k === 2) m = d < 3 ? M.SAND : M.STONE;
        else if (k === 3) m = d < 1 ? M.GRAVEL : M.STONE;
        else if (hi >= 50) m = M.STONE;
        else if (gravelPatch && d < 2) m = M.GRAVEL;
        else if (hi >= 47) m = d === 0 && n.noise2(x * 0.3, z * 0.3) > 0 ? M.GRASS : d < 2 ? M.DIRT : M.STONE;
        else m = d === 0 ? M.GRASS : d < dirtDepth ? M.DIRT : M.STONE;
        if (m === M.STONE && n.fbm3(x * 0.11, y * 0.11, z * 0.11, 2) > 0.43) m = M.METAL;
        if (m === M.STONE && y - b < 2 && n.noise3(x * 0.2, y * 0.2, z * 0.2) > 0.3) m = M.GRAVEL;
        mat[idx(x, y, z)] = m;
      }
      // snow caps
      if (hi >= 50) {
        const depth = hi >= 55 ? 2 : 1;
        for (let y = hi + 1; y <= Math.min(SY - 1, hi + depth); y++) mat[idx(x, y, z)] = M.SNOW;
      }
      // water
      if (k === 1) for (let y = lakeFloor[c] + 1; y <= WL; y++) mat[idx(x, y, z)] = M.WATER;
      if (k === 3 && hi === WL - 1) mat[idx(x, WL, z)] = M.WATER;
    }
  }

  // Spring on the mountain slope between lake and peak
  {
    const steps = 60;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const x = Math.round(lx + (mx - lx) * f), z = Math.round(lz + (mz - lz) * f);
      const hi = top[x + z * SX];
      if (hi >= WL + 7 && hi < 48) {
        // a gentle trickle that runs down into the lake
        mat[idx(x, hi, z)] = M.SPRING;
        world.life[idx(x, hi, z)] = 1;
        break;
      }
    }
  }
  // Main spring at the head of the waterfall channel keeps the falls running
  {
    for (let t = lakeR + 1; t < lakeR + 8; t += 1) {
      const x = Math.round(lx + chDx * t), z = Math.round(lz + chDz * t);
      if (x < 1 || z < 1 || x >= SX - 1 || z >= SZ - 1) break;
      if (kind[x + z * SX] === 3 && top[x + z * SX] === WL - 1) {
        for (const [ox, oz] of [[0, 0], [-Math.round(chDz), Math.round(chDx)], [Math.round(chDz), -Math.round(chDx)]]) {
          const c = x + ox + (z + oz) * SX;
          if (kind[c] === 3 && top[c] === WL - 1) mat[idx(x + ox, WL - 1, z + oz)] = M.SPRING;
        }
        break;
      }
    }
  }

  // Cave: chamber under the mountain with a lava pocket, tunnel climbing out to the cliff
  const ccx = mx + (cx - mx) * 0.15, ccz = mz + (cz - mz) * 0.15, ccy = 21;
  const carve = (px: number, py: number, pz: number, r: number, floorY = -1) => {
    const r2 = r * r;
    for (let y = Math.floor(py - r); y <= py + r; y++) {
      if (y < floorY) continue;
      for (let z = Math.floor(pz - r); z <= pz + r; z++) {
        for (let x = Math.floor(px - r); x <= px + r; x++) {
          if (!inBounds(x, y, z)) continue;
          const d2 = (x - px) ** 2 + ((y - py) * 1.25) ** 2 + (z - pz) ** 2;
          if (d2 <= r2) {
            const i = idx(x, y, z);
            const m = mat[i];
            if (m !== M.WATER && m !== M.SPRING) mat[i] = M.AIR;
          }
        }
      }
    }
  };
  carve(ccx, ccy, ccz, 7, ccy - 4);
  const caveMouth: [number, number, number] = [ccx, ccy, ccz];
  // tunnel
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
      const ci = Math.round(px) + Math.round(pz) * SX;
      if (Math.round(px) < 0 || Math.round(px) >= SX || Math.round(pz) < 0 || Math.round(pz) >= SZ || top[ci] < 0 || bot[ci] > py) {
        if (outside === 0) { caveMouth[0] = px; caveMouth[1] = py; caveMouth[2] = pz; }
        outside++;
      }
    }
  }
  // lava pocket in the chamber floor
  for (let y = ccy - 7; y <= ccy - 4; y++) {
    for (let z = Math.floor(ccz - 6); z <= ccz + 6; z++) {
      for (let x = Math.floor(ccx - 6); x <= ccx + 6; x++) {
        const d = Math.hypot(x - ccx, z - ccz);
        const r = 4.6 - (ccy - 4 - y) * 0.7;
        if (d < r) {
          const i = idx(x, y, z);
          mat[i] = M.LAVA;
          flags[i] = F_SOURCE;
        } else if (d < r + 1.2 && mat[idx(x, y, z)] === M.STONE && rnd() < 0.7) {
          mat[idx(x, y, z)] = M.OBSIDIAN;
        }
      }
    }
  }

  // Trees
  const trees: [number, number][] = [];
  for (let attempt = 0; attempt < 400 && trees.length < 24; attempt++) {
    const x = 4 + Math.floor(rnd() * (SX - 8)), z = 4 + Math.floor(rnd() * (SZ - 8));
    const c = x + z * SX;
    const hi = top[c];
    if (hi < WL + 1 || hi > 49 || kind[c] !== 0) continue;
    if (mat[idx(x, hi, z)] !== M.GRASS) continue;
    if (Math.hypot(x - cx, z - cz) > 40) continue;
    if (Math.hypot(x - lx, z - lz) < lakeR + 4) continue;
    if (trees.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 7)) continue;
    // flat-ish ground only
    let ok = true;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (Math.abs(top[x + ox + (z + oz) * SX] - hi) > 1) ok = false;
    if (!ok) continue;
    trees.push([x, z]);
    const pine = hi > 43 || rnd() < 0.25;
    growTree(world, x, hi + 1, z, pine, rnd, n);
  }

  // Temperatures + flags
  for (let y = 0; y < SY; y++) {
    const amb = world.ambient[y];
    for (let i = y * LAYER; i < (y + 1) * LAYER; i++) {
      const m = mat[i];
      temp[i] = m === M.LAVA ? 1200 : m === M.SNOW ? Math.min(amb, -2) : amb;
    }
  }
  // where the channel leaves the island (for camera framing)
  let fx = lx, fz = lz;
  for (let t = 0; t < 80; t++) {
    const x = Math.round(lx + chDx * t), z = Math.round(lz + chDz * t);
    if (x < 0 || z < 0 || x >= SX || z >= SZ || top[x + z * SX] < 0) break;
    fx = x; fz = z;
  }
  world.markAllDirty();
  return {
    waterfall: [fx, WL, fz],
    cave: caveMouth,
    center: [cx, WL, cz],
    lake: [lx, WL, lz],
    mountain: [mx, 50, mz],
  };
}

function growTree(world: World, x: number, y: number, z: number, pine: boolean, rnd: () => number, n: Noise) {
  const { mat } = world;
  const below = idx(x, y - 1, z);
  if (mat[below] === M.GRASS) mat[below] = M.DIRT;
  const h = pine ? 7 + Math.floor(rnd() * 3) : 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < h; i++) if (y + i < SY) mat[idx(x, y + i, z)] = M.WOOD;
  const putLeaf = (px: number, py: number, pz: number) => {
    if (!inBounds(px, py, pz)) return;
    const i = idx(px, py, pz);
    if (mat[i] === M.AIR) mat[i] = M.LEAVES;
  };
  if (pine) {
    const base = y + 2;
    const tip = y + h + 1;
    for (let py = base; py <= tip; py++) {
      const f = (py - base) / (tip - base);
      const r = (1 - f) * 3.2 + 0.4 + ((py - base) % 2 === 0 ? 0.5 : 0);
      for (let pz = -4; pz <= 4; pz++) for (let px = -4; px <= 4; px++) {
        if (px * px + pz * pz <= r * r) putLeaf(x + px, py, z + pz);
      }
    }
  } else {
    const cy = y + h - 0.5;
    const rx = 2.8 + rnd() * 0.8, ry = 2.3 + rnd() * 0.5;
    for (let py = -3; py <= 4; py++) for (let pz = -4; pz <= 4; pz++) for (let px = -4; px <= 4; px++) {
      const d = (px * px + pz * pz) / (rx * rx) + (py * py) / (ry * ry);
      const wobble = 0.25 * n.noise3((x + px) * 0.5, (cy + py) * 0.5, (z + pz) * 0.5);
      if (d < 1 + wobble) putLeaf(x + px, Math.round(cy + py), z + pz);
    }
    // a couple of branches poking out
    for (let b = 0; b < 2; b++) {
      const a = rnd() * Math.PI * 2;
      const bx = Math.round(Math.cos(a) * 2), bz = Math.round(Math.sin(a) * 2);
      const by = y + h - 2;
      if (inBounds(x + bx, by, z + bz)) mat[idx(x + bx, by, z + bz)] = M.WOOD;
      const hx = Math.round(Math.cos(a)), hz = Math.round(Math.sin(a));
      if (inBounds(x + hx, by, z + hz)) mat[idx(x + hx, by, z + hz)] = M.WOOD;
    }
  }
}

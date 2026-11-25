// Player tools, applied inside the worker so they act on the authoritative grid.

import { LAYER, SX, SY, SZ } from './constants.ts';
import { M, MATERIALS, State, T_MOVABLE, T_STATE } from './materials.ts';
import type { ToolApply } from './protocol.ts';
import type { Simulator } from './simulate.ts';

function forSphere(cx: number, cy: number, cz: number, r: number, fn: (i: number, d: number, x: number, y: number, z: number) => void) {
  const R = Math.ceil(r);
  for (let y = Math.max(0, cy - R); y <= Math.min(SY - 1, cy + R); y++) {
    for (let z = Math.max(0, cz - R); z <= Math.min(SZ - 1, cz + R); z++) {
      for (let x = Math.max(0, cx - R); x <= Math.min(SX - 1, cx + R); x++) {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r * r + 0.25) continue;
        fn(x + z * SX + y * LAYER, Math.sqrt(d2) / Math.max(r, 0.5), x, y, z);
      }
    }
  }
}

export function applyTool(sim: Simulator, a: ToolApply): void {
  const w = sim.w;
  const rng = w.rng;
  const r = a.r;
  switch (a.tool) {
    case 'add': {
      const cx = a.x + a.nx, cy = a.y + a.ny, cz = a.z + a.nz;
      const m = a.mat;
      const isGas = T_STATE[m] === State.GAS;
      // centre the blob so it sits on the surface rather than half inside it
      const off = Math.max(0, r - 1);
      const ox = Math.round(cx + a.nx * off), oy = Math.round(cy + a.ny * off), oz = Math.round(cz + a.nz * off);
      forSphere(ox, oy, oz, r, (i) => {
        const cur = w.mat[i];
        if (cur === M.AIR || (T_STATE[cur] === State.GAS && !isGas)) {
          if (isGas && rng.next() < 0.4) return;
          w.place(i, m);
        }
      });
      break;
    }
    case 'erase':
    case 'dig': {
      forSphere(a.x, a.y, a.z, r, (i) => {
        const m = w.mat[i];
        if (m === M.AIR) return;
        if (a.tool === 'dig') {
          const st = T_STATE[m];
          if (st === State.LIQUID || st === State.GAS) return;
        }
        w.set(i, M.AIR, w.ambient[i >> 14]);
      });
      break;
    }
    case 'heat':
    case 'cool': {
      const heat = a.tool === 'heat';
      forSphere(a.x, a.y, a.z, r + 1, (i, d) => {
        const f = Math.max(0.2, 1 - d * 0.7);
        if (heat) w.temp[i] = Math.min(2600, w.temp[i] + 110 * f);
        else w.temp[i] = Math.max(-150, w.temp[i] - 70 * f);
        const c = (i & 127) >> 4;
        const cz = ((i >> 7) & 127) >> 4;
        const cy = (i >> 14) >> 4;
        const ci = c + cz * 8 + cy * 64;
        w.awake[ci] = 6;
        w.hot[ci] = Math.max(w.hot[ci], 10);
      });
      break;
    }
    case 'explode': {
      w.explosions.push(a.x + 0.5, a.y + 0.5, a.z + 0.5, 3 + r * 1.3);
      break;
    }
    case 'pour': {
      const m = a.mat;
      const st = T_STATE[m];
      const isGas = st === State.GAS;
      const h = isGas ? 1 : Math.min(SY - 2, a.y + 10 + Math.round(r)) - a.y;
      const baseY = a.y + (isGas ? a.ny : h);
      const spread = r + 1;
      const count = Math.max(2, Math.round(r * 2.5));
      for (let k = 0; k < count; k++) {
        const ang = rng.next() * Math.PI * 2;
        const rad = Math.sqrt(rng.next()) * spread;
        const x = Math.round(a.x + Math.cos(ang) * rad), z = Math.round(a.z + Math.sin(ang) * rad);
        const y = Math.min(SY - 1, Math.max(0, baseY + (isGas ? 0 : rng.int(3))));
        if (x < 0 || z < 0 || x >= SX || z >= SZ) continue;
        const i = x + z * SX + y * LAYER;
        if (!T_MOVABLE[w.mat[i]]) continue;
        if (st === State.SOLID) {
          // solids rain down as flying debris and land as blocks
          sim.debris.add(x + 0.5, y + 0.5, z + 0.5, 0, -4 - rng.next() * 4, 0, m, w.defaultTemp(m, y));
        } else if (m === M.FIRE) {
          w.place(i, M.EMBER);
        } else {
          w.place(i, m);
        }
      }
      break;
    }
    case 'inspect':
      break;
  }
}

export function describeCell(sim: Simulator, x: number, y: number, z: number) {
  const w = sim.w;
  if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return null;
  const i = x + z * SX + y * LAYER;
  const m = w.mat[i];
  return { mat: m, temp: w.temp[i], life: w.life[i], name: MATERIALS[m].name };
}

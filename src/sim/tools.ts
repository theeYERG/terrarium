// Player tools (v2): soft brushes. Every application adds or removes a fraction of fill
// with a smooth falloff, so holding the mouse grows and carves rounded shapes gradually.

import { LAYER, SX, SY, SZ } from './constants.ts';
import { GAS_FIRE, GAS_SMOKE, GAS_SPARK, GAS_STEAM } from './gas.ts';
import { M, State, T_STATE } from './materials.ts';
import type { ToolApply } from './protocol.ts';
import type { Simulator } from './simulate.ts';

function falloff(d: number, r: number) {
  // 1 in the middle, smooth down to 0 at r + 0.9
  const t = Math.min(1, Math.max(0, (d - r * 0.55) / (r * 0.45 + 0.9)));
  return 1 - t * t * (3 - 2 * t);
}

function forBall(cx: number, cy: number, cz: number, r: number, fn: (i: number, f: number, x: number, y: number, z: number) => void) {
  const R = Math.ceil(r + 1);
  for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(SY - 1, Math.ceil(cy + R)); y++) {
    for (let z = Math.max(0, Math.floor(cz - R)); z <= Math.min(SZ - 1, Math.ceil(cz + R)); z++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(SX - 1, Math.ceil(cx + R)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
        const f = falloff(d, Math.max(0.6, r));
        if (f <= 0.01) continue;
        fn(x + z * SX + y * LAYER, f, x, y, z);
      }
    }
  }
}

const GAS_OF: Record<number, number> = { [M.FIRE]: GAS_FIRE, [M.SMOKE]: GAS_SMOKE, [M.STEAM]: GAS_STEAM, [M.EMBER]: GAS_SPARK };

export function applyTool(sim: Simulator, a: ToolApply): void {
  const w = sim.w;
  const rng = w.rng;
  const r = a.r;
  const m = a.mat;
  switch (a.tool) {
    case 'add': {
      const off = Math.max(0.6, r * 0.8);
      const cx = a.x + 0.5 + a.nx * off, cy = a.y + 0.5 + a.ny * off, cz = a.z + 0.5 + a.nz * off;
      const gasType = GAS_OF[m];
      if (gasType !== undefined) {
        const count = Math.round(6 + r * 6);
        for (let k = 0; k < count; k++) {
          sim.gas.spawn(gasType, cx + (rng.next() - 0.5) * r * 2, cy + (rng.next() - 0.5) * r, cz + (rng.next() - 0.5) * r * 2);
        }
        if (m === M.FIRE) forBall(cx, cy, cz, r, (i, f) => { w.temp[i] = Math.max(w.temp[i], 300 + 500 * f); w.keepAwake(i); w.markHot(i); });
        break;
      }
      const st = T_STATE[m];
      forBall(cx, cy, cz, r, (i, f) => {
        const cur = w.mat[i];
        if (st === State.LIQUID) {
          const add = 0.35 * f;
          if (cur === M.AIR || T_STATE[cur] === State.GAS) w.place(i, m, 0, add);
          else if (cur === m) { w.mass[i] = Math.min(1.1, w.mass[i] + add); w.wakeLiquid(i); }
          return;
        }
        const add = 255 * 0.42 * f;
        if (cur === M.AIR || T_STATE[cur] === State.GAS) {
          if (add >= 14) w.place(i, m, 0, add);
        } else if (cur === m) {
          w.setFill(i, w.fill[i] + add);
        }
      });
      break;
    }
    case 'erase':
    case 'dig': {
      forBall(a.x + 0.5, a.y + 0.5, a.z + 0.5, r, (i, f) => {
        const cur = w.mat[i];
        if (cur === M.AIR) return;
        const st = T_STATE[cur];
        if (st === State.LIQUID) {
          if (a.tool === 'dig') return;
          w.mass[i] -= 0.45 * f;
          if (w.mass[i] < 0.02) w.set(i, M.AIR); else w.wakeLiquid(i);
          return;
        }
        if (st !== State.SOLID && st !== State.POWDER) return;
        w.setFill(i, w.fill[i] - 255 * 0.45 * f);
      });
      break;
    }
    case 'heat':
    case 'cool': {
      const heat = a.tool === 'heat';
      forBall(a.x + 0.5, a.y + 0.5, a.z + 0.5, r + 1, (i, f) => {
        if (heat) w.temp[i] = Math.min(2600, w.temp[i] + 110 * f);
        else w.temp[i] = Math.max(-150, w.temp[i] - 70 * f);
        w.keepAwake(i);
        w.markHot(i);
      });
      if (heat && rng.next() < 0.4) sim.gas.spawn(GAS_SMOKE, a.x + 0.5, a.y + 1.5, a.z + 0.5, 0, 0.5, 0, 0.8);
      break;
    }
    case 'explode':
      w.explosions.push(a.x + 0.5, a.y + 0.5, a.z + 0.5, 3 + r * 1.3);
      break;
    case 'pour': {
      const st = T_STATE[m];
      const gasType = GAS_OF[m];
      if (gasType !== undefined) {
        for (let k = 0; k < 4 + r * 2; k++) {
          sim.gas.spawn(gasType, a.x + 0.5 + (rng.next() - 0.5) * r * 2, a.y + 1.2, a.z + 0.5 + (rng.next() - 0.5) * r * 2);
        }
        break;
      }
      const top = Math.min(SY - 1.5, a.y + 10 + r);
      const spread = r + 0.5;
      if (st === State.LIQUID) {
        const count = Math.round(3 + r * 3);
        for (let k = 0; k < count; k++) {
          const ang = rng.next() * Math.PI * 2, rad = Math.sqrt(rng.next()) * spread;
          sim.liquids.spawnDrop(m, a.x + 0.5 + Math.cos(ang) * rad, top + rng.next(), a.z + 0.5 + Math.sin(ang) * rad,
            0, -4 - rng.next() * 3, 0, 0.12, w.defaultTemp(m, Math.floor(top)));
        }
      } else {
        const count = Math.max(1, Math.round(r * 0.8));
        for (let k = 0; k < count; k++) {
          const ang = rng.next() * Math.PI * 2, rad = Math.sqrt(rng.next()) * spread;
          sim.pourSolid(a.x + 0.5 + Math.cos(ang) * rad, top + rng.next(), a.z + 0.5 + Math.sin(ang) * rad, m, 200);
        }
      }
      break;
    }
    case 'inspect':
      break;
  }
}

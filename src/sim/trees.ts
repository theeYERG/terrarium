// Trees are separate low poly models now, not voxels. The worker keeps their state:
// standing → burning → burnt, or knocked over into a tumbling physics body.

import { LAYER, SX, SY, SZ } from './constants.ts';
import { GAS_FIRE, GAS_SMOKE, GAS_SPARK, type Gas } from './gas.ts';
import type { TreeSpec } from './generate.ts';
import type { Physics } from './physics.ts';
import { SOLID_FILL, World } from './world.ts';
import { State, T_STATE } from './materials.ts';

export const TREE_STANDING = 0, TREE_BURNING = 1, TREE_BURNT = 2, TREE_FALLEN = 3, TREE_GONE = 4;

export interface TreeState extends TreeSpec {
  state: number;
  burn: number; // 0..1 how much has burned
  onFire: boolean;
  bodyId: number;
}

export class Trees {
  list: TreeState[] = [];
  private w: World;
  private gas: Gas;
  private physics: Physics;
  private tickN = 0;

  constructor(w: World, gas: Gas, physics: Physics) {
    this.w = w;
    this.gas = gas;
    this.physics = physics;
    physics.onTreeSettled = () => {};
  }

  set(specs: TreeSpec[]) {
    this.list = specs.map((s) => ({ ...s, state: TREE_STANDING, burn: 0, onFire: false, bodyId: 0 }));
  }

  restore(list: TreeState[]) {
    this.list = list.map((t) => ({ ...t, state: t.state === TREE_FALLEN ? TREE_GONE : t.state, bodyId: 0 }));
  }

  private tempAt(x: number, y: number, z: number) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= SX || iy >= SY || iz >= SZ) return 20;
    return this.w.temp[ix + iz * SX + iy * LAYER];
  }

  private fall(t: TreeState, ix: number, iy: number, iz: number) {
    t.bodyId = this.physics.spawnTree(t.id, t.x, t.y, t.z, t.h, t.kind, ix, iy, iz);
    t.state = TREE_FALLEN;
  }

  knock(x: number, y: number, z: number, r: number) {
    for (const t of this.list) {
      if (t.state !== TREE_STANDING && t.state !== TREE_BURNING && t.state !== TREE_BURNT) continue;
      const dx = t.x - x, dy = t.y + 1.5 - y, dz = t.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > r * 1.8) continue;
      const p = (1 - d / (r * 1.8)) * 26 + 6;
      const l = Math.hypot(dx, dz) || 1;
      this.fall(t, dx / l * p, p * 0.4, dz / l * p);
      if (d < r) t.onFire = true;
    }
  }

  update(dt: number) {
    const w = this.w;
    this.tickN++;
    for (const t of this.list) {
      if (t.state === TREE_GONE) continue;
      let x = t.x, y = t.y, z = t.z;
      if (t.state === TREE_FALLEN) {
        const b = this.physics.bodies.find((bb) => bb.id === t.bodyId);
        if (!b) { t.state = TREE_GONE; continue; }
        x = b.px; y = b.py; z = b.pz;
      }
      // footing: the ground under a standing tree has to stay solid
      if ((t.state === TREE_STANDING || t.state === TREE_BURNT) && (this.tickN + t.id) % 8 === 0) {
        const ix = Math.floor(x), iy = Math.floor(y - 0.4), iz = Math.floor(z);
        let solid = false;
        if (iy >= 0 && ix >= 0 && iz >= 0 && ix < SX && iz < SZ) {
          for (let yy = iy; yy >= Math.max(0, iy - 1) && !solid; yy--) {
            const i = ix + iz * SX + yy * LAYER;
            const st = T_STATE[w.mat[i]];
            solid = (st === State.SOLID || st === State.POWDER) && w.fill[i] >= SOLID_FILL - 30;
          }
        }
        if (!solid) { this.fall(t, (w.rng.next() - 0.5) * 4, 0, (w.rng.next() - 0.5) * 4); continue; }
      }
      // catching fire from hot air around the crown or trunk
      if (!t.onFire && t.state !== TREE_BURNT && (this.tickN + t.id) % 3 === 0) {
        const hot = Math.max(this.tempAt(x, y + 1, z), this.tempAt(x, y + t.h * 0.6, z), this.tempAt(x + 1, y + t.h * 0.6, z), this.tempAt(x - 1, y + t.h * 0.6, z));
        if (hot > 260) { t.onFire = true; if (t.state === TREE_STANDING) t.state = TREE_BURNING; w.event({ t: 'ignite', x, y: y + t.h * 0.6, z }); }
      }
      if (t.onFire) {
        t.burn = Math.min(1, t.burn + dt / 16);
        const strength = Math.sin(Math.min(1, t.burn) * Math.PI) * 0.8 + 0.2;
        const crownY = t.state === TREE_FALLEN ? y + 0.8 : y + t.h * (t.kind === 1 ? 0.55 : 0.68);
        const spread = t.state === TREE_FALLEN ? t.h * 0.4 : t.h * 0.28;
        const n = w.rng.next() < strength * 0.9 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          this.gas.spawn(GAS_FIRE, x + (w.rng.next() - 0.5) * spread * 2, crownY + (w.rng.next() - 0.5) * spread * 1.4, z + (w.rng.next() - 0.5) * spread * 2, 0, 1.5);
        }
        if (w.rng.next() < 0.25 * strength) this.gas.spawn(GAS_SMOKE, x, crownY + spread, z, 0, 2);
        if (w.rng.next() < 0.03 * strength) this.gas.spawn(GAS_SPARK, x, crownY + spread, z, (w.rng.next() - 0.5) * 4, 1, (w.rng.next() - 0.5) * 4);
        if (t.burn >= 1) {
          t.onFire = false;
          if (t.state === TREE_BURNING) t.state = TREE_BURNT;
        }
      }
    }
  }

  /** id, state, burn, onFire, x, y, z, kind, h, seed — 10 floats per tree */
  pack(): Float32Array {
    const out = new Float32Array(this.list.length * 10);
    let o = 0;
    for (const t of this.list) {
      out[o] = t.id; out[o + 1] = t.state; out[o + 2] = t.burn; out[o + 3] = t.onFire ? 1 : 0;
      out[o + 4] = t.x; out[o + 5] = t.y; out[o + 6] = t.z; out[o + 7] = t.kind; out[o + 8] = t.h; out[o + 9] = t.seed;
      o += 10;
    }
    return out;
  }
}

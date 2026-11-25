// Structural support: after solid voxels disappear, flood-fill the structural voxels
// next to the hole. A connected piece that is small (it never reaches CAP cells) is not
// attached to the island, so it breaks loose and falls as debris.

import { LAYER, SX, SY, SZ, VOLUME } from './constants.ts';
import { M, T_STRUCT } from './materials.ts';
import type { Debris } from './debris.ts';
import { F_SOURCE, type World } from './world.ts';

const CAP = 14000;

export class Structure {
  private visit = new Int32Array(VOLUME);

  private queue = new Int32Array(CAP + 16);
  private comp = 1;
  private w: World;
  private debris: Debris;
  collapsed = 0;

  constructor(w: World, debris: Debris) {
    this.w = w;
    this.debris = debris;
  }

  run(): void {
    const w = this.w;
    const removed = w.removedStruct;
    if (removed.length === 0 && w.newSolids.length === 0) return;
    // A fresh numbering pass: reset ids when they get large.
    if (this.comp > 2e9) {
      this.visit.fill(0);
      this.comp = 1;

    }
    const passStart = this.comp + 1;
    const anchoredIds: boolean[] = [];
    const mat = w.mat;
    const seeds: number[] = [];
    for (const i of removed) {
      if (T_STRUCT[mat[i]]) continue; // refilled
      const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
      if (x > 0) seeds.push(i - 1);
      if (x < SX - 1) seeds.push(i + 1);
      if (z > 0) seeds.push(i - SX);
      if (z < SZ - 1) seeds.push(i + SX);
      if (y > 0) seeds.push(i - LAYER);
      if (y < SY - 1) seeds.push(i + LAYER);
    }
    removed.length = 0;
    for (const i of w.newSolids) seeds.push(i);
    w.newSolids.length = 0;

    let budget = 120000; // max BFS steps per tick
    for (const s of seeds) {
      if (!T_STRUCT[mat[s]]) continue;
      if (this.visit[s] >= passStart) continue;
      if (budget <= 0) break;
      const id = ++this.comp;
      const q = this.queue;
      let head = 0, tail = 0;
      q[tail++] = s;
      this.visit[s] = id;
      let anchored = false;
      while (head < tail) {
        const i = q[head++];
        const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
        // permanent sources (the lava pocket rim etc.) count as bedrock
        if (w.flags[i] & F_SOURCE) { anchored = true; break; }
        for (let k = 0; k < 6; k++) {
          let n: number;
          if (k === 0) { if (x === 0) continue; n = i - 1; }
          else if (k === 1) { if (x === SX - 1) continue; n = i + 1; }
          else if (k === 2) { if (z === 0) continue; n = i - SX; }
          else if (k === 3) { if (z === SZ - 1) continue; n = i + SX; }
          else if (k === 4) { if (y === 0) continue; n = i - LAYER; }
          else { if (y === SY - 1) continue; n = i + LAYER; }
          if (!T_STRUCT[mat[n]]) continue;
          const v = this.visit[n];
          if (v === id) continue;
          if (v >= passStart) {
            // touches a component already classified this pass (it must be anchored,
            // floating components are always explored completely)
            if (anchoredIds[v - passStart]) { anchored = true; break; }
            continue;
          }
          this.visit[n] = id;
          if (tail >= CAP) { anchored = true; break; }
          q[tail++] = n;
        }
        if (anchored) break;
      }
      budget -= tail;
      anchoredIds[id - passStart] = anchored;
      if (!anchored) this.dropComponent(q, tail);
    }
  }

  private dropComponent(q: Int32Array, n: number) {
    const w = this.w;
    if (this.debris.count + n > 12000) return;
    const rng = w.rng;
    // the whole piece starts with the same small push so it falls as one chunk
    const jx = (rng.next() - 0.5) * 1.2, jz = (rng.next() - 0.5) * 1.2;
    for (let k = 0; k < n; k++) {
      const i = q[k];
      const m = w.mat[i];
      const x = i & 127, z = (i >> 7) & 127, y = i >> 14;
      this.debris.add(x + 0.5, y + 0.5, z + 0.5, jx, -1, jz, m === M.GRASS ? M.DIRT : m, w.temp[i]);
      w.mat[i] = M.AIR;
      w.life[i] = 0;
      w.flags[i] = 0;
      w.wake(i);
      w.disturb(i);
    }
    this.collapsed += n;
  }
}

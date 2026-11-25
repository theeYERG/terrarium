// Headless simulation tests (v2): run with `npm run test:sim` (plain Node, no browser).
// Each test builds a small scene, runs ticks, and checks the physics/chemistry.

import { CHUNKS, idx, VOLUME } from '../src/sim/constants.ts';
import { generateIsland } from '../src/sim/generate.ts';
import { M } from '../src/sim/materials.ts';
import { meshChunk } from '../src/sim/mesher.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { Simulator } from '../src/sim/simulate.ts';
import { decodeWorld, encodeWorld } from '../src/sim/snapshot.ts';
import { applyTool } from '../src/sim/tools.ts';
import { TREE_BURNT, TREE_FALLEN } from '../src/sim/trees.ts';
import { World } from '../src/sim/world.ts';

await initPhysics();
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

function fresh() {
  const w = new World();
  w.clear();
  return { w, sim: new Simulator(w) };
}
/** a thick stone slab with an optional top material */
function slab(w: World, y: number, top: number = M.STONE, x0 = 20, x1 = 108, z0 = 20, z1 = 108) {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    for (let yy = y - 3; yy < y; yy++) { const i = idx(x, yy, z); w.mat[i] = M.STONE; w.fill[i] = 255; }
    const i = idx(x, y, z); w.mat[i] = top; w.fill[i] = 255;
  }
  w.markAllDirty();
}
function walls(w: World, y0: number, y1: number, x0: number, x1: number, z0: number, z1: number) {
  for (let y = y0; y <= y1; y++) for (let k = x0; k <= x1; k++) for (const [x, z] of [[k, z0], [k, z1]]) { const i = idx(x, y, z); w.mat[i] = M.STONE; w.fill[i] = 255; }
  for (let y = y0; y <= y1; y++) for (let k = z0; k <= z1; k++) for (const [x, z] of [[x0, k], [x1, k]]) { const i = idx(x, y, z); w.mat[i] = M.STONE; w.fill[i] = 255; }
}
/** keep the physics colliders in sync like the worker does */
function syncColliders(w: World, sim: Simulator) {
  for (let c = 0; c < CHUNKS; c++) if (w.dirty[c] & 1) { w.dirty[c] = 0; sim.physics.setTerrain(c, meshChunk(w, c).collider); }
}
function run(w: World, sim: Simulator, n: number) {
  for (let i = 0; i < n; i++) { if (i % 5 === 0) syncColliders(w, sim); sim.step(); }
}
function liquidMass(w: World, m: number) {
  let s = 0;
  for (let i = 0; i < VOLUME; i++) if (w.mat[i] === m) s += w.mass[i];
  return s;
}
function count(w: World, m: number) {
  let n = 0;
  for (let i = 0; i < VOLUME; i++) if (w.mat[i] === m) n++;
  return n;
}

// 1. Water levels out smoothly in a basin and keeps its mass
{
  const { w, sim } = fresh();
  slab(w, 10);
  walls(w, 11, 16, 40, 60, 40, 60);
  for (let z = 41; z < 47; z++) for (let x = 41; x < 47; x++) for (let y = 11; y < 16; y++) w.place(idx(x, y, z), M.WATER);
  const m0 = liquidMass(w, M.WATER);
  run(w, sim, 500);
  let lo = 99, hi = 0;
  for (let z = 41; z < 60; z++) for (let x = 41; x < 60; x++) {
    let top = 0;
    for (let y = 11; y < 17; y++) { const i = idx(x, y, z); if (w.mat[i] === M.WATER) top = y + w.mass[i]; }
    lo = Math.min(lo, top); hi = Math.max(hi, top);
  }
  const m1 = liquidMass(w, M.WATER);
  check('water spreads out to a flat surface', hi - lo < 0.35, `surface heights ${lo.toFixed(2)} .. ${hi.toFixed(2)}`);
  check('water mass is conserved while it flows', Math.abs(m1 - m0) / m0 < 0.03, `${m0.toFixed(1)} -> ${m1.toFixed(1)}`);
}

// 2. Oil floats on water
{
  const { w, sim } = fresh();
  slab(w, 10);
  walls(w, 11, 22, 50, 56, 50, 56);
  for (let y = 11; y < 13; y++) for (let z = 51; z < 56; z++) for (let x = 51; x < 56; x++) w.place(idx(x, y, z), M.OIL);
  for (let y = 13; y < 16; y++) for (let z = 51; z < 56; z++) for (let x = 51; x < 56; x++) w.place(idx(x, y, z), M.WATER);
  run(w, sim, 400);
  let oy = 0, no = 0, wy = 0, nw = 0;
  for (let y = 11; y < 22; y++) for (let z = 51; z < 56; z++) for (let x = 51; x < 56; x++) {
    const m = w.mat[idx(x, y, z)];
    if (m === M.OIL) { oy += y; no++; }
    if (m === M.WATER) { wy += y; nw++; }
  }
  check('oil floats on top of water', no > 0 && nw > 0 && oy / no > wy / nw + 1, `oil avg y ${(oy / no).toFixed(1)}, water avg y ${(wy / nw).toFixed(1)}`);
}

// 3. Falling water becomes droplets and lands again
{
  const { w, sim } = fresh();
  slab(w, 10);
  for (let z = 60; z < 64; z++) for (let x = 60; x < 64; x++) w.place(idx(x, 30, z), M.WATER);
  const m0 = liquidMass(w, M.WATER);
  sim.step(); sim.step();
  const drops = sim.liquids.n;
  run(w, sim, 120);
  const m1 = liquidMass(w, M.WATER) + Array.from(sim.liquids.pm.subarray(0, sim.liquids.n)).reduce((a, b) => a + b, 0);
  check('unsupported water turns into droplets', drops > 20, `${drops} droplets`);
  check('droplets merge back into a puddle', sim.liquids.n === 0 && liquidMass(w, M.WATER) > m0 * 0.8, `water in cells ${liquidMass(w, M.WATER).toFixed(2)} of ${m0.toFixed(2)} (total ${m1.toFixed(2)})`);
}

// 4. Lava meets water: obsidian + steam
{
  const { w, sim } = fresh();
  slab(w, 10);
  walls(w, 11, 14, 55, 70, 55, 70);
  for (let z = 56; z < 70; z++) for (let x = 56; x < 70; x++) w.place(idx(x, 11, z), M.WATER);
  for (let z = 61; z < 65; z++) for (let x = 61; x < 65; x++) w.place(idx(x, 14, z), M.LAVA);
  let steam = 0;
  for (let t = 0; t < 120; t++) { if (t % 5 === 0) syncColliders(w, sim); sim.step(); steam = Math.max(steam, sim.gas.n); }
  check('lava quenched by water makes obsidian and steam', count(w, M.OBSIDIAN) > 0 && steam > 0, `obsidian ${count(w, M.OBSIDIAN)}, steam particles (max) ${steam}`);
}

// 5. Powders fall as rigid grains and settle back into a pile
{
  const { w, sim } = fresh();
  slab(w, 10);
  syncColliders(w, sim);
  for (let k = 0; k < 40; k++) { sim.pourSolid(64.5 + (k % 3) * 0.2, 25 + k * 0.5, 64.5, M.SAND, 220); }
  let maxBodies = 0;
  for (let t = 0; t < 360; t++) { if (t % 5 === 0) syncColliders(w, sim); sim.step(); maxBodies = Math.max(maxBodies, sim.physics.bodies.length); }
  let fill = 0;
  for (let i = 0; i < VOLUME; i++) if (w.mat[i] === M.SAND) fill += w.fill[i];
  check('poured sand falls as physics grains', maxBodies >= 30, `${maxBodies} bodies in flight`);
  check('grains settle and merge back into the terrain', sim.physics.bodies.length === 0 && fill > 40 * 220 * 0.9, `bodies left ${sim.physics.bodies.length}, sand fill ${fill} of ${40 * 220}`);
}

// 6. Unsupported terrain breaks off as one tumbling rigid chunk and lands
{
  const { w, sim } = fresh();
  slab(w, 10);
  for (let y = 11; y < 20; y++) { const i = idx(64, y, 64); w.mat[i] = M.STONE; w.fill[i] = 255; }
  for (let z = 61; z <= 67; z++) for (let x = 61; x <= 67; x++) { const i = idx(x, 20, z); w.mat[i] = M.STONE; w.fill[i] = 255; }
  w.markAllDirty();
  const stoneAbove = () => { let n = 0; for (let y = 11; y < 40; y++) for (let z = 40; z < 90; z++) for (let x = 40; x < 90; x++) if (w.mat[idx(x, y, z)] === M.STONE) n++; return n; };
  const total0 = stoneAbove();
  syncColliders(w, sim);
  for (let k = 0; k < 4; k++) applyTool(sim, { tool: 'erase', mat: 0, x: 64, y: 13, z: 64, nx: 0, ny: 1, nz: 0, r: 0.6 });
  run(w, sim, 3);
  const chunks = sim.physics.bodies.filter((b) => b.kind === 2).length;
  run(w, sim, 200);
  let high = 0;
  for (let y = 20; y < 40; y++) for (let z = 40; z < 90; z++) for (let x = 40; x < 90; x++) if (w.mat[idx(x, y, z)] === M.STONE) high++;
  const total1 = stoneAbove();
  check('a loose table top falls as one rigid chunk', chunks === 1, `${chunks} chunk bodies`);
  check('the chunk lands and is written back into the grid', sim.physics.bodies.length === 0 && high === 0 && total1 >= total0 - 8, `bodies left ${sim.physics.bodies.length}, stone cells ${total0} -> ${total1}, still up high ${high}`);
}

// 7. Phase changes with heat
{
  const { w, sim } = fresh();
  slab(w, 10, M.METAL);
  w.place(idx(70, 11, 70), M.SAND);
  w.place(idx(40, 11, 40), M.ICE);
  w.markAllDirty();
  // heat just long enough to fuse (much longer and the glass itself melts)
  for (let t = 0; t < 18; t++) { applyTool(sim, { tool: 'heat', mat: 0, x: 70, y: 11, z: 70, nx: 0, ny: 1, nz: 0, r: 0.5 }); sim.step(); }
  run(w, sim, 400);
  check('very hot sand fuses into glass', count(w, M.GLASS) > 0, `glass cells ${count(w, M.GLASS)}`);
  check('ice melts at room temperature', w.mat[idx(40, 11, 40)] !== M.ICE, `cell is now ${w.mat[idx(40, 11, 40)]}`);
}

// 8. Acid eats stone but not glass
{
  const { w, sim } = fresh();
  slab(w, 10, M.STONE, 40, 50, 40, 50);
  slab(w, 10, M.GLASS, 80, 90, 80, 90);
  const s0 = count(w, M.STONE), g0 = count(w, M.GLASS);
  let f0 = 0; for (let i = 0; i < VOLUME; i++) if (w.mat[i] === M.STONE) f0 += w.fill[i];
  for (let z = 43; z < 47; z++) for (let x = 43; x < 47; x++) w.place(idx(x, 11, z), M.ACID);
  for (let z = 83; z < 87; z++) for (let x = 83; x < 87; x++) w.place(idx(x, 11, z), M.ACID);
  run(w, sim, 300);
  let f1 = 0; for (let i = 0; i < VOLUME; i++) if (w.mat[i] === M.STONE) f1 += w.fill[i];
  check('acid dissolves stone but glass resists', f1 < f0 && count(w, M.GLASS) === g0, `stone fill ${f0} -> ${f1}, glass ${g0} -> ${count(w, M.GLASS)} (stone cells ${s0})`);
}

// 9. Gunpowder chain reaction
{
  const { w, sim } = fresh();
  slab(w, 10);
  for (let x = 30; x < 100; x += 2) w.place(idx(x, 11, 64), M.GUNPOWDER);
  const g0 = count(w, M.GUNPOWDER);
  syncColliders(w, sim);
  for (let k = 0; k < 6; k++) { applyTool(sim, { tool: 'heat', mat: 0, x: 30, y: 11, z: 64, nx: 0, ny: 1, nz: 0, r: 1 }); sim.step(); }
  run(w, sim, 300);
  check('a gunpowder trail chain-explodes', count(w, M.GUNPOWDER) < g0 * 0.2, `gunpowder ${g0} -> ${count(w, M.GUNPOWDER)}`);
}

// 10. Soft brushes: dig carves gradually, add grows gradually
{
  const { w, sim } = fresh();
  slab(w, 20);
  const before = w.fill[idx(64, 20, 64)];
  applyTool(sim, { tool: 'dig', mat: 0, x: 64, y: 20, z: 64, nx: 0, ny: 1, nz: 0, r: 2.5 });
  const after1 = w.fill[idx(64, 20, 64)];
  for (let k = 0; k < 4; k++) applyTool(sim, { tool: 'dig', mat: 0, x: 64, y: 20, z: 64, nx: 0, ny: 1, nz: 0, r: 2.5 });
  check('dig removes material gradually, not in one pop', after1 < before && after1 > 0 && w.mat[idx(64, 20, 64)] === M.AIR, `fill ${before} -> ${after1} -> ${w.fill[idx(64, 20, 64)]}`);
  applyTool(sim, { tool: 'add', mat: M.STONE, x: 30, y: 20, z: 30, nx: 0, ny: 1, nz: 0, r: 2.5 });
  const a1 = w.fill[idx(30, 22, 30)];
  applyTool(sim, { tool: 'add', mat: M.STONE, x: 30, y: 20, z: 30, nx: 0, ny: 1, nz: 0, r: 2.5 });
  check('add grows material gradually', a1 > 0 && w.fill[idx(30, 22, 30)] > a1, `fill ${a1} -> ${w.fill[idx(30, 22, 30)]}`);
}

// 11. The island: generation, lake stability, waterfall, trees, performance, snapshots
{
  const w = new World();
  const sim = new Simulator(w);
  const t0 = performance.now();
  const isl = generateIsland(w, 42);
  sim.trees.set(isl.trees);
  const genMs = performance.now() - t0;
  for (let c = 0; c < CHUNKS; c++) sim.physics.setTerrain(c, meshChunk(w, c).collider);
  const water0 = liquidMass(w, M.WATER);
  run(w, sim, 200);
  const t1 = performance.now();
  for (let k = 0; k < 150; k++) sim.step();
  const avg = (performance.now() - t1) / 150;
  const water1 = liquidMass(w, M.WATER);
  check('island generates quickly', genMs < 500, `${genMs.toFixed(0)} ms`);
  check('island has trees and decorations', isl.trees.length >= 15 && isl.decor.length > 200, `${isl.trees.length} trees, ${isl.decor.length} decorations`);
  check('the lake stays full (spring keeps up with the waterfall)', water1 > water0 * 0.9, `water mass ${water0.toFixed(0)} -> ${water1.toFixed(0)}`);
  check('the waterfall streams droplets off the edge', sim.liquids.n > 50, `${sim.liquids.n} droplets in flight`);
  check('steady-state tick fits the 30 Hz budget (< 20 ms)', avg < 20, `${avg.toFixed(2)} ms/tick`);
  const enc = encodeWorld(w, JSON.stringify({ trees: sim.trees.list }));
  const w2 = new World();
  const extra = decodeWorld(w2, enc);
  let same = extra !== null;
  for (let i = 0; i < VOLUME && same; i++) if (w.mat[i] !== w2.mat[i] || w.fill[i] !== w2.fill[i]) same = false;
  check('snapshot round-trips materials, fill and trees', same && JSON.parse(extra!).trees.length === isl.trees.length, `${(enc.length / 1024).toFixed(0)} KB`);
  // blast next to a tree: rocks fly, the tree topples
  const tr = sim.trees.list[0];
  sim.explode(tr.x + 2, tr.y + 1, tr.z, 5);
  const rocks = sim.physics.bodies.filter((b) => b.kind === 1).length;
  check('explosions throw physics rocks and knock trees over', rocks > 10 && tr.state === TREE_FALLEN, `${rocks} rocks, tree state ${tr.state}`);
  // fire
  const tr2 = sim.trees.list.find((t) => t.state === 0)!;
  for (let k = 0; k < 20; k++) { applyTool(sim, { tool: 'heat', mat: 0, x: Math.floor(tr2.x), y: Math.floor(tr2.y) + 2, z: Math.floor(tr2.z), nx: 0, ny: 1, nz: 0, r: 1.5 }); sim.step(); }
  run(w, sim, 600);
  check('a heated tree catches fire and burns down', tr2.state === TREE_BURNT || tr2.burn > 0.9, `state ${tr2.state}, burnt ${(tr2.burn * 100).toFixed(0)}%`);
}

console.log(failed ? `\n${failed} test(s) failed` : '\nAll simulation tests passed');
process.exit(failed ? 1 : 0);

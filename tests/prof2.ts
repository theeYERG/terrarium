// Profile a busy world: lava into the lake, a blast, a burning tree, poured sand.
import { CHUNKS } from '../src/sim/constants.ts';
import { generateIsland } from '../src/sim/generate.ts';
import { M } from '../src/sim/materials.ts';
import { meshChunk } from '../src/sim/mesher.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { Simulator } from '../src/sim/simulate.ts';
import { applyTool } from '../src/sim/tools.ts';
import { World } from '../src/sim/world.ts';
await initPhysics();
const w = new World(); const sim = new Simulator(w);
const isl = generateIsland(w, 20261125); sim.trees.set(isl.trees);
const sync = () => { for (let c = 0; c < CHUNKS; c++) if (w.dirty[c] & 1) { w.dirty[c] = 0; sim.physics.setTerrain(c, meshChunk(w, c).collider); } };
sync();
const [lx, , lz] = isl.lake.map(Math.round);
for (let k = 0; k < 45; k++) { applyTool(sim, { tool: 'pour', mat: M.LAVA, x: lx, y: 34, z: lz, nx: 0, ny: 1, nz: 0, r: 2.5 }); sim.step(); if (k % 5 === 0) sync(); }
sim.explode(60, 38, 60, 6);
const t = sim.trees.list[3];
for (let k = 0; k < 30; k++) { applyTool(sim, { tool: 'heat', mat: 0, x: Math.floor(t.x), y: Math.floor(t.y) + 1, z: Math.floor(t.z), nx: 0, ny: 1, nz: 0, r: 1.5 }); sim.step(); }
for (let k = 0; k < 20; k++) applyTool(sim, { tool: 'pour', mat: M.SAND, x: 70, y: 36, z: 70, nx: 0, ny: 1, nz: 0, r: 3 });
const S = sim as unknown as Record<string, Function>;
const acc: Record<string, number> = {};
const wrap = (obj: Record<string, Function>, name: string, key: string) => { const f = obj[name].bind(obj); obj[name] = (...a: unknown[]) => { const t0 = performance.now(); const r = f(...a); acc[key] = (acc[key] ?? 0) + performance.now() - t0; return r; }; };
for (const n of ['terrainChunk', 'heatChunk', 'randomTicks']) wrap(S, n, n);
wrap(sim.liquids as unknown as Record<string, Function>, 'step', 'liquids');
for (const n of ['vertical', 'flux', 'applyFaces', 'stepDrops']) wrap(sim.liquids as unknown as Record<string, Function>, n, ' liq.' + n);
wrap(sim.gas as unknown as Record<string, Function>, 'step', 'gas');
wrap(sim.physics as unknown as Record<string, Function>, 'step', 'physics');
wrap(sim.structure as unknown as Record<string, Function>, 'run', 'structure');
wrap(sim.trees as unknown as Record<string, Function>, 'update', 'trees');
const N = 90; const t0 = performance.now();
for (let k = 0; k < N; k++) { sim.step(); if (k % 5 === 0) sync(); }
console.log('ms/tick', ((performance.now() - t0) / N).toFixed(1), 'awake', sim.stats.awake, 'heated', sim.stats.heated, 'drops', sim.liquids.n, 'gas', sim.gas.n, 'bodies', sim.physics.bodies.length);
for (const [k, v] of Object.entries(acc).sort((a, b) => b[1] - a[1])) console.log(k.padEnd(16), (v / N).toFixed(2));

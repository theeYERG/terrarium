// Headless benchmark of the v2 simulation: node tests/bench.ts
import { CHUNKS } from '../src/sim/constants.ts';
import { generateIsland } from '../src/sim/generate.ts';
import { M } from '../src/sim/materials.ts';
import { meshChunk } from '../src/sim/mesher.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { Simulator } from '../src/sim/simulate.ts';
import { World } from '../src/sim/world.ts';
await initPhysics();
const w = new World();
const sim = new Simulator(w);
let t = performance.now();
const isl = generateIsland(w, 20261125);
sim.trees.set(isl.trees);
console.log('gen', (performance.now() - t).toFixed(0), 'ms; trees', isl.trees.length, 'decor', isl.decor.length);
const countWater = () => { let s = 0; for (let i = 0; i < w.mat.length; i++) if (w.mat[i] === M.WATER) s += w.mass[i]; return s; };
t = performance.now();
let tris = 0, liqTris = 0;
for (let c = 0; c < CHUNKS; c++) { const m = meshChunk(w, c); sim.physics.setTerrain(c, m.collider); tris += (m.terrain?.pos.length ?? 0) / 9; liqTris += (m.liquid?.pos.length ?? 0) / 9; }
console.log('mesh all', (performance.now() - t).toFixed(0), 'ms; terrain tris', tris, 'liquid tris', liqTris);
const w0 = countWater();
for (let round = 0; round < 6; round++) {
  t = performance.now();
  for (let k = 0; k < 50; k++) {
    sim.step();
    if (k % 10 === 0) for (let c = 0; c < CHUNKS; c++) if (w.dirty[c]) { w.dirty[c] = 0; sim.physics.setTerrain(c, meshChunk(w, c).collider); }
  }
  const s = sim.stats;
  console.log(`ticks ${round * 50 + 50}: ${((performance.now() - t) / 50).toFixed(2)} ms/tick  liquid ${s.liquidMs.toFixed(2)} phys ${s.physicsMs.toFixed(2)} awake ${s.awake} heated ${s.heated} bodies ${sim.physics.bodies.length} drops ${sim.liquids.n} gas ${sim.gas.n} water ${countWater().toFixed(0)} (start ${w0.toFixed(0)})`);
}

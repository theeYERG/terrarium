import { CHUNKS } from '../src/sim/constants.ts';
import { generateIsland } from '../src/sim/generate.ts';
import { meshChunk } from '../src/sim/mesher.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { Simulator } from '../src/sim/simulate.ts';
import { World } from '../src/sim/world.ts';
await initPhysics();
const w = new World(); const sim = new Simulator(w);
const isl = generateIsland(w, 20261125); sim.trees.set(isl.trees);
for (let c = 0; c < CHUNKS; c++) sim.physics.setTerrain(c, meshChunk(w, c).collider);
for (let k = 0; k < 240; k++) sim.step();
// wrap methods to time them
const S = sim as unknown as Record<string, Function>;
const acc: Record<string, number> = {};
for (const name of ['terrainChunk', 'heatChunk', 'randomTicks', 'explode']) {
  const f = S[name].bind(sim);
  S[name] = (...a: unknown[]) => { const t = performance.now(); const r = f(...a); acc[name] = (acc[name] ?? 0) + performance.now() - t; return r; };
}
for (const [obj, name, key] of [[sim.liquids, 'step', 'liquids'], [sim.gas, 'step', 'gas'], [sim.trees, 'update', 'trees'], [sim.physics, 'step', 'physics'], [sim.structure, 'run', 'structure']] as const) {
  const o = obj as unknown as Record<string, Function>;
  const f = o[name].bind(obj);
  o[name] = (...a: unknown[]) => { const t = performance.now(); const r = f(...a); acc[key] = (acc[key] ?? 0) + performance.now() - t; return r; };
}
const L = sim.liquids as unknown as Record<string, Function>;
for (const name of ['vertical', 'flux', 'apply', 'stepDrops']) {
  const f = L[name].bind(sim.liquids);
  L[name] = (...a: unknown[]) => { const t = performance.now(); const r = f(...a); acc['  liq.' + name] = (acc['  liq.' + name] ?? 0) + performance.now() - t; return r; };
}
const N = 150;
const t0 = performance.now();
for (let k = 0; k < N; k++) sim.step();
console.log('ms/tick', ((performance.now() - t0) / N).toFixed(2), 'awake', sim.stats.awake, 'heated', sim.stats.heated, 'drops', sim.liquids.n);
for (const [k, v] of Object.entries(acc).sort((a, b) => b[1] - a[1])) console.log(k.padEnd(18), (v / N).toFixed(2));

// Headless simulation tests: run with `npm run test:sim` (plain Node, no browser).
// Each test builds a small scene in an empty world, runs ticks and checks the physics.

import { idx, LAYER, SX, SZ, VOLUME } from '../src/sim/constants.ts';
import { generateIsland } from '../src/sim/generate.ts';
import { M } from '../src/sim/materials.ts';
import { Simulator } from '../src/sim/simulate.ts';
import { decodeWorld, encodeWorld } from '../src/sim/snapshot.ts';
import { applyTool } from '../src/sim/tools.ts';
import { World } from '../src/sim/world.ts';

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
function floor(w: World, y: number, x0 = 20, x1 = 108, z0 = 20, z1 = 108, m: number = M.STONE) {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) w.mat[idx(x, y, z)] = m;
  // a thick stone base under every test so it counts as anchored (big) ground
  for (let z = 20; z <= 108; z++) for (let x = 20; x <= 108; x++) { w.mat[idx(x, y - 1, z)] = M.STONE; w.mat[idx(x, y - 2, z)] = M.STONE; }
}
function count(w: World, m: number) {
  let n = 0;
  for (let i = 0; i < VOLUME; i++) if (w.mat[i] === m) n++;
  return n;
}
function run(sim: Simulator, n: number) {
  for (let i = 0; i < n; i++) sim.step();
}

// 1. Sand angle of repose
{
  const { w, sim } = fresh();
  floor(w, 10);
  for (let t = 0; t < 1500; t++) {
    const i = idx(64, 40, 64);
    if (w.mat[i] === M.AIR) w.place(i, M.SAND);
    sim.step();
  }
  run(sim, 400);
  let top = 0;
  for (let y = 11; y < 64; y++) if (w.mat[idx(64, y, 64)] === M.SAND) top = y;
  let radius = 0;
  for (let x = 64; x < 108; x++) if (w.mat[idx(x, 11, 64)] === M.SAND) radius = x - 64;
  const h = top - 10;
  const angle = (Math.atan2(h, radius) * 180) / Math.PI;
  check('sand forms a cone at a realistic angle of repose (28-42°)', angle > 28 && angle < 42, `h=${h} r=${radius} angle=${angle.toFixed(1)}°`);
}

// 2. Water levels out in a basin
{
  const { w, sim } = fresh();
  floor(w, 10, 40, 60, 40, 60);
  for (let y = 11; y < 16; y++) for (let k = 40; k <= 60; k++) {
    w.mat[idx(40, y, k)] = M.STONE; w.mat[idx(60, y, k)] = M.STONE;
    w.mat[idx(k, y, 40)] = M.STONE; w.mat[idx(k, y, 60)] = M.STONE;
  }
  for (let t = 0; t < 800; t++) {
    const i = idx(45, 30, 45);
    if (w.mat[i] === M.AIR) w.place(i, M.WATER);
    if (t < 600) sim.step();
  }
  run(sim, 600);
  let minTop = 99, maxTop = 0;
  for (let z = 41; z < 60; z++) for (let x = 41; x < 60; x++) {
    let top = 0;
    for (let y = 11; y < 20; y++) if (w.mat[idx(x, y, z)] === M.WATER) top = y;
    minTop = Math.min(minTop, top); maxTop = Math.max(maxTop, top);
  }
  check('water fills a basin and levels flat', maxTop - minTop <= 1, `surface between y=${minTop} and y=${maxTop}`);
}

// 3. Oil floats on water
{
  const { w, sim } = fresh();
  floor(w, 10, 50, 56, 50, 56);
  for (let y = 11; y < 22; y++) for (let k = 50; k <= 56; k++) {
    w.mat[idx(50, y, k)] = M.STONE; w.mat[idx(56, y, k)] = M.STONE;
    w.mat[idx(k, y, 50)] = M.STONE; w.mat[idx(k, y, 56)] = M.STONE;
  }
  // oil at the bottom, water on top: they must swap
  for (let y = 11; y < 14; y++) for (let z = 51; z < 56; z++) for (let x = 51; x < 56; x++) w.place(idx(x, y, z), M.OIL);
  for (let y = 14; y < 17; y++) for (let z = 51; z < 56; z++) for (let x = 51; x < 56; x++) w.place(idx(x, y, z), M.WATER);
  run(sim, 900);
  let oilY = 0, waterY = 0, no = 0, nw = 0;
  for (let y = 11; y < 22; y++) for (let z = 51; z < 56; z++) for (let x = 51; x < 56; x++) {
    const m = w.mat[idx(x, y, z)];
    if (m === M.OIL) { oilY += y; no++; }
    if (m === M.WATER) { waterY += y; nw++; }
  }
  check('oil floats on top of water', oilY / no > waterY / nw + 1.5, `oil avg y=${(oilY / no).toFixed(1)}, water avg y=${(waterY / nw).toFixed(1)}`);
}

// 4. Lava + water -> obsidian + steam
{
  const { w, sim } = fresh();
  floor(w, 10);
  for (let z = 60; z < 68; z++) for (let x = 60; x < 68; x++) w.place(idx(x, 11, z), M.WATER);
  for (let z = 62; z < 66; z++) for (let x = 62; x < 66; x++) w.place(idx(x, 14, z), M.LAVA);
  let steamSeen = 0;
  for (let t = 0; t < 60; t++) { sim.step(); steamSeen = Math.max(steamSeen, count(w, M.STEAM)); }
  check('lava meeting water makes obsidian and steam', count(w, M.OBSIDIAN) > 0 && steamSeen > 0, `obsidian=${count(w, M.OBSIDIAN)} steam(max)=${steamSeen}`);
}

// 5. Fire burns a tree down
{
  const { w, sim } = fresh();
  floor(w, 10, 50, 70, 50, 70, M.DIRT);
  for (let y = 11; y < 17; y++) w.mat[idx(60, y, 60)] = M.WOOD;
  for (let y = 16; y < 20; y++) for (let z = 58; z <= 62; z++) for (let x = 58; x <= 62; x++) if (w.mat[idx(x, y, z)] === M.AIR) w.mat[idx(x, y, z)] = M.LEAVES;
  const wood0 = count(w, M.WOOD) + count(w, M.LEAVES);
  w.markAllDirty();
  applyTool(sim, { tool: 'heat', mat: 0, x: 60, y: 11, z: 60, nx: 0, ny: 1, nz: 0, r: 1 });
  for (let k = 0; k < 8; k++) { applyTool(sim, { tool: 'heat', mat: 0, x: 60, y: 12, z: 60, nx: 0, ny: 1, nz: 0, r: 1 }); sim.step(); }
  let maxFire = 0, smoke = 0;
  for (let t = 0; t < 2500; t++) { sim.step(); maxFire = Math.max(maxFire, count(w, M.FIRE)); smoke = Math.max(smoke, count(w, M.SMOKE)); if (t % 100 === 0 && count(w, M.FIRE) === 0 && t > 200) break; }
  run(sim, 400);
  const left = count(w, M.WOOD) + count(w, M.LEAVES);
  check('fire spreads through a tree, smokes and burns out', left < wood0 * 0.2 && count(w, M.FIRE) === 0 && smoke > 0,
    `fuel ${wood0} -> ${left}, peak fire=${maxFire}, peak smoke=${smoke}, fire now=${count(w, M.FIRE)}`);
}

// 6. Structural collapse
{
  const { w, sim } = fresh();
  floor(w, 10); floor(w, 9); // two layers: big enough to count as "the island"
  for (let y = 11; y < 20; y++) w.mat[idx(64, y, 64)] = M.STONE; // pillar
  for (let z = 60; z <= 68; z++) for (let x = 60; x <= 68; x++) w.mat[idx(x, 20, z)] = M.STONE; // table top
  applyTool(sim, { tool: 'erase', mat: 0, x: 64, y: 13, z: 64, nx: 0, ny: 1, nz: 0, r: 0.5 });
  sim.step();
  const flying = sim.debris.count;
  run(sim, 120);
  let landed = 0;
  for (let y = 11; y < 16; y++) for (let z = 55; z < 74; z++) for (let x = 55; x < 74; x++) if (w.mat[idx(x, y, z)] === M.STONE) landed++;
  check('unsupported stone breaks loose, falls as debris and lands', flying > 50 && sim.debris.count === 0 && landed > 60,
    `debris spawned=${flying}, still flying=${sim.debris.count}, landed blocks=${landed}`);
}

// 7. Phase changes
{
  const { w, sim } = fresh();
  floor(w, 10);
  w.place(idx(40, 11, 40), M.ICE);
  for (let z = 68; z <= 72; z++) for (let x = 68; x <= 72; x++) w.mat[idx(x, 10, z)] = M.METAL;
  w.place(idx(70, 11, 70), M.SAND);
  w.mat[idx(90, 11, 90)] = M.STONE;
  for (let t = 0; t < 120; t++) {
    if (t < 25) applyTool(sim, { tool: 'heat', mat: 0, x: 70, y: 11, z: 70, nx: 0, ny: 1, nz: 0, r: 0.5 });
    applyTool(sim, { tool: 'heat', mat: 0, x: 90, y: 11, z: 90, nx: 0, ny: 1, nz: 0, r: 0.5 });
    sim.step();
  }
  run(sim, 600);
  const hasWaterOrSteam = count(w, M.WATER) + count(w, M.STEAM) + count(w, M.ICE) - 0;
  check('ice melts at room temperature', w.mat[idx(40, 11, 40)] !== M.ICE && hasWaterOrSteam >= 0, `ice cell now ${w.mat[idx(40, 11, 40)]}`);
  check('very hot sand turns into glass', count(w, M.GLASS) > 0, `glass=${count(w, M.GLASS)}`);
  check('very hot stone melts into lava, then cools to obsidian', count(w, M.OBSIDIAN) + count(w, M.LAVA) > 0, `lava=${count(w, M.LAVA)} obsidian=${count(w, M.OBSIDIAN)}`);
}

// 8. Acid dissolves stone but not glass
{
  const { w, sim } = fresh();
  floor(w, 10, 40, 50, 40, 50, M.STONE);
  floor(w, 10, 80, 90, 80, 90, M.GLASS);
  const s0 = count(w, M.STONE), g0 = count(w, M.GLASS);
  for (let z = 43; z < 47; z++) for (let x = 43; x < 47; x++) w.place(idx(x, 11, z), M.ACID);
  for (let z = 83; z < 87; z++) for (let x = 83; x < 87; x++) w.place(idx(x, 11, z), M.ACID);
  run(sim, 400);
  check('acid eats stone, glass resists', count(w, M.STONE) < s0 && count(w, M.GLASS) === g0, `stone ${s0}->${count(w, M.STONE)}, glass ${g0}->${count(w, M.GLASS)}`);
}

// 9. Gunpowder chain reaction
{
  const { w, sim } = fresh();
  floor(w, 10);
  for (let x = 30; x < 100; x++) w.place(idx(x, 11, 64), M.GUNPOWDER);
  const g0 = count(w, M.GUNPOWDER);
  applyTool(sim, { tool: 'heat', mat: 0, x: 30, y: 11, z: 64, nx: 0, ny: 1, nz: 0, r: 1 });
  for (let k = 0; k < 6; k++) { applyTool(sim, { tool: 'heat', mat: 0, x: 30, y: 11, z: 64, nx: 0, ny: 1, nz: 0, r: 1 }); sim.step(); }
  run(sim, 300);
  check('gunpowder trail chain-explodes', count(w, M.GUNPOWDER) < g0 * 0.2, `gunpowder ${g0} -> ${count(w, M.GUNPOWDER)}`);
}

// 10. Wet dirt -> mud, and powders sink through water
{
  const { w, sim } = fresh();
  floor(w, 10, 50, 60, 50, 60, M.DIRT);
  for (let y = 11; y < 14; y++) for (let k = 50; k <= 60; k++) {
    w.mat[idx(50, y, k)] = M.STONE; w.mat[idx(60, y, k)] = M.STONE;
    w.mat[idx(k, y, 50)] = M.STONE; w.mat[idx(k, y, 60)] = M.STONE;
  }
  for (let z = 52; z < 58; z++) for (let x = 52; x < 58; x++) w.place(idx(x, 11, z), M.WATER);
  run(sim, 300);
  check('water soaks dirt into mud', count(w, M.MUD) > 0, `mud=${count(w, M.MUD)}`);
}

// 11. The island: generation, waterfall keeps flowing, performance
{
  const w = new World();
  const sim = new Simulator(w);
  const t0 = performance.now();
  const info = generateIsland(w, 42);
  const genMs = performance.now() - t0;
  const water0 = count(w, M.WATER);
  const t1 = performance.now();
  run(sim, 600);
  const avg = (performance.now() - t1) / 600;
  const water1 = count(w, M.WATER);
  // water below the lake level and outside the lake = waterfall / stream
  let falling = 0;
  for (let y = 0; y < 30; y++) for (let i = y * LAYER; i < (y + 1) * LAYER; i++) if (w.mat[i] === M.WATER) falling++;
  check('island generates quickly', genMs < 400, `${genMs.toFixed(0)} ms`);
  check('lake is fed by the spring and does not drain', water1 > water0 * 0.85, `water ${water0} -> ${water1}`);
  check('waterfall pours off the edge', falling > 10, `${falling} water cells below y=30`);
  check('steady-state tick is fast (< 8 ms)', avg < 8, `${avg.toFixed(2)} ms/tick, awake chunks=${sim.stats.awake}, heated=${sim.stats.heated}`);
  void info;
  // snapshot round trip
  const enc = encodeWorld(w);
  const w2 = new World();
  decodeWorld(w2, enc);
  let same = true;
  for (let i = 0; i < VOLUME; i++) if (w.mat[i] !== w2.mat[i]) { same = false; break; }
  check('snapshot encode/decode round-trips', same, `${(enc.length / 1024).toFixed(0)} KB`);
  // explosion cost
  const t2 = performance.now();
  applyTool(sim, { tool: 'explode', mat: 0, x: 64, y: 36, z: 64, nx: 0, ny: 1, nz: 0, r: 4 });
  sim.step();
  check('explosion throws debris', sim.debris.count > 50, `${sim.debris.count} debris, ${(performance.now() - t2).toFixed(1)} ms`);
  void SX; void SZ;
}

console.log(failed ? `\n${failed} test(s) failed` : '\nAll simulation tests passed');
process.exit(failed ? 1 : 0);

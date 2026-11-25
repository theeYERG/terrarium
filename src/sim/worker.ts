/// <reference lib="webworker" />
// Simulation worker: owns the world, runs the fixed 30 Hz tick, meshes dirty chunks
// (surface nets), keeps the physics colliders in sync, and streams meshes, rigid bodies,
// droplets, gas particles, trees, events and light clusters to the main thread.

import { BASE_TPS, CHUNKS, CX, CZ, LAYER, SX, SY, SZ } from './constants.ts';
import { GAS_FIRE } from './gas.ts';
import { generateIsland, type DecorSpec } from './generate.ts';
import { M } from './materials.ts';
import { meshChunk, type ChunkMesh } from './mesher.ts';
import { initPhysics } from './physics.ts';
import type { ToMain, ToolApply, ToWorker } from './protocol.ts';
import { Simulator } from './simulate.ts';
import { decodeWorld, encodeWorld } from './snapshot.ts';
import { applyTool } from './tools.ts';
import { TREE_BURNING, type TreeState } from './trees.ts';
import { World } from './world.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const world = new World();
let sim: Simulator | null = null;
let decor: DecorSpec[] = [];

let paused = false;
let speed = 1;
let acc = 0;
let last = performance.now();
let ready = false;
let stepOnce = false;
const tools: ToolApply[] = [];
const undo: Uint8Array[] = [];
const MAX_UNDO = 20;
const pending: ToWorker[] = [];

const lavaCount = new Float32Array(CHUNKS);
const lavaPos = new Float32Array(CHUNKS * 3);

let tickMsAvg = 0, meshMsAvg = 0, liquidMsAvg = 0, physMsAvg = 0, ticksThisSecond = 0, tps = 0, secondStart = performance.now();

function post(msg: ToMain, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function transferables(list: ChunkMesh[]): Transferable[] {
  const t: Transferable[] = [];
  for (const m of list) {
    t.push(m.mats.buffer, m.fills.buffer);
    if (m.terrain) t.push(m.terrain.pos.buffer, m.terrain.nrm.buffer, m.terrain.col.buffer, m.terrain.col0.buffer, m.terrain.tchg.buffer, m.terrain.aux.buffer);
    if (m.liquid) t.push(m.liquid.pos.buffer, m.liquid.nrm.buffer, m.liquid.aux.buffer);
  }
  return t;
}

function record(m: ChunkMesh) {
  lavaCount[m.c] = m.lava;
  lavaPos[m.c * 3] = m.lavaPos[0];
  lavaPos[m.c * 3 + 1] = m.lavaPos[1];
  lavaPos[m.c * 3 + 2] = m.lavaPos[2];
  if (m.hasTerrain) sim!.physics.setTerrain(m.c, m.collider);
  m.collider = null; // stays in the worker
}

function warmUp(ticks: number) {
  for (let k = 0; k < ticks; k++) {
    if (k % 30 === 0) {
      // keep colliders current so settling grains have something to land on
      for (let c = 0; c < CHUNKS; c++) if (world.dirty[c] & 1) { world.dirty[c] = 0; record(meshChunk(world, c)); }
      post({ t: 'progress', p: 0.25 + 0.25 * (k / ticks), label: 'Letting the water settle…' });
    }
    sim!.step();
  }
  world.events.length = 0;
}

function meshAll(label: string) {
  world.dirty.fill(0);
  let batch: ChunkMesh[] = [];
  for (let c = 0; c < CHUNKS; c++) {
    const m = meshChunk(world, c);
    record(m);
    batch.push(m);
    if (batch.length >= 32 || c === CHUNKS - 1) {
      post({ t: 'chunks', list: batch, full: true }, transferables(batch));
      post({ t: 'progress', p: 0.5 + 0.5 * ((c + 1) / CHUNKS), label });
      batch = [];
    }
  }
}

function meshDirty(budgetMs: number) {
  const t0 = performance.now();
  const list: ChunkMesh[] = [];
  const start = (world.tick * 37) % CHUNKS;
  // terrain edits first (that's what the player is looking at), then liquid surfaces
  outer: for (const want of [1, 2]) {
    for (let k = 0; k < CHUNKS; k++) {
      const c = (start + k) % CHUNKS;
      const d = world.dirty[c];
      if (!(d & want)) continue;
      world.dirty[c] = 0;
      const m = meshChunk(world, c, (d & 1) !== 0);
      record(m);
      list.push(m);
      if (performance.now() - t0 > budgetMs) break outer;
    }
  }
  if (list.length) {
    post({ t: 'chunks', list, full: false }, transferables(list));
    meshMsAvg = meshMsAvg * 0.9 + (performance.now() - t0) * 0.1;
  }
}

function lightClusters(): { lights: number[]; fire: number } {
  const s = sim!;
  // bin fire particles per chunk
  const fire = new Float32Array(CHUNKS);
  const fx = new Float32Array(CHUNKS), fy = new Float32Array(CHUNKS), fz = new Float32Array(CHUNKS);
  const g = s.gas;
  let total = 0;
  for (let k = 0; k < g.n; k++) {
    if (g.type[k] !== GAS_FIRE) continue;
    const x = g.x[k], y = g.y[k], z = g.z[k];
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) continue;
    const c = (x >> 4) + (z >> 4) * CX + (y >> 4) * CX * CZ;
    fire[c]++; fx[c] += x; fy[c] += y; fz[c] += z;
    total++;
  }
  const scores: [number, number][] = [];
  for (let c = 0; c < CHUNKS; c++) {
    const sc = lavaCount[c] * 0.3 + fire[c] * 0.9;
    if (sc >= 4) scores.push([sc, c]);
  }
  scores.sort((a, b) => b[0] - a[0]);
  const lights: number[] = [];
  for (let k = 0; k < Math.min(6, scores.length); k++) {
    const c = scores[k][1];
    const f = fire[c];
    if (f > 0 && f * 0.9 >= lavaCount[c] * 0.3) lights.push(fx[c] / f, fy[c] / f + 0.5, fz[c] / f, Math.min(1, scores[k][0] / 60), 1);
    else lights.push(lavaPos[c * 3], lavaPos[c * 3 + 1], lavaPos[c * 3 + 2], Math.min(1, scores[k][0] / 80), 0);
  }
  for (const t of s.trees.list) if (t.state === TREE_BURNING && lights.length < 6 * 5) lights.push(t.x, t.y + t.h * 0.6, t.z, 0.6, 1);
  return { lights, fire: total };
}

function postFrame() {
  const s = sim!;
  const bodies = s.physics.pack();
  const drops = s.liquids.pack();
  const gas = s.gas.pack();
  const trees = s.trees.pack();
  const newChunks = s.physics.newChunks.splice(0, s.physics.newChunks.length);
  const { lights, fire } = lightClusters();
  const events = world.events.splice(0, world.events.length);
  post({
    t: 'frame', tick: world.tick, bodies, drops, gas, trees, newChunks, events, lights, simTime: world.time,
    stats: {
      tps, tickMs: tickMsAvg, meshMs: meshMsAvg, liquidMs: liquidMsAvg, physicsMs: physMsAvg,
      awake: s.stats.awake, heated: s.stats.heated, bodies: s.physics.bodies.length, drops: s.liquids.n,
      gas: s.gas.n, fire, flow: s.liquids.activity,
    },
  }, [bodies.buffer, drops.buffer, gas.buffer, trees.buffer]);
}

function extras() {
  return JSON.stringify({ trees: sim!.trees.list, decor });
}

function restoreExtras(json: string | null) {
  try {
    const e = JSON.parse(json || '{}') as { trees?: TreeState[]; decor?: DecorSpec[] };
    sim!.trees.restore(e.trees ?? []);
    decor = e.decor ?? [];
  } catch {
    sim!.trees.restore([]);
    decor = [];
  }
}

function pushUndo() {
  undo.push(encodeWorld(world, extras()));
  if (undo.length > MAX_UNDO) undo.shift();
  post({ t: 'undoState', depth: undo.length });
}

function flatSlab() {
  world.clear();
  const cx = SX / 2, cz = SZ / 2;
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const d = Math.hypot(x - cx, z - cz);
    if (d > 45) continue;
    const bottom = 30 - (6 + (1 - d / 45) * 10);
    const top = 32.6 - Math.max(0, d - 42) * 0.8;
    for (let y = Math.floor(bottom) - 1; y <= 33; y++) {
      const f = Math.max(0, Math.min(1, 0.5 + Math.min(top - (y + 0.5), (y + 0.5) - bottom)));
      if (f < 0.06) continue;
      const i = x + z * SX + y * LAYER;
      world.mat[i] = y >= 32 ? M.GRASS : y >= 30 ? M.DIRT : M.STONE;
      world.fill[i] = Math.round(f * 255);
    }
  }
  world.markAllDirty();
  sim!.trees.set([]);
  decor = [];
}

function resetAfterJump() {
  sim!.resetDynamics();
  world.dirty.fill(3);
}

let frameCounter = 0;
function loop() {
  const t0 = performance.now();
  const dt = t0 - last;
  last = t0;
  if (ready && sim) {
    const changed = tools.length > 0;
    while (tools.length) applyTool(sim, tools.shift()!);
    if (!paused) acc = Math.min(3, acc + (dt / 1000) * BASE_TPS * speed);
    let ticks = 0;
    while ((acc >= 1 && ticks < 3) || stepOnce) {
      sim.step();
      tickMsAvg = tickMsAvg * 0.9 + sim.stats.tickMs * 0.1;
      liquidMsAvg = liquidMsAvg * 0.9 + sim.stats.liquidMs * 0.1;
      physMsAvg = physMsAvg * 0.9 + sim.stats.physicsMs * 0.1;
      if (!stepOnce) acc -= 1;
      stepOnce = false;
      ticks++;
      ticksThisSecond++;
      if (performance.now() - t0 > 28) { acc = Math.min(acc, 1); break; }
    }
    if (t0 - secondStart >= 1000) {
      tps = (ticksThisSecond * 1000) / (t0 - secondStart);
      ticksThisSecond = 0;
      secondStart = t0;
    }
    if (ticks > 0 || changed) meshDirty(Math.max(7, 22 - (performance.now() - t0)));
    frameCounter++;
    if (ticks > 0 || changed || frameCounter % 6 === 0) postFrame();
  }
  const elapsed = performance.now() - t0;
  setTimeout(loop, Math.max(1, 15 - elapsed));
}

function handle(msg: ToWorker) {
  const s = sim!;
  switch (msg.t) {
    case 'init': {
      post({ t: 'progress', p: 0.08, label: 'Raising the island…' });
      let restored = msg.save ? decodeWorld(world, msg.save) : null;
      let info = null;
      if (restored !== null) restoreExtras(restored);
      else {
        const isl = generateIsland(world, msg.seed);
        s.trees.set(isl.trees);
        decor = isl.decor;
        info = isl;
        warmUp(240);
        restored = null;
      }
      post({ t: 'progress', p: 0.5, label: 'Shaping the terrain…' });
      meshAll('Shaping the terrain…');
      ready = true;
      post({ t: 'ready', seed: world.seed, info: info ? strip(info) : null, decor });
      break;
    }
    case 'regen': {
      pushUndo();
      s.resetDynamics();
      const isl = generateIsland(world, msg.seed);
      s.trees.set(isl.trees);
      decor = isl.decor;
      warmUp(240);
      meshAll('Regenerating…');
      post({ t: 'ready', seed: world.seed, info: strip(isl), decor });
      break;
    }
    case 'clear':
      pushUndo();
      s.resetDynamics();
      flatSlab();
      post({ t: 'ready', seed: world.seed, info: null, decor });
      break;
    case 'tool':
      tools.push(msg.a);
      break;
    case 'snapshot':
      pushUndo();
      break;
    case 'undo': {
      const snap = undo.pop();
      if (snap) {
        restoreExtras(decodeWorld(world, snap));
        resetAfterJump();
        post({ t: 'ready', seed: world.seed, info: null, decor });
        post({ t: 'toast', text: `Undo (${undo.length} left)` });
      } else post({ t: 'toast', text: 'Nothing to undo' });
      post({ t: 'undoState', depth: undo.length });
      break;
    }
    case 'pause': paused = msg.v; break;
    case 'speed': speed = msg.v; break;
    case 'step': stepOnce = true; break;
    case 'inspect': {
      const { x, y, z } = msg;
      if (x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ) {
        const i = x + z * SX + y * LAYER;
        post({ t: 'inspect', mat: world.mat[i], temp: world.temp[i], life: world.life[i], x, y, z, amount: world.mat[i] === M.AIR ? 0 : (world.fill[i] / 255 || world.mass[i]) });
      }
      break;
    }
    case 'save': {
      const data = encodeWorld(world, extras());
      post({ t: 'saved', data }, [data.buffer]);
      break;
    }
    case 'load': {
      pushUndo();
      const ex = decodeWorld(world, msg.data);
      if (ex === null) post({ t: 'toast', text: 'Save file is damaged' });
      else { restoreExtras(ex); resetAfterJump(); post({ t: 'ready', seed: world.seed, info: null, decor }); }
      break;
    }
    case 'bench': {
      const t = performance.now();
      for (let k = 0; k < msg.ticks; k++) s.step();
      post({ t: 'toast', text: `bench ${msg.ticks} ticks: ${((performance.now() - t) / msg.ticks).toFixed(2)} ms/tick` });
      break;
    }
  }
}

function strip(i: { center: number[]; lake: number[]; mountain: number[]; waterfall: number[]; cave: number[] }) {
  return { center: i.center, lake: i.lake, mountain: i.mountain, waterfall: i.waterfall, cave: i.cave };
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  if (!sim) pending.push(ev.data);
  else handle(ev.data);
};

initPhysics().then(() => {
  sim = new Simulator(world);
  for (const m of pending.splice(0)) handle(m);
  loop();
});

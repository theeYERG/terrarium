/// <reference lib="webworker" />
// Simulation worker: owns the world, runs the fixed-rate tick loop, meshes dirty chunks
// and streams meshes, debris, gases, events and light clusters to the main thread.

import { BASE_TPS, CHUNKS, CS, CX, CZ, LAYER, SX, SY, SZ } from './constants.ts';
import { generateIsland } from './generate.ts';
import { M, MATERIALS } from './materials.ts';
import { meshChunk, type ChunkMesh } from './mesher.ts';
import type { ToMain, ToolApply, ToWorker } from './protocol.ts';
import { Simulator } from './simulate.ts';
import { decodeWorld, encodeWorld } from './snapshot.ts';
import { applyTool } from './tools.ts';
import { World } from './world.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const world = new World();
const sim = new Simulator(world);

let paused = false;
let speed = 1;
let acc = 0;
let last = performance.now();
let ready = false;
let stepOnce = false;
const tools: ToolApply[] = [];
const undo: Uint8Array[] = [];
const MAX_UNDO = 20;

const lavaCount = new Float32Array(CHUNKS);
const lavaPos = new Float32Array(CHUNKS * 3);

// rolling stats
let tickMsAvg = 0, meshMsAvg = 0, ticksThisSecond = 0, tps = 0, secondStart = performance.now();

function post(msg: ToMain, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function transferables(list: ChunkMesh[]): Transferable[] {
  const t: Transferable[] = [];
  for (const m of list) {
    t.push(m.mats.buffer);
    for (const b of [m.opaque, m.trans]) {
      if (!b) continue;
      t.push(b.pos.buffer, b.nrm.buffer, b.data.buffer, b.idx.buffer);
    }
  }
  return t;
}

function recordMesh(m: ChunkMesh) {
  lavaCount[m.c] = m.lava;
  lavaPos[m.c * 3] = m.lavaPos[0];
  lavaPos[m.c * 3 + 1] = m.lavaPos[1];
  lavaPos[m.c * 3 + 2] = m.lavaPos[2];
}

function meshAll(label: string) {
  world.dirty.fill(0);
  let batch: ChunkMesh[] = [];
  for (let c = 0; c < CHUNKS; c++) {
    const m = meshChunk(world, c);
    recordMesh(m);
    batch.push(m);
    if (batch.length >= 32 || c === CHUNKS - 1) {
      post({ t: 'chunks', list: batch, full: true }, transferables(batch));
      post({ t: 'progress', p: 0.4 + 0.6 * ((c + 1) / CHUNKS), label });
      batch = [];
    }
  }
}

function meshDirty(budgetMs: number) {
  const t0 = performance.now();
  const list: ChunkMesh[] = [];
  // start at a rotating offset so a busy area can't starve the rest
  const start = (world.tick * 37) % CHUNKS;
  for (let k = 0; k < CHUNKS; k++) {
    const c = (start + k) % CHUNKS;
    if (!world.dirty[c]) continue;
    world.dirty[c] = 0;
    const m = meshChunk(world, c);
    recordMesh(m);
    list.push(m);
    if (performance.now() - t0 > budgetMs) break;
  }
  if (list.length) {
    post({ t: 'chunks', list, full: false }, transferables(list));
    const dt = performance.now() - t0;
    meshMsAvg = meshMsAvg * 0.9 + dt * 0.1;
  }
}

function gasList(): Float32Array {
  const out: number[] = [];
  const mat = world.mat, life = world.life;
  for (let c = 0; c < CHUNKS; c++) {
    if (!world.awake[c]) continue;
    const ox = (c % CX) * CS, oz = (Math.floor(c / CX) % CZ) * CS, oy = Math.floor(c / (CX * CZ)) * CS;
    for (let y = oy; y < oy + CS; y++) {
      for (let z = oz; z < oz + CS; z++) {
        const row = z * SX + y * LAYER;
        for (let x = ox; x < ox + CS; x++) {
          const m = mat[row + x];
          if (m !== M.FIRE && m !== M.SMOKE && m !== M.STEAM) continue;
          const kind = m === M.FIRE ? 0 : m === M.SMOKE ? 1 : 2;
          const maxLife = m === M.FIRE ? 30 : MATERIALS[m].life[1];
          const l = Math.min(0.999, life[row + x] / maxLife);
          out.push(x + 0.5, y + 0.5, z + 0.5, kind + l);
          if (out.length >= 24000 * 4) return new Float32Array(out);
        }
      }
    }
  }
  return new Float32Array(out);
}

function lightClusters(): { lights: number[]; fire: number } {
  const scores: [number, number][] = [];
  let fireTotal = 0;
  for (let c = 0; c < CHUNKS; c++) {
    const f = sim.fireCount[c];
    fireTotal += f;
    const s = lavaCount[c] * 0.3 + f * 1.5;
    if (s >= 4) scores.push([s, c]);
  }
  scores.sort((a, b) => b[0] - a[0]);
  const lights: number[] = [];
  for (let k = 0; k < Math.min(6, scores.length); k++) {
    const c = scores[k][1];
    const f = sim.fireCount[c], l = lavaCount[c];
    let x: number, y: number, z: number;
    if (f > 0 && (f * 1.5 > l * 0.3 || l === 0)) {
      x = sim.fireSum[c * 3] / f + 0.5; y = sim.fireSum[c * 3 + 1] / f + 1; z = sim.fireSum[c * 3 + 2] / f + 0.5;
    } else {
      x = lavaPos[c * 3]; y = lavaPos[c * 3 + 1]; z = lavaPos[c * 3 + 2];
    }
    lights.push(x, y, z, Math.min(1, scores[k][0] / 80), f > 0 ? 1 : 0);
  }
  return { lights, fire: fireTotal };
}

function postFrame() {
  const debris = sim.debris.pack();
  const gas = gasList();
  const { lights, fire } = lightClusters();
  const events = world.events.splice(0, world.events.length);
  post({
    t: 'frame', debris, gas, events, lights,
    stats: {
      tps, tickMs: tickMsAvg, meshMs: meshMsAvg, awake: sim.stats.awake, heated: sim.stats.heated,
      debris: sim.debris.count, fire, water: 0,
    },
  }, [debris.buffer, gas.buffer]);
}

function pushUndo() {
  undo.push(encodeWorld(world));
  if (undo.length > MAX_UNDO) undo.shift();
  post({ t: 'undoState', depth: undo.length });
}

function flatSlab() {
  world.clear();
  const cx = SX / 2, cz = SZ / 2;
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const d = Math.hypot(x - cx, z - cz);
    if (d > 44) continue;
    const depth = Math.round(6 + (1 - d / 44) * 10);
    for (let y = 30 - depth; y <= 32; y++) {
      const m = y === 32 ? M.GRASS : y >= 30 ? M.DIRT : M.STONE;
      world.mat[x + z * SX + y * LAYER] = m;
    }
  }
  world.markAllDirty();
}

let frameCounter = 0;
function loop() {
  const t0 = performance.now();
  const dt = t0 - last;
  last = t0;
  if (ready) {
    let changed = tools.length > 0;
    while (tools.length) applyTool(sim, tools.shift()!);
    if (!paused) acc = Math.min(4, acc + (dt / 1000) * BASE_TPS * speed);
    let ticks = 0;
    while ((acc >= 1 && ticks < 4) || stepOnce) {
      sim.step();
      tickMsAvg = tickMsAvg * 0.9 + sim.stats.tickMs * 0.1;
      if (!stepOnce) acc -= 1;
      stepOnce = false;
      ticks++;
      ticksThisSecond++;
      // don't let a slow tick starve meshing
      if (performance.now() - t0 > 30) { acc = Math.min(acc, 1); break; }
    }
    if (t0 - secondStart >= 1000) {
      tps = (ticksThisSecond * 1000) / (t0 - secondStart);
      ticksThisSecond = 0;
      secondStart = t0;
    }
    meshDirty(Math.max(4, 22 - (performance.now() - t0)));
    frameCounter++;
    if (ticks > 0 || changed || frameCounter % 6 === 0) postFrame();
  }
  const elapsed = performance.now() - t0;
  setTimeout(loop, Math.max(1, 16 - elapsed));
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.t) {
    case 'init': {
      let ok = false;
      post({ t: 'progress', p: 0.05, label: 'Raising the island…' });
      if (msg.save) ok = decodeWorld(world, msg.save);
      let info = null;
      if (!ok) info = generateIsland(world, msg.seed);
      post({ t: 'progress', p: 0.4, label: 'Carving voxels…' });
      meshAll('Carving voxels…');
      ready = true;
      post({ t: 'ready', seed: world.seed, info });
      break;
    }
    case 'regen': {
      pushUndo();
      sim.debris.clear();
      const info = generateIsland(world, msg.seed);
      meshAll('Regenerating…');
      post({ t: 'ready', seed: world.seed, info });
      break;
    }
    case 'clear': {
      pushUndo();
      sim.debris.clear();
      flatSlab();
      break;
    }
    case 'tool':
      tools.push(msg.a);
      break;
    case 'snapshot':
      pushUndo();
      break;
    case 'undo': {
      const snap = undo.pop();
      if (snap) {
        sim.debris.clear();
        decodeWorld(world, snap);
        post({ t: 'toast', text: `Undo (${undo.length} left)` });
      } else post({ t: 'toast', text: 'Nothing to undo' });
      post({ t: 'undoState', depth: undo.length });
      break;
    }
    case 'pause':
      paused = msg.v;
      break;
    case 'speed':
      speed = msg.v;
      break;
    case 'step':
      stepOnce = true;
      break;
    case 'inspect': {
      const { x, y, z } = msg;
      if (x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ) {
        const i = x + z * SX + y * LAYER;
        post({ t: 'inspect', mat: world.mat[i], temp: world.temp[i], life: world.life[i], x, y, z });
      }
      break;
    }
    case 'save': {
      const data = encodeWorld(world);
      post({ t: 'saved', data }, [data.buffer]);
      break;
    }
    case 'load': {
      pushUndo();
      sim.debris.clear();
      if (!decodeWorld(world, msg.data)) post({ t: 'toast', text: 'Save file is damaged' });
      break;
    }
    case 'bench': {
      const t = performance.now();
      for (let k = 0; k < msg.ticks; k++) sim.step();
      post({ t: 'toast', text: `bench ${msg.ticks} ticks: ${((performance.now() - t) / msg.ticks).toFixed(2)} ms/tick` });
      break;
    }
  }
};

loop();

// Terrarium – entry point. Wires the simulation worker, renderer, camera, input, UI and audio.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Sound } from './audio/sound.ts';
import { CameraRig } from './camera.ts';
import { brushRadius, ToolInput, type ToolState } from './input.ts';
import { BrushPreview } from './render/brush.ts';
import { sharedUniforms } from './render/chunkMaterial.ts';
import { ChunkManager } from './render/chunks.ts';
import { DebrisRenderer, GasRenderer, GlowLights, Particles } from './render/effects.ts';
import { PostFX } from './render/post.ts';
import { SkyRig } from './render/sky.ts';
import { M, MATERIALS, State, T_STATE } from './sim/materials.ts';
import type { ToMain, ToolApply, ToolName, ToWorker } from './sim/protocol.ts';
import { LOGO, UI } from './ui/ui.ts';
import './ui/styles.css';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const SAVE_KEY = 'terrarium-save-v1';
const DEFAULT_SEED = 20261125;

// ───────────────────────────── renderer + scene ─────────────────────────────
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
const maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
let pixelRatio = maxPixelRatio;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const chunks = new ChunkManager();
scene.add(chunks.group);
const center = new THREE.Vector3(64, 30, 64);
const sky = new SkyRig(scene, center);
const gas = new GasRenderer(scene);
const particles = new Particles(scene);
const debris = new DebrisRenderer(scene);
const glow = new GlowLights(scene);
const brush = new BrushPreview(scene);

const solidAt = (x: number, y: number, z: number) => {
  const m = chunks.matAt(x, y, z);
  const st = T_STATE[m];
  return st === State.SOLID || st === State.POWDER;
};
const rig = new CameraRig(canvas, solidAt);
const post = new PostFX(renderer, scene, rig.camera);

// ───────────────────────────── worker ─────────────────────────────
const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);

// ───────────────────────────── state ─────────────────────────────
const state: ToolState = { tool: 'add', mat: M.SAND, brush: 3 };
let paused = false;
let speedIdx = 2;
let showFps = false;
let seed = DEFAULT_SEED;
let started = false;
let worldReady = false;
let undoDepth = 0;
let islandInfo: { center: number[]; lake: number[]; mountain: number[]; waterfall: number[] } | null = null;
let framedOnce = false;

/** Put the camera on the lake side so the waterfall and the peak are both in view. */
function frameIsland() {
  if (!islandInfo) return;
  const [lx, , lz] = islandInfo.lake;
  const dir = new THREE.Vector3(lx - 64, 0, lz - 64).normalize();
  // swing a bit to the side so the lake isn't hidden behind its own rim
  dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.55);
  rig.controls.target.set(64, 30, 64);
  rig.camera.position.set(64 + dir.x * 150, 30 + 78, 64 + dir.z * 150);
  rig.controls.update();
}
const sound = new Sound();
const stats = { tps: 0, tickMs: 0, meshMs: 0, awake: 0, heated: 0, debris: 0, fire: 0, water: 0 };
let inspectInfo: { mat: number; temp: number; x: number; y: number; z: number } | null = null;
let lastInspectSend = 0;
let screenX = 0, screenY = 0;
let wantShot = false;

const ui = new UI({
  setTool(t) { state.tool = t; ui.showTool(t); sound.click(); },
  setMat(m) {
    state.mat = m;
    ui.showMat(m);
    if (state.tool !== 'add' && state.tool !== 'pour') { state.tool = 'add'; ui.showTool('add'); }
    sound.click();
  },
  brush(d) { state.brush = Math.max(1, Math.min(9, state.brush + d)); ui.showBrush(state.brush); },
  togglePause() {
    paused = !paused;
    send({ t: 'pause', v: paused });
    ui.showPaused(paused);
    ui.toast(paused ? 'Paused' : 'Running');
  },
  cycleSpeed(dir) {
    speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, speedIdx + dir));
    send({ t: 'speed', v: SPEEDS[speedIdx] });
    ui.showSpeed(SPEEDS[speedIdx]);
  },
  step() { if (!paused) this.togglePause(); send({ t: 'step' }); },
  undo() { send({ t: 'undo' }); },
  regen(s) {
    seed = s ?? Math.floor(Math.random() * 1e9);
    ui.setSeed(seed);
    ui.toast(`Raising island ${seed}…`);
    send({ t: 'regen', seed });
  },
  clear() { send({ t: 'clear' }); ui.toast('Cleared to a flat slab (Ctrl+Z to undo)'); },
  save() { send({ t: 'save' }); },
  load() {
    const s = localStorage.getItem(SAVE_KEY);
    if (!s) { ui.toast('No saved world yet'); return; }
    const data = base64ToBytes(s);
    send({ t: 'load', data }, [data.buffer]);
    ui.toast('World loaded');
  },
  screenshot() { wantShot = true; },
  cinematic() {
    rig.setCinematic(!rig.cinematic);
    ui.showCinematic(rig.cinematic);
    if (rig.cinematic) ui.toast('Cinematic camera · press V or Esc to exit');
  },
  toggleFps() { showFps = !showFps; ui.showFps(showFps); },
  toggleMute() {
    sound.start();
    sound.setMuted(!sound.muted);
    ui.showMuted(sound.muted);
    ui.toast(sound.muted ? 'Sound off' : 'Sound on');
  },
  setTiltShift(on) { post.tiltShift = on; },
  setDayCycle(on) { sky.running = on; },
  setTime(t) { sky.time = t; },
  setDayLength(s) { sky.dayLength = s; },
  setBloom(on) { post.bloom.enabled = on; },
  setShadows(on) { sky.sun.castShadow = on; },
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && rig.cinematic) { rig.setCinematic(false); ui.showCinematic(false); }
});

ui.showTool(state.tool);
ui.showMat(state.mat);
ui.showBrush(state.brush);
ui.showPaused(false);
ui.showSpeed(1);
ui.showMuted(sound.muted);
ui.setSeed(seed);
document.getElementById('title-logo')!.innerHTML = LOGO;

// ───────────────────────────── input ─────────────────────────────
const input = new ToolInput(canvas, rig, chunks.mats, state);
input.onStrokeStart = () => {
  if (state.tool !== 'inspect') send({ t: 'snapshot' });
};
input.onApply = (a: ToolApply) => {
  send({ t: 'tool', a });
  feedback(a);
};
input.onBrushChange = (d) => { state.brush = Math.max(1, Math.min(9, state.brush + d)); ui.showBrush(state.brush); };
canvas.addEventListener('pointerdown', () => sound.start());
canvas.addEventListener('pointermove', (e) => { screenX = e.clientX; screenY = e.clientY; });

function feedback(a: ToolApply) {
  const st = T_STATE[a.mat];
  switch (a.tool) {
    case 'add': sound.place(st === State.LIQUID); break;
    case 'erase': case 'dig': {
      sound.dig();
      const m = chunks.matAt(a.x, a.y, a.z);
      if (m && Math.random() < 0.6) particles.dust(a.x + 0.5, a.y + 0.5, a.z + 0.5, m);
      break;
    }
    case 'heat': sound.heat(); break;
    case 'cool': sound.cool(); break;
    case 'pour': if (st === State.LIQUID) sound.place(true); break;
  }
}

// ───────────────────────────── worker messages ─────────────────────────────
const loadBar = document.getElementById('load-bar') as HTMLElement;
const loadLabel = document.getElementById('load-label') as HTMLElement;
const enterBtn = document.getElementById('enter') as HTMLButtonElement;

worker.onmessage = (ev: MessageEvent<ToMain>) => {
  const msg = ev.data;
  switch (msg.t) {
    case 'progress':
      if (!started) {
        loadBar.style.width = `${Math.round(msg.p * 100)}%`;
        loadLabel.textContent = msg.label;
      }
      break;
    case 'ready':
      worldReady = true;
      seed = msg.seed;
      if (msg.info) islandInfo = msg.info;
      if (!framedOnce) { frameIsland(); framedOnce = true; }
      ui.setSeed(seed);
      if (!started) {
        loadBar.style.width = '100%';
        loadLabel.textContent = 'Ready';
        enterBtn.classList.add('ready');
      } else {
        ui.toast('New island ready');
      }
      break;
    case 'chunks':
      chunks.receive(msg.list);
      if (msg.full) chunks.flush(0, true);
      break;
    case 'frame':
      debris.set(msg.debris);
      gas.set(msg.gas);
      glow.set(msg.lights);
      Object.assign(stats, msg.stats);
      for (const e of msg.events) handleEvent(e);
      break;
    case 'inspect':
      inspectInfo = msg;
      break;
    case 'saved': {
      try {
        localStorage.setItem(SAVE_KEY, bytesToBase64(msg.data));
        ui.toast(`Saved (${(msg.data.length / 1024).toFixed(0)} KB)`);
      } catch {
        ui.toast('Could not save: browser storage is full');
      }
      break;
    }
    case 'undoState':
      undoDepth = msg.depth;
      ui.showUndo(undoDepth);
      break;
    case 'toast':
      ui.toast(msg.text);
      break;
  }
};

let boomBudget = 0;
function handleEvent(e: { t: string; x: number; y: number; z: number; r?: number }) {
  const d = rig.camera.position.distanceTo(new THREE.Vector3(e.x, e.y, e.z));
  if (e.t === 'boom') {
    const r = e.r ?? 3;
    if (boomBudget < 6) {
      particles.explosion(e.x, e.y, e.z, r);
      boomBudget++;
    }
    rig.addShake(Math.min(1.6, (r / 4) * (120 / Math.max(40, d))));
    sound.boom(r, d);
  } else if (e.t === 'sizzle') {
    particles.sizzle(e.x, e.y, e.z);
    sound.sizzle();
  } else if (e.t === 'splash') {
    particles.splash(e.x, e.y, e.z);
    sound.splash();
  }
}

enterBtn.addEventListener('click', () => {
  if (!worldReady) return;
  started = true;
  sound.start();
  document.getElementById('title')!.classList.add('gone');
  document.getElementById('hud')!.classList.remove('hidden');
  setTimeout(() => ui.toast('Right-drag to orbit · left-click to build · press ? for controls'), 700);
});

// ───────────────────────────── boot ─────────────────────────────
const urlSeed = new URLSearchParams(location.search).get('seed');
if (urlSeed && /^\d+$/.test(urlSeed)) seed = parseInt(urlSeed, 10);
send({ t: 'init', seed });

// ───────────────────────────── resize ─────────────────────────────
function resize() {
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
  post.setSize(innerWidth, innerHeight);
  rig.resize(innerWidth, innerHeight);
  const scale = (innerHeight * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(rig.camera.fov / 2)));
  gas.uniforms.uScale.value = scale;
  particles.uniforms.uScale.value = scale;
}
window.addEventListener('resize', resize);
resize();

// ───────────────────────────── frame loop ─────────────────────────────
let lastFrame = performance.now();
let elapsed = 0;
let fpsFrames = 0, fpsTime = 0, fps = 60, frameMsAvg = 16;
let slowTime = 0, fastTime = 0;
const toolColors: Record<ToolName, number> = {
  add: 0xffffff, erase: 0xff5d6c, dig: 0xffa94d, heat: 0xff7b39, cool: 0x7fe0ff, explode: 0xffd84d, pour: 0x8fc8ff, inspect: 0xffffff,
};
const tmpColor = new THREE.Color();

function frame() {
  requestAnimationFrame(frame);
  const t0 = performance.now();
  const dt = Math.min(0.05, (t0 - lastFrame) / 1000);
  lastFrame = t0;
  elapsed += dt;
  boomBudget = Math.max(0, boomBudget - dt * 8);

  chunks.flush(5);
  rig.update(dt);
  input.update(dt);

  // brush preview
  const h = input.hit;
  if (state.tool === 'add' || state.tool === 'pour') tmpColor.set(MATERIALS[state.mat].color).lerp(new THREE.Color(0xffffff), 0.35);
  else tmpColor.set(toolColors[state.tool]);
  brush.show(started && !rig.cinematic ? h : null, state.tool === 'inspect' ? 0 : brushRadius(state.brush), tmpColor, state.tool === 'add');
  brush.update(dt, elapsed);

  // inspect
  if (state.tool === 'inspect' && h) {
    const now = performance.now();
    if (now - lastInspectSend > 100) {
      send({ t: 'inspect', x: h.x, y: h.y, z: h.z });
      lastInspectSend = now;
    }
    ui.showInspect(inspectInfo, screenX, screenY);
  } else {
    ui.showInspect(null, 0, 0);
  }

  // environment + effects
  sky.update(dt, rig.camera, elapsed);
  (scene.fog as THREE.Fog).color.copy(sky.fogColor);
  const night = 1 - sky.dayFactor;
  sharedUniforms.uTime.value = elapsed;
  sharedUniforms.uNight.value = night;
  gas.uniforms.uTime.value = elapsed;
  gas.uniforms.uNight.value = night;
  scene.environmentIntensity = 0.1 + 0.3 * sky.dayFactor;
  renderer.toneMappingExposure = 1.0 + night * 0.25;
  if (!sky.running) ui.timeSlider.value = String(sky.time);
  else if (Math.random() < 0.05) ui.timeSlider.value = String(sky.time);
  glow.update(dt, elapsed);
  for (const l of glow.lights) {
    if (l.intensity > 8 && Math.random() < dt * 3 * (l.intensity / 60)) particles.ember(l.position.x, l.position.y, l.position.z);
  }
  particles.update(dt);
  debris.update(dt, elapsed);
  sound.setFire(stats.fire);
  sound.setDay(sky.dayFactor);

  post.render(dt);
  if (wantShot) {
    wantShot = false;
    takeScreenshot();
  }

  // stats + adaptive resolution
  const frameMs = performance.now() - t0;
  frameMsAvg = frameMsAvg * 0.95 + frameMs * 0.05;
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0;
    fpsTime = 0;
    if (started) adapt();
    const info = renderer.info;
    ui.setStats(
      `<b>${fps.toFixed(0)}</b> fps · ${frameMsAvg.toFixed(1)} ms cpu<br>` +
      `sim <b>${stats.tps.toFixed(0)}</b> tps · ${stats.tickMs.toFixed(1)} ms/tick<br>` +
      `remesh ${stats.meshMs.toFixed(1)} ms · awake ${stats.awake}/256<br>` +
      `debris ${stats.debris} · fire ${stats.fire}<br>` +
      `${(chunks.triangles / 1000).toFixed(0)}k tris · ${info.render.calls} calls<br>` +
      `res ×${pixelRatio.toFixed(2)}${paused ? ' · <b>paused</b>' : ''}`,
    );
  }
  (window as unknown as { __fps: number }).__fps = fps;
}

function adapt() {
  // keep ~60 fps: lower the render resolution when slow, raise it back when there's headroom
  if (fps < 50) { slowTime += 0.5; fastTime = 0; } else if (fps > 58) { fastTime += 0.5; slowTime = 0; } else { slowTime = 0; fastTime = 0; }
  if (slowTime >= 1.5 && pixelRatio > 0.6) {
    pixelRatio = Math.max(0.6, pixelRatio - 0.15);
    slowTime = 0;
    resize();
  } else if (fastTime >= 6 && pixelRatio < maxPixelRatio) {
    pixelRatio = Math.min(maxPixelRatio, pixelRatio + 0.1);
    fastTime = 0;
    resize();
  }
}

function takeScreenshot() {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `terrarium-${seed}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
  const sh = document.getElementById('shutter')!;
  sh.classList.add('flash');
  requestAnimationFrame(() => sh.classList.remove('flash'));
  ui.toast('Screenshot saved');
}

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// test / debugging hooks (used by the Playwright scenarios)
(window as unknown as Record<string, unknown>).__terrarium = {
  send, state, rig, stats, chunks, sky, ui, post,
  get ready() { return worldReady; },
  get info() { return islandInfo; },
  frameIsland,
  look(px: number, py: number, pz: number, tx: number, ty: number, tz: number) {
    rig.controls.target.set(tx, ty, tz);
    rig.camera.position.set(px, py, pz);
    rig.zoom(0);
    (rig as unknown as { targetDist: number }).targetDist = rig.camera.position.distanceTo(rig.controls.target);
    rig.controls.update();
  },
  get undoDepth() { return undoDepth; },
  start: () => enterBtn.click(),
  apply: (a: ToolApply) => { send({ t: 'tool', a }); },
};

frame();

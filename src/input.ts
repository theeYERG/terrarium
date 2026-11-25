// Mouse / touch input for tools: voxel DDA raycast against the mirrored grid, brush
// strokes with interpolation between positions, and hold-to-paint repetition.

import * as THREE from 'three';
import type { CameraRig } from './camera.ts';
import { LAYER, SX, SY, SZ } from './sim/constants.ts';
import { State, T_STATE } from './sim/materials.ts';
import type { ToolApply, ToolName } from './sim/protocol.ts';

export interface Hit {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  dist: number;
}

export interface ToolState {
  tool: ToolName;
  mat: number;
  brush: number; // 1..9
}

export function brushRadius(brush: number) {
  return brush - 0.5;
}

/** Amanatides & Woo voxel traversal. skipLiquids: dig passes through water. */
export function raycastVoxels(mats: Uint8Array, origin: THREE.Vector3, dir: THREE.Vector3, skipLiquids: boolean, maxDist = 900): Hit | null {
  // clip the ray to the grid box first
  let tmin = 0, tmax = maxDist;
  const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z], size = [SX, SY, SZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < 0 || o[a] >= size[a]) return null;
    } else {
      let t1 = (0 - o[a]) / d[a], t2 = (size[a] - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  const start = tmin + 1e-4;
  let x = Math.floor(o[0] + d[0] * start), y = Math.floor(o[1] + d[1] * start), z = Math.floor(o[2] + d[2] * start);
  const stepX = d[0] > 0 ? 1 : -1, stepY = d[1] > 0 ? 1 : -1, stepZ = d[2] > 0 ? 1 : -1;
  const px = o[0] + d[0] * start, py = o[1] + d[1] * start, pz = o[2] + d[2] * start;
  const tdx = Math.abs(1 / d[0]), tdy = Math.abs(1 / d[1]), tdz = Math.abs(1 / d[2]);
  let tmx = d[0] !== 0 ? ((stepX > 0 ? x + 1 - px : px - x) * tdx) : Infinity;
  let tmy = d[1] !== 0 ? ((stepY > 0 ? y + 1 - py : py - y) * tdy) : Infinity;
  let tmz = d[2] !== 0 ? ((stepZ > 0 ? z + 1 - pz : pz - z) * tdz) : Infinity;
  // entry face normal (for the first cell, from the box face we entered through)
  let nx = 0, ny = 0, nz = 0;
  {
    const ex = o[0] + d[0] * tmin, ey = o[1] + d[1] * tmin, ez = o[2] + d[2] * tmin;
    if (Math.abs(ex) < 1e-3 || Math.abs(ex - SX) < 1e-3) nx = -stepX;
    else if (Math.abs(ey) < 1e-3 || Math.abs(ey - SY) < 1e-3) ny = -stepY;
    else if (Math.abs(ez) < 1e-3 || Math.abs(ez - SZ) < 1e-3) nz = -stepZ;
  }
  let t = start;
  for (let k = 0; k < 600; k++) {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return null;
    const m = mats[x + z * SX + y * LAYER];
    if (m !== 0) {
      const st = T_STATE[m];
      const pass = st === State.GAS || (skipLiquids && st === State.LIQUID);
      if (!pass) return { x, y, z, nx, ny, nz, dist: t };
    }
    if (tmx < tmy && tmx < tmz) { x += stepX; t = start + tmx; tmx += tdx; nx = -stepX; ny = 0; nz = 0; }
    else if (tmy < tmz) { y += stepY; t = start + tmy; tmy += tdy; nx = 0; ny = -stepY; nz = 0; }
    else { z += stepZ; t = start + tmz; tmz += tdz; nx = 0; ny = 0; nz = -stepZ; }
    if (t > tmax + 1) return null;
  }
  return null;
}

export class ToolInput {
  hit: Hit | null = null;
  mouse = new THREE.Vector2(-10, -10);
  painting = false;
  private overCanvas = false;
  private lastApplied: Hit | null = null;
  private lastApplyTime = 0;
  private sinceContinuous = 0;
  private raycaster = new THREE.Raycaster();
  private activePointers = new Set<number>();
  private paintPointer = -1;
  onStrokeStart: () => void = () => {};
  onApply: (a: ToolApply) => void = () => {};
  onBrushChange: (delta: number) => void = () => {};

  private dom: HTMLElement;
  private rig: CameraRig;
  private mats: Uint8Array;
  private state: ToolState;

  constructor(dom: HTMLElement, rig: CameraRig, mats: Uint8Array, state: ToolState) {
    this.dom = dom;
    this.rig = rig;
    this.mats = mats;
    this.state = state;
    dom.addEventListener('pointermove', (e) => this.move(e));
    dom.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    dom.addEventListener('pointerleave', () => { this.overCanvas = false; });
    dom.addEventListener('pointerenter', () => { this.overCanvas = true; });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.style.cursor = 'crosshair';
    dom.addEventListener('pointerdown', (e) => { if (e.button === 1 || e.button === 2) dom.style.cursor = 'grabbing'; });
    window.addEventListener('pointerup', () => { dom.style.cursor = 'crosshair'; });
    // We own the wheel: zoom, or brush size with Shift / Ctrl / Alt.
    window.addEventListener('wheel', (e) => {
      if (e.target !== dom) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.shiftKey || e.ctrlKey || e.altKey) {
        const dy = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        this.onBrushChange(dy < 0 ? 1 : -1);
      } else {
        this.rig.zoom(e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      }
    }, { capture: true, passive: false });
  }

  private setMouse(e: PointerEvent) {
    const r = this.dom.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private move(e: PointerEvent) {
    this.overCanvas = true;
    if (e.pointerType !== 'touch' || e.pointerId === this.paintPointer) this.setMouse(e);
  }

  private down(e: PointerEvent) {
    this.activePointers.add(e.pointerId);
    if (e.pointerType === 'touch') {
      if (this.activePointers.size > 1) {
        // second finger: this is a camera gesture, cancel painting
        this.painting = false;
        this.paintPointer = -1;
        return;
      }
      this.paintPointer = e.pointerId;
      this.setMouse(e);
    }
    if (e.button !== 0) return;
    this.overCanvas = true;
    if (this.state.tool === 'inspect') return;
    this.painting = true;
    this.lastApplied = null;
    this.onStrokeStart();
    this.updateHit();
    this.applyNow(performance.now());
  }

  private up(e: PointerEvent) {
    this.activePointers.delete(e.pointerId);
    if (e.pointerId === this.paintPointer) this.paintPointer = -1;
    if (e.button === 0 || e.pointerType === 'touch') {
      this.painting = false;
      this.lastApplied = null;
    }
  }

  updateHit() {
    if (!this.overCanvas && !this.painting) { this.hit = null; return; }
    this.raycaster.setFromCamera(this.mouse, this.rig.camera);
    const ray = this.raycaster.ray;
    this.hit = raycastVoxels(this.mats, ray.origin, ray.direction, this.state.tool === 'dig');
  }

  private apply(h: Hit) {
    const s = this.state;
    this.onApply({ tool: s.tool, mat: s.mat, x: h.x, y: h.y, z: h.z, nx: h.nx, ny: h.ny, nz: h.nz, r: brushRadius(s.brush) });
  }

  private applyNow(now: number) {
    if (!this.hit) return;
    this.apply(this.hit);
    this.lastApplied = { ...this.hit };
    this.lastApplyTime = now;
  }

  /** Called every frame. */
  update(dt: number) {
    this.updateHit();
    if (!this.painting || !this.hit) return;
    const now = performance.now();
    const tool = this.state.tool;
    const r = brushRadius(this.state.brush);
    if (tool === 'heat' || tool === 'cool' || tool === 'pour') {
      this.sinceContinuous += dt;
      if (this.sinceContinuous >= 1 / 30) {
        this.sinceContinuous = 0;
        this.applyNow(now);
      }
      return;
    }
    if (tool === 'explode') {
      if (now - this.lastApplyTime > 450) this.applyNow(now);
      return;
    }
    // add / erase / dig: interpolate between the last stamp and the cursor
    const h = this.hit;
    const last = this.lastApplied;
    if (!last) { this.applyNow(now); return; }
    const dx = h.x - last.x, dy = h.y - last.y, dz = h.z - last.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const step = Math.max(1, r * 0.7);
    if (dist >= step) {
      const n = Math.min(24, Math.ceil(dist / step));
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        this.apply({
          x: Math.round(last.x + dx * f), y: Math.round(last.y + dy * f), z: Math.round(last.z + dz * f),
          nx: h.nx, ny: h.ny, nz: h.nz, dist: h.dist,
        });
      }
      this.lastApplied = { ...h };
      this.lastApplyTime = now;
    } else if (tool !== 'add' || T_STATE[this.state.mat] !== State.SOLID) {
      // holding still keeps digging / pouring; solid blocks only paint while the cursor moves
      if (now - this.lastApplyTime > (tool === 'add' ? 160 : 110)) this.applyNow(now);
    }
  }
}

// Messages between the main thread and the simulation worker.

import type { ChunkMesh } from './mesher.ts';
import type { SimEvent } from './world.ts';

export type ToolName = 'add' | 'erase' | 'dig' | 'heat' | 'cool' | 'explode' | 'pour' | 'inspect';

export interface ToolApply {
  tool: ToolName;
  mat: number;
  x: number; y: number; z: number; // hit cell
  nx: number; ny: number; nz: number; // face normal
  r: number; // brush radius in cells
}

export type ToMain =
  | { t: 'progress'; p: number; label: string }
  | { t: 'ready'; seed: number; info: { center: number[]; lake: number[]; mountain: number[]; waterfall: number[]; cave: number[] } | null }
  | { t: 'chunks'; list: ChunkMesh[]; full: boolean }
  | {
    t: 'frame';
    debris: Float32Array;
    gas: Float32Array;
    events: SimEvent[];
    lights: number[]; // x,y,z,intensity * n
    stats: { tps: number; tickMs: number; meshMs: number; awake: number; heated: number; debris: number; fire: number; water: number };
  }
  | { t: 'inspect'; mat: number; temp: number; x: number; y: number; z: number; life: number }
  | { t: 'saved'; data: Uint8Array }
  | { t: 'undoState'; depth: number }
  | { t: 'toast'; text: string };

export type ToWorker =
  | { t: 'init'; seed: number; save?: Uint8Array | null }
  | { t: 'regen'; seed: number }
  | { t: 'clear' }
  | { t: 'tool'; a: ToolApply }
  | { t: 'snapshot' }
  | { t: 'undo' }
  | { t: 'pause'; v: boolean }
  | { t: 'speed'; v: number }
  | { t: 'step' }
  | { t: 'inspect'; x: number; y: number; z: number }
  | { t: 'save' }
  | { t: 'load'; data: Uint8Array }
  | { t: 'bench'; ticks: number };

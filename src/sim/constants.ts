// World dimensions and index helpers shared by the worker and the main thread.
// Layout is y-major: idx = x + z*SX + y*SX*SZ, so one horizontal layer is contiguous.

export const SX = 128;
export const SY = 64;
export const SZ = 128;
export const LAYER = SX * SZ;
export const VOLUME = SX * SY * SZ;

export const CS = 16; // chunk size
export const CX = SX / CS;
export const CY = SY / CS;
export const CZ = SZ / CS;
export const CHUNKS = CX * CY * CZ;
export const CHUNK_VOL = CS * CS * CS;

export const BASE_TPS = 30; // simulation ticks per second at 1x speed

export function idx(x: number, y: number, z: number): number {
  return x + z * SX + y * LAYER;
}

export function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ;
}

export function chunkIndex(cx: number, cy: number, cz: number): number {
  return cx + cz * CX + cy * CX * CZ;
}

export function chunkOfCell(x: number, y: number, z: number): number {
  return (x >> 4) + (z >> 4) * CX + (y >> 4) * CX * CZ;
}

/** Ambient air temperature falls with altitude (lapse rate) so the peak keeps its snow. */
export function ambientTemp(y: number): number {
  return 20 - Math.max(0, y - 30) * 0.95;
}

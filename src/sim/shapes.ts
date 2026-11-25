// Shared low poly shapes: the worker builds physics colliders from them and the renderer
// builds matching meshes, so what you see is what collides.

import { mulberry32 } from './noise.ts';

export const ROCK_VARIANTS = 6;

/** Points of a lumpy icosahedron (unit radius), deterministic per variant. */
export function rockPoints(variant: number): Float32Array {
  const rnd = mulberry32(9137 + variant * 7919);
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const out = new Float32Array(base.length * 3);
  base.forEach((p, k) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    const s = (0.75 + rnd() * 0.4) / l;
    // squash a little vertically so rocks sit nicely
    out[k * 3] = p[0] * s;
    out[k * 3 + 1] = p[1] * s * (0.72 + rnd() * 0.2);
    out[k * 3 + 2] = p[2] * s;
  });
  return out;
}

/** Radius of a debris rock that carries `amount` (0..255) of fill. */
export function rockSize(amount: number): number {
  return 0.32 + Math.cbrt(amount / 255) * 0.42;
}

export const GRAIN_RADIUS = 0.36;

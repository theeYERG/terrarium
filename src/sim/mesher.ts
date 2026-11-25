// Low poly chunk mesher: Surface Nets over the voxel fill field.
//
// Terrain: density = fill (0..1) of solid/powder cells, iso 0.5. One vertex per dual cube
// (average of edge crossings) with a small position-seeded jitter, quads split into two
// triangles, emitted NON-indexed so every triangle has its own flat normal and colour.
// Vertex colours blend the palette colours of the surrounding materials (grass fades into
// dirt, sand into stone), faces get a hashed shade and a soft ambient-occlusion term.
//
// Liquids: a second Surface Nets pass over liquid mass, extended into touching solids so
// the liquid surface tucks inside the terrain instead of leaving seams.

import { CS, CX, CZ, LAYER, SX, SY, SZ } from './constants.ts';
import { M, MAT_COUNT, State, T_STATE } from './materials.ts';
import type { World } from './world.ts';

export interface TerrainBuffers {
  pos: Float32Array; // local to chunk origin
  nrm: Int8Array;
  col: Uint8Array; // sRGB, current material colour
  col0: Uint8Array; // sRGB, colour before the last material change
  tchg: Float32Array; // sim time of that change (for the colour lerp)
  aux: Uint8Array; // [heat glow 0-255, material, 0, 0]
}

export interface LiquidBuffers {
  pos: Float32Array;
  nrm: Int8Array;
  aux: Uint8Array; // [liquid material, depth 0-255, foam 0-255, lava heat 0-255]
}

export interface ChunkMesh {
  c: number;
  /** false: the terrain mesh didn't change, keep the old one (terrain/collider are null) */
  hasTerrain: boolean;
  terrain: TerrainBuffers | null;
  liquid: LiquidBuffers | null;
  /** world-space triangle soup for the physics collider (terrain only) */
  collider: Float32Array | null;
  mats: Uint8Array; // CS³ copy of materials, local index lx + lz*16 + ly*256
  fills: Uint8Array; // CS³ copy of fill / liquid mass (0..255)
  lava: number;
  lavaPos: [number, number, number];
}

// ───────────────────────────── palette ─────────────────────────────
// Three shades per material (light, mid, dark), sRGB. Kept soft and cohesive.
export const PALETTE: Record<number, [number, number, number]> = {
  [M.STONE]: [0x9aa0a6, 0x868c93, 0x737980],
  [M.DIRT]: [0xa27350, 0x8f6444, 0x7b5639],
  [M.GRASS]: [0x86c95a, 0x74b84c, 0x63a742],
  [M.SAND]: [0xeed6a0, 0xe3c98e, 0xd5b97c],
  [M.GRAVEL]: [0xa69d94, 0x938a82, 0x7f7770],
  [M.ICE]: [0xcdeefa, 0xb9e3f4, 0xa5d6ec],
  [M.SNOW]: [0xeef3f8, 0xe2e9f1, 0xd3dce8],
  [M.WOOD]: [0x8b5e3c, 0x7a5033, 0x68442b],
  [M.LEAVES]: [0x6fb85a, 0x5ea84d, 0x4f9641],
  [M.GLASS]: [0xd8f2f6, 0xc8e8ee, 0xb8dde6],
  [M.OBSIDIAN]: [0x4a3d63, 0x3d3254, 0x312846],
  [M.MUD]: [0x7a5a3e, 0x6a4c33, 0x5b402b],
  [M.GUNPOWDER]: [0x55555e, 0x48484f, 0x3c3c42],
  [M.METAL]: [0xc4cad2, 0xb0b7c0, 0x9ca3ad],
  [M.SPRING]: [0x6fa9b8, 0x5f97a6, 0x4f8594],
  [M.EMBER]: [0xffa050, 0xff8a3a, 0xf07028],
  [M.LAVA]: [0xff7a2a, 0xff6a1e, 0xf05a14],
};
const CLIFF = [0xa27a55, 0x8d6a49, 0x7a5c40]; // steep grass faces
const ROCKFACE = [0xa9adb2, 0x969ba1, 0x84898f]; // steep snow faces

const PAL_R = new Float32Array(MAT_COUNT * 3);
const PAL_G = new Float32Array(MAT_COUNT * 3);
const PAL_B = new Float32Array(MAT_COUNT * 3);
for (let m = 0; m < MAT_COUNT; m++) {
  const p = PALETTE[m] ?? [0x999999, 0x888888, 0x777777];
  for (let k = 0; k < 3; k++) {
    PAL_R[m * 3 + k] = (p[k] >> 16) & 255;
    PAL_G[m * 3 + k] = (p[k] >> 8) & 255;
    PAL_B[m * 3 + k] = p[k] & 255;
  }
}
const hexR = (h: number) => (h >> 16) & 255, hexG = (h: number) => (h >> 8) & 255, hexB = (h: number) => h & 255;

/** Cells that form terrain (meshed by the terrain pass). */
export const IS_TERRAIN = new Uint8Array(MAT_COUNT);
for (let m = 0; m < MAT_COUNT; m++) IS_TERRAIN[m] = T_STATE[m] === State.SOLID || T_STATE[m] === State.POWDER ? 1 : 0;

export function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function glowLevel(_m: number, t: number): number {
  if (t < 480) return 0;
  return Math.min(255, Math.round((t - 480) * 0.25));
}

// ───────────────────────────── scratch ─────────────────────────────
const N = CS + 3; // samples from -1 .. CS+1
const NN = N * N * N;
const dens = new Float32Array(NN);
const smat = new Uint8Array(NN);
const vidx = new Int32Array(NN);
const vx = new Float32Array(NN * 3);
const vcol = new Float32Array(NN * 3);
const vcol0 = new Float32Array(NN * 3);
const vt = new Float32Array(NN);
const vglow = new Float32Array(NN);
const vao = new Float32Array(NN);
const vmat = new Uint8Array(NN);
const vdepth = new Float32Array(NN);
const vfoam = new Float32Array(NN);
const cs = new Float32Array(8);

class Soup {
  pos: number[] = [];
  nrm: number[] = [];
  a: number[] = [];
  b: number[] = [];
  t: number[] = [];
  reset() {
    this.pos.length = 0; this.nrm.length = 0; this.a.length = 0; this.b.length = 0; this.t.length = 0;
  }
}
const soupT = new Soup();
const soupL = new Soup();

const S = (x: number, y: number, z: number) => (x + 1) + (y + 1) * N + (z + 1) * N * N;

// cube corners (bit 0 = x, bit 1 = y, bit 2 = z) and the 12 edges between them
const CORNER = new Int8Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]);
const COFF = [0, 1, N, N + 1, N * N, N * N + 1, N * N + N, N * N + N + 1];
const EDGE_A = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
const EDGE_B = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];

export function meshChunk(world: World, c: number, doTerrain = true): ChunkMesh {
  const { mat, fill, temp, mass, prevMat, changeT, foam } = world;
  const ccx = c % CX, ccz = Math.floor(c / CX) % CZ, ccy = Math.floor(c / (CX * CZ));
  const ox = ccx * CS, oy = ccy * CS, oz = ccz * CS;

  // ── terrain density for cells -1..CS+1 (also used for liquid materials below)
  for (let z = -1; z <= CS + 1; z++) for (let y = -1; y <= CS + 1; y++) for (let x = -1; x <= CS + 1; x++) {
    const wx = ox + x, wy = oy + y, wz = oz + z;
    const s = S(x, y, z);
    if (wx < 0 || wy < 0 || wz < 0 || wx >= SX || wy >= SY || wz >= SZ) { dens[s] = 0; smat[s] = 0; continue; }
    const i = wx + wz * SX + wy * LAYER;
    const m = mat[i];
    smat[s] = m;
    dens[s] = IS_TERRAIN[m] ? fill[i] / 255 : 0;
  }
  soupT.reset();
  const terrain = doTerrain && surfaceNets(true) ? packTerrain() : null;
  const collider = terrain ? colliderFrom(terrain.pos, ox, oy, oz) : null;

  // ── liquid field
  for (let z = -1; z <= CS + 1; z++) for (let y = -1; y <= CS + 1; y++) for (let x = -1; x <= CS + 1; x++) {
    const wx = ox + x, wy = oy + y, wz = oz + z;
    const s = S(x, y, z);
    if (wx < 0 || wy < 0 || wz < 0 || wx >= SX || wy >= SY || wz >= SZ) { dens[s] = 0; continue; }
    const i = wx + wz * SX + wy * LAYER;
    const m = mat[i];
    if (T_STATE[m] === State.LIQUID) { dens[s] = Math.min(1, mass[i]); continue; }
    // solids next to liquid borrow its level, so the liquid surface ends inside the wall
    if (IS_TERRAIN[m]) {
      let best = 0, bm = 0;
      const probe = (j: number) => { const mm = mat[j]; if (T_STATE[mm] === State.LIQUID && mass[j] > best) { best = mass[j]; bm = mm; } };
      if (wx > 0) probe(i - 1);
      if (wx < SX - 1) probe(i + 1);
      if (wz > 0) probe(i - SX);
      if (wz < SZ - 1) probe(i + SX);
      if (wy < SY - 1) { const j = i + LAYER; if (T_STATE[mat[j]] === State.LIQUID && mass[j] > 0.15) { best = 1; bm = mat[j]; } }
      dens[s] = Math.min(0.999, best);
      if (bm) smat[s] = bm;
      continue;
    }
    dens[s] = 0;
  }
  soupL.reset();
  const liquid = surfaceNets(false) ? packLiquid() : null;

  // ── material copy for the main-thread mirror + lava stats
  const mats = new Uint8Array(CS * CS * CS);
  const fills = new Uint8Array(CS * CS * CS);
  let lava = 0, lx = 0, ly = 0, lz = 0;
  for (let y = 0; y < CS; y++) for (let z = 0; z < CS; z++) {
    const row = ox + (oz + z) * SX + (oy + y) * LAYER;
    for (let x = 0; x < CS; x++) {
      const i = row + x;
      const m = mat[i];
      const k = x + z * CS + y * CS * CS;
      mats[k] = m;
      fills[k] = T_STATE[m] === State.LIQUID ? Math.min(255, Math.round(mass[i] * 255)) : fill[i];
      if (m === M.LAVA) { lava++; lx += x; ly += y; lz += z; }
    }
  }
  return {
    c, hasTerrain: doTerrain, terrain, liquid, collider, mats, fills, lava,
    lavaPos: lava ? [ox + lx / lava + 0.5, oy + ly / lava + 1.2, oz + lz / lava + 0.5] : [0, 0, 0],
  };

  // ───────────────────────── inner helpers ─────────────────────────

  function surfaceNets(isTerrain: boolean): boolean {
    const ISO = 0.5;
    vidx.fill(-1);
    let nv = 0;
    // 1. one vertex per dual cube with a sign change (cube min corner -1 .. CS-1)
    for (let z = -1; z < CS; z++) for (let y = -1; y < CS; y++) for (let x = -1; x < CS; x++) {
      const base = S(x, y, z);
      let inside = 0;
      for (let k = 0; k < 8; k++) { cs[k] = dens[base + COFF[k]]; if (cs[k] >= ISO) inside++; }
      if (inside === 0 || inside === 8) continue;
      let px = 0, py = 0, pz = 0, cnt = 0;
      for (let e = 0; e < 12; e++) {
        const a = EDGE_A[e], b = EDGE_B[e];
        const da = cs[a], db = cs[b];
        if ((da >= ISO) === (db >= ISO)) continue;
        const t = (ISO - da) / (db - da);
        px += CORNER[a * 3] + (CORNER[b * 3] - CORNER[a * 3]) * t;
        py += CORNER[a * 3 + 1] + (CORNER[b * 3 + 1] - CORNER[a * 3 + 1]) * t;
        pz += CORNER[a * 3 + 2] + (CORNER[b * 3 + 2] - CORNER[a * 3 + 2]) * t;
        cnt++;
      }
      px /= cnt; py /= cnt; pz /= cnt;
      const wx = ox + x, wy = oy + y, wz = oz + z;
      // samples sit at cell centres: cube corner (0,0,0) is the centre of cell (x,y,z)
      let fx = x + 0.5 + px, fy = y + 0.5 + py, fz = z + 0.5 + pz;
      if (isTerrain) {
        // hand-made look: a little jitter seeded by the world position of the cube
        fx += (hash3(wx, wy, wz) - 0.5) * 0.3;
        fy += (hash3(wx + 71, wy, wz + 13) - 0.5) * 0.18;
        fz += (hash3(wx, wy + 37, wz - 29) - 0.5) * 0.3;
      } else {
        fx += (hash3(wx, wy, wz) - 0.5) * 0.3;
        fz += (hash3(wx + 5, wy, wz + 3) - 0.5) * 0.3;
      }
      const v = nv++;
      vidx[base] = v;
      vx[v * 3] = fx; vx[v * 3 + 1] = fy; vx[v * 3 + 2] = fz;

      if (isTerrain) {
        let r = 0, g = 0, bb = 0, r0 = 0, g0 = 0, b0 = 0, wsum = 0, tmax = 0, hot = 0, best = 0, bm = 0;
        for (let k = 0; k < 8; k++) {
          const s = base + COFF[k];
          const d = dens[s];
          if (d <= 0) continue;
          const m = smat[s];
          const w = d * d;
          const i = (ox + x + CORNER[k * 3]) + (oz + z + CORNER[k * 3 + 2]) * SX + (oy + y + CORNER[k * 3 + 1]) * LAYER;
          r += PAL_R[m * 3 + 1] * w; g += PAL_G[m * 3 + 1] * w; bb += PAL_B[m * 3 + 1] * w;
          const pm = IS_TERRAIN[prevMat[i]] ? prevMat[i] : m;
          r0 += PAL_R[pm * 3 + 1] * w; g0 += PAL_G[pm * 3 + 1] * w; b0 += PAL_B[pm * 3 + 1] * w;
          wsum += w;
          if (changeT[i] > tmax) tmax = changeT[i];
          if (temp[i] > hot) hot = temp[i];
          if (w > best) { best = w; bm = m; }
        }
        if (wsum === 0) wsum = 1;
        vcol[v * 3] = r / wsum; vcol[v * 3 + 1] = g / wsum; vcol[v * 3 + 2] = bb / wsum;
        vcol0[v * 3] = r0 / wsum; vcol0[v * 3 + 1] = g0 / wsum; vcol0[v * 3 + 2] = b0 / wsum;
        vt[v] = tmax;
        vglow[v] = glowLevel(bm, hot);
        vmat[v] = bm;
        // soft AO: how buried the vertex is in a 4x4x4 neighbourhood
        let occ = 0;
        for (let dz = -1; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
          const sx = x + dx, sy = y + dy, sz = z + dz;
          if (sx < -1 || sy < -1 || sz < -1 || sx > CS + 1 || sy > CS + 1 || sz > CS + 1) { occ += 0.4; continue; }
          occ += dens[S(sx, sy, sz)];
        }
        occ /= 64;
        vao[v] = Math.max(0.6, Math.min(1.06, 1.08 - (occ - 0.42) * 1.35));
      } else {
        let bm = 0, best = 0, nearSolid = 0;
        for (let k = 0; k < 8; k++) {
          const s = base + COFF[k];
          const m = smat[s];
          if (T_STATE[m] === State.LIQUID && dens[s] > best) { best = dens[s]; bm = m; }
          if (IS_TERRAIN[m]) nearSolid++;
        }
        if (!bm) bm = M.WATER;
        vmat[v] = bm;
        const cx2 = Math.max(0, Math.min(SX - 1, ox + Math.floor(fx))), cz2 = Math.max(0, Math.min(SZ - 1, oz + Math.floor(fz)));
        const cy2 = Math.max(0, Math.min(SY - 1, oy + Math.floor(fy)));
        let depth = 0;
        for (let yy = cy2; yy >= 0 && depth < 12; yy--) {
          if (T_STATE[mat[cx2 + cz2 * SX + yy * LAYER]] !== State.LIQUID) { if (yy < cy2) break; else continue; }
          depth++;
        }
        vdepth[v] = Math.min(255, depth * 26);
        const fi = cx2 + cz2 * SX + cy2 * LAYER;
        vfoam[v] = Math.max(nearSolid >= 3 ? 110 : nearSolid > 0 ? 45 : 0, foam[fi]);
        vglow[v] = bm === M.LAVA ? Math.max(0, Math.min(255, (temp[fi] - 650) * 0.45)) : 0;
      }
    }

    // 2. a quad for every sample edge with a sign change (edge base sample 0..CS-1)
    let tris = 0;
    for (let z = 0; z < CS; z++) for (let y = 0; y < CS; y++) for (let x = 0; x < CS; x++) {
      const s = S(x, y, z);
      const d0 = dens[s] >= ISO;
      for (let axis = 0; axis < 3; axis++) {
        const step = axis === 0 ? 1 : axis === 1 ? N : N * N;
        const d1 = dens[s + step] >= ISO;
        if (d0 === d1) continue;
        const u = axis === 0 ? N : axis === 1 ? N * N : 1;
        const w = axis === 0 ? N * N : axis === 1 ? 1 : N;
        const a = vidx[s], b = vidx[s - u], cc = vidx[s - u - w], d = vidx[s - w];
        if (a < 0 || b < 0 || cc < 0 || d < 0) continue;
        if (d0) { emitTri(a, b, cc, isTerrain); emitTri(a, cc, d, isTerrain); }
        else { emitTri(a, cc, b, isTerrain); emitTri(a, d, cc, isTerrain); }
        tris += 2;
      }
    }
    return tris > 0;
  }

  function emitTri(a: number, b: number, c2: number, isTerrain: boolean) {
    const soup = isTerrain ? soupT : soupL;
    const ax = vx[a * 3], ay = vx[a * 3 + 1], az = vx[a * 3 + 2];
    const bx = vx[b * 3], by = vx[b * 3 + 1], bz = vx[b * 3 + 2];
    const cx = vx[c2 * 3], cy = vx[c2 * 3 + 1], cz = vx[c2 * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const n8x = Math.round(nx * 127), n8y = Math.round(ny * 127), n8z = Math.round(nz * 127);
    soup.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    soup.nrm.push(n8x, n8y, n8z, n8x, n8y, n8z, n8x, n8y, n8z);
    if (!isTerrain) {
      soup.a.push(vmat[a], vdepth[a], vfoam[a], vglow[a], vmat[a], vdepth[b], vfoam[b], vglow[b], vmat[a], vdepth[c2], vfoam[c2], vglow[c2]);
      return;
    }
    // one colour per face: blend of the three vertex colours + hashed shade + AO + slope rules
    const h = hash3(Math.floor((ox + (ax + bx + cx) / 3) * 3), Math.floor((oy + (ay + by + cy) / 3) * 3), Math.floor((oz + (az + bz + cz) / 3) * 3));
    const shade = 0.955 + h * 0.08;
    const ao = (vao[a] + vao[b] + vao[c2]) / 3;
    const dom = vmat[a] === vmat[b] || vmat[a] === vmat[c2] ? vmat[a] : vmat[b];
    let r = (vcol[a * 3] + vcol[b * 3] + vcol[c2 * 3]) / 3;
    let g = (vcol[a * 3 + 1] + vcol[b * 3 + 1] + vcol[c2 * 3 + 1]) / 3;
    let bl = (vcol[a * 3 + 2] + vcol[b * 3 + 2] + vcol[c2 * 3 + 2]) / 3;
    let r0 = (vcol0[a * 3] + vcol0[b * 3] + vcol0[c2 * 3]) / 3;
    let g0 = (vcol0[a * 3 + 1] + vcol0[b * 3 + 1] + vcol0[c2 * 3 + 1]) / 3;
    let b0 = (vcol0[a * 3 + 2] + vcol0[b * 3 + 2] + vcol0[c2 * 3 + 2]) / 3;
    const k = h < 0.34 ? 0 : h < 0.7 ? 1 : 2;
    // slope-aware styling: steep grass shows earthy cliffs, steep snow shows rock
    // only genuinely steep faces turn to earth / rock (jitter alone shouldn't speckle the grass)
    const steep = 1 - Math.max(0, Math.min(1, (ny - 0.28) / 0.25));
    if (dom === M.GRASS && steep > 0) {
      r += (hexR(CLIFF[k]) - r) * steep; g += (hexG(CLIFF[k]) - g) * steep; bl += (hexB(CLIFF[k]) - bl) * steep;
    } else if (dom === M.SNOW && steep > 0.3) {
      const t = (steep - 0.3) / 0.7;
      r += (hexR(ROCKFACE[k]) - r) * t; g += (hexG(ROCKFACE[k]) - g) * t; bl += (hexB(ROCKFACE[k]) - bl) * t;
    } else {
      r += (PAL_R[dom * 3 + k] - PAL_R[dom * 3 + 1]) * 0.55;
      g += (PAL_G[dom * 3 + k] - PAL_G[dom * 3 + 1]) * 0.55;
      bl += (PAL_B[dom * 3 + k] - PAL_B[dom * 3 + 1]) * 0.55;
    }
    const f = shade * ao * (ny < -0.3 ? 0.88 : 1);
    const R = clamp8(r * f), G = clamp8(g * f), B = clamp8(bl * f);
    const R0 = clamp8(r0 * f), G0 = clamp8(g0 * f), B0 = clamp8(b0 * f);
    const t = Math.max(vt[a], vt[b], vt[c2]);
    const glow = Math.max(vglow[a], vglow[b], vglow[c2]);
    for (let q = 0; q < 3; q++) {
      soup.a.push(R, G, B);
      soup.b.push(R0, G0, B0);
      soup.t.push(t, glow, dom);
    }
  }

  function packTerrain(): TerrainBuffers {
    const n = soupT.pos.length / 3;
    const aux = new Uint8Array(n * 4);
    const tchg = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      tchg[k] = soupT.t[k * 3];
      aux[k * 4] = soupT.t[k * 3 + 1];
      aux[k * 4 + 1] = soupT.t[k * 3 + 2];
    }
    return {
      pos: Float32Array.from(soupT.pos),
      nrm: Int8Array.from(soupT.nrm),
      col: Uint8Array.from(soupT.a),
      col0: Uint8Array.from(soupT.b),
      tchg,
      aux,
    };
  }

  function packLiquid(): LiquidBuffers {
    return { pos: Float32Array.from(soupL.pos), nrm: Int8Array.from(soupL.nrm), aux: Uint8Array.from(soupL.a) };
  }
}

function clamp8(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function colliderFrom(pos: Float32Array, ox: number, oy: number, oz: number): Float32Array {
  const out = new Float32Array(pos.length);
  for (let k = 0; k < pos.length; k += 3) {
    out[k] = pos[k] + ox; out[k + 1] = pos[k + 1] + oy; out[k + 2] = pos[k + 2] + oz;
  }
  return out;
}

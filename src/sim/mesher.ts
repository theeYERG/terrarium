// Greedy chunk mesher with per-vertex ambient occlusion.
// Faces are merged only when material, AO and glow level all match. Per-voxel colour
// variation is done in the fragment shader from the world position, so it doesn't
// prevent merging.

import { CS, CX, CZ, LAYER, SX, SY, SZ } from './constants.ts';
import { M, T_OPAQUE, T_TRANSLUCENT } from './materials.ts';
import type { World } from './world.ts';

export interface MeshBuffers {
  pos: Uint8Array;
  nrm: Int8Array;
  data: Uint8Array;
  idx: Uint16Array | Uint32Array;
}

export interface ChunkMesh {
  c: number;
  opaque: MeshBuffers | null;
  trans: MeshBuffers | null;
  mats: Uint8Array; // CS³ copy of materials, local index lx + lz*16 + ly*256
  lava: number; // count of glowing cells for light clustering
  lavaPos: [number, number, number];
}

const MAX_QUADS = 6 * CS * CS * CS / 2 + 64;

class Builder {
  pos = new Uint8Array(MAX_QUADS * 4 * 3);
  nrm = new Int8Array(MAX_QUADS * 4 * 3);
  data = new Uint8Array(MAX_QUADS * 4 * 4);
  idx = new Uint32Array(MAX_QUADS * 6);
  quads = 0;

  reset() {
    this.quads = 0;
  }

  /** v: 4 corners (x,y,z) in CCW order seen from outside. */
  quad(v: number[], n: number[], mat: number, ao: number[], glow: number, face: number) {
    const q = this.quads++;
    const vb = q * 4;
    for (let k = 0; k < 4; k++) {
      const o = (vb + k) * 3;
      this.pos[o] = v[k * 3];
      this.pos[o + 1] = v[k * 3 + 1];
      this.pos[o + 2] = v[k * 3 + 2];
      this.nrm[o] = n[0] * 127;
      this.nrm[o + 1] = n[1] * 127;
      this.nrm[o + 2] = n[2] * 127;
      const d = (vb + k) * 4;
      this.data[d] = mat;
      this.data[d + 1] = ao[k];
      this.data[d + 2] = glow;
      this.data[d + 3] = face;
    }
    const io = q * 6;
    // flip the diagonal so AO interpolates without the classic anisotropy artefact
    if (ao[0] + ao[2] < ao[1] + ao[3]) {
      this.idx[io] = vb + 1; this.idx[io + 1] = vb + 2; this.idx[io + 2] = vb + 3;
      this.idx[io + 3] = vb + 1; this.idx[io + 4] = vb + 3; this.idx[io + 5] = vb;
    } else {
      this.idx[io] = vb; this.idx[io + 1] = vb + 1; this.idx[io + 2] = vb + 2;
      this.idx[io + 3] = vb; this.idx[io + 4] = vb + 2; this.idx[io + 5] = vb + 3;
    }
  }

  build(): MeshBuffers | null {
    if (this.quads === 0) return null;
    const nv = this.quads * 4;
    const ni = this.quads * 6;
    const idx = nv > 65535 ? this.idx.slice(0, ni) : Uint16Array.from(this.idx.subarray(0, ni));
    return {
      pos: this.pos.slice(0, nv * 3),
      nrm: this.nrm.slice(0, nv * 3),
      data: this.data.slice(0, nv * 4),
      idx,
    };
  }
}

const opaqueB = new Builder();
const transB = new Builder();
const maskO = new Int32Array(CS * CS);
const maskT = new Int32Array(CS * CS);

export function glowLevel(m: number, t: number): number {
  if (t < 480 || m === M.LAVA) return 0;
  return Math.min(7, Math.floor((t - 480) / 120) + 1);
}

export function meshChunk(world: World, c: number): ChunkMesh {
  const { mat, temp } = world;
  const ccx = c % CX, ccz = Math.floor(c / CX) % CZ, ccy = Math.floor(c / (CX * CZ));
  const ox = ccx * CS, oy = ccy * CS, oz = ccz * CS;

  const get = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return M.AIR;
    return mat[x + z * SX + y * LAYER];
  };
  const occ = (x: number, y: number, z: number): number => T_OPAQUE[get(x, y, z)];

  opaqueB.reset();
  transB.reset();
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  const du = [0, 0, 0];
  const dv = [0, 0, 0];
  const nrm = [0, 0, 0];
  const ao = [0, 0, 0, 0];
  const verts = new Array(12);

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const eu = [0, 0, 0], ev = [0, 0, 0];
    eu[u] = 1; ev[v] = 1;
    for (let side = -1; side <= 1; side += 2) {
      const face = d * 2 + (side > 0 ? 0 : 1);
      nrm[0] = nrm[1] = nrm[2] = 0;
      nrm[d] = side;
      for (let s = 0; s < CS; s++) {
        // build masks
        for (let j = 0; j < CS; j++) {
          for (let i = 0; i < CS; i++) {
            p[d] = s; p[u] = i; p[v] = j;
            const wx = ox + p[0], wy = oy + p[1], wz = oz + p[2];
            const m = mat[wx + wz * SX + wy * LAYER];
            const mi = i + j * CS;
            maskO[mi] = 0;
            maskT[mi] = 0;
            if (m === M.AIR) continue;
            const isO = T_OPAQUE[m], isT = T_TRANSLUCENT[m];
            if (!isO && !isT) continue;
            q[0] = wx; q[1] = wy; q[2] = wz;
            q[d] += side;
            const nm = get(q[0], q[1], q[2]);
            let visible = false;
            if (isO) visible = !T_OPAQUE[nm];
            else visible = nm !== m && !T_OPAQUE[nm];
            if (!visible) continue;
            // AO from the 8 cells around the face in the outward layer
            let a0, a1, a2, a3;
            {
              const bx = q[0], by = q[1], bz = q[2];
              const s_u0 = occ(bx - eu[0], by - eu[1], bz - eu[2]);
              const s_u1 = occ(bx + eu[0], by + eu[1], bz + eu[2]);
              const s_v0 = occ(bx - ev[0], by - ev[1], bz - ev[2]);
              const s_v1 = occ(bx + ev[0], by + ev[1], bz + ev[2]);
              const c00 = occ(bx - eu[0] - ev[0], by - eu[1] - ev[1], bz - eu[2] - ev[2]);
              const c10 = occ(bx + eu[0] - ev[0], by + eu[1] - ev[1], bz + eu[2] - ev[2]);
              const c11 = occ(bx + eu[0] + ev[0], by + eu[1] + ev[1], bz + eu[2] + ev[2]);
              const c01 = occ(bx - eu[0] + ev[0], by - eu[1] + ev[1], bz - eu[2] + ev[2]);
              a0 = vao(s_u0, s_v0, c00);
              a1 = vao(s_u1, s_v0, c10);
              a2 = vao(s_u1, s_v1, c11);
              a3 = vao(s_u0, s_v1, c01);
            }
            const glow = isO ? glowLevel(m, temp[wx + wz * SX + wy * LAYER]) : 0;
            const key = 1 + m + (glow << 5) + (a0 << 8) + (a1 << 10) + (a2 << 12) + (a3 << 14);
            if (isO) maskO[mi] = key;
            else maskT[mi] = key;
          }
        }
        greedy(maskO, opaqueB);
        greedy(maskT, transB);

        function greedy(mask: Int32Array, b: Builder) {
          for (let j = 0; j < CS; j++) {
            for (let i = 0; i < CS;) {
              const key = mask[i + j * CS];
              if (key === 0) { i++; continue; }
              let w = 1;
              while (i + w < CS && mask[i + w + j * CS] === key) w++;
              let h = 1;
              outer: while (j + h < CS) {
                for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * CS] !== key) break outer;
                h++;
              }
              for (let hh = 0; hh < h; hh++) for (let k = 0; k < w; k++) mask[i + k + (j + hh) * CS] = 0;

              const k0 = key - 1;
              const m = k0 & 31;
              const glow = (k0 >> 5) & 7;
              ao[0] = (k0 >> 8) & 3; ao[1] = (k0 >> 10) & 3; ao[2] = (k0 >> 12) & 3; ao[3] = (k0 >> 14) & 3;
              // corners
              const plane = side > 0 ? s + 1 : s;
              du[0] = du[1] = du[2] = 0; dv[0] = dv[1] = dv[2] = 0;
              du[u] = w; dv[v] = h;
              const base = [0, 0, 0];
              base[d] = plane; base[u] = i; base[v] = j;
              // corner order (u0v0, u1v0, u1v1, u0v1) is CCW from +d
              const c0 = base, c1 = [base[0] + du[0], base[1] + du[1], base[2] + du[2]];
              const c2 = [c1[0] + dv[0], c1[1] + dv[1], c1[2] + dv[2]];
              const c3 = [base[0] + dv[0], base[1] + dv[1], base[2] + dv[2]];
              if (side > 0) {
                verts[0] = c0[0]; verts[1] = c0[1]; verts[2] = c0[2];
                verts[3] = c1[0]; verts[4] = c1[1]; verts[5] = c1[2];
                verts[6] = c2[0]; verts[7] = c2[1]; verts[8] = c2[2];
                verts[9] = c3[0]; verts[10] = c3[1]; verts[11] = c3[2];
                b.quad(verts, nrm, m, ao, glow, face);
              } else {
                // reverse winding: c0, c3, c2, c1
                verts[0] = c0[0]; verts[1] = c0[1]; verts[2] = c0[2];
                verts[3] = c3[0]; verts[4] = c3[1]; verts[5] = c3[2];
                verts[6] = c2[0]; verts[7] = c2[1]; verts[8] = c2[2];
                verts[9] = c1[0]; verts[10] = c1[1]; verts[11] = c1[2];
                const aoR = [ao[0], ao[3], ao[2], ao[1]];
                b.quad(verts, nrm, m, aoR, glow, face);
              }
              i += w;
            }
          }
        }
      }
    }
  }

  // material copy + glow stats
  const mats = new Uint8Array(CS * CS * CS);
  let lava = 0, lx = 0, ly = 0, lz = 0;
  for (let y = 0; y < CS; y++) {
    for (let z = 0; z < CS; z++) {
      const row = ox + (oz + z) * SX + (oy + y) * LAYER;
      for (let x = 0; x < CS; x++) {
        const m = mat[row + x];
        mats[x + z * CS + y * CS * CS] = m;
        if (m === M.LAVA) {
          lava++;
          lx += x; ly += y; lz += z;
        }
      }
    }
  }
  return {
    c,
    opaque: opaqueB.build(),
    trans: transB.build(),
    mats,
    lava,
    lavaPos: lava ? [ox + lx / lava + 0.5, oy + ly / lava + 1.5, oz + lz / lava + 0.5] : [0, 0, 0],
  };
}

function vao(s1: number, s2: number, c: number): number {
  if (s1 && s2) return 0;
  return 3 - (s1 + s2 + c);
}

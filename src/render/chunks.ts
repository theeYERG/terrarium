// Holds one opaque + one translucent mesh per chunk and swaps in new geometry as the
// worker sends it. Also keeps the main-thread mirror of the material grid for raycasts.

import * as THREE from 'three';
import { CHUNKS, CS, CX, CZ, LAYER, SX, VOLUME } from '../sim/constants.ts';
import { POS_OFFSET, POS_SCALE, type ChunkMesh, type MeshBuffers } from '../sim/mesher.ts';
import { createChunkMaterials } from './chunkMaterial.ts';

export class ChunkManager {
  group = new THREE.Group();
  mats = new Uint8Array(VOLUME); // mirror of the worker's material grid
  private opaque: (THREE.Mesh | null)[] = new Array(CHUNKS).fill(null);
  private trans: (THREE.Mesh | null)[] = new Array(CHUNKS).fill(null);
  materials = createChunkMaterials();
  pending: ChunkMesh[] = [];
  triangles = 0;

  /** queue chunk meshes; they are uploaded a few per frame in flush() */
  receive(list: ChunkMesh[]) {
    for (const m of list) {
      // replace any older queued version of the same chunk
      const k = this.pending.findIndex((p) => p.c === m.c);
      if (k >= 0) this.pending[k] = m;
      else this.pending.push(m);
    }
  }

  flush(maxMs = 4, all = false) {
    const t0 = performance.now();
    while (this.pending.length && (all || performance.now() - t0 < maxMs)) {
      this.apply(this.pending.shift()!);
    }
  }

  private apply(m: ChunkMesh) {
    const c = m.c;
    const ccx = c % CX, ccz = Math.floor(c / CX) % CZ, ccy = Math.floor(c / (CX * CZ));
    const ox = ccx * CS, oy = ccy * CS, oz = ccz * CS;
    // mirror materials
    for (let y = 0; y < CS; y++) for (let z = 0; z < CS; z++) {
      const dst = ox + (oz + z) * SX + (oy + y) * LAYER;
      const src = z * CS + y * CS * CS;
      this.mats.set(m.mats.subarray(src, src + CS), dst);
    }
    this.opaque[c] = this.update(this.opaque[c], m.opaque, this.materials.opaque, ox, oy, oz, false);
    this.trans[c] = this.update(this.trans[c], m.trans, this.materials.trans, ox, oy, oz, true);
  }

  private update(mesh: THREE.Mesh | null, buf: MeshBuffers | null, material: THREE.Material, ox: number, oy: number, oz: number, translucent: boolean) {
    if (!buf) {
      if (mesh) {
        this.triangles -= (mesh.geometry.index?.count ?? 0) / 3;
        mesh.geometry.dispose();
        this.group.remove(mesh);
      }
      return null;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(buf.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(buf.nrm, 3, true));
    g.setAttribute('aData', new THREE.BufferAttribute(buf.data, 4));
    g.setIndex(new THREE.BufferAttribute(buf.idx, 1));
    const ext = (CS + POS_OFFSET * 2) * POS_SCALE;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(ext, ext, ext));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(ext / 2, ext / 2, ext / 2), ext * 0.87);
    this.triangles += buf.idx.length / 3;
    if (mesh) {
      this.triangles -= (mesh.geometry.index?.count ?? 0) / 3;
      mesh.geometry.dispose();
      mesh.geometry = g;
      return mesh;
    }
    const nm = new THREE.Mesh(g, material);
    nm.position.set(ox - POS_OFFSET, oy - POS_OFFSET, oz - POS_OFFSET);
    nm.scale.setScalar(1 / POS_SCALE);
    nm.matrixAutoUpdate = false;
    nm.updateMatrix();
    nm.castShadow = !translucent;
    nm.receiveShadow = true;
    if (translucent) nm.renderOrder = 1;
    this.group.add(nm);
    return nm;
  }

  matAt(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= 64 || z >= SX) return 0;
    return this.mats[x + z * SX + y * LAYER];
  }
}

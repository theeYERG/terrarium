// Terrain + liquid chunk meshes (low poly, flat shaded) and the main-thread mirror of the
// grid used for raycasting. Chunk meshes arrive from the worker as non-indexed triangle
// soups; the terrain shader blends colours after material changes and adds heat glow,
// the liquid shader does waves, depth colour, fresnel, foam and lava.

import * as THREE from 'three';
import { CHUNKS, CS, CX, CZ, LAYER, SX, VOLUME } from '../sim/constants.ts';
import { M } from '../sim/materials.ts';
import type { ChunkMesh, LiquidBuffers, TerrainBuffers } from '../sim/mesher.ts';

export const terrainUniforms = {
  uSimTime: { value: 0 },
  uTime: { value: 0 },
  uNight: { value: 0 },
};

function makeTerrainMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.3 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSimTime = terrainUniforms.uSimTime;
    sh.uniforms.uTime = terrainUniforms.uTime;
    sh.vertexShader = /* glsl */ `
      attribute vec3 aCol0;
      attribute float aChange;
      attribute vec4 aAux;
      uniform float uSimTime;
      varying float vGlow;
      vec3 s2l(vec3 c) { return pow(c, vec3(2.2)); }
    ` + sh.vertexShader.replace('#include <color_vertex>', /* glsl */ `
      #include <color_vertex>
      {
        // ease from the previous material's colour to the new one
        float tt = clamp((uSimTime - aChange) / 0.45, 0.0, 1.0);
        tt = tt * tt * (3.0 - 2.0 * tt);
        vColor.rgb = mix(s2l(aCol0), s2l(color.rgb), tt);
        vGlow = aAux.x / 255.0;
      }
    `);
    sh.fragmentShader = /* glsl */ `
      varying float vGlow;
      uniform float uTime;
    ` + sh.fragmentShader.replace('#include <emissivemap_fragment>', /* glsl */ `
      #include <emissivemap_fragment>
      if (vGlow > 0.0) {
        vec3 bb = mix(vec3(0.7, 0.05, 0.0), vec3(1.0, 0.45, 0.08), smoothstep(0.0, 0.6, vGlow));
        bb = mix(bb, vec3(1.0, 0.85, 0.55), smoothstep(0.6, 1.0, vGlow));
        totalEmissiveRadiance += bb * vGlow * 3.0;
      }
    `);
  };
  mat.customProgramCacheKey = () => 'lowpoly-terrain';
  return mat;
}

function makeLiquidMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.22, metalness: 0, transparent: true, depthWrite: false, flatShading: true, envMapIntensity: 0.25,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = terrainUniforms.uTime;
    sh.uniforms.uNight = terrainUniforms.uNight;
    sh.vertexShader = /* glsl */ `
      attribute vec4 aAux;
      uniform float uTime;
      varying vec4 vLiq; // type, depth, foam, heat (0..1)
      varying vec3 vWPos;
    ` + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */ `
      #include <begin_vertex>
      vLiq = vec4(aAux.x, aAux.y / 255.0, aAux.z / 255.0, aAux.w / 255.0);
      {
        vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
        // gentle waves on upward faces: same world position => same offset, so no cracks
        float amp = vLiq.x > 7.5 && vLiq.x < 8.5 ? 0.035 : vLiq.x > 6.5 && vLiq.x < 7.5 ? 0.05 : 0.08;
        float up = step(0.3, normal.y);
        float wv = sin(wp.x * 0.55 + uTime * 1.3) * 0.5 + sin(wp.z * 0.7 - uTime * 1.05) * 0.35 + sin((wp.x + wp.z) * 1.3 + uTime * 2.1) * 0.15;
        transformed.y += wv * amp * up * smoothstep(0.0, 0.25, vLiq.y);
      }
    `).replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = /* glsl */ `
      uniform float uTime;
      uniform float uNight;
      varying vec4 vLiq;
      varying vec3 vWPos;
      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
    ` + sh.fragmentShader
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        float lt = vLiq.x;
        float depth = vLiq.y;
        vec3 V = normalize(cameraPosition - vWPos);
        float facing = abs(dot(V, vec3(0.0, 1.0, 0.0)));
        float fres = pow(1.0 - clamp(facing, 0.0, 1.0), 3.0);
        float alpha = 0.6;
        vec3 col;
        if (lt > 7.5 && lt < 8.5) {            // lava
          float hot = vLiq.w;
          float n = vn(vWPos.xz * 0.6 + vec2(uTime * 0.12, -uTime * 0.08)) * 0.6 + vn(vWPos.xz * 1.7 - uTime * 0.2) * 0.4;
          float crust = smoothstep(0.75, 0.3, hot + n * 0.25);
          col = mix(vec3(1.0, 0.42, 0.08), vec3(0.16, 0.09, 0.08), crust);
          alpha = 1.0;
        } else if (lt > 6.5 && lt < 7.5) {     // oil
          col = mix(vec3(0.06, 0.035, 0.015), vec3(0.015, 0.008, 0.004), smoothstep(0.0, 0.5, depth));
          alpha = 0.9;
        } else if (lt > 15.5) {                 // acid
          col = mix(vec3(0.45, 0.95, 0.1), vec3(0.1, 0.45, 0.02), smoothstep(0.0, 0.6, depth));
          alpha = 0.78;
        } else {                                // water
          // (linear colours) turquoise shallows -> teal -> deep blue
          col = mix(vec3(0.12, 0.48, 0.5), vec3(0.02, 0.17, 0.33), smoothstep(0.0, 0.45, depth));
          col = mix(col, vec3(0.006, 0.06, 0.17), smoothstep(0.45, 1.0, depth));
          alpha = mix(0.55, 0.93, smoothstep(0.0, 0.6, depth));
        }
        // foam at shores, impacts and fast flow: broken, slowly drifting
        float foamN = vn(vWPos.xz * 2.3 + vec2(uTime * 0.3, uTime * 0.2));
        float foam = smoothstep(0.35, 0.9, vLiq.z * (0.55 + foamN * 0.7)) * (lt > 7.5 && lt < 8.5 ? 0.0 : 1.0);
        col = mix(col, vec3(0.85, 0.92, 0.95) * (1.0 - uNight * 0.6), foam * 0.85);
        alpha = max(alpha, foam * 0.92);
        col += vec3(0.1, 0.18, 0.26) * fres * (1.0 - uNight) * 0.5;
        alpha = clamp(alpha + fres * 0.25, 0.0, 1.0);
        diffuseColor = vec4(col, alpha);
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        if (vLiq.x > 7.5 && vLiq.x < 8.5) {
          float n2 = vn(vWPos.xz * 0.6 + vec2(uTime * 0.12, -uTime * 0.08));
          float glow = smoothstep(0.2, 0.9, vLiq.w + n2 * 0.3);
          totalEmissiveRadiance += vec3(1.0, 0.35, 0.06) * glow * 3.2;
        } else if (vLiq.x > 15.5) {
          totalEmissiveRadiance += vec3(0.2, 0.5, 0.05) * 0.4;
        }
      `);
  };
  mat.customProgramCacheKey = () => 'lowpoly-liquid';
  return mat;
}

export class TerrainManager {
  group = new THREE.Group();
  mats = new Uint8Array(VOLUME);
  fills = new Uint8Array(VOLUME);
  private terrain: (THREE.Mesh | null)[] = new Array(CHUNKS).fill(null);
  private liquid: (THREE.Mesh | null)[] = new Array(CHUNKS).fill(null);
  terrainMat = makeTerrainMaterial();
  liquidMat = makeLiquidMaterial();
  pending: ChunkMesh[] = [];
  triangles = 0;

  receive(list: ChunkMesh[]) {
    for (const m of list) {
      const k = this.pending.findIndex((p) => p.c === m.c);
      if (k >= 0) {
        // a newer liquid-only update must not drop a pending terrain update
        const old = this.pending[k];
        if (!m.hasTerrain && old.hasTerrain) { m.hasTerrain = true; m.terrain = old.terrain; }
        this.pending[k] = m;
      } else this.pending.push(m);
    }
  }

  flush(maxMs = 4, all = false) {
    const t0 = performance.now();
    while (this.pending.length && (all || performance.now() - t0 < maxMs)) this.apply(this.pending.shift()!);
  }

  private apply(m: ChunkMesh) {
    const c = m.c;
    const ccx = c % CX, ccz = Math.floor(c / CX) % CZ, ccy = Math.floor(c / (CX * CZ));
    const ox = ccx * CS, oy = ccy * CS, oz = ccz * CS;
    for (let y = 0; y < CS; y++) for (let z = 0; z < CS; z++) {
      const dst = ox + (oz + z) * SX + (oy + y) * LAYER;
      const src = z * CS + y * CS * CS;
      this.mats.set(m.mats.subarray(src, src + CS), dst);
      this.fills.set(m.fills.subarray(src, src + CS), dst);
    }
    if (m.hasTerrain) this.terrain[c] = this.updateTerrain(this.terrain[c], m.terrain, ox, oy, oz);
    this.liquid[c] = this.updateLiquid(this.liquid[c], m.liquid, ox, oy, oz);
  }

  private place(mesh: THREE.Mesh, ox: number, oy: number, oz: number) {
    mesh.position.set(ox, oy, oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
  }

  private dispose(mesh: THREE.Mesh | null) {
    if (!mesh) return;
    this.triangles -= mesh.geometry.attributes.position.count / 3;
    mesh.geometry.dispose();
  }

  private updateTerrain(mesh: THREE.Mesh | null, b: TerrainBuffers | null, ox: number, oy: number, oz: number) {
    if (!b) {
      if (mesh) { this.dispose(mesh); this.group.remove(mesh); }
      return null;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.nrm, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(b.col, 3, true));
    g.setAttribute('aCol0', new THREE.BufferAttribute(b.col0, 3, true));
    g.setAttribute('aChange', new THREE.BufferAttribute(b.tchg, 1));
    g.setAttribute('aAux', new THREE.BufferAttribute(b.aux, 4));
    bounds(g);
    this.triangles += b.pos.length / 9;
    if (mesh) { this.dispose(mesh); mesh.geometry = g; return mesh; }
    const nm = new THREE.Mesh(g, this.terrainMat);
    nm.castShadow = true;
    nm.receiveShadow = true;
    this.place(nm, ox, oy, oz);
    return nm;
  }

  private updateLiquid(mesh: THREE.Mesh | null, b: LiquidBuffers | null, ox: number, oy: number, oz: number) {
    if (!b) {
      if (mesh) { this.dispose(mesh); this.group.remove(mesh); }
      return null;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.nrm, 3, true));
    g.setAttribute('aAux', new THREE.BufferAttribute(b.aux, 4));
    bounds(g);
    this.triangles += b.pos.length / 9;
    if (mesh) { this.dispose(mesh); mesh.geometry = g; return mesh; }
    const nm = new THREE.Mesh(g, this.liquidMat);
    nm.receiveShadow = true;
    nm.renderOrder = 1;
    this.place(nm, ox, oy, oz);
    return nm;
  }

  matAt(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= 64 || z >= SX) return 0;
    return this.mats[x + z * SX + y * LAYER];
  }

  fillAt(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= 64 || z >= SX) return 0;
    return this.fills[x + z * SX + y * LAYER];
  }

  /** Is there solid terrain (at least half full) in this cell? */
  solidAt(x: number, y: number, z: number): boolean {
    const m = this.matAt(x, y, z);
    if (m === M.AIR || m === M.WATER || m === M.OIL || m === M.LAVA || m === M.ACID) return false;
    return this.fillAt(x, y, z) >= 128;
  }
}

function bounds(g: THREE.BufferGeometry) {
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1.5, -1.5, -1.5), new THREE.Vector3(CS + 1.5, CS + 1.5, CS + 1.5));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(CS / 2, CS / 2, CS / 2), CS * 0.95);
}

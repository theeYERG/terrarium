// Chunk materials: MeshStandardMaterial patched with onBeforeCompile so we keep three's
// lighting + shadows while adding a per-material palette, per-voxel colour variation,
// baked vertex AO, heat glow, animated lava, and shimmering liquid surfaces.

import * as THREE from 'three';
import { M, MATERIALS, MAT_COUNT } from '../sim/materials.ts';

export const sharedUniforms = {
  uTime: { value: 0 },
  uMatTex: { value: null as THREE.DataTexture | null },
  uNight: { value: 0 },
};

// material "kind" codes used in the shader
const KIND: Record<number, number> = {
  [M.GRASS]: 1, [M.LAVA]: 2, [M.WATER]: 3, [M.GLASS]: 4, [M.METAL]: 5, [M.ICE]: 6, [M.EMBER]: 7,
  [M.ACID]: 8, [M.OIL]: 9, [M.OBSIDIAN]: 10, [M.SPRING]: 11, [M.LEAVES]: 12, [M.SNOW]: 13, [M.SAND]: 14,
};

function buildMatTexture(): THREE.DataTexture {
  const W = 32;
  const data = new Float32Array(W * 4 * 4);
  const lin = (hex: number) => new THREE.Color(hex).convertSRGBToLinear();
  for (let m = 0; m < MAT_COUNT; m++) {
    const mm = MATERIALS[m];
    const c1 = lin(mm.color);
    const c2 = lin(mm.color2 >= 0 ? mm.color2 : mm.color);
    const set = (row: number, r: number, g: number, b: number, a: number) => {
      const o = (row * W + m) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    };
    set(0, c1.r, c1.g, c1.b, 1);
    set(1, c2.r, c2.g, c2.b, 1);
    set(2, mm.variation, mm.alpha, mm.emissive, KIND[m] ?? 0);
    // roughness, metalness
    const rough = m === M.METAL ? 0.32 : m === M.OBSIDIAN ? 0.22 : m === M.ICE ? 0.12 : m === M.GLASS ? 0.04
      : m === M.WATER || m === M.OIL || m === M.ACID ? 0.14 : m === M.SNOW ? 0.75 : m === M.LEAVES ? 0.8 : 0.92;
    const metal = m === M.METAL ? 0.75 : 0;
    set(3, rough, metal, 0, 0);
  }
  const tex = new THREE.DataTexture(data, W, 4, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

const COMMON = /* glsl */ `
uniform sampler2D uMatTex;
uniform float uTime;
uniform float uNight;
varying vec3 vWPos;
varying vec3 vWNrm;
flat varying int vMat;
varying float vAO;
varying float vGlow;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0)), n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1)), n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
`;

const VERT_HEAD = /* glsl */ `
attribute vec4 aData;
varying vec3 vWPos;
varying vec3 vWNrm;
flat varying int vMat;
varying float vAO;
varying float vGlow;
`;

const VERT_BODY = /* glsl */ `
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNrm = normal;
vMat = int(aData.x + 0.5);
vAO = aData.y / 3.0;
vGlow = aData.z / 7.0;
`;

const FRAG_COLOR = /* glsl */ `
vec4 mc1 = texelFetch(uMatTex, ivec2(vMat, 0), 0);
vec4 mc2 = texelFetch(uMatTex, ivec2(vMat, 1), 0);
vec4 mpr = texelFetch(uMatTex, ivec2(vMat, 2), 0);
int kind = int(mpr.w + 0.5);
vec3 cell = floor(vWPos - vWNrm * 0.5);
float hv = hash13(cell);
float patchN = vnoise(vWPos * 0.11);
vec3 col = mix(mc1.rgb, mc2.rgb, smoothstep(0.25, 0.85, hv * 0.55 + patchN * 0.6));
col *= 1.0 + (hv - 0.5) * 2.0 * mpr.x;
// fine texel detail inside each voxel (4x4 "pixels" per face)
float tex = hash13(floor(vWPos * 4.0 + vWNrm * 0.01) + cell * 3.17);
if (mpr.y > 0.99) col *= 1.0 + (tex - 0.5) * mpr.x * 0.9;
if (kind == 1 && vWNrm.y < 0.5) {
  // grass block sides: dirt with a ragged green fringe on top
  vec3 dirt = texelFetch(uMatTex, ivec2(2, 0), 0).rgb;
  float fy = fract(vWPos.y);
  float along = abs(vWNrm.x) > 0.5 ? vWPos.z : vWPos.x;
  float edge = 0.5 - 0.2 * hash13(vec3(floor(along * 4.0), cell.y, cell.x + cell.z));
  if (vWNrm.y < -0.5 || fy < edge) col = dirt * (1.0 + (tex - 0.5) * 0.2) * (1.0 + (hv - 0.5) * 0.2);
}
if (kind == 1 && vWNrm.y > 0.5) {
  col *= 0.9 + 0.25 * vnoise(vWPos * 0.6);
}
if (kind == 14) col *= 0.96 + 0.08 * vnoise(vWPos * 1.7);
diffuseColor.rgb *= col;
`;

const FRAG_EMISSIVE = /* glsl */ `
{
  float tt = uTime;
  if (kind == 2) {
    // lava: flowing bright veins with a darker crust
    float n1 = vnoise(vWPos * 0.45 + vec3(0.0, -tt * 0.25, tt * 0.18));
    float n2 = vnoise(vWPos * 1.3 + vec3(tt * 0.3, 0.0, -tt * 0.2));
    float v = smoothstep(0.35, 0.8, n1 * 0.7 + n2 * 0.45);
    vec3 hot = mix(vec3(1.0, 0.18, 0.02), vec3(1.0, 0.62, 0.15), v);
    totalEmissiveRadiance += hot * (1.6 + 2.6 * v);
    diffuseColor.rgb *= 0.25;
  } else if (kind == 7) {
    totalEmissiveRadiance += vec3(1.0, 0.45, 0.08) * (2.5 + 1.5 * sin(tt * 13.0 + hv * 40.0));
  } else if (kind == 11) {
    float s = step(0.86, hash13(floor(vWPos * 4.0) + floor(tt * 2.0)));
    totalEmissiveRadiance += vec3(0.25, 0.7, 0.9) * s * 0.6;
  }
#ifndef VOXEL_TRANSLUCENT
  if (vGlow > 0.0) {
    // blackbody-ish: dull red -> orange -> yellow-white
    vec3 bb = mix(vec3(0.7, 0.04, 0.0), vec3(1.0, 0.45, 0.08), smoothstep(0.0, 0.6, vGlow));
    bb = mix(bb, vec3(1.0, 0.85, 0.55), smoothstep(0.6, 1.0, vGlow));
    totalEmissiveRadiance += bb * vGlow * 3.2;
  }
#endif
}
`;

const FRAG_AO = /* glsl */ `
{
  float aoF = mix(0.3, 1.0, vAO * vAO * 0.4 + vAO * 0.6);
  reflectedLight.indirectDiffuse *= aoF;
  reflectedLight.indirectSpecular *= aoF;
  reflectedLight.directDiffuse *= mix(0.6, 1.0, vAO);
}
`;

const FRAG_ROUGH = /* glsl */ `
{
  vec4 mrm = texelFetch(uMatTex, ivec2(vMat, 3), 0);
  roughnessFactor = mrm.x;
}
`;

// liquid surface ripples: perturb the normal on top faces
const FRAG_NORMAL = /* glsl */ `
{
  vec4 lpr = texelFetch(uMatTex, ivec2(vMat, 2), 0);
  int lk = int(lpr.w + 0.5);
  if ((lk == 3 || lk == 8 || lk == 9) && vWNrm.y > 0.5) {
    float tt = uTime;
    vec3 p = vWPos * vec3(0.32, 0.0, 0.32);
    float e = 0.25;
    float h0 = vnoise(p + vec3(tt * 0.6, 0.0, tt * 0.4)) + 0.5 * vnoise(p * 2.3 + vec3(-tt * 0.9, 0.0, tt * 0.7));
    float hx = vnoise(p + vec3(e, 0.0, 0.0) + vec3(tt * 0.6, 0.0, tt * 0.4)) + 0.5 * vnoise((p + vec3(e, 0.0, 0.0)) * 2.3 + vec3(-tt * 0.9, 0.0, tt * 0.7));
    float hz = vnoise(p + vec3(0.0, 0.0, e) + vec3(tt * 0.6, 0.0, tt * 0.4)) + 0.5 * vnoise((p + vec3(0.0, 0.0, e)) * 2.3 + vec3(-tt * 0.9, 0.0, tt * 0.7));
    float amp = 0.9 * smoothstep(260.0, 60.0, length(cameraPosition - vWPos));
    vec3 nW = normalize(vec3((h0 - hx) * amp, 1.0, (h0 - hz) * amp));
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  }
}
`;

const FRAG_ALPHA = /* glsl */ `
{
  vec4 apr = texelFetch(uMatTex, ivec2(vMat, 2), 0);
  int ak = int(apr.w + 0.5);
  float a = apr.y;
  vec3 V = normalize(cameraPosition - vWPos);
  float fres = pow(1.0 - clamp(abs(dot(V, vWNrm)), 0.0, 1.0), 3.0);
  if (ak == 4 || ak == 6) {
    // glass / ice: frame each voxel so it reads as blocks of glass
    vec3 f = fract(vWPos);
    vec3 d = min(f, 1.0 - f);
    float e1 = abs(vWNrm.x) > 0.5 ? min(d.y, d.z) : abs(vWNrm.y) > 0.5 ? min(d.x, d.z) : min(d.x, d.y);
    float frame = 1.0 - smoothstep(0.03, 0.07, e1);
    a = mix(a, 0.75, frame);
    diffuseColor.rgb *= mix(1.0, 0.8, frame);
  }
  if (ak == 3 || ak == 8 || ak == 9) {
    // deeper liquid: darker and more opaque; shallow water gets a turquoise tint
    float depth = vGlow;
    if (ak == 3) diffuseColor.rgb = mix(vec3(0.16, 0.55, 0.62), diffuseColor.rgb, smoothstep(0.0, 0.45, depth));
    diffuseColor.rgb *= mix(1.05, 0.5, depth);
    a = mix(a, 0.93, smoothstep(0.0, 0.85, depth));
  }
  if (ak == 3) {
    float sparkle = pow(vnoise(vWPos * 1.6 + vec3(uTime * 0.9, 0.0, -uTime * 0.7)), 10.0) * 2.0;
    if (vWNrm.y > 0.5) totalEmissiveRadiance += vec3(0.7, 0.85, 1.0) * sparkle * (1.0 - uNight) * 0.15 * smoothstep(200.0, 50.0, length(cameraPosition - vWPos));
  }
  if (ak == 8) totalEmissiveRadiance += vec3(0.25, 0.6, 0.05) * 0.5;
  diffuseColor.a = clamp(a + fres * 0.35, 0.0, 1.0);
}
`;

const FRAG_TRANS_SPEC = /* glsl */ `
reflectedLight.directSpecular *= 0.3;
`;

function patch(mat: THREE.MeshStandardMaterial, translucent: boolean) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uMatTex = sharedUniforms.uMatTex;
    shader.uniforms.uNight = sharedUniforms.uNight;
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\n' + VERT_BODY);
    let fs = (translucent ? '#define VOXEL_TRANSLUCENT\n' : '') + COMMON + shader.fragmentShader;
    fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR);
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + FRAG_ROUGH);
    fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n{ vec4 mrm2 = texelFetch(uMatTex, ivec2(vMat, 3), 0); metalnessFactor = mrm2.y; }');
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + FRAG_EMISSIVE + (translucent ? FRAG_ALPHA : ''));
    fs = fs.replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + FRAG_AO + (translucent ? FRAG_TRANS_SPEC : ''));
    if (translucent) fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => (translucent ? 'voxel-trans' : 'voxel-opaque');
}

export function createChunkMaterials() {
  sharedUniforms.uMatTex.value = buildMatTexture();
  const opaque = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.35 });
  patch(opaque, false);
  const trans = new THREE.MeshStandardMaterial({
    roughness: 0.08, metalness: 0, transparent: true, depthWrite: false, envMapIntensity: 0.3,
  });
  patch(trans, true);
  return { opaque, trans };
}

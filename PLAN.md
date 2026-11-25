# Terrarium – Architecture Plan

## Overview

```
 main thread                                   sim worker (src/sim/worker.ts)
 ─────────────────────────────                 ─────────────────────────────────────
 main.ts      boot, loading screen             World: typed arrays (mat, temp, life, flags)
 render/      Three.js scene, chunks,   <───   tick(): cellular automaton over awake chunks
              sky, water, post-fx,             mesher: greedy mesh + per-vertex AO for
              particles, debris                        dirty chunks -> transferable buffers
 ui/          toolbar, palette, HUD            debris: flying voxels (explosions, collapse)
 input.ts     raycast (DDA on mirror grid),    structure: connectivity check after removal
              brush, strokes            ───>   tools: add/erase/dig/heat/cool/explode/pour
 audio/       WebAudio synth (no assets)       undo snapshots (RLE), save/load encode
```

* Grid **128 × 64 × 128** (x, y, z), index `x + z*128 + y*128*128` (y-major so a
  horizontal layer is contiguous). Chunks are **16³** → 8 × 4 × 8 = 256 chunks.
* Per-cell arrays: `mat:Uint8`, `temp:Float32` (°C), `life:Uint8` (fire/gas lifetime),
  `flags:Uint8` (source bit, moved-this-tick parity bit).
* Main thread keeps a **mirror of `mat`** (the worker ships each remeshed chunk's
  materials) so raycasting is an exact voxel DDA with no worker round trip.
* Only **awake chunks** are simulated. A chunk wakes when anything in or next to it
  changes, and stays awake while it holds moving cells or temperatures away from ambient.
* Greedy meshing per chunk, two meshes per chunk: opaque and translucent (water, oil,
  acid, ice, glass). Per-voxel colour variation is done in the shader from the world
  cell position, so greedy merging still works. AO is per vertex (merge only equal AO).
* Gases (fire, smoke, steam) are drawn as soft point sprites, not cubes.
* Flying debris is an `InstancedMesh`; the worker simulates it and sends positions +
  velocities each tick, the main thread extrapolates between ticks.

## Checklist

### Phase 1 – voxel data + meshing
- [x] material table (density, state, temperatures, flammability, conductivity, colours)
- [x] seeded noise + island generator (layers, lake, waterfall + spring, trees, cave, lava pocket, snowy peak, metal veins)
- [x] greedy chunk mesher with per-vertex AO, opaque/translucent split

### Phase 2 – camera + rendering
- [x] chunk meshes with custom shader (palette, variation, AO, glow)
- [x] orbit camera: right-drag orbit, middle-drag pan, scroll zoom, damping, limits, anti-clip
- [x] sun shadows (PCF soft), hemisphere ambient, fog

### Phase 3 – simulation core
- [x] worker loop with fixed tick rate + speed control + pause
- [x] awake-chunk scheduling, randomized order, moved-parity flags
- [x] powders with angle of repose, liquids with dispersion + density sinking, gases rise/fade
- [x] heat conduction, ambient relaxation, phase changes

### Phase 4 – materials + reactions
- [x] fire (fuel, spread, smoke, embers, burn-out), gunpowder chain explosions
- [x] lava + water → obsidian + steam, acid dissolves, grass spread, mud, steam condensing
- [x] structural support → collapsing debris

### Phase 5 – tools
- [x] add, erase, dig, heat, cool, explode, pour/rain, inspect
- [x] brush preview sphere + face highlight, size with Shift/Ctrl+scroll and [ ]
- [x] hold-to-paint with interpolation between positions

### Phase 6 – visual effects
- [x] bloom, emissive lava/fire, dynamic point lights near lava/fire clusters
- [x] animated translucent water with shimmer, glass/ice transparency
- [x] gradient sky, day/night, sun + moon, stars, fog
- [x] particles: explosion sparks, splashes, smoke puffs, steam hiss, embers
- [x] tilt-shift miniature effect (toggle)

### Phase 7 – UI
- [x] glassy toolbar with icons + tooltips, material palette, settings panel
- [x] shortcuts, pause/speed, FPS counter, undo (20), clear, regenerate w/ seed, save/load, screenshot, cinematic
- [x] title + loading screen, sound (WebAudio, muted until first click), touch support

### Phase 8 – polish
- [x] Playwright scenario tests + screenshots
- [x] profiling (sim tick, remesh, frame time) and optimisation
- [x] picky designer review – 10 fixes
- [x] GitHub repo, Pages workflow, README

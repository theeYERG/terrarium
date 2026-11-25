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
- [ ] material table (density, state, temperatures, flammability, conductivity, colours)
- [ ] seeded noise + island generator (layers, lake, waterfall + spring, trees, cave, lava pocket, snowy peak, metal veins)
- [ ] greedy chunk mesher with per-vertex AO, opaque/translucent split

### Phase 2 – camera + rendering
- [ ] chunk meshes with custom shader (palette, variation, AO, glow)
- [ ] orbit camera: right-drag orbit, middle-drag pan, scroll zoom, damping, limits, anti-clip
- [ ] sun shadows (PCF soft), hemisphere ambient, fog

### Phase 3 – simulation core
- [ ] worker loop with fixed tick rate + speed control + pause
- [ ] awake-chunk scheduling, randomized order, moved-parity flags
- [ ] powders with angle of repose, liquids with dispersion + density sinking, gases rise/fade
- [ ] heat conduction, ambient relaxation, phase changes

### Phase 4 – materials + reactions
- [ ] fire (fuel, spread, smoke, embers, burn-out), gunpowder chain explosions
- [ ] lava + water → obsidian + steam, acid dissolves, grass spread, mud, steam condensing
- [ ] structural support → collapsing debris

### Phase 5 – tools
- [ ] add, erase, dig, heat, cool, explode, pour/rain, inspect
- [ ] brush preview sphere + face highlight, size with Shift/Ctrl+scroll and [ ]
- [ ] hold-to-paint with interpolation between positions

### Phase 6 – visual effects
- [ ] bloom, emissive lava/fire, dynamic point lights near lava/fire clusters
- [ ] animated translucent water with shimmer, glass/ice transparency
- [ ] gradient sky, day/night, sun + moon, stars, fog
- [ ] particles: explosion sparks, splashes, smoke puffs, steam hiss, embers
- [ ] tilt-shift miniature effect (toggle)

### Phase 7 – UI
- [ ] glassy toolbar with icons + tooltips, material palette, settings panel
- [ ] shortcuts, pause/speed, FPS counter, undo (20), clear, regenerate w/ seed, save/load, screenshot, cinematic
- [ ] title + loading screen, sound (WebAudio, muted until first click), touch support

### Phase 8 – polish
- [ ] Playwright scenario tests + screenshots
- [ ] profiling (sim tick, remesh, frame time) and optimisation
- [ ] picky designer review – 10 fixes
- [ ] GitHub repo, Pages workflow, README

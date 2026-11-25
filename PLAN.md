# Terrarium – Plan (v2: low poly + smooth motion)

v1 (blocky voxels, cell-by-cell CA) is described in git history (`git show c5ae228:PLAN.md`).
v2 keeps the voxel grid as the *data* but changes how it is drawn and how things move.

## Architecture

```
 sim worker (one thread)                                    main thread
 ───────────────────────────────────────────────────        ──────────────────────────────────
 grid: mat, fill(0..1), temp, mass(liquid), flux x/z,        terrain chunks: flat-shaded surface-nets
       prevMat + changeTime (colour transitions), foam              meshes, vertex colours, colour lerp
 terrain   : heat, phase changes, burning, powder slump      liquid chunks: one smooth surface per chunk,
 liquids   : mass-based "virtual pipe" flow per layer               waves, depth colour, fresnel, foam
             (levels out, waves, viscosity per liquid)       instanced: grains, rocks, droplets, puffs
 particles : falling liquid (gravity + cohesion + XSPH),     rigid chunk meshes + tree models
             merge back into cells on landing                 interpolation: bodies lerp/slerp between the
 gas       : fire / smoke / steam particles (buoyancy,              last two ticks; particles extrapolate by v
             swirl, fade, heat + ignite, condense)           sky / lights / post / UI / audio (kept)
 physics   : Rapier – terrain trimesh colliders per chunk,
             grains, explosion rocks, tumbling chunks, trees;
             settled bodies shrink while their fill is
             deposited back into the grid
 mesher    : surface nets on fill (terrain) and on liquid
             mass (liquids); only dirty chunks; jittered,
             non-indexed, per-face colours + AO
```

* Tick: fixed 30 Hz. Everything visible is interpolated or extrapolated per render frame.
* A cell is "solid" for physics when `fill >= 0.5`. Brush edits change `fill` with a soft falloff
  over several ticks, so surfaces grow and recede instead of popping.
* Material changes record `prevMat` + `changeTime`; the terrain shader lerps the colour over
  ~0.4 s and the worker emits a puff of particles.

## Phases / checklist

### 1. Smooth terrain mesh
- [ ] `fill` field in the world, generator writes smooth fractional surfaces
- [ ] surface nets mesher (per chunk, dirty-only, in the worker), non-indexed flat triangles
- [ ] position-seeded vertex jitter, per-face colours, material blending at boundaries, AO
- [ ] soft-falloff brush for add / dig / erase / explode; raycast uses fill

### 2. Low poly styling
- [ ] cohesive palette (2–3 shades per material), slope-aware grass/dirt/rock colouring
- [ ] trees (cone pines, icosphere oaks), chunky rocks, grass tufts / flowers as instanced models
- [ ] pastel sky, warm soft light, fog

### 3. Liquid heightfield
- [ ] per-cell liquid mass + face fluxes (virtual pipes) with per-liquid viscosity
- [ ] density sorting (oil floats), lava crust → obsidian, lava + water → steam + obsidian, acid
- [ ] liquid surface mesh: waves, depth colour, fresnel, foam at shores and impacts, faceting

### 4. Liquid particles
- [ ] water leaving a ledge turns into particles; cohesion + XSPH; landing merges into cells
- [ ] waterfall stream look, splashes + spray, foam where they land

### 5. Rigid debris (Rapier)
- [ ] terrain trimesh colliders per chunk, rebuilt with remesh
- [ ] powder grains: unsupported sand/gravel/snow → bodies → settle → merge (shrink + deposit)
- [ ] explosion rocks with velocity; tumbling rigid chunks for unsupported terrain; falling trees

### 6. Particle effects
- [ ] fire / smoke / steam as particles: buoyancy, swirl, eased fade; fire heats + ignites, steam condenses

### 7. Interpolation & transitions
- [ ] snapshot interpolation for bodies, extrapolation for particles, eased camera
- [ ] colour lerp on material change, puffs on state changes, shrink on merge

### 8. Polish
- [ ] profile (sim tick, remesh, physics, render) → steady 60 fps; scale counts down if needed
- [ ] art-director review: 10 fixes
- [ ] tests updated, README + screenshots, deploy

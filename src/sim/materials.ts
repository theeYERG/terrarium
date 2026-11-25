// Material table. Shared by the simulation worker and the renderer/UI.
// Units: temperatures in °C, density in kg/m³ (relative ordering is what matters).

export const State = {
  EMPTY: 0,
  SOLID: 1,
  POWDER: 2,
  LIQUID: 3,
  GAS: 4,
} as const;
export const STATE_NAMES = ['empty', 'solid', 'powder', 'liquid', 'gas'];

export const M = {
  AIR: 0,
  STONE: 1,
  DIRT: 2,
  GRASS: 3,
  SAND: 4,
  GRAVEL: 5,
  WATER: 6,
  OIL: 7,
  LAVA: 8,
  ICE: 9,
  SNOW: 10,
  STEAM: 11,
  SMOKE: 12,
  FIRE: 13,
  WOOD: 14,
  LEAVES: 15,
  ACID: 16,
  GLASS: 17,
  OBSIDIAN: 18,
  MUD: 19,
  GUNPOWDER: 20,
  METAL: 21,
  SPRING: 22,
  EMBER: 23,
} as const;
export const MAT_COUNT = 24;

export interface Material {
  id: number;
  name: string;
  desc: string;
  state: number;
  density: number;
  color: number; // base colour (sRGB hex)
  color2: number; // secondary colour used for variation / grass sides
  variation: number; // per-voxel brightness jitter 0..1
  alpha: number; // < 1 => translucent mesh
  emissive: number; // intrinsic glow 0..1
  conductivity: number; // heat exchange rate with neighbours 0..1
  relax: number; // rate it drifts back to ambient temperature per tick
  defaultTemp: number | null; // null => ambient at that height
  meltPoint: number; meltTo: number; // goes to meltTo when T > meltPoint
  freezePoint: number; freezeTo: number; // goes to freezeTo when T < freezePoint
  flammability: number; // 0..1 chance to catch per hot tick
  ignite: number; // auto-ignition temperature
  burnTime: number; // ticks a fuel voxel burns
  structural: boolean; // takes part in support checks (can collapse)
  hardness: number; // explosion resistance 0..1
  acidResist: number; // 0..1
  dispersion: number; // liquids: how far they spread sideways per tick
  viscosity: number; // 0..1 chance to skip moving this tick
  diag: number; // powders: chance to roll down a slope instead of resting
  slide: number; // powders: chance to slide two cells (shallower repose)
  life: [number, number]; // gases/fire: lifetime range in ticks
}

const NONE = 1e9;

function mat(p: Partial<Material> & { id: number; name: string; state: number }): Material {
  return {
    desc: '',
    density: 1000,
    color: 0xff00ff,
    color2: -1,
    variation: 0.08,
    alpha: 1,
    emissive: 0,
    conductivity: 0.05,
    relax: 0.0015,
    defaultTemp: null,
    meltPoint: NONE, meltTo: 0,
    freezePoint: -NONE, freezeTo: 0,
    flammability: 0,
    ignite: NONE,
    burnTime: 0,
    structural: false,
    hardness: 0.2,
    acidResist: 0,
    dispersion: 0,
    viscosity: 0,
    diag: 1,
    slide: 0,
    life: [0, 0],
    ...p,
  } as Material;
}

export const MATERIALS: Material[] = [
  mat({ id: M.AIR, name: 'Air', state: State.EMPTY, density: 1.2, conductivity: 0.02, relax: 0.04, color: 0 }),
  mat({ id: M.STONE, name: 'Stone', desc: 'Solid rock. Melts into lava around 1200 °C.', state: State.SOLID,
    density: 2600, color: 0x8b8f94, color2: 0x7a7f86, variation: 0.1, conductivity: 0.06, meltPoint: 1200, meltTo: M.LAVA,
    structural: true, hardness: 0.55, acidResist: 0.4 }),
  mat({ id: M.DIRT, name: 'Dirt', desc: 'Soil. Turns to mud when wet, grows grass in the light.', state: State.SOLID,
    density: 1500, color: 0x7b5636, color2: 0x6a4a2e, variation: 0.1, conductivity: 0.04, meltPoint: 1300, meltTo: M.LAVA,
    structural: true, hardness: 0.3 }),
  mat({ id: M.GRASS, name: 'Grass', desc: 'Dirt with a living top. Burns back to dirt, spreads near water.', state: State.SOLID,
    density: 1400, color: 0x68b545, color2: 0x7b5636, variation: 0.12, conductivity: 0.04, flammability: 0.25, ignite: 280,
    burnTime: 10, structural: true, hardness: 0.3, meltPoint: 1300, meltTo: M.LAVA }),
  mat({ id: M.SAND, name: 'Sand', desc: 'Powder, angle of repose ~34°. Fuses into glass at 1500 °C.', state: State.POWDER,
    density: 1600, color: 0xe2cd8c, color2: 0xd6bd78, variation: 0.08, conductivity: 0.05, meltPoint: 1500, meltTo: M.GLASS,
    diag: 1, slide: 0.35, hardness: 0.15 }),
  mat({ id: M.GRAVEL, name: 'Gravel', desc: 'Coarse powder, steeper slopes (~40°).', state: State.POWDER,
    density: 1800, color: 0x8e8780, color2: 0x6f6a66, variation: 0.22, conductivity: 0.05, meltPoint: 1200, meltTo: M.LAVA,
    diag: 0.85, slide: 0.05, hardness: 0.3 }),
  mat({ id: M.WATER, name: 'Water', desc: 'Flows and levels out. Freezes at 0 °C, boils at 100 °C.', state: State.LIQUID,
    density: 1000, color: 0x2f86d0, color2: 0x45a6e0, variation: 0.03, alpha: 0.62, conductivity: 0.12, relax: 0.002,
    freezePoint: -0.5, freezeTo: M.ICE, meltPoint: 100, meltTo: M.STEAM, dispersion: 5 }),
  mat({ id: M.OIL, name: 'Oil', desc: 'Lighter than water so it floats. Very flammable.', state: State.LIQUID,
    density: 850, color: 0x3a2c1c, color2: 0x55402a, variation: 0.03, alpha: 0.9, conductivity: 0.05, flammability: 0.6,
    ignite: 220, burnTime: 45, dispersion: 3, viscosity: 0.2 }),
  mat({ id: M.LAVA, name: 'Lava', desc: 'Molten rock at 1200 °C. Ignites things, hardens to obsidian.', state: State.LIQUID,
    density: 3100, color: 0xff5b12, color2: 0xffb03a, variation: 0.05, emissive: 1, conductivity: 0.2, relax: 0.0012,
    defaultTemp: 1200, freezePoint: 750, freezeTo: M.OBSIDIAN, dispersion: 2, viscosity: 0.72 }),
  mat({ id: M.ICE, name: 'Ice', desc: 'Frozen water, melts above 0 °C.', state: State.SOLID,
    density: 917, color: 0xbfe6f5, color2: 0xa6d7ef, variation: 0.05, alpha: 0.78, conductivity: 0.1, defaultTemp: -10,
    meltPoint: 0.5, meltTo: M.WATER, hardness: 0.25 }),
  mat({ id: M.SNOW, name: 'Snow', desc: 'Light, sticky powder that piles steeply. Melts above 0 °C.', state: State.POWDER,
    density: 300, color: 0xf3f7fb, color2: 0xdfe8f2, variation: 0.04, conductivity: 0.03, defaultTemp: -5,
    meltPoint: 0.5, meltTo: M.WATER, diag: 0.3, slide: 0, hardness: 0.05 }),
  mat({ id: M.STEAM, name: 'Steam', desc: 'Hot water vapour. Rises and condenses back to water.', state: State.GAS,
    density: 0.6, color: 0xe8eef3, conductivity: 0.03, relax: 0.006, defaultTemp: 110, freezePoint: 92, freezeTo: M.WATER,
    life: [180, 320] }),
  mat({ id: M.SMOKE, name: 'Smoke', desc: 'Rises, drifts and fades away.', state: State.GAS,
    density: 0.9, color: 0x4a4a4e, conductivity: 0.02, relax: 0.02, life: [90, 200] }),
  mat({ id: M.FIRE, name: 'Fire', desc: 'Needs fuel. Spreads by flammability and gives off smoke.', state: State.GAS,
    density: 0.3, color: 0xff8a2a, emissive: 1, conductivity: 0.25, relax: 0, defaultTemp: 900, life: [8, 22] }),
  mat({ id: M.WOOD, name: 'Wood', desc: 'Burns slowly and steadily.', state: State.SOLID,
    density: 700, color: 0x6e4527, color2: 0x5a381f, variation: 0.1, conductivity: 0.03, flammability: 0.12, ignite: 300,
    burnTime: 260, structural: true, hardness: 0.35 }),
  mat({ id: M.LEAVES, name: 'Leaves', desc: 'Catches fire very easily.', state: State.SOLID,
    density: 300, color: 0x3f8f3a, color2: 0x58a83f, variation: 0.18, conductivity: 0.03, flammability: 0.5, ignite: 220,
    burnTime: 35, structural: true, hardness: 0.05 }),
  mat({ id: M.ACID, name: 'Acid', desc: 'Dissolves most things it touches. Glass resists it.', state: State.LIQUID,
    density: 1200, color: 0x8ef03c, color2: 0xb8ff6a, variation: 0.03, alpha: 0.72, emissive: 0.25, conductivity: 0.1,
    dispersion: 4, meltPoint: 300, meltTo: M.SMOKE, acidResist: 1 }),
  mat({ id: M.GLASS, name: 'Glass', desc: 'Transparent solid made from very hot sand. Acid-proof.', state: State.SOLID,
    density: 2500, color: 0xd5eef4, color2: 0xc0e2ea, variation: 0.02, alpha: 0.28, conductivity: 0.04, meltPoint: 2200,
    meltTo: M.LAVA, structural: true, hardness: 0.1, acidResist: 1 }),
  mat({ id: M.OBSIDIAN, name: 'Obsidian', desc: 'Volcanic glass from quenched lava. Very blast-resistant.', state: State.SOLID,
    density: 2400, color: 0x2a2036, color2: 0x3d2f52, variation: 0.12, conductivity: 0.05, meltPoint: 1250, meltTo: M.LAVA,
    structural: true, hardness: 0.92, acidResist: 0.85 }),
  mat({ id: M.MUD, name: 'Mud', desc: 'Wet dirt. Slumps slowly, dries out when hot.', state: State.POWDER,
    density: 1900, color: 0x4f3926, color2: 0x5d4530, variation: 0.06, conductivity: 0.08, meltPoint: 70, meltTo: M.DIRT,
    diag: 0.35, slide: 0.1, viscosity: 0.6, hardness: 0.15 }),
  mat({ id: M.GUNPOWDER, name: 'Gunpowder', desc: 'Explodes when it gets hot. Chain reactions!', state: State.POWDER,
    density: 1700, color: 0x3c3c42, color2: 0x55555c, variation: 0.25, conductivity: 0.06, flammability: 1, ignite: 180,
    diag: 0.9, slide: 0.15, hardness: 0.05 }),
  mat({ id: M.METAL, name: 'Metal', desc: 'Conducts heat fast and glows when hot.', state: State.SOLID,
    density: 7800, color: 0xaeb4bd, color2: 0x8d949e, variation: 0.04, conductivity: 0.45, relax: 0.0008,
    structural: true, hardness: 0.85, acidResist: 0.7 }),
  mat({ id: M.SPRING, name: 'Spring', desc: 'A mossy rock that endlessly bubbles out fresh water.', state: State.SOLID,
    density: 2600, color: 0x4f7f8f, color2: 0x6fb2c2, variation: 0.1, conductivity: 0.05, structural: true, hardness: 0.6 }),
  mat({ id: M.EMBER, name: 'Ember', desc: 'A glowing spark that falls and lights fuel.', state: State.POWDER,
    density: 400, color: 0xff7a1a, color2: 0xffc04a, emissive: 0.9, conductivity: 0.2, relax: 0, defaultTemp: 700,
    diag: 1, slide: 0.5, life: [30, 80] }),
];

// Fast lookup tables used in the hot loops of the simulation.
export const T_STATE = new Uint8Array(MAT_COUNT);
export const T_DENSITY = new Float32Array(MAT_COUNT);
export const T_COND = new Float32Array(MAT_COUNT);
export const T_RELAX = new Float32Array(MAT_COUNT);
export const T_MELT = new Float32Array(MAT_COUNT);
export const T_MELT_TO = new Uint8Array(MAT_COUNT);
export const T_FREEZE = new Float32Array(MAT_COUNT);
export const T_FREEZE_TO = new Uint8Array(MAT_COUNT);
export const T_FLAM = new Float32Array(MAT_COUNT);
export const T_IGNITE = new Float32Array(MAT_COUNT);
export const T_STRUCT = new Uint8Array(MAT_COUNT);
export const T_OPAQUE = new Uint8Array(MAT_COUNT); // meshed in the opaque pass, occludes AO
export const T_TRANSLUCENT = new Uint8Array(MAT_COUNT);
export const T_MOVABLE = new Uint8Array(MAT_COUNT); // empty or gas: things can move into it

for (const m of MATERIALS) {
  T_STATE[m.id] = m.state;
  T_DENSITY[m.id] = m.density;
  T_COND[m.id] = m.conductivity;
  T_RELAX[m.id] = m.relax;
  T_MELT[m.id] = m.meltPoint;
  T_MELT_TO[m.id] = m.meltTo;
  T_FREEZE[m.id] = m.freezePoint;
  T_FREEZE_TO[m.id] = m.freezeTo;
  T_FLAM[m.id] = m.flammability;
  T_IGNITE[m.id] = m.ignite;
  T_STRUCT[m.id] = m.structural ? 1 : 0;
  const meshed = m.state === State.SOLID || m.state === State.POWDER || m.state === State.LIQUID;
  T_OPAQUE[m.id] = meshed && m.alpha >= 1 ? 1 : 0;
  T_TRANSLUCENT[m.id] = meshed && m.alpha < 1 ? 1 : 0;
  T_MOVABLE[m.id] = m.state === State.EMPTY || m.state === State.GAS ? 1 : 0;
}

/** Materials offered in the palette, in shortcut order (keys 1-9 then the rest). */
export const PALETTE: number[] = [
  M.SAND, M.WATER, M.DIRT, M.STONE, M.LAVA, M.OIL, M.WOOD, M.GUNPOWDER, M.ACID,
  M.GRASS, M.GRAVEL, M.SNOW, M.ICE, M.LEAVES, M.GLASS, M.METAL, M.OBSIDIAN, M.MUD,
  M.FIRE, M.STEAM, M.SMOKE, M.SPRING,
];

export function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

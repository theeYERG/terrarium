// End-to-end scenarios in a real browser (Playwright + installed Chrome).
// Usage: npm run dev (port 5179) then `node tests/e2e.mjs [url] [onlyScenario]`
// Screenshots go to shots/e2e-*.png. Each scenario also asserts on the world state.

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:5179/';
const only = process.argv[3] || '';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url);
await page.waitForFunction(() => window.__terrarium?.ready, null, { timeout: 60000 });
await page.click('#enter');
await page.waitForTimeout(1200);

// helpers living in the page
await page.evaluate(() => {
  const T = window.__terrarium;
  const M = { AIR: 0, STONE: 1, DIRT: 2, GRASS: 3, SAND: 4, WATER: 6, OIL: 7, LAVA: 8, ICE: 9, STEAM: 11, SMOKE: 12, FIRE: 13, WOOD: 14, LEAVES: 15, OBSIDIAN: 18, GUNPOWDER: 20 };
  const mats = T.chunks.mats;
  const at = (x, y, z) => mats[x + z * 128 + y * 128 * 128];
  window.H = {
    M, at,
    top(x, z) { for (let y = 63; y >= 0; y--) { const m = at(x, y, z); if (m && m !== 11 && m !== 12 && m !== 13) return y; } return -1; },
    count(m) { let n = 0; for (let i = 0; i < mats.length; i++) if (mats[i] === m) n++; return n; },
    find(m, filter = () => true) {
      for (let y = 0; y < 64; y++) for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) if (at(x, y, z) === m && filter(x, y, z)) return [x, y, z];
      return null;
    },
    apply(tool, mat, x, y, z, r = 2.5, n = [0, 1, 0]) { T.apply({ tool, mat, x, y, z, nx: n[0], ny: n[1], nz: n[2], r }); },
    look(tx, ty, tz, dist = 40, yaw = 0.6, pitch = 0.6) {
      T.look(tx + Math.cos(yaw) * Math.cos(pitch) * dist, ty + Math.sin(pitch) * dist, tz + Math.sin(yaw) * Math.cos(pitch) * dist, tx, ty, tz);
    },
  };
  T.post.tiltShift = false;
  if (location.hash === '#nobloom') T.post.bloom.enabled = false;
});

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const shot = (name) => page.screenshot({ path: `shots/e2e-${name}.png` });
const run = (name) => !only || only === name;

// ── A: real mouse input through the UI ──
if (run('mouse')) {
  await page.evaluate(() => { const c = window.__terrarium.info.center; H.look(64, 34, 64, 110, 0.9, 0.75); void c; });
  await wait(800);
  await page.click('#toolbar button.tool:nth-child(3)'); // Dig
  const before = await page.evaluate(() => H.count(H.M.GRASS) + H.count(H.M.DIRT));
  await page.mouse.move(640, 470);
  await page.mouse.down();
  for (let k = 0; k < 20; k++) { await page.mouse.move(640 + k * 8, 470 + k * 2); await wait(40); }
  await page.mouse.up();
  await wait(1200);
  const after = await page.evaluate(() => H.count(H.M.GRASS) + H.count(H.M.DIRT));
  const undo = await page.evaluate(() => window.__terrarium.undoDepth);
  await shot('mouse-dig');
  ok('mouse drag with Dig removes terrain and records undo', after < before - 20 && undo >= 1, `grass+dirt ${before} -> ${after}, undo depth ${undo}`);
  await page.keyboard.press('Control+z');
  await wait(1200);
  const undone = await page.evaluate(() => H.count(H.M.GRASS) + H.count(H.M.DIRT));
  ok('Ctrl+Z restores the terrain', Math.abs(undone - before) < 40, `after undo ${undone} (before ${before})`);
}

// ── B: pour water into a pit ──
if (run('pit')) {
  const spot = await page.evaluate(() => {
    const i = window.__terrarium.info;
    // a grassy spot between the centre and the side opposite the lake
    const dx = 64 - i.lake[0], dz = 64 - i.lake[2], l = Math.hypot(dx, dz);
    for (let d = 8; d < 30; d++) {
      const x = Math.round(64 + dx / l * d), z = Math.round(64 + dz / l * d + 6);
      const y = H.top(x, z);
      if (H.at(x, y, z) === H.M.GRASS) return [x, y, z];
    }
    return [64, H.top(64, 64), 64];
  });
  const [x, y, z] = spot;
  await page.evaluate(([x, y, z]) => {
    for (let k = 0; k < 5; k++) H.apply('dig', 0, x, y - k, z, 4.5);
    H.look(x, y - 2, z, 42, 0.9, 0.85);
  }, spot);
  await wait(1500);
  await shot('pit-dug');
  for (let k = 0; k < 40; k++) {
    await page.evaluate(([x, y, z]) => H.apply('pour', H.M.WATER, x, y - 4, z, 2.5), spot);
    await wait(50);
  }
  await wait(6000);
  await shot('pit-water');
  const level = await page.evaluate(([x, y, z]) => {
    const tops = [];
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      let t = -1;
      for (let yy = y - 6; yy <= y + 2; yy++) if (H.at(x + dx, yy, z + dz) === H.M.WATER) t = yy;
      tops.push(t);
    }
    return tops;
  }, spot);
  const filled = level.filter((t) => t >= 0);
  const flat = filled.length > 15 && Math.max(...filled) - Math.min(...filled) <= 1;
  ok('water poured into a pit fills it and levels out', flat, `surface heights ${[...new Set(filled)].join(',')} in ${filled.length}/25 columns`);
}

// ── C: lava into the lake ──
if (run('lava')) {
  const lake = await page.evaluate(() => window.__terrarium.info.lake);
  const obs0 = await page.evaluate(() => H.count(H.M.OBSIDIAN));
  await page.evaluate(([x, y, z]) => H.look(x, y, z, 38, 2.2, 0.55), lake);
  for (let k = 0; k < 45; k++) {
    await page.evaluate(([x, y, z]) => H.apply('pour', H.M.LAVA, Math.round(x), y, Math.round(z), 2.5), lake);
    await wait(40);
  }
  await wait(900);
  await shot('lava-lake-hiss');
  const steam = await page.evaluate(() => window.__terrarium.stats);
  await wait(4000);
  await shot('lava-lake-after');
  const obs1 = await page.evaluate(() => H.count(H.M.OBSIDIAN));
  ok('lava poured into the lake quenches to obsidian', obs1 > obs0 + 10, `obsidian ${obs0} -> ${obs1}, awake chunks ${steam.awake}`);
}

// ── D: burn a tree (trees are low poly models with their own burn state) ──
if (run('fire')) {
  // trees: id, state, burn, onFire, x, y, z, kind, h, seed
  const tree = await page.evaluate(() => {
    const t = window.__terrarium.trees;
    for (let o = 0; o < t.length; o += 10) if (t[o + 1] === 0 && t[o + 7] === 0) return [t[o], t[o + 4], t[o + 5], t[o + 6], t[o + 8]];
    return [t[0], t[4], t[5], t[6], t[8]];
  });
  const [id, tx, ty, tz, th] = tree;
  await page.evaluate(([x, y, z, h]) => H.look(x, y + h * 0.5, z, 26, 0.4, 0.3), [tx, ty, tz, th]);
  for (let k = 0; k < 40; k++) {
    await page.evaluate(([x, y, z]) => H.apply('heat', 0, Math.floor(x), Math.floor(y) + 1, Math.floor(z), 1.5), [tx, ty, tz]);
    await wait(33);
  }
  await wait(1200);
  await shot('fire-burning1');
  await wait(2500);
  await shot('fire-burning');
  const fire = await page.evaluate(() => window.__terrarium.stats.fire);
  await page.evaluate(() => { window.__terrarium.sky.running = false; window.__terrarium.sky.time = 0.02; });
  await wait(2000);
  await shot('fire-night');
  await page.evaluate(() => { window.__terrarium.sky.time = 0.34; window.__terrarium.sky.running = true; });
  await wait(15000);
  await shot('fire-after');
  const state = await page.evaluate((id) => { const t = window.__terrarium.trees; for (let o = 0; o < t.length; o += 10) if (t[o] === id) return [t[o + 1], t[o + 2]]; return [-1, 0]; }, id);
  ok('heating a tree sets it on fire and it burns down', fire > 5 && state[1] > 0.6, `fire particles at peak ~${fire}, tree state ${state[0]} burnt ${(state[1] * 100).toFixed(0)}%`);
}

// ── E: blow a hole under a cliff ──
if (run('blast')) {
  const target = await page.evaluate(() => {
    const m = window.__terrarium.info.mountain;
    // walk outward from the mountain until the column drops: blast the cliff side low down
    const dx = m[0] - 64, dz = m[2] - 64, l = Math.hypot(dx, dz) || 1;
    let last = null;
    for (let d = 0; d < 60; d++) {
      const x = Math.round(m[0] + dx / l * d), z = Math.round(m[2] + dz / l * d);
      if (x < 0 || z < 0 || x > 127 || z > 127) break;
      const t = H.top(x, z);
      if (t < 0) break;
      last = [x, t, z];
    }
    return [last[0], last[1] - 6, last[2]];
  });
  await page.evaluate(([x, y, z]) => {
    const dx = x - 64, dz = z - 64;
    H.look(x, y, z, 55, Math.atan2(dz, dx), 0.25);
  }, target);
  await wait(800);
  const before = await page.evaluate(() => H.count(H.M.STONE) + H.count(H.M.DIRT) + H.count(H.M.GRASS));
  await page.evaluate(([x, y, z]) => { H.apply('explode', 0, x, y, z, 4.5); }, target);
  await wait(350);
  await shot('blast-boom');
  const debris = await page.evaluate(() => window.__terrarium.stats.bodies);
  await page.evaluate(([x, y, z]) => { H.apply('explode', 0, x, y + 5, z, 4.5); }, target);
  await wait(4000);
  await shot('blast-after');
  const after = await page.evaluate(() => H.count(H.M.STONE) + H.count(H.M.DIRT) + H.count(H.M.GRASS));
  ok('explosion under a cliff carves a crater and throws debris', debris > 50 && after < before - 200, `debris in flight ${debris}, solid cells ${before} -> ${after}`);
}

// ── F: performance sample ──
if (run('perf')) {
  await page.evaluate(() => H.look(64, 30, 64, 170, 0.8, 0.6));
  await wait(3000);
  const perf = await page.evaluate(() => ({ fps: window.__fps, frameMs: window.__frameMs, ...window.__terrarium.stats }));
  ok('frame rate stays above 55 fps (headless GPU)', perf.fps > 55, `fps ${perf.fps.toFixed(0)}, main-thread cpu ${perf.frameMs.toFixed(2)} ms/frame, sim ${perf.tps.toFixed(0)} tps @ ${perf.tickMs.toFixed(1)} ms, mesh ${perf.meshMs.toFixed(1)} ms`);
  ok('main thread CPU per frame < 8 ms', perf.frameMs < 8, `${perf.frameMs.toFixed(2)} ms`);
  await shot('overview');
}

ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} scenario check(s) failed` : '\nAll scenarios passed');
process.exit(failed ? 1 : 0);

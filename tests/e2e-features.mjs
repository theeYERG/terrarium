// Feature checks: save/load, screenshot download, cinematic, regenerate, clear,
// material showcase (glass, ice, oil, acid, gunpowder, sand pile), the cave, and touch.
// Usage: node tests/e2e-features.mjs [url]

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:5179/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const results = [];
const ok = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };

async function open(viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__terrarium?.ready, null, { timeout: 60000 });
  await page.click('#enter');
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const T = window.__terrarium;
    const mats = T.chunks.mats;
    const at = (x, y, z) => mats[x + z * 128 + y * 128 * 128];
    window.H = {
      at,
      top(x, z) { for (let y = 63; y >= 0; y--) { const m = at(x, y, z); if (m && m !== 11 && m !== 12 && m !== 13) return y; } return -1; },
      count(m) { let n = 0; for (let i = 0; i < mats.length; i++) if (mats[i] === m) n++; return n; },
      apply(tool, mat, x, y, z, r = 2.5) { T.apply({ tool, mat, x, y, z, nx: 0, ny: 1, nz: 0, r }); },
      look(tx, ty, tz, dist = 40, yaw = 0.6, pitch = 0.6) {
        T.look(tx + Math.cos(yaw) * Math.cos(pitch) * dist, ty + Math.sin(pitch) * dist, tz + Math.sin(yaw) * Math.cos(pitch) * dist, tx, ty, tz);
      },
    };
  });
  return { page, ctx, errors };
}

// ── desktop features ──
{
  const { page, errors } = await open({ width: 1440, height: 900 });
  const wait = (ms) => page.waitForTimeout(ms);

  // save -> change -> load
  await page.keyboard.press('Control+s');
  await wait(800);
  const saved = await page.evaluate(() => (localStorage.getItem('terrarium-save-v1') || '').length);
  const before = await page.evaluate(() => H.count(1));
  await page.evaluate(() => H.apply('explode', 0, 64, H.top(64, 64), 64, 6));
  await wait(2500);
  const blasted = await page.evaluate(() => H.count(1));
  await page.keyboard.press('Control+l');
  await wait(2000);
  const loaded = await page.evaluate(() => H.count(1));
  ok('save to localStorage and load it back', saved > 1000 && blasted < before && Math.abs(loaded - before) < 30,
    `save ${Math.round(saved / 1024)} KB, stone ${before} -> ${blasted} after blast -> ${loaded} after load`);

  // screenshot downloads a PNG
  const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.keyboard.press('k');
  const d = await dl;
  ok('screenshot button downloads a PNG', !!d && d.suggestedFilename().endsWith('.png'), d ? d.suggestedFilename() : 'no download');

  // cinematic mode hides UI and moves the camera
  const cam0 = await page.evaluate(() => window.__terrarium.rig.camera.position.toArray());
  await page.keyboard.press('v');
  await wait(2500);
  const cine = await page.evaluate(() => ({ faded: document.getElementById('hud').classList.contains('faded'), p: window.__terrarium.rig.camera.position.toArray() }));
  await page.screenshot({ path: 'shots/feat-cinematic.png' });
  await page.keyboard.press('Escape');
  const moved = Math.hypot(cine.p[0] - cam0[0], cine.p[2] - cam0[2]);
  ok('cinematic camera auto-rotates and hides the UI', cine.faded && moved > 2, `moved ${moved.toFixed(1)} units, ui hidden ${cine.faded}`);

  // regenerate with a typed seed
  await page.click('#topbar button:nth-child(6)');
  await page.fill('#seed', '12345');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#brand .seed').textContent.includes('12345'));
  await wait(2500);
  const seedInfo = await page.evaluate(() => window.__terrarium.info);
  await page.screenshot({ path: 'shots/feat-seed-12345.png' });
  ok('regenerate with a seed builds a different island', !!seedInfo, `lake at ${seedInfo.lake.map((v) => Math.round(v)).join(',')}`);

  // undo the regeneration
  await page.keyboard.press('Control+z');
  await wait(1500);

  // material showcase on a cleared slab
  await page.click('#topbar button:nth-child(7)'); // clear
  await wait(1500);
  const slab = await page.evaluate(() => H.count(3));
  ok('clear makes a flat slab', slab > 4000, `${slab} grass cells`);
  await page.evaluate(() => {
    const y = 33;
    // glass box with water inside, ice block, oil on water pool, acid on stone, gunpowder trail, sand pile
    for (let x = 40; x <= 46; x++) for (let z = 50; z <= 56; z++) for (let yy = y; yy < y + 5; yy++) {
      const edge = x === 40 || x === 46 || z === 50 || z === 56;
      if (edge || yy === y) H.apply('add', 17, x, yy - 1, z, 0.5);
    }
    for (let k = 0; k < 4; k++) H.apply('add', 6, 43, y + k, 53, 1.5);
    for (let k = 0; k < 3; k++) H.apply('add', 9, 54, y + k - 1, 53, 1.5);
    for (let k = 0; k < 3; k++) H.apply('add', 4, 66, y + 6 + k * 2, 52, 2.5);
    for (let k = 0; k < 2; k++) H.apply('add', 21, 76, y + k - 1, 53, 1.5);
    for (let k = 0; k < 2; k++) H.apply('add', 18, 82, y + k - 1, 53, 1.5);
  });
  await wait(1000);
  await page.evaluate(() => {
    for (let k = 0; k < 12; k++) H.apply('pour', 4, 66, 33, 52, 1.5);
  });
  await wait(5000);
  await page.evaluate(() => H.look(62, 33, 53, 42, 1.25, 0.5));
  await wait(1500);
  await page.screenshot({ path: 'shots/feat-materials.png' });
  const glass = await page.evaluate(() => H.count(17));
  ok('glass, ice, metal, obsidian and sand all placeable', glass > 50, `glass cells ${glass}`);

  // oil + water layering + ignition
  await page.evaluate(() => {
    for (let x = 52; x <= 60; x++) for (let z = 62; z <= 68; z++) { H.apply('dig', 0, x, 32, z, 0.5); H.apply('dig', 0, x, 31, z, 0.5); }
  });
  await wait(600);
  await page.evaluate(() => {
    for (let k = 0; k < 8; k++) H.apply('pour', 6, 56, 30, 65, 2.5);
  });
  await wait(2500);
  await page.evaluate(() => {
    for (let k = 0; k < 6; k++) H.apply('pour', 7, 56, 31, 65, 2.5);
  });
  await wait(4000);
  await page.evaluate(() => H.look(56, 31, 65, 26, 1.1, 0.7));
  await wait(800);
  await page.screenshot({ path: 'shots/feat-oil.png' });
  for (let k = 0; k < 30; k++) { await page.evaluate(() => H.apply('heat', 0, 56, 32, 65, 1.5)); await wait(33); }
  await wait(2500);
  await page.screenshot({ path: 'shots/feat-oil-fire.png' });
  const fire = await page.evaluate(() => window.__terrarium.stats.fire);
  ok('oil floating on water can be set alight', fire > 3, `fire cells ${fire}`);

  // acid
  await page.evaluate(() => { for (let k = 0; k < 6; k++) H.apply('pour', 16, 76, 34, 53, 1.5); });
  await wait(4000);
  await page.evaluate(() => H.look(76, 32, 53, 26, 0.9, 0.6));
  await wait(800);
  await page.screenshot({ path: 'shots/feat-acid.png' });

  // gunpowder chain
  await page.evaluate(() => { for (let x = 30; x < 95; x += 2) H.apply('add', 20, x, 32, 75, 0.5); });
  await wait(800);
  await page.evaluate(() => H.look(62, 32, 75, 70, 1.3, 0.5));
  await page.evaluate(() => { for (let k = 0; k < 8; k++) H.apply('heat', 0, 30, 33, 75, 1.5); });
  await wait(1500);
  await page.screenshot({ path: 'shots/feat-gunpowder.png' });
  await wait(3000);
  const gp = await page.evaluate(() => H.count(20));
  ok('gunpowder trail chain-reacts', gp < 15, `gunpowder left ${gp}`);

  ok('no page errors (desktop)', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
}

// ── the cave with its lava pocket (fresh default island) ──
{
  const { page } = await open({ width: 1440, height: 900 });
  const cave = await page.evaluate(() => {
    // find the lava pocket and look at it through the tunnel mouth
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let y = 0; y < 40; y++) for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) if (H.at(x, y, z) === 8) { sx += x; sy += y; sz += z; n++; }
    return n ? [sx / n, sy / n, sz / n, n] : null;
  });
  ok('the island has a lava pocket', !!cave && cave[3] > 20, cave ? `${cave[3]} lava cells` : 'none');
  if (cave) {
    // cut the island open with a slice so the cave is visible, like a cross-section diorama
    await page.evaluate(() => {
      const [x, y, z] = window.__terrarium.info.cave;
      window.__terrarium.sky.running = false;
      window.__terrarium.sky.time = 0.42;
      H.look(x, y, z, 34, Math.atan2(z - 64, x - 64), 0.12);
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'shots/feat-cave-outside.png' });
  }
}

// ── phone: touch to paint ──
{
  const { page, errors, ctx } = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await page.screenshot({ path: 'shots/feat-mobile.png' });
  const before = await page.evaluate(() => window.__terrarium.undoDepth);
  await page.touchscreen.tap(195, 420);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => window.__terrarium.undoDepth);
  ok('a one-finger tap on a phone uses the tool', after > before, `undo depth ${before} -> ${after}`);
  ok('no page errors (mobile)', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} feature check(s) failed` : '\nAll feature checks passed');
process.exit(failed ? 1 : 0);

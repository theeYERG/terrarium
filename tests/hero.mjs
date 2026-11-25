// README screenshots: node tests/hero.mjs [url]
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5179/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(url);
await page.waitForFunction(() => window.__terrarium?.ready, null, { timeout: 60000 });
await page.click('#enter');
await page.waitForTimeout(1500);
// clean hero shot, no UI
await page.evaluate(() => {
  const T = window.__terrarium;
  T.sky.running = false; T.sky.time = 0.36;
  document.getElementById('hud').classList.add('faded');
  const i = T.info; const dx = i.lake[0] - 64, dz = i.lake[2] - 64, l = Math.hypot(dx, dz);
  const a = Math.atan2(dz, dx) + 0.45;
  T.look(64 + Math.cos(a) * 125, 92, 64 + Math.sin(a) * 125, 64, 32, 64);
});
await page.waitForTimeout(3500);
await page.screenshot({ path: 'docs/screenshot.png' });
// action shot with UI: lava flowing down the mountain at dusk + a burning tree
await page.evaluate(() => {
  const T = window.__terrarium;
  document.getElementById('hud').classList.remove('faded');
  T.sky.time = 0.71;
  const m = T.info.mountain;
  const mats = T.chunks.mats;
  let top = 0; for (let y = 63; y >= 0; y--) if (mats[Math.round(m[0]) + Math.round(m[2]) * 128 + y * 16384]) { top = y; break; }
  for (let k = 0; k < 4; k++) T.apply({ tool: 'add', mat: 8, x: Math.round(m[0]), y: top, z: Math.round(m[2]), nx: 0, ny: 1, nz: 0, r: 2.5 });
});
await page.waitForTimeout(6000);
await page.evaluate(() => {
  const T = window.__terrarium;
  const i = T.info; const dx = i.lake[0] - 64, dz = i.lake[2] - 64;
  const a = Math.atan2(dz, dx) + 0.45;
  T.look(64 + Math.cos(a) * 105, 80, 64 + Math.sin(a) * 105, 62, 34, 66);
  T.ui.showFps(false);
});
await page.waitForTimeout(3000);
await page.screenshot({ path: 'docs/screenshot-dusk.png' });
await browser.close();

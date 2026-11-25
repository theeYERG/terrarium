// Frame sequences for eyeballing motion: sand pour and water filling a dug pit.
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
await page.goto(process.argv[2] || 'http://localhost:5179/');
await page.waitForFunction(() => window.__terrarium?.ready, null, { timeout: 90000 });
await page.evaluate(() => window.__terrarium.start());
await page.waitForTimeout(1200);
await page.evaluate(() => { document.getElementById('hud').classList.add('faded'); window.__terrarium.post.tiltShift = false; });
// a flat-ish spot: centre of the clear slab
await page.evaluate(() => window.__terrarium.send({ t: 'clear' }));
await page.waitForTimeout(2500);
await page.evaluate(() => window.__terrarium.look(64 + 26, 46, 64 + 26, 64, 33, 64));
await page.waitForTimeout(800);
await page.evaluate(() => { for (let k = 0; k < 6; k++) window.__terrarium.apply({ tool: 'dig', mat: 0, x: 70, y: 32 - Math.floor(k / 2), z: 58, nx: 0, ny: 1, nz: 0, r: 4.5 }); });
await page.waitForTimeout(1200);
const pour = setInterval(() => page.evaluate(() => {
  const T = window.__terrarium;
  T.apply({ tool: 'pour', mat: 4, x: 58, y: 33, z: 70, nx: 0, ny: 1, nz: 0, r: 1.5 });
  T.apply({ tool: 'pour', mat: 6, x: 70, y: 30, z: 58, nx: 0, ny: 1, nz: 0, r: 1.5 });
}).catch(() => {}), 70);
for (let f = 0; f < 6; f++) { await page.waitForTimeout(f < 3 ? 400 : 1500); await page.screenshot({ path: `shots/frames-${f}.png` }); }
clearInterval(pour);
await page.waitForTimeout(5000);
await page.screenshot({ path: 'shots/frames-settled.png' });
await browser.close();

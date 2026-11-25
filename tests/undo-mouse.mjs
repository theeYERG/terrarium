import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:5179/');
await page.waitForFunction(() => window.__terrarium?.ready, null, { timeout: 90000 });
await page.click('#enter');
await page.waitForTimeout(1200);
const count = () => page.evaluate(() => { const T = window.__terrarium.chunks; let n = 0; for (let i = 0; i < T.mats.length; i++) if ((T.mats[i] === 2 || T.mats[i] === 3)) n++; return n; });
await page.evaluate(() => { const T = window.__terrarium; T.look(64 + 110 * Math.cos(0.9) * Math.cos(0.75), 34 + 110 * Math.sin(0.75), 64 + 110 * Math.sin(0.9) * Math.cos(0.75), 64, 34, 64); });
await page.waitForTimeout(800);
await page.click('#toolbar button.tool:nth-child(3)');
const a = await count();
await page.mouse.move(640, 470);
await page.mouse.down();
for (let k = 0; k < 20; k++) { await page.mouse.move(640 + k * 8, 470 + k * 2); await page.waitForTimeout(40); }
await page.mouse.up();
for (let t = 0; t < 4; t++) { await page.waitForTimeout(500); console.log('after dig', t * 0.5 + 0.5, await count()); }
await page.keyboard.press('Control+z');
for (let t = 0; t < 6; t++) { await page.waitForTimeout(500); console.log('after undo', t * 0.5 + 0.5, await count(), 'depth', await page.evaluate(() => window.__terrarium.undoDepth)); }
console.log('before', a);
await browser.close();

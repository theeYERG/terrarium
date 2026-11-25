// Quick visual check: node tests/shoot.mjs <url> <out.png> [jsToRunAfterStart] [waitMs]
import { chromium } from 'playwright';
const [url = 'http://localhost:5179/', out = 'shots/shot.png', script = '', wait = '2500'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__terrarium && window.__terrarium.ready, null, { timeout: 60000 });
await page.evaluate(() => window.__terrarium.start());
await page.waitForTimeout(1500);
if (script) await page.evaluate(script);
await page.waitForTimeout(parseInt(wait, 10));
await page.screenshot({ path: out });
const info = await page.evaluate(() => ({ fps: window.__fps, stats: window.__terrarium.stats, gl: (() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; })() }));
console.log(JSON.stringify(info));
console.log(logs.slice(0, 20).join('\n'));
await browser.close();

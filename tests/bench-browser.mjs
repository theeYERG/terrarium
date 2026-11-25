import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(process.argv[2] || 'http://localhost:5179/');
await page.waitForFunction(() => window.__terrarium?.ready, null, { timeout: 90000 });
await page.evaluate(() => window.__terrarium.start());
await page.waitForTimeout(2000);
const txt = await page.evaluate(() => new Promise((res) => {
  const ui = window.__terrarium.ui; const orig = ui.toast.bind(ui);
  ui.toast = (t) => { if (t.startsWith('bench')) res(t); orig(t); };
  window.__terrarium.send({ t: 'pause', v: true });
  window.__terrarium.send({ t: 'bench', ticks: 120 });
}));
console.log(txt);
await browser.close();

// Motion smoothness check: every rendered frame, record the interpolated positions of
// flying bodies and look for teleports (a frame step far larger than the steps around it),
// and check that bodies which settle shrink away instead of popping out.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5179/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url);
await page.waitForFunction(() => window.__terrarium?.ready, null, { timeout: 90000 });
await page.evaluate(() => window.__terrarium.start());
await page.waitForTimeout(1500);
const res = await page.evaluate(async () => {
  const T = window.__terrarium;
  // blast a crater near the middle and also pour some sand
  T.apply({ tool: 'explode', mat: 0, x: 60, y: 38, z: 60, nx: 0, ny: 1, nz: 0, r: 4 });
  for (let k = 0; k < 10; k++) T.apply({ tool: 'pour', mat: 4, x: 72, y: 36, z: 70, nx: 0, ny: 1, nz: 0, r: 3 });
  const tracks = new Map(); // id -> [{x,y,z,s,t}]
  const t0 = performance.now();
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now();
      for (const [id, v] of T.bodies.views) {
        if (!v.cur) continue;
        let tr = tracks.get(id);
        if (!tr) { tr = []; tracks.set(id, tr); }
        tr.push({ x: v.cur.x, y: v.cur.y, z: v.cur.z, s: v.curScale, t: now });
      }
      if (now - t0 < 6000) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  let frames = 0, jumps = 0, worst = 0, popped = 0, ended = 0;
  for (const [id, tr] of tracks) {
    if (tr.length < 6) continue;
    const steps = [];
    for (let k = 1; k < tr.length; k++) steps.push(Math.hypot(tr[k].x - tr[k - 1].x, tr[k].y - tr[k - 1].y, tr[k].z - tr[k - 1].z));
    for (let k = 2; k < steps.length - 2; k++) {
      frames++;
      const around = Math.max(steps[k - 2], steps[k - 1], steps[k + 1], steps[k + 2], 0.02);
      if (steps[k] > around * 3.5 && steps[k] > 0.3) { jumps++; worst = Math.max(worst, steps[k] / around); }
    }
    // body that disappeared during the recording: how big was it on its last frame?
    if (!T.bodies.views.has(id)) { ended++; if (tr[tr.length - 1].s > 0.25) popped++; }
  }
  return { bodies: tracks.size, frames, jumps, worst: +worst.toFixed(1), ended, popped };
});
console.log(JSON.stringify(res));
const ok = res.bodies > 20 && res.jumps <= Math.max(2, res.frames * 0.002) && res.popped <= Math.max(1, res.ended * 0.05);
console.log(ok ? 'PASS  bodies move smoothly and shrink away when they settle' : 'FAIL  motion has jumps or pops');
await browser.close();
process.exit(ok ? 0 : 1);

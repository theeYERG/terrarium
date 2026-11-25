// Vanilla DOM UI: glass toolbar, material palette, top bar, settings, help, tooltips,
// inspect panel, toasts and keyboard shortcuts.

import { M, MATERIALS, PALETTE, STATE_NAMES } from '../sim/materials.ts';
import type { ToolName } from '../sim/protocol.ts';
import { ICONS } from './icons.ts';

export interface UIActions {
  setTool(t: ToolName): void;
  setMat(m: number): void;
  brush(delta: number): void;
  togglePause(): void;
  cycleSpeed(dir: number): void;
  step(): void;
  undo(): void;
  regen(seed: number | null): void;
  clear(): void;
  save(): void;
  load(): void;
  screenshot(): void;
  cinematic(): void;
  toggleFps(): void;
  toggleMute(): void;
  setTiltShift(on: boolean): void;
  setDayCycle(on: boolean): void;
  setTime(t: number): void;
  setDayLength(s: number): void;
  setBloom(on: boolean): void;
  setShadows(on: boolean): void;
}

export const TOOLS: { id: ToolName; name: string; key: string; desc: string }[] = [
  { id: 'add', name: 'Add', key: 'B', desc: 'Place the selected material on the surface you click.' },
  { id: 'erase', name: 'Erase', key: 'E', desc: 'Delete anything in the brush.' },
  { id: 'dig', name: 'Dig', key: 'D', desc: 'Remove solids and powders only. Liquids are left alone.' },
  { id: 'heat', name: 'Heat', key: 'H', desc: 'Warm things up: melt, boil, ignite.' },
  { id: 'cool', name: 'Cool', key: 'C', desc: 'Chill things down: freeze water, harden lava.' },
  { id: 'explode', name: 'Explode', key: 'X', desc: 'Blast a crater and throw debris.' },
  { id: 'pour', name: 'Rain / Pour', key: 'P', desc: 'Rain the selected material down from above the cursor.' },
  { id: 'inspect', name: 'Inspect', key: 'I', desc: 'Hover to read material, temperature and state.' },
];

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

export class UI {
  private a: UIActions;
  private tip = document.getElementById('tip')!;
  private hud = document.getElementById('hud')!;
  private toolButtons = new Map<ToolName, HTMLButtonElement>();
  private swatches = new Map<number, HTMLElement>();
  private brushSize!: HTMLElement;
  private currentMat!: HTMLElement;
  private stats!: HTMLElement;
  private inspect!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private speedBtn!: HTMLButtonElement;
  private muteBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private cineBtn!: HTMLButtonElement;
  private fpsBtn!: HTMLButtonElement;
  private settings!: HTMLElement;
  private help!: HTMLElement;
  private seedLabel!: HTMLElement;
  private seedInput!: HTMLInputElement;
  timeSlider!: HTMLInputElement;
  private tipTarget: HTMLElement | null = null;

  constructor(actions: UIActions) {
    this.a = actions;
    this.build();
    this.keys();
    this.tooltips();
  }

  private btn(icon: string, tip: string, onClick: () => void, cls = 'ib'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = ICONS[icon] ?? icon;
    b.dataset.tip = tip;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  private build() {
    const hud = this.hud;
    // brand
    const brand = document.createElement('div');
    brand.id = 'brand';
    brand.className = 'glass';
    brand.innerHTML = `<svg class="logo" viewBox="0 0 64 64">${LOGO}</svg><div><div class="name">TERRARIUM</div><div class="seed"></div></div>`;
    this.seedLabel = brand.querySelector('.seed')!;
    hud.appendChild(brand);

    this.stats = document.createElement('div');
    this.stats.id = 'stats';
    this.stats.className = 'glass hidden';
    hud.appendChild(this.stats);

    // top bar
    const top = document.createElement('div');
    top.id = 'topbar';
    top.className = 'glass';
    this.pauseBtn = this.btn('pause', 'Pause / play <kbd>Space</kbd>', () => this.a.togglePause());
    this.speedBtn = this.btn('<span class="txt">1×</span>', 'Simulation speed <kbd>-</kbd><kbd>=</kbd>', () => this.a.cycleSpeed(1));
    this.speedBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); this.a.cycleSpeed(-1); });
    const stepBtn = this.btn('step', 'Step one tick while paused <kbd>N</kbd>', () => this.a.step());
    this.undoBtn = this.btn('undo', 'Undo <kbd>Ctrl Z</kbd>', () => this.a.undo());
    this.undoBtn.disabled = true;
    const regen = this.btn('regen', 'New island <kbd>R</kbd>', () => this.toggle(this.settings, true));
    const clear = this.btn('clear', 'Clear to a flat slab', () => this.a.clear());
    const save = this.btn('save', 'Save to this browser <kbd>Ctrl S</kbd>', () => this.a.save());
    const load = this.btn('load', 'Load saved world <kbd>Ctrl L</kbd>', () => this.a.load());
    const shot = this.btn('camera', 'Screenshot (PNG) <kbd>K</kbd>', () => this.a.screenshot());
    this.cineBtn = this.btn('film', 'Cinematic camera <kbd>V</kbd>', () => this.a.cinematic());
    this.fpsBtn = this.btn('fps', 'Performance stats <kbd>F</kbd>', () => this.a.toggleFps());
    this.muteBtn = this.btn('sound', 'Sound on / off <kbd>M</kbd>', () => this.a.toggleMute());
    const set = this.btn('settings', 'World & visual settings', () => this.toggle(this.settings));
    const help = this.btn('help', 'Controls <kbd>?</kbd>', () => this.toggle(this.help));
    const sep = () => { const s = document.createElement('div'); s.className = 'sep'; return s; };
    top.append(this.pauseBtn, stepBtn, this.speedBtn, sep(), this.undoBtn, regen, clear, save, load, sep(), shot, this.cineBtn, this.fpsBtn, this.muteBtn, set, help);
    hud.appendChild(top);

    // palette
    const pal = document.createElement('div');
    pal.id = 'palette';
    pal.className = 'glass';
    this.currentMat = document.createElement('div');
    this.currentMat.className = 'current';
    const grid = document.createElement('div');
    grid.className = 'grid';
    PALETTE.forEach((m, k) => {
      const mm = MATERIALS[m];
      const s = document.createElement('div');
      s.className = 'swatch';
      if (mm.emissive > 0.5) s.classList.add('glow');
      s.style.backgroundColor = hex(mm.color);
      if (mm.alpha < 0.5) s.classList.add('trans');
      const key = k < 9 ? `${k + 1}` : '';
      if (key) s.innerHTML = `<span class="k">${key}</span>`;
      s.dataset.tip = `<b>${mm.name}</b>${key ? `<kbd>${key}</kbd>` : ''}<span class="d">${mm.desc}</span><span class="d">${STATE_NAMES[mm.state]} · ${mm.density} kg/m³</span>`;
      s.addEventListener('click', () => this.a.setMat(m));
      this.swatches.set(m, s);
      grid.appendChild(s);
    });
    pal.append(this.currentMat, grid);
    hud.appendChild(pal);

    // toolbar
    const tb = document.createElement('div');
    tb.id = 'toolbar';
    tb.className = 'glass';
    for (const t of TOOLS) {
      const b = this.btn(t.id, `<b>${t.name}</b><kbd>${t.key}</kbd><span class="d">${t.desc}</span>`, () => this.a.setTool(t.id), 'ib tool');
      b.insertAdjacentHTML('beforeend', `<span class="key">${t.key}</span>`);
      this.toolButtons.set(t.id, b);
      tb.appendChild(b);
    }
    tb.appendChild(sep());
    const brush = document.createElement('div');
    brush.id = 'brush';
    const minus = this.btn('minus', 'Smaller brush <kbd>[</kbd> or <kbd>Shift</kbd>+scroll', () => this.a.brush(-1));
    const plus = this.btn('plus', 'Bigger brush <kbd>]</kbd> or <kbd>Shift</kbd>+scroll', () => this.a.brush(1));
    this.brushSize = document.createElement('div');
    this.brushSize.className = 'size';
    brush.append(minus, this.brushSize, plus);
    tb.appendChild(brush);
    hud.appendChild(tb);

    // inspect panel
    this.inspect = document.createElement('div');
    this.inspect.id = 'inspect';
    this.inspect.className = 'glass hidden';
    document.body.appendChild(this.inspect);

    // toasts
    const toasts = document.createElement('div');
    toasts.id = 'toasts';
    hud.appendChild(toasts);

    // settings popover
    this.settings = document.createElement('div');
    this.settings.className = 'glass pop hidden';
    this.settings.innerHTML = `
      <h3>New island</h3>
      <div class="seedrow"><input type="text" id="seed" placeholder="seed" spellcheck="false"><button class="btn primary" id="go">Generate</button></div>
      <div class="seedrow"><button class="btn" id="rand" style="flex:1">Random seed</button></div>
      <h3 style="margin-top:16px">World</h3>
      <label class="row">Day / night cycle <input type="checkbox" id="cyc" checked></label>
      <label class="row">Time of day <input type="range" id="tod" min="0" max="1" step="0.001"></label>
      <label class="row">Day length <input type="range" id="dl" min="60" max="900" step="30" value="360"></label>
      <h3 style="margin-top:16px">Visuals</h3>
      <label class="row">Tilt-shift miniature <input type="checkbox" id="tilt" checked></label>
      <label class="row">Bloom glow <input type="checkbox" id="bloom" checked></label>
      <label class="row">Soft shadows <input type="checkbox" id="shadows" checked></label>`;
    hud.appendChild(this.settings);
    this.seedInput = this.settings.querySelector('#seed')!;
    const go = () => {
      const v = this.seedInput.value.trim();
      this.a.regen(v ? seedFromString(v) : null);
    };
    this.settings.querySelector('#go')!.addEventListener('click', go);
    this.seedInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); });
    this.settings.querySelector('#rand')!.addEventListener('click', () => this.a.regen(null));
    const chk = (id: string, fn: (v: boolean) => void) => {
      const el = this.settings.querySelector<HTMLInputElement>('#' + id)!;
      el.addEventListener('change', () => fn(el.checked));
    };
    chk('cyc', (v) => this.a.setDayCycle(v));
    chk('tilt', (v) => this.a.setTiltShift(v));
    chk('bloom', (v) => this.a.setBloom(v));
    chk('shadows', (v) => this.a.setShadows(v));
    this.timeSlider = this.settings.querySelector('#tod')!;
    this.timeSlider.addEventListener('input', () => this.a.setTime(parseFloat(this.timeSlider.value)));
    const dl = this.settings.querySelector<HTMLInputElement>('#dl')!;
    dl.addEventListener('input', () => this.a.setDayLength(parseFloat(dl.value)));

    // help
    this.help = document.createElement('div');
    this.help.className = 'glass modal help hidden';
    const row = (k: string, v: string) => `<div><span>${v}</span><span>${k}</span></div>`;
    this.help.innerHTML = `
      <h2>Terrarium</h2>
      <p class="sub">A tiny floating world with real-ish physics. Pick a tool and a material, then click the island.</p>
      <div class="cols">
        ${row('<kbd>Left drag</kbd>', 'Use tool')}
        ${row('<kbd>Right drag</kbd>', 'Orbit camera')}
        ${row('<kbd>Middle drag</kbd>', 'Pan camera')}
        ${row('<kbd>Scroll</kbd>', 'Zoom')}
        ${row('<kbd>Shift</kbd>+<kbd>Scroll</kbd> / <kbd>[</kbd><kbd>]</kbd>', 'Brush size')}
        ${row('<kbd>1</kbd>–<kbd>9</kbd>', 'Materials')}
        ${row('<kbd>B</kbd>', 'Add')}
        ${row('<kbd>E</kbd>', 'Erase')}
        ${row('<kbd>D</kbd>', 'Dig')}
        ${row('<kbd>H</kbd> / <kbd>C</kbd>', 'Heat / Cool')}
        ${row('<kbd>X</kbd>', 'Explode')}
        ${row('<kbd>P</kbd>', 'Rain / Pour')}
        ${row('<kbd>I</kbd>', 'Inspect')}
        ${row('<kbd>Space</kbd>', 'Pause / play')}
        ${row('<kbd>N</kbd>', 'Step one tick')}
        ${row('<kbd>-</kbd> / <kbd>=</kbd>', 'Simulation speed')}
        ${row('<kbd>Ctrl</kbd>+<kbd>Z</kbd>', 'Undo (20 steps)')}
        ${row('<kbd>R</kbd>', 'New island')}
        ${row('<kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>L</kbd>', 'Save / load')}
        ${row('<kbd>K</kbd>', 'Screenshot')}
        ${row('<kbd>V</kbd>', 'Cinematic camera')}
        ${row('<kbd>T</kbd>', 'Tilt-shift')}
        ${row('<kbd>F</kbd>', 'Stats / FPS')}
        ${row('<kbd>M</kbd>', 'Mute')}
        ${row('<kbd>Tab</kbd>', 'Hide UI')}
        ${row('Touch: 1 finger / 2 fingers', 'Tool / orbit + zoom')}
      </div>`;
    const close = this.btn('<span class="txt">✕</span>', 'Close', () => this.toggle(this.help, false), 'ib close');
    this.help.appendChild(close);
    hud.appendChild(this.help);

    // close popovers on outside click
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node;
      if (!this.settings.contains(t) && !(t as HTMLElement).closest?.('#topbar')) this.settings.classList.add('hidden');
      if (!this.help.contains(t) && !(t as HTMLElement).closest?.('#topbar')) this.help.classList.add('hidden');
    });
  }

  private toggle(el: HTMLElement, force?: boolean) {
    const show = force ?? el.classList.contains('hidden');
    for (const p of [this.settings, this.help]) if (p !== el) p.classList.add('hidden');
    el.classList.toggle('hidden', !show);
    if (el === this.settings && show) {
      this.seedInput.focus();
      this.seedInput.select();
    }
  }

  private keys() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && k === 'z') { e.preventDefault(); this.a.undo(); return; }
      if (ctrl && k === 's') { e.preventDefault(); this.a.save(); return; }
      if (ctrl && k === 'l') { e.preventDefault(); this.a.load(); return; }
      if (ctrl || e.altKey) return;
      if (e.key >= '1' && e.key <= '9') { this.a.setMat(PALETTE[parseInt(e.key, 10) - 1]); return; }
      switch (k) {
        case 'b': case 'a': this.a.setTool('add'); break;
        case 'e': this.a.setTool('erase'); break;
        case 'd': this.a.setTool('dig'); break;
        case 'h': this.a.setTool('heat'); break;
        case 'c': this.a.setTool('cool'); break;
        case 'x': this.a.setTool('explode'); break;
        case 'p': this.a.setTool('pour'); break;
        case 'i': this.a.setTool('inspect'); break;
        case ' ': e.preventDefault(); this.a.togglePause(); break;
        case 'n': this.a.step(); break;
        case 'r': this.a.regen(null); break;
        case 'f': this.a.toggleFps(); break;
        case 'm': this.a.toggleMute(); break;
        case 'k': this.a.screenshot(); break;
        case 'v': this.a.cinematic(); break;
        case 't': {
          const el = this.settings.querySelector<HTMLInputElement>('#tilt')!;
          el.checked = !el.checked;
          this.a.setTiltShift(el.checked);
          this.toast(`Tilt-shift ${el.checked ? 'on' : 'off'}`);
          break;
        }
        case '[': this.a.brush(-1); break;
        case ']': this.a.brush(1); break;
        case '-': case '_': this.a.cycleSpeed(-1); break;
        case '=': case '+': this.a.cycleSpeed(1); break;
        case '?': case '/': this.toggle(this.help); break;
        case 'tab': e.preventDefault(); this.hud.classList.toggle('faded'); break;
        case 'escape':
          this.settings.classList.add('hidden');
          this.help.classList.add('hidden');
          this.hud.classList.remove('faded');
          break;
      }
    });
  }

  private tooltips() {
    document.addEventListener('pointerover', (e) => {
      const t = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
      if (t === this.tipTarget) return;
      this.tipTarget = t;
      if (!t || e.pointerType === 'touch') { this.tip.classList.remove('show'); return; }
      this.tip.innerHTML = t.dataset.tip!;
      const r = t.getBoundingClientRect();
      this.tip.classList.add('show');
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      let x: number, y: number;
      if (t.closest('#toolbar')) { x = r.left + r.width / 2 - tw / 2; y = r.top - th - 10; }
      else if (t.closest('#palette')) { x = r.right + 12; y = r.top + r.height / 2 - th / 2; }
      else { x = r.left + r.width / 2 - tw / 2; y = r.bottom + 10; }
      x = Math.max(8, Math.min(innerWidth - tw - 8, x));
      y = Math.max(8, Math.min(innerHeight - th - 8, y));
      this.tip.style.left = `${x}px`;
      this.tip.style.top = `${y}px`;
    });
  }

  // ─── state display ───
  showTool(t: ToolName) {
    for (const [id, b] of this.toolButtons) b.classList.toggle('active', id === t);
  }
  showMat(m: number) {
    for (const [id, s] of this.swatches) s.classList.toggle('active', id === m);
    this.currentMat.textContent = MATERIALS[m].name;
  }
  showBrush(b: number) {
    this.brushSize.innerHTML = `${b}<small>BRUSH</small>`;
  }
  showPaused(p: boolean) {
    this.pauseBtn.innerHTML = ICONS[p ? 'play' : 'pause'];
    this.pauseBtn.classList.toggle('on', p);
  }
  showSpeed(s: number) {
    this.speedBtn.innerHTML = `<span class="txt">${s < 1 ? s.toString().replace(/^0/, '') : s}×</span>`;
  }
  showMuted(m: boolean) {
    this.muteBtn.innerHTML = ICONS[m ? 'mute' : 'sound'];
  }
  showUndo(depth: number) {
    this.undoBtn.disabled = depth === 0;
  }
  showCinematic(on: boolean) {
    this.cineBtn.classList.toggle('on', on);
    this.hud.classList.toggle('faded', on);
  }
  showFps(on: boolean) {
    this.stats.classList.toggle('hidden', !on);
    this.fpsBtn.classList.toggle('on', on);
  }
  setSeed(seed: number) {
    this.seedLabel.textContent = `seed ${seed}`;
    this.seedInput.value = String(seed);
  }
  setStats(html: string) {
    if (!this.stats.classList.contains('hidden')) this.stats.innerHTML = html;
  }
  toast(text: string) {
    const t = document.createElement('div');
    t.className = 'toast glass';
    t.textContent = text;
    document.getElementById('toasts')!.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }
  showInspect(info: { mat: number; temp: number; x: number; y: number; z: number } | null, sx: number, sy: number) {
    if (!info) { this.inspect.classList.add('hidden'); return; }
    const mm = MATERIALS[info.mat];
    const st = STATE_NAMES[mm.state];
    const t = info.temp;
    const temp = Math.abs(t) >= 100 ? t.toFixed(0) : t.toFixed(1);
    const extra = info.mat === M.FIRE ? 'burning' : info.mat === M.AIR ? '' : t > 480 && mm.state !== 4 ? 'glowing hot' : '';
    this.inspect.innerHTML = `<div class="n"><span class="dot" style="background:${hex(mm.color)}"></span>${mm.name}</div>
      <div class="row"><span>Temperature</span><span>${temp} °C</span></div>
      <div class="row"><span>State</span><span>${st}${extra ? ' · ' + extra : ''}</span></div>
      <div class="row"><span>Density</span><span>${mm.density} kg/m³</span></div>
      <div class="row"><span>Cell</span><span>${info.x}, ${info.y}, ${info.z}</span></div>`;
    this.inspect.classList.remove('hidden');
    const w = this.inspect.offsetWidth, h = this.inspect.offsetHeight;
    let x = sx + 18, y = sy + 18;
    if (x + w > innerWidth - 8) x = sx - w - 18;
    if (y + h > innerHeight - 8) y = sy - h - 18;
    this.inspect.style.left = `${x}px`;
    this.inspect.style.top = `${y}px`;
  }
}

export function seedFromString(s: string): number {
  if (/^\d+$/.test(s)) return parseInt(s, 10) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const LOGO = `
  <defs><linearGradient id="lg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8be06a"/><stop offset="1" stop-color="#4c9e3c"/></linearGradient>
  <linearGradient id="lg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a6240"/><stop offset="1" stop-color="#4b3220"/></linearGradient></defs>
  <path d="M32 6l24 12-24 12L8 18z" fill="url(#lg1)"/>
  <path d="M8 18l24 12v8L8 26z" fill="#5f7e3c"/><path d="M56 18L32 30v8l24-12z" fill="#4a6a30"/>
  <path d="M8 26l24 12v6L14 35z" fill="url(#lg2)"/><path d="M56 26L32 38v6l18-9z" fill="#5a3c26"/>
  <path d="M14 35l18 9v14z" fill="#6f7680"/><path d="M50 35L32 44v14z" fill="#555c66"/>
  <path d="M24 18l8-4 8 4-8 4z" fill="#58b4f0"/>
  <rect x="38" y="9" width="2.6" height="7" fill="#6e4527"/><circle cx="39.3" cy="8" r="4" fill="#3f8f3a"/>`;

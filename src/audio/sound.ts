// Soft procedural sound effects with WebAudio (no audio files). Nothing plays until the
// first user click starts the AudioContext. Mute state is remembered.

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private ambience: GainNode | null = null;
  private fireGain: GainNode | null = null;
  private lastPlay: Record<string, number> = {};
  muted = localStorage.getItem('terrarium-muted') === '1';

  /** Call from a user gesture. */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    this.master.connect(comp).connect(ctx.destination);
    // 2 s of white noise, reused by every effect
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    this.startAmbience();
  }

  setMuted(m: boolean) {
    this.muted = m;
    localStorage.setItem('terrarium-muted', m ? '1' : '0');
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  private noise(dur: number, filterType: BiquadFilterType, freq: number, q: number, gain: number, attack = 0.005, freqEnd?: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', freqEnd?: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private ok(key: string, gapMs: number) {
    if (!this.ctx || this.muted) return false;
    const now = performance.now();
    if (now - (this.lastPlay[key] ?? 0) < gapMs) return false;
    this.lastPlay[key] = now;
    return true;
  }

  place(liquid: boolean) {
    if (!this.ok('place', 70)) return;
    if (liquid) this.tone(520 + Math.random() * 200, 0.12, 0.06, 'sine', 260);
    else {
      this.noise(0.07, 'bandpass', 900 + Math.random() * 500, 1.2, 0.18);
      this.tone(180 + Math.random() * 40, 0.08, 0.05, 'triangle');
    }
  }

  dig() {
    if (!this.ok('dig', 80)) return;
    this.noise(0.12, 'lowpass', 700 + Math.random() * 300, 0.7, 0.22);
  }

  heat() {
    if (!this.ok('heat', 120)) return;
    this.noise(0.25, 'bandpass', 2400, 0.6, 0.03);
  }

  cool() {
    if (!this.ok('cool', 120)) return;
    this.noise(0.25, 'highpass', 5000, 0.5, 0.025);
  }

  boom(size: number, distance: number) {
    if (!this.ok('boom', 60)) return;
    const v = Math.min(1, (0.6 + size * 0.08) * Math.max(0.25, 1 - distance / 400));
    this.noise(1.4 + size * 0.1, 'lowpass', 1800, 0.8, 0.55 * v, 0.004, 90);
    this.tone(70, 0.9, 0.5 * v, 'sine', 32);
  }

  sizzle() {
    if (!this.ok('sizzle', 140)) return;
    this.noise(0.6, 'highpass', 3200, 0.7, 0.08);
  }

  splash() {
    if (!this.ok('splash', 100)) return;
    this.noise(0.25, 'bandpass', 1200, 1, 0.08, 0.005, 500);
  }

  click() {
    if (!this.ok('click', 30)) return;
    this.tone(1400, 0.04, 0.035, 'sine', 900);
  }

  /** Called each frame with the amount of fire on the island. */
  setFire(amount: number) {
    if (!this.ctx || !this.fireGain) return;
    const target = Math.min(0.16, amount / 1500);
    this.fireGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
    if (amount > 5 && Math.random() < Math.min(0.5, amount / 400) && this.ok('crackle', 40)) {
      this.noise(0.03, 'highpass', 2500 + Math.random() * 3000, 1, 0.05 + Math.random() * 0.05);
    }
  }

  private startAmbience() {
    const ctx = this.ctx!;
    // breeze: slowly swept band-passed noise
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 400;
    f.Q.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(f.frequency);
    const g = ctx.createGain();
    g.gain.value = 0.035;
    src.connect(f).connect(g).connect(this.master!);
    // distant waterfall rumble
    const w = ctx.createBiquadFilter();
    w.type = 'lowpass';
    w.frequency.value = 650;
    const wg = ctx.createGain();
    wg.gain.value = 0.03;
    src.connect(w).connect(wg).connect(this.master!);
    // fire roar bed (volume follows the amount of fire)
    const ff = ctx.createBiquadFilter();
    ff.type = 'lowpass';
    ff.frequency.value = 300;
    this.fireGain = ctx.createGain();
    this.fireGain.gain.value = 0;
    src.connect(ff).connect(this.fireGain).connect(this.master!);
    src.start();
    lfo.start();
    this.ambience = g;
  }

  setDay(day: number) {
    if (this.ambience && this.ctx) this.ambience.gain.setTargetAtTime(0.02 + 0.025 * day, this.ctx.currentTime, 1);
  }
}

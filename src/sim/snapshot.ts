// Compact world snapshots for undo and save/load: run-length encoded streams of
// materials, quantised temperatures and life/flags. A typical island packs to ~100-300 KB.

import { VOLUME } from './constants.ts';
import { F_SETTLED, type World } from './world.ts';

const MAGIC = 0x31525254; // "TRR1"

class ByteWriter {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u32(v: number) {
    this.ensure(4);
    this.buf[this.len++] = v & 255;
    this.buf[this.len++] = (v >>> 8) & 255;
    this.buf[this.len++] = (v >>> 16) & 255;
    this.buf[this.len++] = (v >>> 24) & 255;
  }
  varint(v: number) {
    this.ensure(5);
    while (v >= 128) {
      this.buf[this.len++] = (v & 127) | 128;
      v >>>= 7;
    }
    this.buf[this.len++] = v;
  }
  bytes() {
    return this.buf.slice(0, this.len);
  }
}

class ByteReader {
  pos = 0;
  private buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  u32() {
    const b = this.buf, p = this.pos;
    this.pos += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }
  varint() {
    let v = 0, shift = 0, b: number;
    do {
      b = this.buf[this.pos++];
      v += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return v;
  }
}

function rle(wr: ByteWriter, get: (i: number) => number) {
  let prev = get(0), run = 1;
  for (let i = 1; i < VOLUME; i++) {
    const v = get(i);
    if (v === prev) { run++; continue; }
    wr.varint(run);
    wr.varint(prev);
    prev = v;
    run = 1;
  }
  wr.varint(run);
  wr.varint(prev);
}

function unrle(rd: ByteReader, put: (i: number, v: number) => void) {
  let i = 0;
  while (i < VOLUME) {
    const run = rd.varint();
    const v = rd.varint();
    for (let k = 0; k < run && i < VOLUME; k++) put(i++, v);
  }
}

export function encodeWorld(w: World): Uint8Array {
  const wr = new ByteWriter();
  wr.u32(MAGIC);
  wr.u32(w.seed >>> 0);
  const { mat, temp, life, flags } = w;
  rle(wr, (i) => mat[i]);
  rle(wr, (i) => Math.max(0, Math.min(65535, Math.round(temp[i]) + 32768)));
  rle(wr, (i) => life[i] | ((flags[i] & ~F_SETTLED) << 8));
  return wr.bytes();
}

export function decodeWorld(w: World, data: Uint8Array): boolean {
  const rd = new ByteReader(data);
  if (rd.u32() !== MAGIC) return false;
  w.seed = rd.u32();
  const { mat, temp, life, flags } = w;
  unrle(rd, (i, v) => { mat[i] = v; });
  unrle(rd, (i, v) => { temp[i] = v - 32768; });
  unrle(rd, (i, v) => { life[i] = v & 255; flags[i] = v >> 8; });
  w.stamp.fill(0);
  w.removedStruct.length = 0;
  w.explosions.length = 0;
  w.hot.fill(1);
  w.markAllDirty();
  return true;
}

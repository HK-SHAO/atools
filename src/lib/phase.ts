export const TUNE = {
  pghi: true,
  iters: 32,
  momentum: 0.5,
  gamma: 0.25645,
  tol: [0.1, 1e-10] as [number, number],
  rtisi: true,
  rtisiIters: 8,
  rtisiGl: 0,
  fine: {
    rtisiIters: 16,
    rtisiBudget: 2e8,
    glIters: 8,
    glBudgetMs: 12_000,
  },
};

const TWO_PI = Math.PI * 2;

const wrap = (a: number): number => {
  let v = (a + Math.PI) % TWO_PI;
  if (v < 0) v += TWO_PI;
  return v - Math.PI;
};

function orderByLevel(mag: Float64Array, top: number, n: number): Uint32Array {
  const B = 256;
  const counts = new Uint32Array(B);
  const keys = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.min(B - 1, (mag[i]! / top) * B) | 0;
    keys[i] = k;
    counts[k] = counts[k]! + 1;
  }
  const start = new Uint32Array(B + 1);
  for (let b = B - 1; b >= 0; b--) start[b] = start[b + 1]! + counts[b]!;

  const order = new Uint32Array(n);
  const at = new Uint32Array(B);
  for (let b = 0; b < B; b++) at[b] = start[b + 1]!;
  for (let i = 0; i < n; i++) order[at[keys[i]!]!++] = i;
  return order;
}

class Heap {
  private idx: Uint32Array;
  private key: Float64Array;
  size = 0;

  constructor(cap = 1024) {
    this.idx = new Uint32Array(cap);
    this.key = new Float64Array(cap);
  }

  private grow(): void {
    const idx = new Uint32Array(this.idx.length * 2);
    idx.set(this.idx);
    const key = new Float64Array(this.key.length * 2);
    key.set(this.key);
    this.idx = idx;
    this.key = key;
  }

  push(value: number, key: number): void {
    if (this.size === this.idx.length) this.grow();
    let c = this.size++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p]! >= key) break;
      this.idx[c] = this.idx[p]!;
      this.key[c] = this.key[p]!;
      c = p;
    }
    this.idx[c] = value;
    this.key[c] = key;
  }

  pop(): number {
    const top = this.idx[0]!;
    const last = --this.size;
    if (last > 0) {
      const value = this.idx[last]!;
      const key = this.key[last]!;
      let c = 0;
      for (;;) {
        let ch = 2 * c + 1;
        if (ch >= last) break;
        if (ch + 1 < last && this.key[ch + 1]! > this.key[ch]!) ch++;
        if (this.key[ch]! <= key) break;
        this.idx[c] = this.idx[ch]!;
        this.key[c] = this.key[ch]!;
        c = ch;
      }
      this.idx[c] = value;
      this.key[c] = key;
    }
    return top;
  }
}

export function phaseFromMagnitude(
  mag: Float64Array,
  frames: number,
  bins: number,
  win: number,
  hop: number,
): Float64Array {
  const n = frames * bins;
  const phase = new Float64Array(n);

  let top = 0;
  for (let i = 0; i < n; i++) if (mag[i]! > top) top = mag[i]!;
  if (top <= 0 || frames < 2 || bins < 2) return phase;

  const floor = top * 1e-12;
  const slog = new Float64Array(n);
  for (let i = 0; i < n; i++) slog[i] = Math.log(Math.max(mag[i]!, floor));

  const gamma = TUNE.gamma * win * win;
  const cF = gamma / (hop * win);
  const cT = (hop * win) / gamma;
  const fgrad = new Float32Array(n);
  const tgrad = new Float32Array(n);

  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    const up = (f > 0 ? f - 1 : 0) * bins;
    const dn = (f < frames - 1 ? f + 1 : frames - 1) * bins;
    const dt = f > 0 && f < frames - 1 ? 2 : 1;
    for (let b = 0; b < bins; b++) {
      fgrad[base + b] = (-cF * (slog[dn + b]! - slog[up + b]!)) / dt - Math.PI;
    }
  }
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      const lo = b > 0 ? b - 1 : 0;
      const hi = b < bins - 1 ? b + 1 : bins - 1;
      const db = b > 0 && b < bins - 1 ? 2 : 1;
      tgrad[base + b] =
        (cT * (slog[base + hi]! - slog[base + lo]!)) / db + (TWO_PI * hop * b) / win;
    }
  }
  slog.fill(0);

  const done = new Uint8Array(n);
  const queued = new Uint8Array(n);
  const order = orderByLevel(mag, top, n);
  const heap = new Heap();

  const drain = (limit: number): void => {
    while (heap.size > 0) {
      const i = heap.pop();
      if (done[i]) continue;

      const f = (i / bins) | 0;
      const b = i - f * bins;
      let best = -1;
      let bestMag = -1;

      if (b > 0 && done[i - 1]! && mag[i - 1]! > bestMag) {
        best = i - 1;
        bestMag = mag[i - 1]!;
      }
      if (b < bins - 1 && done[i + 1]! && mag[i + 1]! > bestMag) {
        best = i + 1;
        bestMag = mag[i + 1]!;
      }
      if (f > 0 && done[i - bins]! && mag[i - bins]! > bestMag) {
        best = i - bins;
        bestMag = mag[i - bins]!;
      }
      if (f < frames - 1 && done[i + bins]! && mag[i + bins]! > bestMag) {
        best = i + bins;
        bestMag = mag[i + bins]!;
      }

      if (best < 0) {
        phase[i] = 0;
      } else if (best === i - 1) {
        phase[i] = wrap(phase[best]! + 0.5 * (fgrad[best]! + fgrad[i]!));
      } else if (best === i + 1) {
        phase[i] = wrap(phase[best]! - 0.5 * (fgrad[best]! + fgrad[i]!));
      } else if (best === i - bins) {
        phase[i] = wrap(phase[best]! + 0.5 * (tgrad[best]! + tgrad[i]!));
      } else {
        phase[i] = wrap(phase[best]! - 0.5 * (tgrad[best]! + tgrad[i]!));
      }
      done[i] = 1;

      if (b > 0) offer(i - 1, limit);
      if (b < bins - 1) offer(i + 1, limit);
      if (f > 0) offer(i - bins, limit);
      if (f < frames - 1) offer(i + bins, limit);
    }
  };

  function offer(j: number, limit: number): void {
    if (done[j] || queued[j] || mag[j]! <= limit) return;
    queued[j] = 1;
    heap.push(j, mag[j]!);
  }

  for (const limit of [top * TUNE.tol[0], top * TUNE.tol[1]]) {
    for (let k = 0; k < n; k++) {
      const i = order[k]!;
      if (done[i] || mag[i]! <= limit) continue;
      queued[i] = 1;
      heap.push(i, mag[i]!);
      drain(limit);
    }
  }

  let seed = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    if (done[i]) continue;
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    phase[i] = ((seed >>> 0) / 0xffffffff) * TWO_PI - Math.PI;
  }

  return phase;
}

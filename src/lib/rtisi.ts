import { FFT, hannWindow, mirrorSpectrum } from "./fft";

export interface RtisiOptions {
  lookahead?: number;
  iters?: number;
  warm?: Float64Array | null;
  fromPast?: boolean;
  budget?: number;
  tick?: (m: number, frames: number) => Promise<void> | void;
}

export const DEFAULT_BUDGET = 5e7;

export async function rtisiLa(
  mag: Float64Array,
  frames: number,
  bins: number,
  win: number,
  hop: number,
  samples: number,
  opts: RtisiOptions = {},
): Promise<Float64Array> {
  const L = win;
  const a = Math.max(1, Math.round(hop));
  const R = Math.max(1, Math.round(L / a));
  let K = Math.max(0, Math.min(frames - 1, opts.lookahead ?? R - 1));
  let iters = Math.max(1, opts.iters ?? 8);
  const warm = opts.warm ?? null;
  const fromPast = opts.fromPast !== false;
  const tick = opts.tick;

  const unit = frames * L * Math.max(1, Math.log2(L));
  const budget = opts.budget ?? DEFAULT_BUDGET;
  while (K > 1 && unit * (K + 1) * iters > budget) K--;
  while (iters > 1 && unit * (K + 1) * iters > budget) iters--;

  const fft = new FFT(L);
  const w = hannWindow(L);
  const full = L / 2 + 1;
  const padded = samples + L;
  const span = K * a + L;

  const out = new Float64Array(padded);
  const local = new Float64Array(span);
  const re = new Float64Array(L);
  const im = new Float64Array(L);
  const ph = new Float64Array((K + 1) * bins);
  const prev = new Float64Array((K + 1) * bins);

  const load = (at: number): void => {
    local.fill(0);
    const avail = Math.min(span, padded - at);
    if (avail > 0) local.set(out.subarray(at, at + avail));
  };

  const lay = (f: number, k: number): void => {
    const base = f * bins;
    for (let b = 0; b < full; b++) {
      if (b < bins) {
        const g = mag[base + b]!;
        const p = ph[k * bins + b]!;
        re[b] = g * Math.cos(p);
        im[b] = g * Math.sin(p);
      } else {
        re[b] = 0;
        im[b] = 0;
      }
    }
    mirrorSpectrum(re, im, full, L);
    fft.transform(re, im, true);
    const at = k * a;
    for (let n = 0; n < L; n++) local[at + n] = local[at + n]! + re[n]! * w[n]!;
  };

  const read = (k: number): void => {
    const at = k * a;
    for (let n = 0; n < L; n++) {
      re[n] = local[at + n]! * w[n]!;
      im[n] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) ph[k * bins + b] = Math.atan2(im[b]!, re[b]!);
  };

  for (let m = 0; m < frames; m++) {
    const act = Math.min(K + 1, frames - m);
    const at = m * a;

    load(at);

    if (m === 0) {
      for (let k = 0; k < act; k++) {
        if (warm) ph.set(warm.subarray(k * bins, (k + 1) * bins), k * bins);
        else read(k);
      }
    } else {
      for (let k = 0; k < act; k++) {
        if (k <= K - 1) ph.set(prev.subarray((k + 1) * bins, (k + 2) * bins), k * bins);
        else if (warm) ph.set(warm.subarray((m + k) * bins, (m + k + 1) * bins), k * bins);
        else ph.fill(0, k * bins, (k + 1) * bins);
      }
      if (fromPast) read(0);
    }

    for (let it = 0; it < iters; it++) {
      load(at);
      for (let k = 0; k < act; k++) lay(m + k, k);
      for (let k = 0; k < act; k++) read(k);
    }

    const base = m * bins;
    for (let b = 0; b < full; b++) {
      if (b < bins) {
        const g = mag[base + b]!;
        const p = ph[b]!;
        re[b] = g * Math.cos(p);
        im[b] = g * Math.sin(p);
      } else {
        re[b] = 0;
        im[b] = 0;
      }
    }
    mirrorSpectrum(re, im, full, L);
    fft.transform(re, im, true);
    const room = Math.min(L, padded - at);
    for (let n = 0; n < room; n++) out[at + n] = out[at + n]! + re[n]! * w[n]!;

    prev.set(ph);
    if (tick) await tick(m + 1, frames);
  }

  const cover = new Float64Array(padded);
  for (let f = 0; f < frames; f++)
    for (let n = 0; n < L; n++) cover[f * a + n] = cover[f * a + n]! + w[n]! * w[n]!;
  let top = 0;
  for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
  const floor = top * 0.05;

  const y = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const c = cover[L / 2 + i]!;
    y[i] = c > floor ? out[L / 2 + i]! / c : 0;
  }
  return y;
}


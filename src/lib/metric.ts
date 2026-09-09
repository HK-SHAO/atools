import type { Samples } from "./arrays";
import { FFT, hannWindow } from "./fft";

export function align(a: Samples, b: Samples, span: number): { corr: number; snr: number } {
  const n = Math.min(a.length, b.length);
  let best = 0;
  let bv = -2;
  for (let lag = -span; lag <= span; lag++) {
    let sa = 0;
    let sb = 0;
    let sab = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      sa += a[i]! * a[i]!;
      sb += b[j]! * b[j]!;
      sab += a[i]! * b[j]!;
    }
    const v = sab / Math.sqrt(Math.max(sa * sb, 1e-30));
    if (v > bv) {
      bv = v;
      best = lag;
    }
  }
  let sa = 0;
  let se = 0;
  for (let i = 0; i < n; i++) {
    const j = i + best;
    if (j < 0 || j >= n) continue;
    const d = a[i]! - b[j]!;
    sa += a[i]! * a[i]!;
    se += d * d;
  }
  return { corr: bv, snr: 10 * Math.log10(Math.max(sa, 1e-30) / Math.max(se, 1e-30)) };
}

export function magnitudes(x: Samples, win: number, hop: number): Float64Array {
  const fft = new FFT(win);
  const w = hannWindow(win);
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const pad = new Float64Array(x.length + win);
  for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const out = new Float64Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) out[f * bins + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
  }
  return out;
}

export function spectral(
  ref: Float64Array,
  got: Float64Array,
): { conv: number; lsd: number } {
  const n = Math.min(ref.length, got.length);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = ref[i]! - got[i]!;
    num += d * d;
    den += ref[i]! * ref[i]!;
  }
  const conv = 10 * Math.log10(Math.max(num, 1e-30) / Math.max(den, 1e-30));

  let topA = 0;
  let topB = 0;
  for (let i = 0; i < n; i++) {
    if (ref[i]! > topA) topA = ref[i]!;
    if (got[i]! > topB) topB = got[i]!;
  }
  const floorA = Math.log(Math.max(topA, 1e-30)) - 80 / 8.686;
  const floorB = Math.log(Math.max(topB, 1e-30)) - 80 / 8.686;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const la = Math.max(Math.log(Math.max(ref[i]!, 1e-30)), floorA);
    const lb = Math.max(Math.log(Math.max(got[i]!, 1e-30)), floorB);
    const d = la - floorA - (lb - floorB);
    acc += d * d;
  }
  return { conv, lsd: 8.686 * Math.sqrt(acc / Math.max(n, 1)) };
}

export function compare(ref: Samples, got: Samples): { snr: number; corr: number; lsd: number } {
  const n = Math.min(ref.length, got.length);
  const a = align(ref, got, Math.min(2048, Math.floor(n / 4) || 1));
  const s = spectral(magnitudes(ref, 1024, 256), magnitudes(got, 1024, 256));
  return { snr: a.snr, corr: a.corr, lsd: s.lsd };
}

import type { Samples } from "./arrays";

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function kernel(d: number, fc: number): number {
  if (d === 0) return 2 * fc;
  return Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
}

export function resample(x: Samples, from: number, to: number, cutoffHz = 0): Samples {
  if (x.length === 0 || (from === to && cutoffHz <= 0)) return x.slice() as Samples;

  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(x.length / ratio)));

  const nyq = 0.5 * Math.min(1, to / from);
  const limit = cutoffHz > 0 ? Math.min(nyq, cutoffHz / from) : nyq;
  const fc = limit * 0.92;
  const half = clamp(Math.round(2 / Math.max(fc, 1e-5)), 3, 64);

  for (let j = 0; j < out.length; j++) {
    const center = j * ratio;
    const i0 = Math.floor(center);
    const frac = center - i0;
    let acc = 0;
    let wsum = 0;
    for (let m = 1 - half; m <= half; m++) {
      const d = m - frac;
      const t = d / (half + 0.5);
      const w =
        kernel(d, fc) * (0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t));
      const i = i0 + m;
      if (i >= 0 && i < x.length) {
        acc += x[i]! * w;
        wsum += w;
      }
    }
    out[j] = wsum !== 0 ? acc / wsum : 0;
  }

  return out as Samples;
}

export function slice(pcm: Samples, sr: number, start: number, end: number): Samples {
  const a = Math.max(0, Math.min(pcm.length - 1, Math.floor(start * sr)));
  const b = end > 0 ? Math.min(pcm.length, Math.ceil(end * sr)) : pcm.length;
  if (a === 0 && b === pcm.length) return pcm;
  return pcm.slice(a, Math.max(a, b)) as Samples;
}

export function silenceBounds(pcm: Samples, sr: number): { start: number; end: number } {
  const step = Math.max(1, Math.round(sr * 0.02));
  const total = Math.floor(pcm.length / step);
  if (total === 0) return { start: 0, end: 0 };

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]!);
    if (v > peak) peak = v;
  }
  const gate = Math.max(peak * 0.02, 1e-5);

  const rms = new Float64Array(total);
  for (let w = 0; w < total; w++) {
    let sum = 0;
    const from = w * step;
    for (let i = from; i < from + step && i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
    rms[w] = Math.sqrt(sum / step);
  }

  let first = -1;
  let last = -1;
  for (let w = 0; w < total; w++) {
    if (rms[w]! > gate) {
      if (first < 0) first = w;
      last = w;
    }
  }
  if (first < 0) return { start: 0, end: 0 };

  const pad = 0.03;
  const start = Math.max(0, (first * step) / sr - pad);
  const end = Math.min(pcm.length / sr, ((last + 1) * step) / sr + pad);
  return { start, end };
}

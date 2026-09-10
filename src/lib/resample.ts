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
  const spread = half + 0.5;

  // 抽头权重只由 frac 决定，而 frac 的取值个数等于 from/to 既约后的分母
  // （44.1k→8k 只有 80 种），所以同一相的权重先算一次存下。
  // 上限按内存给：既约分母虽小，同一个相却会因浮点漂移散成近十种 frac，
  // 最坏 4096×129 个 double 约 4 MB，用完即回收；再离谱的采样率组合退回逐样点现算。
  // 表以 frac 本身为键、值与原处逐位相同，只是不再重复算 sin/cos。
  const taps = new Map<number, Float64Array>();
  const PHASES = 4096;

  for (let j = 0; j < out.length; j++) {
    const center = j * ratio;
    const i0 = Math.floor(center);
    const frac = center - i0;

    let w = taps.get(frac);
    if (w === undefined) {
      w = new Float64Array(2 * half);
      for (let m = 1 - half; m <= half; m++) {
        const d = m - frac;
        const t = d / spread;
        w[m + half - 1] =
          kernel(d, fc) *
          (0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t));
      }
      if (taps.size < PHASES) taps.set(frac, w);
    }

    let acc = 0;
    let wsum = 0;
    for (let m = 1 - half; m <= half; m++) {
      const tap = w[m + half - 1]!;
      const i = i0 + m;
      if (i >= 0 && i < x.length) {
        acc += x[i]! * tap;
        wsum += tap;
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

export function trimRange(pcm: Samples, sr: number): { start: number; end: number } | null {
  const bounds = silenceBounds(pcm, sr);
  const total = pcm.length / sr;
  if (total <= 0 || bounds.end <= bounds.start) return null;
  const start = Math.round(bounds.start * 100) / 100;
  const end = Math.round(bounds.end * 100) / 100;
  if ((end - start) / total > 0.99) return null;
  return { start, end };
}

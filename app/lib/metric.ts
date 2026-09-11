import type { Samples } from "./arrays";
import { Frames, padOf } from "./stft.ts";

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
  const core = new Frames(win);
  try {
    const bins = core.bins;
    const frames = Math.floor(x.length / hop) + 1;
    const pad = padOf(x, win);
    const out = new Float64Array(frames * bins);
    const { re, im } = core.data();
    for (let f = 0; f < frames; f++) {
      core.analyse(pad, f * hop);
      const base = f * bins;
      for (let b = 0; b < bins; b++) out[base + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
    }
    return out;
  } finally {
    core.close();
  }
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

interface Levelled {
  meta: { bins: number; frames: number };
  levels: ArrayLike<number>;
}

export function levelGap(a: Levelled, b: Levelled): number {
  if (a.meta.bins !== b.meta.bins || a.meta.frames !== b.meta.frames) return -1;
  const n = Math.min(a.levels.length, b.levels.length);
  if (n === 0) return -1;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.levels[i]! - b.levels[i]!);
    if (d > worst) worst = d;
  }
  return worst;
}

const BARK_EDGES = [
  100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700,
  4400, 5300, 6400, 7700, 9500, 12000, 15500,
] as const;

function barkBands(sr: number, bins: number): [number, number][] {
  const perBin = sr / 2 / (bins - 1);
  const out: [number, number][] = [];
  let from = 0;
  for (const edge of BARK_EDGES) {
    const to = Math.min(bins, Math.max(from, Math.round(edge / perBin)));
    if (to > from) out.push([from, to]);
    from = to;
    if (from >= bins) break;
  }
  if (from < bins) out.push([from, bins]);
  return out;
}

function bandEnergy(x: Samples, win: number, hop: number, bands: [number, number][]): Float64Array {
  const bins = win / 2 + 1;
  const mag = magnitudes(x, win, hop);
  const frames = mag.length / bins;
  const out = new Float64Array(frames * bands.length);
  for (let f = 0; f < frames; f++)
    for (let k = 0; k < bands.length; k++) {
      let acc = 0;
      for (let b = bands[k]![0]; b < bands[k]![1]; b++) {
        const m = mag[f * bins + b]!;
        acc += m * m;
      }
      out[f * bands.length + k] = acc;
    }
  return out;
}

export function envelopeCorr(
  ref: Samples,
  got: Samples,
  sr: number,
  winMs = 25,
  hopMs = 10,
): number {
  const win = Math.max(64, 2 ** Math.round(Math.log2((sr * winMs) / 1000)));
  const hop = Math.max(1, Math.round((sr * hopMs) / 1000));
  const bands = barkBands(sr, win / 2 + 1);
  const a = bandEnergy(ref, win, hop, bands);
  const b = bandEnergy(got, win, hop, bands);
  const n = Math.min(a.length, b.length) - (Math.min(a.length, b.length) % bands.length);
  if (n <= 0) return 0;

  let sum = 0;
  for (let k = 0; k < bands.length; k++) {
    let ma = 0;
    let mb = 0;
    for (let f = 0; f < n; f += bands.length) {
      ma += a[f + k]!;
      mb += b[f + k]!;
    }
    ma /= n / bands.length;
    mb /= n / bands.length;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let f = 0; f < n; f += bands.length) {
      const x = a[f + k]! - ma;
      const y = b[f + k]! - mb;
      num += x * y;
      da += x * x;
      db += y * y;
    }
    sum += num / Math.sqrt(Math.max(da * db, 1e-30));
  }
  return sum / bands.length;
}

export function barkDistance(ref: Samples, got: Samples, sr: number, win = 1024, hop = 256): number {
  const bands = barkBands(sr, win / 2 + 1);
  const a = bandEnergy(ref, win, hop, bands);
  const b = bandEnergy(got, win, hop, bands);
  const frames = Math.min(a.length, b.length) / bands.length;
  if (frames < 1) return 0;

  const size = frames * bands.length;
  const la = new Float64Array(size);
  const lb = new Float64Array(size);
  let peak = 0;
  for (let i = 0; i < size; i++) {
    la[i] = Math.pow(Math.max(a[i]!, 0), 0.15);
    lb[i] = Math.pow(Math.max(b[i]!, 0), 0.15);
    if (la[i]! > peak) peak = la[i]!;
    if (lb[i]! > peak) peak = lb[i]!;
  }
  const floor = peak * Math.pow(10, -1.2);

  let acc = 0;
  for (let i = 0; i < size; i++) {
    const d =
      20 * Math.log10(Math.max(la[i]!, floor)) - 20 * Math.log10(Math.max(lb[i]!, floor));
    acc += d * d;
  }
  return Math.sqrt(acc / size);
}

export interface Metrics {
  snr: number;
  corr: number;
  lsd: number;
}

export function compare(ref: Samples, got: Samples): Metrics {
  const n = Math.min(ref.length, got.length);
  const a = align(ref, got, Math.min(2048, Math.floor(n / 4) || 1));
  const s = spectral(magnitudes(ref, 1024, 256), magnitudes(got, 1024, 256));
  return { snr: a.snr, corr: a.corr, lsd: s.lsd };
}

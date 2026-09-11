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

/**
 * 24 段临界带的上边界（Hz）。包络相关与感知谱距共用一张表，
 * 免得「人耳怎么分频」在两个指标里各写一遍。
 */
const BARK_EDGES = [
  100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700,
  4400, 5300, 6400, 7700, 9500, 12000, 15500,
] as const;

/** 把 win/2+1 个线性 bin 分到临界带里，返回每条带的 [起, 止)。 */
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

/** 每条带在每个时间帧上的能量（`frames × bands`）。 */
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

/**
 * 包络相关（STOI 的骨架）：每条临界带的短时能量包络分别求 Pearson 相关再平均。
 * 人耳对相位几乎不敏感，对**包络**极敏感 —— 紧凑 8k 8bit 的波形相关只有 0.19，
 * 包络相关却有 0.93~0.99。看「像不像原声」要以这个为准，`corr` 严重低估听感。
 */
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

/**
 * 感知谱距：临界带内能量先做响度压缩（幂 0.15，即幅度的 0.3 次方），再取 dB 求均方根。
 * 压缩让强弱带不再差几个数量级，更贴近听感。注意它因此**不是真实 dB**，
 * 读数约为同素材 LSD 的 0.3 倍 —— 别拿它和 `spectral().lsd` 横比。
 *
 * **必须加地板**，且两侧共用同一个：取 −80 dB（峰值幅度的 10^-4，压缩后 10^-1.2）。
 * 不带地板时还原侧全静的那条带是 −∞，一两条空带就能把整条距离撑成 Infinity/NaN，
 * 指标当场失效（曾实测严苛素材算出 38~54）。地板若按各自峰值取，则「还原侧全静」
 * 时那一侧的峰值是 0、地板也是 0，照样爆 —— 所以取两侧峰值的较大者，两边共用。
 */
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

export function compare(ref: Samples, got: Samples): { snr: number; corr: number; lsd: number } {
  const n = Math.min(ref.length, got.length);
  const a = align(ref, got, Math.min(2048, Math.floor(n / 4) || 1));
  const s = spectral(magnitudes(ref, 1024, 256), magnitudes(got, 1024, 256));
  return { snr: a.snr, corr: a.corr, lsd: s.lsd };
}

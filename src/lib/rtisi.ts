import { FFT, coverage, hannWindow, mirrorSpectrum } from "./fft";

interface RtisiOptions {
  iters?: number;
  warm?: Float64Array | null;
  budget?: number;
  /** 幅度软约束的下/上界（逐 bin）；不给就退化成硬投影（钉在目标幅度上） */
  lo?: Float64Array | null;
  hi?: Float64Array | null;
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
  let K = Math.max(0, Math.min(frames - 1, R - 1));
  let iters = Math.max(1, opts.iters ?? 8);
  const warm = opts.warm ?? null;
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
  const cos = new Float64Array((K + 1) * bins);
  const sin = new Float64Array((K + 1) * bins);
  const amp = new Float64Array((K + 1) * bins);
  const prevCos = new Float64Array((K + 1) * bins);
  const prevSin = new Float64Array((K + 1) * bins);
  const prevAmp = new Float64Array((K + 1) * bins);
  const lo = opts.lo ?? null;
  const hi = opts.hi ?? null;
  // 给了区间：幅度落在区间内就不动它，出界才夹回来。
  // 没给：退回硬投影 —— 幅度一律写成目标值，与加这套之前逐位相同。
  const fit = (d: number, i: number): number =>
    lo && hi ? (d < lo[i]! ? lo[i]! : d > hi[i]! ? hi[i]! : d) : mag[i]!;

  const load = (at: number): void => {
    local.fill(0);
    const avail = Math.min(span, padded - at);
    if (avail > 0) local.set(out.subarray(at, at + avail));
  };

  const put = (k: number, warm: Float64Array, from: number): void => {
    for (let b = 0; b < bins; b++) {
      const p = warm[from + b]!;
      cos[k * bins + b] = Math.cos(p);
      sin[k * bins + b] = Math.sin(p);
      // 只定相位。幅度如实填 0 —— 这一步覆盖的那些位置，local 里本来就还是空的。
      // 硬投影下幅度恒取目标值、不看 amp，所以这与加软约束之前逐位相同；
      // 软约束下则让它从 0 起步，地板那一档这才真的能落到 0。
      amp[k * bins + b] = 0;
    }
  };

  const lay = (f: number, k: number): void => {
    const base = f * bins;
    const at = k * bins;
    for (let b = 0; b < bins; b++) {
      const g = fit(amp[at + b]!, base + b);
      re[b] = g * cos[at + b]!;
      im[b] = g * sin[at + b]!;
    }
    for (let b = bins; b < full; b++) {
      re[b] = 0;
      im[b] = 0;
    }
    mirrorSpectrum(re, im, full, L);
    fft.transform(re, im, true);
    const from = k * a;
    for (let n = 0; n < L; n++) local[from + n] = local[from + n]! + re[n]! * w[n]!;
  };

  const read = (k: number): void => {
    const from = k * a;
    for (let n = 0; n < L; n++) {
      re[n] = local[from + n]! * w[n]!;
      im[n] = 0;
    }
    fft.transform(re, im);
    const at = k * bins;
    for (let b = 0; b < bins; b++) {
      const rr = re[b]!;
      const ii = im[b]!;
      const d = Math.sqrt(rr * rr + ii * ii);
      cos[at + b] = d > 0 ? rr / d : 1;
      sin[at + b] = d > 0 ? ii / d : 0;
      amp[at + b] = d;
    }
  };

  for (let m = 0; m < frames; m++) {
    const act = Math.min(K + 1, frames - m);
    const at = m * a;

    load(at);

    if (m === 0) {
      for (let k = 0; k < act; k++) {
        if (warm) put(k, warm, k * bins);
        else read(k);
      }
    } else {
      for (let k = 0; k < act; k++) {
        const next = (k + 1) * bins;
        const here = k * bins;
        if (k <= K - 1) {
          cos.set(prevCos.subarray(next, next + bins), here);
          sin.set(prevSin.subarray(next, next + bins), here);
          amp.set(prevAmp.subarray(next, next + bins), here);
        } else if (warm) put(k, warm, (m + k) * bins);
        else {
          cos.fill(1, here, here + bins);
          sin.fill(0, here, here + bins);
          amp.fill(0, here, here + bins);
        }
      }
      // 第 0 帧的相位从已经写进 out 的过去帧重读：逐帧推进才不会在帧界上出爆音。
      read(0);
    }

    for (let it = 0; it < iters; it++) {
      load(at);
      for (let k = 0; k < act; k++) lay(m + k, k);
      for (let k = 0; k < act; k++) read(k);
    }

    const base = m * bins;
    for (let b = 0; b < bins; b++) {
      const g = fit(amp[b]!, base + b);
      re[b] = g * cos[b]!;
      im[b] = g * sin[b]!;
    }
    for (let b = bins; b < full; b++) {
      re[b] = 0;
      im[b] = 0;
    }
    mirrorSpectrum(re, im, full, L);
    fft.transform(re, im, true);
    const room = Math.min(L, padded - at);
    for (let n = 0; n < room; n++) out[at + n] = out[at + n]! + re[n]! * w[n]!;

    prevCos.set(cos);
    prevSin.set(sin);
    prevAmp.set(amp);
    if (tick) await tick(m + 1, frames);
  }

  const cover = coverage(L, a, frames, padded);
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


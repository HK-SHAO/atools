import { FFT, hannWindow } from "./fft";

/*
 * RTISI-LA：带前瞻的实时迭代频谱反演（Zhu, Beauregard & Wyse, ICME 2007）。
 *
 * 为什么不再只用 Griffin-Lim：PGHI 原论文（Průša et al., TASLP 2017）自己给出的结论是
 * 「GLA 迭代 200 次都追不上 PGHI 一次成型」，而 RTISI-LA 在多数素材上又优于 PGHI。
 * 根子在于 GLA 每次迭代都在整段信号上做全局投影、误差单调下降 —— 于是它被自己第一个
 * （很差的）相位估计锁死在一个远离真解的极小里，再也出不来。
 *
 * RTISI-LA 换了个思路：一帧一帧往前推。推第 m 帧时把后面 K 帧一起拉进来参与迭代
 * （前瞻），让第 m 帧的相位同时跟「已经定稿的过去」和「还没定的未来」都自洽，
 * 满意了才把第 m 帧写进输出。每帧只要 8 次迭代就远好过 GLA 的 80 次
 * （论文 Table IV：语音 SER 24.65 dB @8 iters vs G&L 19.99 dB @80 iters）。
 */

export interface RtisiOptions {
  /** 前瞻帧数；默认 L/a - 1，正好铺满一个窗的长度 */
  lookahead?: number;
  /** 每帧迭代次数 */
  iters?: number;
  /** 起步相位（frame-major，frames×bins）。只用来初始化从未打磨过的新帧。 */
  warm?: Float64Array | null;
  /** 第 m 帧的起步相位取自已定稿信号（RTISI 的看家一步），还是沿用上一轮的打磨结果 */
  fromPast?: boolean;
  /** 计算预算。超了先砍前瞻、再砍迭代，保证大文件也不会卡死界面。 */
  budget?: number;
  /** 每帧回调一次，调用方在这里让出主线程 / 检查是否被取消。 */
  tick?: (m: number, frames: number) => Promise<void> | void;
}

const DEFAULT_BUDGET = 5e7;

/**
 * 只有幅度时反演出波形。返回长度 samples 的单声道信号（未归一化电平）。
 *
 * 对齐方式与库里其它合成路径一致：样本 i 落在缓冲的 win/2 + i 处，
 * 帧 f 覆盖 [f·hop, f·hop+win)，最后统一除 Σw²（WOLA）。
 */
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

  // 先按预算收敛规模：大文件宁可少前瞻几帧、少迭代几次，也不能把主线程钉死。
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

  /** 用给定相位把第 f 帧折成加窗时域块，叠进 local 的第 k 槽。 */
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
    mirror(re, im, full, L);
    fft.transform(re, im, true);
    const at = k * a;
    for (let n = 0; n < L; n++) local[at + n] = local[at + n]! + re[n]! * w[n]!;
  };

  /** 从 local 的第 k 槽反推相位，写进 ph。 */
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
      // 第一帧没有过去可依：有新帧相位就用，否则全 0 起步。
      for (let k = 0; k < act; k++) {
        if (warm) ph.set(warm.subarray(k * bins, (k + 1) * bins), k * bins);
        else read(k);
      }
    } else {
      // 上一轮里，第 m+k 帧是第 k+1 槽 —— 已经跟着第 m-1 帧打磨过一轮，直接搬。
      for (let k = 0; k < act; k++) {
        if (k <= K - 1) ph.set(prev.subarray((k + 1) * bins, (k + 2) * bins), k * bins);
        else if (warm) ph.set(warm.subarray((m + k) * bins, (m + k + 1) * bins), k * bins);
        else ph.fill(0, k * bins, (k + 1) * bins);
      }
      // RTISI 的看家一步：当前帧的起步相位直接取「已定稿信号」的相位，
      // 保证推出来的第一件事就是跟过去接得上。
      if (fromPast) read(0);
    }

    for (let it = 0; it < iters; it++) {
      load(at);
      for (let k = 0; k < act; k++) lay(m + k, k);
      for (let k = 0; k < act; k++) read(k);
    }

    // 定稿：只把第 m 帧写进输出，后面 K 帧留给下一轮继续打磨。
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
    mirror(re, im, full, L);
    fft.transform(re, im, true);
    const room = Math.min(L, padded - at);
    for (let n = 0; n < room; n++) out[at + n] = out[at + n]! + re[n]! * w[n]!;

    prev.set(ph);
    if (tick) await tick(m + 1, frames);
  }

  // Σw² 归一化（WOLA），跟其它合成路径保持一致。
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

/** 实信号的共轭对称补齐：逆变换前必须做。 */
function mirror(re: Float64Array, im: Float64Array, bins: number, size: number): void {
  im[0] = 0;
  im[bins - 1] = 0;
  for (let b = 1; b < bins - 1; b++) {
    re[size - b] = re[b]!;
    im[size - b] = -im[b]!;
  }
}

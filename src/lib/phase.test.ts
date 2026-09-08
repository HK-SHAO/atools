/*
 * 相位重建与 FFT 的回归测试。
 *
 * 这几条都是踩过的坑：
 *   频率方向梯度漏了 π      —— 整条频率轴差 180°
 *   heap 在局部极大值处断链 —— 相位被切成成千上万块
 *   重采样把越界抽头算进分母 —— 首尾凭空淡入淡出
 */

import { describe, expect, test } from "bun:test";
import type { Samples } from "./arrays";
import { FFT, hannWindow } from "./fft";
import { phaseFromMagnitude } from "./phase";
import { resample } from "./resample";

const TWO_PI = Math.PI * 2;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** 线性扫频：时频面上一道干净的脊，是相位重建最好发挥的场景。 */
function chirp(n: number, sr: number, from: number, to: number): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    x[i] = Math.sin((TWO_PI * n * (from * t + 0.5 * (to - from) * t * t)) / sr);
  }
  return x;
}

function stft(x: Float64Array, win: number, hop: number) {
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const padded = x.length + win;
  const pad = new Float64Array(padded);
  for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(frames * bins);
  const ph = new Float64Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) {
      mag[f * bins + b] = Math.hypot(re[b]!, im[b]!);
      ph[f * bins + b] = Math.atan2(im[b]!, re[b]!);
    }
  }
  return { mag, ph, frames, bins };
}

describe("fft", () => {
  test("matches a naive dft", () => {
    const n = 32;
    const fft = new FFT(n);
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.31) + i / n);
    const im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.77));
    const re0 = Float64Array.from(re);
    const im0 = Float64Array.from(im);
    fft.transform(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-TWO_PI * k * t) / n;
        sr += re0[t]! * Math.cos(a) - im0[t]! * Math.sin(a);
        si += re0[t]! * Math.sin(a) + im0[t]! * Math.cos(a);
      }
      expect(re[k]!).toBeCloseTo(sr, 8);
      expect(im[k]!).toBeCloseTo(si, 8);
    }
  });

  test("hann is symmetric with its peak at the centre", () => {
    const w = hannWindow(256);
    for (let i = 1; i < 128; i++) expect(w[128 + i]!).toBeCloseTo(w[128 - i]!, 12);
    expect(w[128]!).toBeCloseTo(1, 12);
  });

  /** WOLA 能精确还原的前提：Σw² 沿 hop 平移后是常数。Hann 在 hop=win/4 上成立。 */
  test("coverage is flat at hop = win/4", () => {
    const win = 256;
    const hop = win / 4;
    const w = hannWindow(win);
    const cover = new Float64Array(win);
    for (let f = 0; f * hop < win; f++)
      for (let m = 0; m < win; m++) cover[(f * hop + m) % win] = cover[(f * hop + m) % win]! + w[m]! ** 2;
    let lo = Infinity;
    let hi = 0;
    for (let m = 0; m < win; m++) {
      lo = Math.min(lo, cover[m]!);
      hi = Math.max(hi, cover[m]!);
    }
    expect(hi - lo).toBeLessThan(1e-9);
  });
});

describe("phase from magnitude", () => {
  test("a chirp's phase comes back almost exactly", () => {
    const sr = 16000;
    const win = 512;
    const hop = 128;
    const x = chirp(sr * 1, sr, 300, 4000);
    const { mag, ph, frames, bins } = stft(x, win, hop);
    const got = phaseFromMagnitude(mag, frames, bins, win, hop);

    // 整体转一个常数是免不了的（等于全通，听感无损），先按能量加权求出来再扣掉。
    let cr = 0;
    let ci = 0;
    for (let i = 0; i < mag.length; i++) {
      const wt = mag[i]! ** 2;
      cr += wt * Math.cos(got[i]! - ph[i]!);
      ci += wt * Math.sin(got[i]! - ph[i]!);
    }
    const k = Math.atan2(ci, cr);
    let num = 0;
    let den = 0;
    for (let i = 0; i < mag.length; i++) {
      const wt = mag[i]! ** 2;
      num += wt * wrap(got[i]! - ph[i]! - k) ** 2;
      den += wt;
    }
    const rms = (Math.sqrt(num / den) * 180) / Math.PI;
    expect(rms).toBeLessThan(25);
  });

  /** 半窗偏移让每走一个 bin 相位就转 -π。梯度里必须带着它，漏了整条轴差 180°。 */
  test("the frequency step carries the half-window π", () => {
    const sr = 16000;
    const win = 512;
    const hop = 128;
    // 幅度沿时间平稳：此时沿 bin 走一步的相位增量就只剩那个 -π。
    const x = chirp(sr * 1, sr, 1200, 1200);
    const { mag, ph, frames, bins } = stft(x, win, hop);
    let top = 0;
    for (let i = 0; i < mag.length; i++) if (mag[i]! > top) top = mag[i]!;
    let num = 0;
    let den = 0;
    for (let f = 2; f < frames - 2; f++)
      for (let b = 1; b < bins - 1; b++) {
        const i = f * bins + b;
        const wt = Math.min(mag[i]!, mag[i + 1]!);
        if (wt < top * 0.05) continue;
        num += wt * wrap(ph[i + 1]! - ph[i]! + Math.PI) ** 2;
        den += wt;
      }
    const deg = (Math.sqrt(num / den) * 180) / Math.PI;
    expect(deg).toBeLessThan(30);
  });

  test("a silent spectrum does not blow up", () => {
    const mag = new Float64Array(64 * 33);
    const out = phaseFromMagnitude(mag, 64, 33, 64, 16);
    expect(out.length).toBe(mag.length);
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true);
  });
});

describe("resample", () => {
  test("edges keep their level", () => {
    const sr = 16000;
    const n = sr;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((TWO_PI * 400 * i) / sr);
    const y = resample(x as Samples, sr, 8000);
    // 头尾各 100 个点的包络不该被压掉。
    const rms = (from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += y[i]! * y[i]!;
      return Math.sqrt(s / (to - from));
    };
    const head = rms(0, 100);
    const mid = rms(Math.floor(y.length / 2) - 50, Math.floor(y.length / 2) + 50);
    expect(head).toBeGreaterThan(mid * 0.7);
  });
});

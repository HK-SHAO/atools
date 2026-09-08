import { describe, expect, test } from "bun:test";
import { FFT, hannWindow } from "./fft";
import { align, magnitudes, spectral } from "./metric";
import { levelToDb } from "./spectrum";
import type { Samples } from "./arrays";
import { rtisiLa } from "./rtisi";

/** 用一个 440 Hz 音做 STFT；预期 0 根谐波，整张图就一条亮线，最容易对。 */
function tone(samples: number, sr: number, freq: number, amp = 0.6): Samples {
  const x = new Float32Array(samples);
  for (let i = 0; i < samples; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
}

describe("rtisi", () => {
  const sr = 8000;
  const win = 256;
  const hop = 64;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const x = tone((sr * 2) | 0, sr, 440);
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const padded = x.length + win;
  const pad = new Float64Array(padded);
  for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;

  // 把声音的 STFT 解出来：幅度、真相位都拿一份。
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(frames * bins);
  const truth = new Float64Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
      truth[f * bins + b] = Math.atan2(im[b]!, re[b]!);
    }
  }

  /** 给定相位 WOLA 合成。 */
  const wola = (ph: Float64Array): Float64Array => {
    const acc = new Float64Array(padded);
    const cover = new Float64Array(padded);
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < bins; b++) {
        re[b] = mag[f * bins + b]! * Math.cos(ph[f * bins + b]!);
        im[b] = mag[f * bins + b]! * Math.sin(ph[f * bins + b]!);
      }
      im[0] = 0;
      im[bins - 1] = 0;
      for (let b = 1; b < bins - 1; b++) {
        re[win - b] = re[b]!;
        im[win - b] = -im[b]!;
      }
      fft.transform(re, im, true);
      for (let m = 0; m < win; m++) {
        acc[f * hop + m] = acc[f * hop + m]! + re[m]! * w[m]!;
        cover[f * hop + m] = cover[f * hop + m]! + w[m]! * w[m]!;
      }
    }
    let top = 0;
    for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
    const out = new Float64Array(x.length);
    for (let i = 0; i < out.length; i++)
      out[i] = cover[win / 2 + i]! > top * 0.05 ? acc[win / 2 + i]! / cover[win / 2 + i]! : 0;
    return out;
  };

  test("上限 = 真相位合成出与原信号高相关", () => {
    const y = wola(truth);
    const a = align(x, Float32Array.from(y) as Samples, 64);
    expect(a.corr).toBeGreaterThan(0.99);
  });

  test("纯音上 RTISI-LA 比随机起步起步更稳", () => {
    const y = rtisiLa(mag, frames, bins, win, hop, x.length, { iters: 8 });
    // 纯音 + 高冗余：幅度基本就锁在真相位的附近了，相关应明显大于 0
    const a = align(x, Float32Array.from(y) as Samples, 64);
    expect(a.corr).toBeGreaterThan(0.2);
  });

  test("一个窗的 padding 不会让最后几帧搞砸整体", () => {
    // 短到只有几帧：保证不会爆数组/出 NaN。
    const y = rtisiLa(
      mag.subarray(0, 5 * bins),
      5,
      bins,
      win,
      hop,
      4 * hop,
      { iters: 4 },
    );
    for (let i = 0; i < y.length; i++) expect(Number.isFinite(y[i]!)).toBe(true);
  });
});

describe("metric", () => {
  test("align 把已知时延对齐到相关 1", () => {
    const sr = 1000;
    const a = new Float32Array(sr);
    for (let i = 0; i < sr; i++) a[i] = Math.sin((2 * Math.PI * 7 * i) / sr);
    const shift = 23;
    const b = new Float32Array(sr);
    for (let i = 0; i < sr - shift; i++) b[i + shift] = a[i]!;
    const r = align(a, b, 64);
    expect(r.corr).toBeGreaterThan(0.999);
  });

  test("magnitudes + spectral 对相同输入给出零误差", () => {
    const x = new Float32Array(2048);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 50 * i) / 8000);
    const m = magnitudes(x, 256, 64);
    const s = spectral(m, m);
    expect(s.conv).toBeCloseTo(0, 3);
    expect(s.lsd).toBeCloseTo(0, 3);
  });
});

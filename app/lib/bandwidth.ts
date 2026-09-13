import type { Samples } from "./arrays";
import { SR_OPTIONS } from "./params.ts";

// 有效带宽估计：解码后的音频往往名义采样率很高（Opus 恒为 48k），
// 但编码器已把听感之外的高频滤掉，直接按名义采样率编码会把图画出一大片黑场。
// 这里用少量短窗 FFT 找出「还有能量的最高频率」，供自动选档用。

const FFT_SIZE = 2048;
const FRAMES_MAX = 96;
// 相对每帧谱峰低于这一分贝数的频点视为无能量。
const FLOOR_DB = -60;
// 选档裕量：内容带宽不得超过所选档位 Nyquist 的这一比例，
// 给重采样的过渡带（截止在约 0.92·Nyquist）留出余量。
const NYQUIST_KEEP = 0.95;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const bi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const binHzOf = (sr: number): number => sr / FFT_SIZE;

function frameBandwidth(x: Float64Array, sr: number): number {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let peak = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
    re[i] = x[i]! * w;
  }
  fft(re, im);
  const bins = FFT_SIZE / 2;
  const pow = new Float64Array(bins);
  for (let b = 1; b < bins; b++) {
    const p = re[b]! * re[b]! + im[b]! * im[b]!;
    pow[b] = p;
    if (p > peak) peak = p;
  }
  if (peak <= 0) return 0;
  const gate = peak * Math.pow(10, FLOOR_DB / 10);
  for (let b = bins - 1; b >= 1; b--) {
    if (pow[b]! > gate) return b * binHzOf(sr);
  }
  return 0;
}

// 返回音频内容的有效最高频率（Hz）；太短判不了时返回 sr/2（保持原样）。
export function bandwidthOf(pcm: Samples, sr: number): number {
  const usable = pcm.length - FFT_SIZE;
  if (usable < FFT_SIZE / 2) return sr / 2;
  const count = Math.min(FRAMES_MAX, Math.floor(usable / (FFT_SIZE / 2)));
  const widths: number[] = [];
  const frame = new Float64Array(FFT_SIZE);
  for (let f = 0; f < count; f++) {
    const at = Math.floor((f * usable) / count);
    for (let i = 0; i < FFT_SIZE; i++) frame[i] = pcm[at + i] ?? 0;
    widths.push(frameBandwidth(frame, sr));
  }
  widths.sort((a, b) => a - b);
  return widths[Math.floor((count - 1) * 0.9)]!;
}

// 从低到高找第一个 Nyquist 覆盖住内容带宽的档位（不升过原采样率）；
// 都覆盖不了返回 0（按原采样率）。
export const srForBandwidth = (bw: number, srcSr: number): number => {
  for (const s of SR_OPTIONS) {
    if (s > 0 && s <= srcSr && bw <= NYQUIST_KEEP * (s / 2)) return s;
  }
  return 0;
};

export const autoSr = (pcm: Samples, srcSr: number): number =>
  srForBandwidth(bandwidthOf(pcm, srcSr), srcSr);

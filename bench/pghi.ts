import { FFT, hannWindow } from "../src/lib/fft";
import { phaseFromMagnitude, TUNE } from "../src/lib/phase";
import type { Samples } from "../src/lib/arrays";

const SR = 16000;

function tone(seconds: number): Samples {
  const n = Math.floor(SR * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] =
      0.4 * Math.sin(2 * Math.PI * 220 * t) +
      0.3 * Math.sin(2 * Math.PI * (700 + 500 * t) * t) +
      0.2 * Math.sin(2 * Math.PI * 1500 * t) * Math.max(0, 1 - t / seconds);
  }
  return x;
}

function stft(x: Samples, win: number, hop: number) {
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const pad = new Float64Array(x.length + win);
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
      mag[f * bins + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
      ph[f * bins + b] = Math.atan2(im[b]!, re[b]!);
    }
  }
  return { mag, ph, frames, bins };
}

const wrapd = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function weightedError(est: Float64Array, truth: Float64Array, mag: Float64Array): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < mag.length; i++) {
    const w = mag[i]! ** 2;
    const d = wrapd(est[i]! - truth[i]!);
    num += w * d * d;
    den += w;
  }
  return (Math.sqrt(num / Math.max(den, 1e-30)) * 180) / Math.PI;
}

const x = tone(2);
console.log("win  hop   a/M    γ        加权相位误差    vs 中心窗相位");

for (const [win, hop] of [
  [256, 64],
  [256, 128],
  [512, 128],
  [1024, 256],
] as [number, number][]) {
  const { mag, ph, frames, bins } = stft(x, win, hop);
  for (const g of [0.25645, 0.2833]) {
    TUNE.gamma = g;
    const est = phaseFromMagnitude(mag, frames, bins, win, hop);
    const ours = weightedError(est, ph, mag);
    const centered = new Float64Array(ph.length);
    for (let f = 0; f < frames; f++)
      for (let b = 0; b < bins; b++)
        centered[f * bins + b] = wrapd(ph[f * bins + b]! + Math.PI * b);
    const cent = weightedError(est, centered, mag);
    console.log(
      `${String(win).padStart(4)} ${String(hop).padStart(4)}  ${(hop / win).toFixed(3)}  ${g}   ${ours.toFixed(1).padStart(8)}°   ${cent.toFixed(1).padStart(8)}°`,
    );
  }
}

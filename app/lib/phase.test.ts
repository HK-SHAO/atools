import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import type { Samples } from "./arrays";
import { attachKernel, loadDsp, mustKernel } from "./dsp";
import { phaseFromMagnitude } from "./phase";
import { resample } from "./resample";
import { hannOf, Frames } from "./stft";

const TWO_PI = Math.PI * 2;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

beforeAll(async () => {
  attachKernel(await loadDsp(compileWasm()));
});

function chirp(n: number, sr: number, from: number, to: number): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    x[i] = Math.sin((TWO_PI * n * (from * t + 0.5 * (to - from) * t * t)) / sr);
  }
  return x;
}

function stft(x: Float64Array, win: number, hop: number) {
  const core = new Frames(win);
  try {
    const bins = core.bins;
    const frames = Math.floor(x.length / hop) + 1;
    const pad = new Float64Array(x.length + win);
    for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;
    const mag = new Float64Array(frames * bins);
    const ph = new Float64Array(frames * bins);
    const { re, im } = core.data();
    for (let f = 0; f < frames; f++) {
      core.analyse(pad, f * hop);
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        mag[base + b] = Math.hypot(re[b]!, im[b]!);
        ph[base + b] = Math.atan2(im[b]!, re[b]!);
      }
    }
    return { mag, ph, frames, bins };
  } finally {
    core.close();
  }
}

describe("binding the initial phase", () => {
  test("magnitude in, phase out: frames×bins finite angles come back", () => {
    const frames = 24;
    const bins = 129;
    const win = 256;
    const hop = 64;
    const mag = new Float64Array(frames * bins);
    for (let i = 0; i < mag.length; i++) mag[i] = 1e-3 * (1 + (i % 7));
    const before = mag.slice();
    const out = phaseFromMagnitude(mag, frames, bins, win, hop);

    expect(out.length).toBe(frames * bins);
    let worst = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true);
      worst = Math.max(worst, Math.abs(out[i]!));
    }
    expect(worst).toBeLessThanOrEqual(Math.PI);
    expect(worst).toBeGreaterThan(0.5);
    expect(mag.some((v, i) => v !== before[i]!)).toBe(false);
  });

  test("two calls on the same input are bit for bit identical (both sides are copied, so views cannot alias)", () => {
    const sr = 16000;
    const { mag, frames, bins } = stft(chirp(sr, sr, 300, 4000), 256, 64);
    const a = phaseFromMagnitude(mag, frames, bins, 256, 64);
    const b = phaseFromMagnitude(mag, frames, bins, 256, 64);
    expect(a.findIndex((v, i) => v !== b[i]!)).toBe(-1);
  });

  test("degenerate input yields zero phase instead of throwing (the kernel rejects these parameters at open)", () => {
    const shallow = new Float64Array(4 * 5);
    expect(phaseFromMagnitude(shallow, 1, 5, 256, 64).every(v => v === 0)).toBe(true);
    expect(phaseFromMagnitude(shallow, 4, 1, 256, 64).every(v => v === 0)).toBe(true);
    expect(phaseFromMagnitude(shallow, 4, 5, 256, 0).every(v => v === 0)).toBe(true);
    expect(phaseFromMagnitude(new Float64Array(6), 4, 5, 256, 64).every(v => v === 0)).toBe(true);
  });

  test("an energy-free spectrum runs the whole path and leaves zero phase", () => {
    const out = phaseFromMagnitude(new Float64Array(8 * 9), 8, 9, 256, 64);
    expect(out.length).toBe(72);
    expect(out.every(v => v === 0)).toBe(true);
  });
});

describe("stft conventions", () => {
  test("a frequency step carries the half-window π", () => {
    const sr = 16000;
    const win = 512;
    const hop = 128;
    const { mag, ph, frames, bins } = stft(chirp(sr, sr, 1200, 1200), win, hop);
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
});

describe("resample", () => {
  test("edges keep their level", () => {
    const sr = 16000;
    const n = sr;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((TWO_PI * 400 * i) / sr);
    const y = resample(x as Samples, sr, 8000);
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

describe("stft adapter layer", () => {
  test("the window function comes from the kernel tables and is the same one", () => {
    const w = hannOf(mustKernel(), 256);
    expect(w.length).toBe(256);
    expect(w[128]).toBeCloseTo(1, 12);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(hannOf(mustKernel(), 512).length).toBe(512);
  });

  test("a work area cannot be used once it is handed back (borrows are accounted for)", () => {
    const core = new Frames(512);
    core.close();
    expect(() => core.data()).toThrow(/returned to the kernel/);
    core.close();
  });

  test("a full slot pool reports itself (the pool is 6, so a missed return cannot become a slow path)", () => {
    const held = Array.from({ length: 6 }, () => new Frames(512));
    expect(() => new Frames(512)).toThrow(/session slots exhausted/);
    for (const c of held) c.close();
    new Frames(512).close();
  });
});

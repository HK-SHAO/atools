import { beforeAll, describe, expect, test } from "vitest";
import { compileWasm } from "../../scripts/moon";
import type { Samples } from "./arrays";
import { attachKernel, loadDsp, mustKernel } from "./dsp";
import { phaseFromMagnitude } from "./phase";
import { resample } from "./resample";
import { hannOf, Frames } from "./stft";

/**
 * 这里只剩**还住在宿主**的两条式子：相位反演（`phase.ts`）与重采样（`resample.ts`），
 * 外加它们的接口契约。
 *
 * 原先这里还有三条在量内核的实现细节 —— 正变换与朴素 DFT 是否一致、汉宁窗是否对称、
 * 窗平方在 `hop = win/4` 时是否拼得平 —— 它们都已经被搬进 `moon/` 的白盒
 * （`plan_wbtest.mbt` / `fft_wbtest.mbt`）。搬过去之后判据更硬：量的是**内核真的在用的
 * 那张表**，而不是宿主拿同一条式子重算的一份复制品。
 *
 * 于是本文件里的变换只是**造素材**的手段，走内核的 `Frames`（宿主不再自带 FFT）——
 * 性能不敏感，一致性要紧：素材的谱必须就是产品链会看到的那份谱。
 */

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

describe("phase from magnitude", () => {
  test("a chirp's phase comes back almost exactly", () => {
    const sr = 16000;
    const win = 512;
    const hop = 128;
    const x = chirp(sr * 1, sr, 300, 4000);
    const { mag, ph, frames, bins } = stft(x, win, hop);
    const got = phaseFromMagnitude(mag, frames, bins, win, hop);

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

  test("the frequency step carries the half-window π", () => {
    const sr = 16000;
    const win = 512;
    const hop = 128;
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

describe("stft 适配层", () => {
  test("窗函数来自内核表组，与内核表组是同一份", () => {
    const w = hannOf(mustKernel(), 256);
    expect(w.length).toBe(256);
    expect(w[128]).toBeCloseTo(1, 12);
    expect(w[0]).toBeCloseTo(0, 12);
    // 换一个窗长拿到的是另一张表，不是同一段的别名。
    expect(hannOf(mustKernel(), 512).length).toBe(512);
  });

  test("工作区还回去之后就不能再用（借还有据）", () => {
    const core = new Frames(512);
    core.close();
    expect(() => core.data()).toThrow(/还给内核/);
    // 还过一次再还一次是幂等的：取消路径会走到两次。
    core.close();
  });

  test("槽位池满时报出来（池是 6 个，漏还不会变成慢慢变慢的路）", () => {
    const held = Array.from({ length: 6 }, () => new Frames(512));
    expect(() => new Frames(512)).toThrow(/会话槽已满/);
    for (const c of held) c.close();
    new Frames(512).close();
  });
});

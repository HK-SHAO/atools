import { beforeAll, describe, expect, test } from "vitest";
import { compileWasm } from "../../scripts/moon";
import type { Samples } from "./arrays";
import { attachKernel, loadDsp, mustKernel } from "./dsp";
import { phaseFromMagnitude } from "./phase";
import { resample } from "./resample";
import { hannOf, Frames } from "./stft";

/**
 * 宿主侧**适配层**的契约：相位初值的绑定（`phase.ts` → `moon/pghi.mbt`）、重采样
 * （`resample.ts`）、以及短时变换的骨架（`stft.ts`）。
 *
 * PGHI 的**数值**已经搬进内核的白盒（`moon/pghi_wbtest.mbt` 量啁啾相位的加权 RMS）。
 * 留在这里的是只有宿主这一层才可能做错的事：偏移与基址的拼法、进出两侧的拷贝、
 * 退化输入的返回、以及内核到底有没有被调到。
 *
 * 变换本身没有第二种实现 —— 素材一律走 `Frames`（借内核会话槽）。所以本文件里的
 * `stft()` 不是「另一份 STFT」，它是**产品链会看到的那份谱**；「频率步进带半个窗的 π」
 * 正因此留在这里：内核侧的「真相位是不动点」用的是同一条路径造出来的相位，自洽，
 * 锁不住补零与加窗的约定。
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

describe("相位初值的绑定", () => {
  test("幅度进、相位出，出来的是 frames×bins 个有限角度", () => {
    const frames = 24;
    const bins = 129;
    const win = 256;
    const hop = 64;
    const mag = new Float64Array(frames * bins);
    for (let i = 0; i < mag.length; i++) mag[i] = 1e-3 * (1 + (i % 7));
    const before = mag.slice();
    const out = phaseFromMagnitude(mag, frames, bins, win, hop);

    expect(out.length).toBe(frames * bins);
    // 幅度区要是被当成了相位区，这里会跳出量级（1e-3 对 π）。
    let worst = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true);
      worst = Math.max(worst, Math.abs(out[i]!));
    }
    expect(worst).toBeLessThanOrEqual(Math.PI);
    expect(worst).toBeGreaterThan(0.5);
    // 宿主只往内核拷，不动调用方的数组。
    expect(mag.some((v, i) => v !== before[i]!)).toBe(false);
  });

  test("同一输入两次调用逐位相同（进出两侧都拷过，视图不会串）", () => {
    const sr = 16000;
    const { mag, frames, bins } = stft(chirp(sr, sr, 300, 4000), 256, 64);
    const a = phaseFromMagnitude(mag, frames, bins, 256, 64);
    const b = phaseFromMagnitude(mag, frames, bins, 256, 64);
    expect(a.findIndex((v, i) => v !== b[i]!)).toBe(-1);
  });

  test("退化输入给零相位，不抛（内核在 open 就拒了这些参数）", () => {
    const shallow = new Float64Array(4 * 5);
    expect(phaseFromMagnitude(shallow, 1, 5, 256, 64).every(v => v === 0)).toBe(true);
    expect(phaseFromMagnitude(shallow, 4, 1, 256, 64).every(v => v === 0)).toBe(true);
    expect(phaseFromMagnitude(shallow, 4, 5, 256, 0).every(v => v === 0)).toBe(true);
    // 幅度谱比 frames×bins 短：整条返回零相位，不做「半段算、半段留」。
    expect(phaseFromMagnitude(new Float64Array(6), 4, 5, 256, 64).every(v => v === 0)).toBe(true);
  });

  test("无能量的谱走完整条路，留下零相位", () => {
    const out = phaseFromMagnitude(new Float64Array(8 * 9), 8, 9, 256, 64);
    expect(out.length).toBe(72);
    expect(out.every(v => v === 0)).toBe(true);
  });
});

describe("stft 约定", () => {
  test("频率步进带半个窗的 π", () => {
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

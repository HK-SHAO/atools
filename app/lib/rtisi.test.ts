import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import type { Samples } from "./arrays";
import { attachKernel, loadDsp, openJob, type Dsp } from "./dsp";
import { align, magnitudes, spectral } from "./metric";
import { rtisiLa, type Band } from "./rtisi";
import { Frames } from "./stft";

let dsp: Dsp;
beforeAll(async () => {
  dsp = await loadDsp(compileWasm());
  attachKernel(dsp);
});
afterAll(() => attachKernel(null));

function fixture(win: number, hop: number, samples: number) {
  const core = new Frames(win);
  try {
    const bins = core.bins;
    const frames = Math.floor(samples / hop) + 1;
    const x = new Float64Array(samples);
    for (let i = 0; i < samples; i++) x[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / 8000);
    const pad = new Float64Array(samples + win);
    for (let i = 0; i < samples; i++) pad[win / 2 + i] = x[i]!;
    const mag = new Float64Array(frames * bins);
    const truth = new Float64Array(frames * bins);
    const { re, im } = core.data();
    for (let f = 0; f < frames; f++) {
      core.analyse(pad, f * hop);
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        mag[base + b] = Math.hypot(re[b]!, im[b]!);
        truth[base + b] = Math.atan2(im[b]!, re[b]!);
      }
    }
    return { x, mag, truth, frames, bins, win, hop, samples };
  } finally {
    core.close();
  }
}

const relative = (a: Float64Array, b: Float64Array): number => {
  let peak = 0;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]!));
  if (peak === 0) return 0;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst / peak;
};

describe("rtisi（跨边界的那三件事）", () => {
  test("给了真值相位就几乎原样还回来（宿主这条路上的数值确实是对的）", async () => {
    const fx = fixture(256, 64, 16000);
    const y = await rtisiLa(fx.mag, fx.frames, fx.bins, fx.win, fx.hop, fx.samples, {
      iters: 8,
      warm: fx.truth.slice(),
    });
    expect(align(Float32Array.from(fx.x) as Samples, Float32Array.from(y) as Samples, 64).corr).toBeGreaterThan(
      0.99,
    );
  });

  test("一个窗的 padding 不会让最后几帧搞砸整体（输出处处有限）", async () => {
    const fx = fixture(256, 64, 16000);
    const y = await rtisiLa(fx.mag.subarray(0, 5 * fx.bins), 5, fx.bins, fx.win, fx.hop, 4 * fx.hop, {
      iters: 4,
    });
    for (const v of y) expect(Number.isFinite(v)).toBe(true);
  });

  test("频带表按内核那套坐标读到（写错就退成另一条路，输出差别是 O(1)）", async () => {
    const fx = fixture(256, 64, 9000);
    const fb = fx.frames * fx.bins;
    const levels = new Uint8Array(fb).fill(1);
    const lo = new Float64Array(256);
    const hi = new Float64Array(256);
    lo[0] = 1;
    hi[0] = 1e300;
    const band: Band = { levels, lo, hi };

    const clamped = await rtisiLa(fx.mag, fx.frames, fx.bins, fx.win, fx.hop, fx.samples, {
      iters: 4,
      warm: fx.truth.slice(),
      band,
    });
    let peak = 0;
    for (const v of clamped) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBe(0);

    const hard = await rtisiLa(fx.mag, fx.frames, fx.bins, fx.win, fx.hop, fx.samples, {
      iters: 4,
      warm: fx.truth.slice(),
    });
    let hardPeak = 0;
    for (const v of hard) hardPeak = Math.max(hardPeak, Math.abs(v));
    expect(hardPeak).toBeGreaterThan(1e-3);
  });

  test("另一件作业同时开着，结果逐位不变（各占各的数组）", async () => {
    const fx = fixture(512, 128, 4096);
    const o = { iters: 8, warm: fx.truth.slice() };
    const base = await rtisiLa(fx.mag, fx.frames, fx.bins, fx.win, fx.hop, fx.samples, o);
    const neighbour = openJob(dsp, 1 << 20, 1 << 18);
    try {
      const pushed = await rtisiLa(fx.mag, fx.frames, fx.bins, fx.win, fx.hop, fx.samples, o);
      expect(relative(base, pushed)).toBe(0);
    } finally {
      neighbour.close();
    }
  });

  test("tick 按块报进度，且**让出之后仍然算对**", async () => {
    const fx = fixture(512, 128, 4096);
    const seen: number[] = [];
    const y = await rtisiLa(fx.mag, fx.frames, fx.bins, fx.win, fx.hop, fx.samples, {
      iters: 8,
      warm: fx.truth.slice(),
      tick: async (m, total) => {
        seen.push(m);
        expect(total).toBe(fx.frames);
        await new Promise(done => setTimeout(done, 0));
      },
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(fx.frames);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    expect(y.length).toBe(fx.samples);
  });

  test("中途取消不留作业（正常收尾与抛错两条路都不漏）", async () => {
    const fx = fixture(512, 128, 4096);
    const live = (): number => dsp.kernel.dsp_job_live();
    const before = live();
    await expect(
      rtisiLa(fx.mag, fx.frames, fx.bins, fx.win, fx.hop, fx.samples, {
        iters: 8,
        warm: fx.truth.slice(),
        tick: m => (m >= fx.frames ? undefined : Promise.reject(new Error("cancelled"))),
      }),
    ).rejects.toThrow("cancelled");
    expect(live()).toBe(before);
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
    expect(align(a, b, 64).corr).toBeGreaterThan(0.999);
  });

  test("magnitudes + spectral 对相同输入给出零误差", () => {
    const x = new Float32Array(2048);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 50 * i) / 8000);
    const m = magnitudes(x, 256, 64);
    const s = spectral(m, m);
    expect(s.lsd).toBeCloseTo(0, 3);
    expect(s.conv).toBeLessThan(-100);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compileWasm } from "../../scripts/moon";
import type { Samples } from "./arrays";
import { attachKernel, loadDsp, openJob, type Dsp } from "./dsp";
import { align, magnitudes, spectral } from "./metric";
import { rtisiLa, type Band } from "./rtisi";
import { Frames } from "./stft";

/**
 * RTISI 只在内核里有实现（`moon/rtisi.mbt`），数值行为断言（不动点、分块自由、预算收缩、
 * 软约束那条「字节 → 查表」的路）全在 `moon/rtisi_wbtest.mbt`。这里留下的是**只有跨这条
 * 边界才谈得上**的三件事：
 *
 *   ① 宿主写进去的 `mag` / `warm` / 频带表，内核真的按那套坐标读到了（偏移问内核要，
 *      所以这里比的是**结果**：表写错就会退成另一条路，输出差别是 O(1) 量级）；
 *   ② 分块推进与让出（`tick`）—— 内核里没有 `await`，切块与取消都在宿主这一侧；
 *   ③ **资源归还**：作业区是有限的（4 段），无论正常收尾、`tick` 抛错还是取消，都不能漏。
 */

// 与 `metric` 那一段共用一份内核；文件级挂上，文件级摘掉。
let dsp: Dsp;
beforeAll(async () => {
  dsp = await loadDsp(compileWasm());
  attachKernel(dsp);
});
afterAll(() => attachKernel(null));

/** 一副夹具：纯音 + 它的 STFT（补零约定与 `spectrum.ts` 的 `encode` 同一条）。 */
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

  /**
   * 频带表真的被写到了内核读的那两段上：`levels` 走**字节段**（偏移 0），上下界表走主缓冲
   * 的第 512 项区。这里把 levels 全填 1、表项 1 填成 [0, 0]（表项 0 是放行的），
   * 于是幅度一律被夹成 0、输出必须整条是 0。
   *
   * 任一处的坐标写错（段搞反、偏移少乘 8、表挪了位置），内核就会取到放行的表项 0，
   * 输出立刻非零 —— 这一条不看地址，只看后果。
   */
  test("频带表按内核那套坐标读到（写错就退成另一条路，输出差别是 O(1)）", async () => {
    const fx = fixture(256, 64, 9000);
    const fb = fx.frames * fx.bins;
    const levels = new Uint8Array(fb).fill(1);
    const lo = new Float64Array(256);
    const hi = new Float64Array(256);
    lo[0] = 1;
    hi[0] = 1e300; // 表项 0：放行
    const band: Band = { levels, lo, hi };

    const clamped = await rtisiLa(fx.mag, fx.frames, fx.bins, fx.win, fx.hop, fx.samples, {
      iters: 4,
      warm: fx.truth.slice(),
      band,
    });
    let peak = 0;
    for (const v of clamped) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBe(0);

    // 不给表就是硬投影：同样的起手，输出明显不是 0（否则上面那条恒真）。
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
        // 让出事件循环：另一件活可能在这时开作业区并 grow 内存 —— 那些视图都得现切。
        await new Promise(done => setTimeout(done, 0));
      },
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(fx.frames);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    expect(y.length).toBe(fx.samples);
  });

  /** 取消 = `tick` 抛。抛出去之后作业必须已经还回去 —— 内核里只有 4 段。 */
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

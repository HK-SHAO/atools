import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import type { Samples } from "./arrays";
import { attachKernel, loadDsp } from "./dsp";
import { evaluateRow, sameSpectrum } from "./audit";
import { VOICE } from "./params";
import { resample } from "./resample";
import { encode, synthesise } from "./spectrum";

beforeAll(async () => {
  attachKernel(await loadDsp(compileWasm()));
});

const SR = 8000;

function signal(samples: number, sr: number): Samples {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / sr;
    out[i] =
      0.32 * Math.sin(2 * Math.PI * 220 * t) +
      0.2 * Math.sin(2 * Math.PI * (900 + 700 * t) * t) +
      0.008 * Math.sin(2 * Math.PI * 6300 * t);
  }
  return out;
}

// 精修合成带时间预算（glBudgetMs），两次运行允许小幅浮动
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

describe("sameSpectrum", () => {
  test("一致判定与逐项否决", async () => {
    const pcm = resample(signal(SR * 2, 44100), 44100, SR);
    const spec = await encode(pcm, SR, VOICE);
    expect(sameSpectrum(spec, spec)).toBe(true);

    const levels = spec.levels.slice();
    levels[spec.meta.frames >> 1] = (levels[spec.meta.frames >> 1]! + 7) & 255;
    expect(sameSpectrum(spec, { ...spec, levels })).toBe(false);

    const shifted = { ...spec, meta: { ...spec.meta, frames: spec.meta.frames - 1 } };
    expect(sameSpectrum(spec, shifted)).toBe(false);

    expect(sameSpectrum(spec, { ...spec, phaseCos: new Uint8Array(4) })).toBe(false);
  });
});

describe("evaluateRow 缓存复用", () => {
  // 守卫语义：sameSpectrum 只验证「读回的谱与编码谱一致」，缓存音频本身
  // 由调用方契约保证来自同一谱的精修合成（useAudit 只传当前 job 的 audio）。

  test("谱一致时走复用路径：坏缓存原样生效（fresh 合成不可能得到 corr≈0）", async () => {
    const pcm = resample(signal(SR * 2, 44100), 44100, SR);
    const spec = await encode(pcm, SR, VOICE);
    const cached = await synthesise(spec, undefined, undefined, "fine");

    const reused = await evaluateRow(pcm, spec, spec, cached, false);
    const fresh = await evaluateRow(pcm, spec, spec, null, false);
    for (const key of ["corr", "snr", "lsd"] as const) {
      const tol = key === "corr" ? 0.02 : key === "snr" ? 1 : 0.3;
      expect(
        near(reused[key]!, fresh[key]!, tol),
        `${key}: 复用 ${reused[key]} vs 现算 ${fresh[key]}`,
      ).toBe(true);
    }
    expect(reused.level).toBe(0);

    // 全零缓存 + 谱一致 → 必须走复用（若复用没发生，corr 会接近 fresh 的高值）
    const hit = await evaluateRow(pcm, spec, spec, new Float32Array(cached.length), false);
    expect(hit.corr).toBeLessThan(0.5);
  });

  test("谱不一致时拒绝复用：改坏的谱必须重新合成", async () => {
    const pcm = resample(signal(SR * 2, 44100), 44100, SR);
    const spec = await encode(pcm, SR, VOICE);
    const levels = spec.levels.slice();
    for (let i = 0; i < levels.length; i += 97) levels[i] = Math.min(255, levels[i]! + 9);
    const tampered = { ...spec, levels };

    // 守卫拒绝复用（哪怕缓存传的是全零），从改坏的谱重新合成 → 结果仍接近原声。
    // 若守卫失效变成无条件复用，全零缓存会让 corr 掉到 0。
    const bad = await evaluateRow(pcm, spec, tampered, new Float32Array(pcm.length), false);
    expect(bad.corr).toBeGreaterThan(0.8);
  });

  test("可逆强相位走精确路径：自检零损失", async () => {
    const pcm = resample(signal(SR * 2, 44100), 44100, SR);
    const spec = await encode(pcm, SR, { ...VOICE, mode: "exact" });
    const row = await evaluateRow(pcm, spec, spec, null, true);
    expect(row.level).toBe(0);
    expect(row.corr).toBeGreaterThan(0.999);
  });
});

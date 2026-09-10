import { describe, expect, test } from "bun:test";
import type { Samples } from "./arrays";
import { align, barkDistance, envelopeCorr } from "./metric";
import { VOICE } from "./params";
import { encode, synthesise } from "./spectrum";

const SR = 16000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

/** 带音节包络的谐波人声，能量只落在低频几条带里，高频带近似全静。 */
function voice(seconds = 2, sr = SR): Samples {
  const n = sr * seconds;
  const x = new Float32Array(n);
  const noise = rng(0x1234);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = 180 * Math.pow(2, 0.12 * Math.sin(2 * Math.PI * 2.3 * t));
    let v = 0;
    for (let h = 1; h <= 4; h++) v += (0.9 / h) * Math.sin(2 * Math.PI * f0 * h * t);
    const p = t % 0.42;
    const env = p < 0.42 * 0.72 ? Math.sin((Math.PI / 2) * (p / (0.42 * 0.72))) : 0;
    x[i] = 0.35 * v * env + 0.0004 * noise();
  }
  return x as Samples;
}

describe("perceptual metrics", () => {
  test("identical signals score perfectly", () => {
    const x = voice(1);
    expect(barkDistance(x, x, SR)).toBe(0);
    expect(envelopeCorr(x, x, SR)).toBeCloseTo(1, 12);
  });

  test("degrade monotonically as noise grows", () => {
    const x = voice(1);
    const noise = rng(0xbeef);
    let lastD = -1;
    let lastC = 2;
    for (const level of [0.001, 0.01, 0.05, 0.2]) {
      const y = Float32Array.from(x, v => v + level * noise()) as Samples;
      const d = barkDistance(x, y, SR);
      const c = envelopeCorr(x, y, SR);
      expect(d).toBeGreaterThan(lastD);
      expect(c).toBeLessThan(lastC);
      lastD = d;
      lastC = c;
    }
  });

  // 不带地板时，还原侧某条带全静（能量 0）就意味着 −∞：该带的地板是
  // peak·0，log10(0) 直接把整条距离撑成 Infinity/NaN，指标当场失效
  // （曾实测严苛素材算出 38~54）。带地板后差值被夹在 24 dB 以内。
  test("a wholly silent take stays finite and bounded", () => {
    const x = voice(1);
    const d = barkDistance(x, new Float32Array(x.length) as Samples, SR);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeLessThan(30);
  });

  test("a silent band with a faint one stays finite", () => {
    const x = voice(1);
    const noise = rng(0x99);
    const y = Float32Array.from(x, v => v + 1e-5 * noise()) as Samples;
    const d = barkDistance(x, y, SR);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeLessThan(30);
  });

  test("envelope correlation survives a global gain change", () => {
    const x = voice(1);
    const y = Float32Array.from(x, v => v * 0.25) as Samples;
    expect(envelopeCorr(x, y, SR)).toBeGreaterThan(0.99);
  });

  // 这条是这个指标存在的理由：相位重建出来的波形与原波形对不上（相关只有 0.2 上下），
  // 但**包络**几乎原样 —— 人耳听的就是包络。若两者一起崩，说明指标没量到点子上。
  test("envelope correlation outlives waveform correlation", async () => {
    const sr = 8000;
    const x = voice(3, sr);
    const spec = await encode(x, sr, { ...VOICE, bits: 8, fineness: 2 });
    const y = await synthesise(spec);
    expect(align(x, y, 2048).corr).toBeLessThan(0.7);
    expect(envelopeCorr(x, y, sr)).toBeGreaterThan(0.9);
  });
});

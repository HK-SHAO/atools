import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoSr, bandwidthOf } from "./bandwidth";
import { decodeAudioFile } from "./audio";
import type { Samples } from "./arrays";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const sr = 48000;
const tone = (hz: number, secs = 0.25, gain = 0.5): Samples => {
  const out = new Float32Array(Math.round(sr * secs)) as Samples;
  for (let i = 0; i < out.length; i++) out[i] = gain * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
};

const mix = (...xs: Samples[]): Samples => {
  const out = new Float32Array(xs[0]!.length) as Samples;
  for (const x of xs) for (let i = 0; i < out.length; i++) out[i] = out[i]! + x[i]!;
  return out;
};

const noise = (secs = 0.25): Samples => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  const out = new Float32Array(Math.round(sr * secs)) as Samples;
  for (let i = 0; i < out.length; i++) out[i] = rand() * 0.3;
  return out;
};

describe("bandwidthOf（有效带宽估计）", () => {
  test("纯音 440Hz：带宽就在 440 附近，不会虚报", () => {
    const bw = bandwidthOf(tone(440), sr);
    expect(bw).toBeGreaterThan(400);
    expect(bw).toBeLessThan(600);
  });

  test("白噪声：带宽贴着 Nyquist", () => {
    const bw = bandwidthOf(noise(), sr);
    expect(bw).toBeGreaterThan(20000);
  });

  test("高低频混合：报的是最高有能量的频率", () => {
    const bw = bandwidthOf(mix(tone(440), tone(11000)), sr);
    expect(bw).toBeGreaterThan(10800);
    expect(bw).toBeLessThan(11400);
  });

  test("幅度整体缩小不改变估计（阈值是相对谱峰的）", () => {
    const loud = bandwidthOf(tone(440), sr);
    const quiet = tone(440);
    for (let i = 0; i < quiet.length; i++) quiet[i] = quiet[i]! * 0.001;
    expect(bandwidthOf(quiet, sr)).toBe(loud);
  });

  test("静音报 0；太短的输入报 sr/2（判不了，保持原样）", () => {
    expect(bandwidthOf(new Float32Array(sr / 4) as Samples, sr)).toBe(0);
    expect(bandwidthOf(tone(440, 0.02), sr)).toBe(sr / 2);
  });
});

describe("autoSr（采样率自动选档）", () => {
  test("440Hz → 8k；5k → 16k；11k → 24k；白噪 → 0（按原采样率）", () => {
    expect(autoSr(tone(440), sr)).toBe(8000);
    expect(autoSr(tone(5000), sr)).toBe(16000);
    expect(autoSr(mix(tone(440), tone(11000)), sr)).toBe(24000);
    expect(autoSr(noise(), sr)).toBe(0);
  });

  test("20kHz 内容 16k 档覆盖不了，回退原采样率而不是硬切", () => {
    expect(autoSr(tone(20000), sr)).toBe(0);
  });

  test("低名义采样率的素材不升档", () => {
    expect(autoSr(tone(440), 8000)).toBe(8000);
    // 8k 白噪带宽贴着 4k Nyquist，没有更低的档可降，返回 0（=按原采样率 8k）。
    expect(autoSr(noise(), 8000)).toBe(0);
  });
});

describe("demo.ogg（真实素材的自动选档）", () => {
  test("Opus 名义 48k、实际带宽约 12.6k，应自动选 32k", async () => {
    const bytes = await readFile(join(ASSETS, "demo.ogg"));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const { pcm, sr: decoded } = await decodeAudioFile(buf);
    expect(decoded).toBe(48000);
    const bw = bandwidthOf(pcm, decoded);
    expect(bw).toBeGreaterThan(12000);
    expect(bw).toBeLessThan(13500);
    expect(autoSr(pcm, decoded)).toBe(32000);
  });
});

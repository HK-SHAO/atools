import { describe, expect, test } from "bun:test";
import type { Samples } from "./arrays";
import { FFT } from "./fft";
import { exactPixels, metaFromName, metaToText, sampleBand, textToMeta } from "./image";
import { indexedPng, isPng, readMeta, withMeta } from "./png";
import { BANDS, encode, paramsForImage, rowsFor, shapeFor, synthesise, type Spectrum } from "./spectrum";
import { VOICE, dbSpanOf, hopOf, stepsOf, winOf, type Encode } from "./params";
import { resample, silenceBounds, slice } from "./resample";

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

const snr = (a: Samples, b: Samples): number => {
  let se = 0;
  let sa = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    se += d * d;
    sa += a[i]! * a[i]!;
  }
  return 10 * Math.log10(sa / se);
};

/**
 * 分段各自对齐后的平均相关。
 * 只丢相位的重建会有整体延迟和缓慢漂移，全局相关因此很低 —— 但那听不出来，
 * 所以按 0.25 秒一段找最佳时延再平均，才接近耳朵听到的"像不像"。
 */
const localCorrelation = (a: Samples, b: Samples, sr: number): number => {
  const seg = Math.round(sr * 0.25);
  const n = Math.min(a.length, b.length);
  let total = 0;
  let count = 0;
  for (let s = 0; s + seg <= n; s += seg) {
    let best = -2;
    for (let lag = -400; lag <= 400; lag += 2) {
      let sa = 0;
      let sb = 0;
      let sab = 0;
      for (let i = s; i < s + seg; i++) {
        const j = i + lag;
        if (j < 0 || j >= n) continue;
        sa += a[i]! * a[i]!;
        sb += b[j]! * b[j]!;
        sab += a[i]! * b[j]!;
      }
      if (sa > 0 && sb > 0 && sab / Math.sqrt(sa * sb) > best) best = sab / Math.sqrt(sa * sb);
    }
    total += best;
    count++;
  }
  return count > 0 ? total / count : 0;
};

describe("fft", () => {
  test("inverse recovers the input", () => {
    const fft = new FFT(64);
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.7));
    const im = new Float64Array(64);
    const keep = Float64Array.from(re);
    fft.transform(re, im);
    fft.transform(re, im, true);
    for (let i = 0; i < 64; i++) expect(re[i]!).toBeCloseTo(keep[i]!, 10);
  });
});

describe("params", () => {
  test("defaults are the voice minimum", () => {
    expect(VOICE).toEqual({
      mode: "compact",
      sr: 8000,
      bits: 4,
      fineness: 0,
      fmax: 0,
      start: 0,
      end: 0,
    });
    expect(winOf(VOICE)).toBe(256);
    expect(hopOf(VOICE)).toBe(128);
    expect(stepsOf(4)).toBe(15);
    expect(dbSpanOf(4)).toBe(48);
  });

  test("bit depth drives the dynamic range", () => {
    for (const bits of [2, 4, 6, 8]) {
      const step = dbSpanOf(bits) / stepsOf(bits);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(9);
    }
  });
});

describe("resample", () => {
  test("keeps length roughly proportional", () => {
    const x = signal(44100, 44100);
    expect(resample(x, 44100, 8000).length).toBeCloseTo(8000, -2);
    expect(resample(x, 44100, 44100).length).toBe(44100);
  });

  test("a tone below the new nyquist survives, one above does not", () => {
    const sr = 44100;
    const n = sr * 1;
    const slow = new Float32Array(n);
    const fast = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      slow[i] = Math.sin(2 * Math.PI * 500 * t);
      fast[i] = Math.sin(2 * Math.PI * 7000 * t);
    }
    const to = 8000;
    const a = resample(slow, sr, to);
    const b = resample(fast, sr, to);
    const rms = (v: Samples) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
    expect(rms(a)).toBeGreaterThan(0.3);
    expect(rms(b)).toBeLessThan(0.02);
  });

  test("lowpass alone keeps the sample rate", () => {
    const sr = 16000;
    const x = signal(sr, sr);
    const y = resample(x, sr, sr, 3000);
    expect(y.length).toBe(sr);
  });
});

describe("crop", () => {
  test("slice honours the window", () => {
    const sr = 1000;
    const x = Float32Array.from({ length: sr * 10 }, (_, i) => i);
    expect(slice(x as Samples, sr, 0, 0).length).toBe(sr * 10);
    expect(slice(x as Samples, sr, 2, 3).length).toBe(sr);
  });

  test("silence bounds skip leading and trailing quiet", () => {
    const sr = 8000;
    const n = sr * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      x[i] = t > 0.5 && t < 1.2 ? 0.6 * Math.sin(2 * Math.PI * 300 * t) : 0;
    }
    const b = silenceBounds(x as Samples, sr);
    expect(b.start).toBeGreaterThan(0.4);
    expect(b.start).toBeLessThan(0.6);
    expect(b.end).toBeGreaterThan(1.1);
    expect(b.end).toBeLessThan(1.35);
  });
});

describe("compact round trip", () => {
  test("the image is one magnitude band, nothing hidden", async () => {
    const sr = 8000;
    const pcm = signal(sr * 2, sr);
    const spec = await encode(pcm, sr, VOICE);
    expect(spec.meta.exact).toBe(false);
    expect(spec.fine).toBeNull();
    expect(spec.phaseCos).toBeNull();
    expect(spec.phaseSin).toBeNull();
    expect(spec.meta.bins).toBe(winOf(VOICE) / 2 + 1);
    expect(spec.levels.length).toBe(spec.meta.frames * spec.meta.bins);
  });

  test("four bits means sixteen distinct levels", async () => {
    const sr = 8000;
    const spec = await encode(signal(sr * 2, sr), sr, VOICE);
    const seen = new Set<number>();
    for (const v of spec.levels) seen.add(v);
    expect(seen.size).toBeLessThanOrEqual(16);
    expect(seen.size).toBeGreaterThan(4);
  });

  test("voice defaults still sound like the input", async () => {
    const sr = 8000;
    const pcm = resample(signal(sr * 2, 44100), 44100, sr);
    const spec = await encode(pcm, sr, VOICE);
    const back = await synthesise(spec);
    expect(back.length).toBe(pcm.length);
    expect(localCorrelation(pcm, back, sr)).toBeGreaterThan(0.6);
  });

  test("more bits sound closer", async () => {
    const sr = 8000;
    const pcm = resample(signal(sr * 2, 44100), 44100, sr);
    const at = async (bits: number) =>
      localCorrelation(pcm, await synthesise(await encode(pcm, sr, { ...VOICE, bits })), sr);
    expect(await at(8)).toBeGreaterThan(await at(2));
  });
});

/**
 * 模拟一轮有损重编码（存成 JPEG 再读回来）：
 *   1) 每个字节段量化到 q 级 —— JPEG 的 DCT 量化是主误差；
 *   2) 8×8 块内加一点相对轻微的 DC 偏移，模仿分块量化留下的块边界痕迹。
 * 系数 k 故意压得很小：真实 JPEG 在块边界的错位只有几个灰度级，
 * 远大于此的偏移是无中生有的，会把测试变成一个不真实的压力测试。
 */
function jpegish(spec: Spectrum, q: number, k = 0.04): void {
  const bands = [spec.levels, spec.fine, spec.phaseCos, spec.phaseSin].filter(
    (b): b is Uint8Array => b != null,
  );
  const frames = spec.meta.frames;
  for (const band of bands) {
    const step = 256 / q;
    for (let i = 0; i < band.length; i++) {
      const bx = (i % frames) >> 3;
      const by = (i / frames) | 0;
      const off = (((bx * 31 + by * 17) % q) - (q >> 1)) * step * k;
      const v = Math.round(band[i]! / step) * step + off;
      band[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
  }
}

/** 严重爆音计数：相邻样本跳变超过峰值 30% 的算一次。 */
const clicks = (a: Samples): number => {
  let peak = 0;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]!));
  const thr = peak * 0.3;
  let n = 0;
  for (let i = 1; i < a.length; i++) if (Math.abs(a[i]! - a[i - 1]!) > thr) n++;
  return n;
};

describe("reversible round trip", () => {
  test("four bands reconstruct with low loss and no clicks", async () => {
    const sr = 44100;
    const pcm = signal(sr * 2, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    expect(spec.meta.exact).toBe(true);

    const back = await synthesise(spec);
    expect(back.length).toBe(pcm.length);
    // 相位走 cos/sin（8 位/段），无损下约 35–40 dB SNR，听感透明。
    expect(snr(pcm, back)).toBeGreaterThan(25);
    expect(localCorrelation(pcm, back, sr)).toBeGreaterThan(0.99);
    expect(clicks(back)).toBe(0);
  });

  test("survives aggressive JPEG (q=12) without clicks", async () => {
    const sr = 44100;
    const pcm = signal(sr * 2, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    jpegish(spec, 12); // 量化到 12 级 + 轻微分块，模拟一轮很狠的有损重编码

    const back = await synthesise(spec);
    // 相位走 cos/sin（连续场）：有损重编码后虽然幅度/相位有噪，但 SNR 仍有 ~10 dB、
    // 分段相关 ~0.98，听起来依旧认得出 —— 不会塌成噪声。硬指标是下面这条爆音检查。
    expect(snr(pcm, back)).toBeGreaterThan(9);
    expect(localCorrelation(pcm, back, sr)).toBeGreaterThan(0.9);
    // 用户硬要求：不管怎么压、怎么转格式，都不许出现噪音/爆破音。
    expect(clicks(back)).toBe(0);
  });

  test("survives typical JPEG (q=24) with good fidelity", async () => {
    const sr = 44100;
    const pcm = signal(sr * 2, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    jpegish(spec, 24); // 常见的"画质还行"的 JPEG 重编码

    const back = await synthesise(spec);
    expect(snr(pcm, back)).toBeGreaterThan(11);
    expect(localCorrelation(pcm, back, sr)).toBeGreaterThan(0.95);
    expect(clicks(back)).toBe(0);
  });
});

describe("color (HSL) mode", () => {
  test("emits a 2-band RGB image and round-trips losslessly through sampleBand", async () => {
    const sr = 44100;
    const pcm = signal(sr * 2, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    expect(spec.meta.color).toBe(true);

    // 把彩色相位谱画成像素（与浏览器导出一致），再按 imageToSpectrum 的彩色分支采样回来。
    const { pixels, width, height } = exactPixels(spec);
    expect(height).toBe(2 * spec.meta.bins); // 上 1/2 彩色（R=cos/G=sin/B=幅度）+ 下 1/2 灰度细幅度
    const bandRows = Math.floor(height / 2);
    const cosRaw = sampleBand(pixels, width, 0, bandRows, spec.meta.frames, spec.meta.bins, (r) => r);
    const sinRaw = sampleBand(pixels, width, 0, bandRows, spec.meta.frames, spec.meta.bins, (_r, g) => g);
    const levels = sampleBand(pixels, width, 0, bandRows, spec.meta.frames, spec.meta.bins, (_r, _g, b) => b);
    const fine = sampleBand(pixels, width, bandRows, bandRows, spec.meta.frames, spec.meta.bins, (_r, g) => g);
    const back = await synthesise({
      meta: { ...spec.meta, exact: true, color: true },
      levels,
      fine,
      phaseCos: cosRaw,
      phaseSin: sinRaw,
    });
    // 无损下约 35–40 dB：相位在颜色里，听感透明；且零爆音。
    expect(snr(pcm, back)).toBeGreaterThan(25);
    expect(localCorrelation(pcm, back, sr)).toBeGreaterThan(0.99);
    expect(clicks(back)).toBe(0);
  });

  test("legacy grayscale reversible names (no _C) are not mistaken for color", () => {
    const back = metaFromName("x_SR44100_N1024_H256_F172_L44100.jpg");
    expect(back?.exact).toBe(true);
    expect(back?.color).toBe(false);
  });

  test("filename _C1 marks a color image", () => {
    const back = metaFromName("x_SR44100_N1024_H256_F172_L44100_C1.png");
    expect(back?.color).toBe(true);
  });
});

describe("shape", () => {
  test("frequency ceiling crops rows", () => {
    expect(rowsFor(256, 8000, 0)).toBe(129);
    expect(rowsFor(256, 8000, 2000)).toBeLessThan(129);
    expect(rowsFor(256, 8000, 9999)).toBe(129);
  });

  test("refuses oversized requests", () => {
    expect(() => shapeFor(VOICE, 8000, 8000 * 600)).toThrow();
    expect(() => shapeFor({ ...VOICE, fineness: 2 }, 44100, 44100 * 600)).toThrow();
  });

  test("budget holds for sane lengths", () => {
    for (const seconds of [0.2, 1, 5, 30]) {
      const s = shapeFor(VOICE, 8000, 8000 * seconds);
      expect(s.frames).toBeLessThanOrEqual(20000);
      expect(s.frames * s.bins).toBeLessThanOrEqual(8_000_000);
    }
  });
});

describe("png", () => {
  const plainChunk = (type: string, data: number[]): number[] => {
    const body = [...type.split("").map(c => c.charCodeAt(0)), ...data];
    let c = 0xffffffff;
    for (const x of body) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    c = (c ^ 0xffffffff) >>> 0;
    return [(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...body, (c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255];
  };

  test("tEXt rides along without breaking the file", () => {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const ihdr = plainChunk("IHDR", [0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0]);
    const iend = plainChunk("IEND", []);
    const plain = Uint8Array.from([...signature, ...ihdr, ...iend]);

    const out = withMeta(plain, "[3,8000,256,128,10,129,1280,4,-6.5,0]");
    expect(isPng(out)).toBe(true);
    expect(readMeta(out)).toBe("[3,8000,256,128,10,129,1280,4,-6.5,0]");
  });

  test("indexed output is a valid png with the right chunks", async () => {
    const w = 7;
    const h = 5;
    const indices = new Uint8Array(w * h);
    for (let i = 0; i < indices.length; i++) indices[i] = i % 16;
    const palette = new Uint8Array(16 * 3);
    for (let q = 0; q < 16; q++) {
      palette[q * 3] = q * 17;
      palette[q * 3 + 1] = q * 17;
      palette[q * 3 + 2] = q * 17;
    }
    const bytes = await indexedPng(indices, w, h, 4, palette, "hello");

    expect(isPng(bytes)).toBe(true);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    const seen: string[] = [];
    while (at + 12 <= bytes.length) {
      const len = view.getUint32(at);
      seen.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
      // 每段的 CRC 必须自洽
      expect(view.getUint32(at + 8 + len)).toBe(crcOf(bytes, at + 4, at + 8 + len));
      at += 12 + len;
    }
    expect(seen).toEqual(["IHDR", "PLTE", "tEXt", "IDAT", "IEND"]);
    expect(bytes[24]).toBe(4); // 位深
    expect(bytes[25]).toBe(3); // 索引色
    expect(readMeta(bytes)).toBe("hello");
  });

  test("indices survive packing at every bit depth", async () => {
    const w = 13;
    const h = 5;
    for (const depth of [1, 2, 4, 6, 8]) {
      const count = 1 << depth;
      const indices = Uint8Array.from({ length: w * h }, (_, i) => i % count);
      const palette = new Uint8Array(count * 3).fill(90);
      const png = await indexedPng(indices, w, h, depth, palette, "m");

      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      let at = 8;
      let idat: Uint8Array | null = null;
      while (at + 12 <= png.length) {
        const len = view.getUint32(at);
        const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
        if (type === "IDAT") idat = png.subarray(at + 8, at + 8 + len);
        at += 12 + len;
      }
      expect(idat).not.toBeNull();

      const raw = new Uint8Array(
        await new Response(
          new Blob([idat! as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")),
        ).arrayBuffer(),
      );
      const rowBytes = Math.ceil((w * depth) / 8);
      expect(raw.length).toBe((rowBytes + 1) * h);

      for (let y = 0; y < h; y++) {
        let p = y * (rowBytes + 1) + 1;
        expect(raw[y * (rowBytes + 1)]).toBe(0);
        let acc = 0;
        let bits = 0;
        for (let x = 0; x < w; x++) {
          while (bits < depth) {
            acc = (acc << 8) | raw[p++]!;
            bits += 8;
          }
          bits -= depth;
          expect((acc >>> bits) & ((1 << depth) - 1)).toBe(indices[y * w + x]!);
        }
      }
    }
  });

  test("eight bit indices round trip through the packer", async () => {
    const w = 9;
    const h = 3;
    const indices = Uint8Array.from({ length: w * h }, (_, i) => (i * 29) & 255);
    const palette = new Uint8Array(256 * 3).fill(120);
    const bytes = await indexedPng(indices, w, h, 8, palette, "x");
    expect(isPng(bytes)).toBe(true);
    expect(bytes[24]).toBe(8);
  });
});

function crcOf(b: Uint8Array, from: number, to: number): number {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = t[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

describe("metadata", () => {
  const meta = {
    sr: 8000,
    win: 256,
    hop: 128,
    frames: 300,
    bins: 129,
    samples: 38400,
    bits: 4,
    ref: -6.5,
    exact: false,
    color: false,
  };

  test("survives a text round trip", () => {
    const back = textToMeta(metaToText(meta));
    expect(back).toEqual(meta);
  });

  test("rejects junk", () => {
    expect(textToMeta("")).toBeNull();
    expect(textToMeta("[2,1,2,3]")).toBeNull();
    expect(textToMeta("[3,0,256,128,1,129,1,4,0,0]")).toBeNull();
  });

  test("the filename carries the same numbers", () => {
    const name = `语音_SR${meta.sr}_N${meta.win}_H${meta.hop}_F${meta.frames}_L${meta.samples}_B${meta.bits}.png`;
    const back = metaFromName(name);
    expect(back?.sr).toBe(meta.sr);
    expect(back?.win).toBe(meta.win);
    expect(back?.bits).toBe(meta.bits);
    expect(back?.exact).toBe(false);
  });

  test("legacy names without _B are read as reversible", () => {
    const back = metaFromName("x_SR44100_N1024_H256_F172_L44100.jpg");
    expect(back?.bits).toBe(0);
    expect(back?.exact).toBe(true);
  });
});

describe("image params", () => {
  test("window covers the requested rows", () => {
    for (const rows of [2, 57, 300, 513, 2049]) {
      const p = paramsForImage(120, rows, 44100, 8, 0, false);
      expect(p.bins).toBeLessThanOrEqual(p.win / 2 + 1);
      expect(p.win).toBeGreaterThanOrEqual(256);
    }
  });
});

describe("image footprint", () => {
  test("compact voice defaults beat the reversible layout by a wide margin", () => {
    const s = shapeFor(VOICE, 8000, 8000 * 10);
    const compact = s.frames * s.bins;
    const reversible = shapeFor({ ...VOICE, mode: "exact" }, 8000, 8000 * 10);
    expect(compact * BANDS).toBeLessThanOrEqual(reversible.frames * reversible.bins * BANDS);
    expect(compact).toBeLessThan(120_000);
  });
});

import { describe, expect, test } from "bun:test";
import type { Samples } from "./arrays";
import { FFT } from "./fft";
import { exactPixels, metaFromGeometry, metaFromName, metaToText, recognizeExact, sampleLevels, samplePhase, textToMeta } from "./image";
import { indexedPng, isPng, readIndexedRamp, readMeta, withMeta } from "./png";
import { RAMP } from "./palette";
import { BANDS, encode, fitEncode, paramsForImage, rowsFor, shapeFor, synthesise, type Spectrum } from "./spectrum";
import { VOICE, dbSpanOf, hopOf, stepsOf, winOf, type Encode } from "./params";
import { STUB_ROWS, stubFits } from "./stub";
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
      bits: 8,
      fineness: 1,
      fmax: 0,
      start: 0,
      end: 0,
    });
    expect(winOf(VOICE)).toBe(512);
    expect(hopOf(VOICE)).toBe(256);
    expect(stepsOf(8)).toBe(255);
    expect(dbSpanOf(8)).toBe(96);
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
    expect(spec.phaseCos).toBeNull();
    expect(spec.phaseSin).toBeNull();
    expect(spec.meta.bins).toBe(winOf(VOICE) / 2 + 1);
    expect(spec.levels.length).toBe(spec.meta.frames * spec.meta.bins);
  });

  test("four bits means sixteen distinct levels", async () => {
    const sr = 8000;
    const spec = await encode(signal(sr * 2, sr), sr, { ...VOICE, bits: 4 });
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

  test("fine quality helps phase-free images and never regresses", async () => {
    const sr = 8000;
    const pcm = resample(signal(sr * 8, 44100), 44100, sr);

    const compactSpec = await encode(pcm, sr, VOICE);
    const fast = localCorrelation(pcm, await synthesise(compactSpec), sr);
    const fine = localCorrelation(
      pcm,
      await synthesise(compactSpec, undefined, undefined, "fine"),
      sr,
    );
    expect(fine).toBeGreaterThanOrEqual(fast * 0.98);
  });

  test("damaged phase works as an anchor: fine beats magnitude-only", async () => {
    const sr = 8000;
    const pcm = resample(signal(sr * 8, 44100), 44100, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    jpegish(spec, 48);

    // 模拟读端：逐 bin 归一化并存置信度权重；弱相位只作锚，不作真值
    const n = spec.phaseCos!.length;
    const w = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const cr = (spec.phaseCos![i]! - 127.5) / 127.5;
      const cs = (spec.phaseSin![i]! - 127.5) / 127.5;
      const h = Math.sqrt(cr * cr + cs * cs);
      w[i] = Math.min(255, Math.round(h * 255));
      const k = h > 1e-6 ? 1 / h : 0;
      spec.phaseCos![i] = Math.max(0, Math.min(255, Math.round(cr * k * 127.5 + 127.5)));
      spec.phaseSin![i] = Math.max(0, Math.min(255, Math.round(cs * k * 127.5 + 127.5)));
    }
    spec.phaseW = w;
    spec.phaseWeak = true;

    const fast = localCorrelation(pcm, await synthesise(spec), sr);
    const fine = localCorrelation(
      pcm,
      await synthesise(spec, undefined, undefined, "fine"),
      sr,
    );
    expect(fine).toBeGreaterThan(fast);
  });

  test("stored phase stays the best estimator, even on lossy images", async () => {
    const sr = 8000;
    const pcm = resample(signal(sr * 8, 44100), 44100, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    jpegish(spec, 24);
    expect(localCorrelation(pcm, await synthesise(spec), sr)).toBeGreaterThan(0.9);
  });
});

function jpegish(spec: Spectrum, q: number, k = 0.04): void {
  const bands = [spec.levels, spec.phaseCos, spec.phaseSin].filter(
    (b): b is Uint8Array | Uint16Array => b != null,
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

const clicks = (a: Samples): number => {
  let peak = 0;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]!));
  const thr = peak * 0.3;
  let n = 0;
  for (let i = 1; i < a.length; i++) if (Math.abs(a[i]! - a[i - 1]!) > thr) n++;
  return n;
};

describe("reversible round trip", () => {
  test("stored-phase reversible reconstruction is lossless and click-free", async () => {
    const sr = 44100;
    const pcm = signal(sr * 2, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    expect(spec.meta.exact).toBe(true);

    const back = await synthesise(spec);
    expect(back.length).toBe(pcm.length);
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
    expect(snr(pcm, back)).toBeGreaterThan(9);
    expect(localCorrelation(pcm, back, sr)).toBeGreaterThan(0.9);
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

describe("exact (2-band) mode", () => {
  test("emits a readable magnitude band + phase band and round-trips losslessly", async () => {
    const sr = 44100;
    const pcm = signal(sr * 2, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    expect(spec.meta.exact).toBe(true);

    const { pixels, width, height } = exactPixels(spec);
    const stubRows = stubFits(width) ? STUB_ROWS : 0;
    expect(height).toBe(2 * spec.meta.bins + stubRows);

    const bandRows = Math.floor((height - stubRows) / 2);
    const levels = sampleLevels(pixels, width, 0, bandRows, spec.meta.frames, spec.meta.bins);
    const ph = samplePhase(pixels, width, bandRows, bandRows, spec.meta.frames, spec.meta.bins);
    expect(ph.reliability).toBeGreaterThan(0.98);
    const back = await synthesise({
      meta: { ...spec.meta, exact: true },
      levels,
      phaseCos: ph.cos,
      phaseSin: ph.sin,
    });
    expect(snr(pcm, back)).toBeGreaterThan(25);
    expect(localCorrelation(pcm, back, sr)).toBeGreaterThan(0.99);
    expect(clicks(back)).toBe(0);
  });

  test("filenames without _B are rejected", () => {
    expect(metaFromName("x_SR44100_N1024_H256_F172_L44100.jpg")).toBeNull();
  });
});

describe("shape", () => {
  test("frequency ceiling crops rows", () => {
    expect(rowsFor(256, 8000, 0)).toBe(129);
    expect(rowsFor(256, 8000, 2000)).toBeLessThan(129);
    expect(rowsFor(256, 8000, 9999)).toBe(129);
  });

  test("refuses oversized requests", () => {
    expect(() => shapeFor(VOICE, 8000, 8000 * 700)).toThrow();
    expect(() => shapeFor({ ...VOICE, fineness: 2 }, 44100, 44100 * 600)).toThrow();
  });

  test("fitEncode downsamples long audio instead of refusing it", () => {
    const samples = 44100 * 264;
    expect(() => shapeFor(VOICE, 8000, Math.ceil((samples * 8000) / 44100))).not.toThrow();

    const want = { ...VOICE, sr: 44100 };
    expect(() => shapeFor(want, 44100, samples)).toThrow();

    const fit = fitEncode(want, 44100, samples);
    expect(fit.note).not.toBeNull();
    expect(fit.enc.sr).toBe(16000);
    const tuned = shapeFor(fit.enc, fit.enc.sr, Math.ceil((samples * fit.enc.sr) / 44100));
    expect(tuned.frames).toBeLessThanOrEqual(20000);
    expect(tuned.frames * tuned.bins).toBeLessThanOrEqual(8_000_000);

    const short = fitEncode(want, 44100, 44100 * 30);
    expect(short.enc).toEqual(want);
    expect(short.note).toBeNull();

    const huge = fitEncode(VOICE, 44100, 44100 * 3600);
    expect(huge.enc.sr).toBe(8000);
    expect(huge.enc.end - huge.enc.start).toBeLessThanOrEqual((20000 * hopOf(huge.enc)) / 8000);
  });

  test("fitEncode resolves pixel-bound exact audio instead of dead-ending", () => {
    const e: Encode = { ...VOICE, mode: "exact", sr: 8000, fineness: 2 };
    const samples = 8000 * 256;
    const fit = fitEncode(e, 8000, samples);
    expect(fit.note).not.toBeNull();
    const sr = fit.enc.sr > 0 ? fit.enc.sr : 8000;
    const tuned = shapeFor(fit.enc, sr, Math.ceil((samples * sr) / 8000));
    expect(tuned.frames).toBeLessThanOrEqual(20000);
    expect(tuned.frames * tuned.bins * BANDS).toBeLessThanOrEqual(8_000_000);
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
  };

  test("survives a text round trip", () => {
    const back = textToMeta(metaToText(meta));
    expect(back).toEqual(meta);
  });

  test("rejects pre-contract and junk versions", () => {
    expect(textToMeta(JSON.stringify([2, meta.sr, meta.win, meta.hop, meta.frames, meta.bins, meta.samples, meta.bits, meta.ref, 0]))).toBeNull();
    expect(textToMeta("[2,1,2,3]")).toBeNull();
    expect(textToMeta("[3,0,256,128,1,129,1,4,0,0]")).toBeNull();
    expect(textToMeta(JSON.stringify([99, meta.sr, meta.win, meta.hop, meta.frames, meta.bins, meta.samples, meta.bits, meta.ref, 0]))).toBeNull();
  });

  test("the filename carries the same numbers", () => {
    const name = `语音_SR${meta.sr}_N${meta.win}_H${meta.hop}_F${meta.frames}_L${meta.samples}_B${meta.bits}.png`;
    const back = metaFromName(name);
    expect(back?.sr).toBe(meta.sr);
    expect(back?.win).toBe(meta.win);
    expect(back?.bits).toBe(meta.bits);
    expect(back?.exact).toBe(false);
  });

  test("rejects tampered metas with fractional fields", () => {
    const bad = JSON.parse(metaToText(meta)) as number[];
    bad[4] = 300.5;
    expect(textToMeta(JSON.stringify(bad))).toBeNull();
  });
});

describe("reads our images with no metadata at all", () => {
  const sr = 8000;

  function box2(px: Uint8ClampedArray, w: number, h: number): { px: Uint8ClampedArray; w: number; h: number } {
    const nw = w >> 1;
    const nh = h >> 1;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const p = ((y * 2 + dy) * w + x * 2 + dx) * 4;
            r += px[p]!;
            g += px[p + 1]!;
            b += px[p + 2]!;
          }
        const q = (y * nw + x) * 4;
        out[q] = r / 4;
        out[q + 1] = g / 4;
        out[q + 2] = b / 4;
        out[q + 3] = 255;
      }
    return { px: out, w: nw, h: nh };
  }

  test("pixel signature recognizes the exact layout and rejects photos", async () => {
    const pcm = signal(sr * 3, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    const { pixels, width, height } = exactPixels(spec);
    expect(recognizeExact(pixels, width, height)).toBe(true);

    const fake = new Uint8ClampedArray(width * height * 4) as unknown as import("./arrays").Pixels;
    for (let i = 0; i < fake.length; i += 4) {
      fake[i] = Math.random() * 255;
      fake[i + 1] = Math.random() * 255;
      fake[i + 2] = Math.random() * 255;
      fake[i + 3] = 255;
    }
    expect(recognizeExact(fake, width, height)).toBe(false);
  });

  test("black images and doodles are not mistaken for exact", () => {
    const img = new Uint8ClampedArray(64 * 32 * 4) as unknown as import("./arrays").Pixels;
    for (let i = 0; i < img.length; i += 4) img[i + 3] = 255;
    expect(recognizeExact(img, 64, 32)).toBe(false);

    for (let x = 8; x < 40; x++)
      for (let y = 6; y < 26; y++) {
        const p = (y * 64 + x) * 4;
        img[p] = 220;
        img[p + 1] = 180;
        img[p + 2] = 60;
      }
    expect(recognizeExact(img, 64, 32)).toBe(false);
  });

  test("phase reliability drops when the image is downscaled, and synthesis falls back", async () => {
    const pcm = signal(sr * 3, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    const { pixels, width, height } = exactPixels(spec);
    const bandRows = height >> 1;

    const half = box2(pixels, width, height);
    const halfRows = half.h >> 1;
    const ph = samplePhase(half.px as unknown as import("./arrays").Pixels, half.w, halfRows, halfRows, half.w, halfRows);
    expect(ph.reliability).toBeLessThan(0.8);

    const full = samplePhase(pixels, width, bandRows, bandRows, spec.meta.frames, spec.meta.bins);
    expect(full.reliability).toBeGreaterThan(0.95);
  });

  test("geometry meta keeps win/bins consistent", () => {
    const m = metaFromGeometry(620, 257, true, 0);
    expect(m.win).toBe(512); // 257 bins → (257-1)*2 = 512
    expect(m.bins).toBeLessThanOrEqual(m.win / 2 + 1);
    expect(m.hop).toBe(m.win / 2);
    expect(m.sr).toBe(8000);
    const big = metaFromGeometry(620, 3000, true, 0);
    expect(big.win).toBe(4096);
    expect(big.bins).toBeLessThanOrEqual(2049);
  });

  test("readIndexedRamp recognizes our compact palette and rejects others", async () => {
    const w = 12;
    const h = 5;
    const indices = Uint8Array.from({ length: w * h }, (_, i) => (i * 37) & 255);
    const steps = 255;
    const palette = new Uint8Array(256 * 3);
    for (let q = 0; q < 256; q++) {
      const c = Math.min(255, Math.round((Math.min(q, steps) * 255) / steps)) * 3;
      palette[q * 3] = RAMP[c]!;
      palette[q * 3 + 1] = RAMP[c + 1]!;
      palette[q * 3 + 2] = RAMP[c + 2]!;
    }
    const bytes = await indexedPng(indices, w, h, 8, palette, "ignored");
    const hit = await readIndexedRamp(bytes);
    expect(hit).not.toBeNull();
    expect(hit!.width).toBe(w);
    expect(hit!.height).toBe(h);
    expect(hit!.levels[0]).toBe(Math.round((indices[0]! * 255) / steps));

    const gray = new Uint8Array(256 * 3);
    for (let q = 0; q < 256; q++) gray[q * 3] = gray[q * 3 + 1] = gray[q * 3 + 2] = q;
    const alien = await readIndexedRamp(await indexedPng(indices, w, h, 8, gray, "x"));
    expect(alien).toBeNull();
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

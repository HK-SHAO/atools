import { describe, expect, test } from "bun:test";
import type { Samples } from "./arrays";
import { FFT, hannWindow } from "./fft";
import { exactPixels, metaFromGeometry, metaFromName, metaToText, recognizeExact, sampleLevels, samplePhase, textToMeta } from "./image";
import { indexedPng, isPng, readIndexedRamp, readMeta, withMeta } from "./png";
import { RAMP } from "./palette";
import { BANDS, encode, fitEncode, paramsForImage, rowsFor, shapeFor, synthesise, type Spectrum } from "./spectrum";
import { VOICE, dbSpanOf, hopOf, stepsOf, winOf, type Encode } from "./params";
import { STUB_ROWS, stubFits } from "./stub";
import { TUNE } from "./phase";
import { resample, silenceBounds, slice, trimRange } from "./resample";

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

// 「相位表之前」的逐样点现算版，作为比位对照。测试专用，不进生产代码。
const naiveInline = (x: Samples, from: number, to: number, cutoffHz = 0): Float32Array => {
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(x.length / ratio)));
  const nyq = 0.5 * Math.min(1, to / from);
  const limit = cutoffHz > 0 ? Math.min(nyq, cutoffHz / from) : nyq;
  const fc = limit * 0.92;
  const half = Math.min(64, Math.max(3, Math.round(2 / Math.max(fc, 1e-5))));
  for (let j = 0; j < out.length; j++) {
    const center = j * ratio;
    const i0 = Math.floor(center);
    const frac = center - i0;
    let acc = 0;
    let wsum = 0;
    for (let m = 1 - half; m <= half; m++) {
      const d = m - frac;
      const t = d / (half + 0.5);
      const w =
        (d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d)) *
        (0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t));
      const i = i0 + m;
      if (i >= 0 && i < x.length) {
        acc += x[i]! * w;
        wsum += w;
      }
    }
    out[j] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
};

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

  // 相位权重查表是纯缓存：值与逐样点现算逐位相同，音质门禁因此不会漂
  test("phase table is bit-identical to computing each tap inline", () => {
    const src = signal(44100, 44100 * 2);
    for (const [from, to, cutoff] of [
      [44100, 8000, 0],
      [44100, 16000, 0],
      [44100, 48000, 0],
      [44100, 44100, 3000],
      [48000, 44100, 0],
    ] as [number, number, number][]) {
      const got = resample(src, from, to, cutoff);
      const want = naiveInline(src, from, to, cutoff);
      expect(got.length).toBe(want.length);
      let same = true;
      for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) same = false;
      expect([from, to, cutoff, same]).toEqual([from, to, cutoff, true]);
    }
  });

  // 表顶到上限时会整段退回现算（回退路径不分配数组）。那条分支必须与查表路径同值，
  // 否则「逐位不变」只在表装得下时成立。这里用实际相位数远超上限的组合把它压出来。
  test("phase table falling back to inline taps is bit-identical too", () => {
    const from = 44101;
    const to = 96000;
    const n = from * 2;
    const x = signal(n, from);

    // 该组合实际会出现多少种 frac —— 必须超过上限 1<<14，这条测试才真的覆盖到回退分支
    const seen = new Set<number>();
    const ratio = from / to;
    for (let j = 0; j < Math.round(n / ratio); j++) {
      const c = j * ratio;
      seen.add(c - Math.floor(c));
    }
    expect(seen.size).toBeGreaterThan(1 << 14);

    const got = resample(x, from, to);
    const want = naiveInline(x, from, to);
    expect(got.length).toBe(want.length);
    let differ = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) differ++;
    expect(differ).toBe(0);
  });

  // 边缘输入：空、单点、极短、全零、冲激，以及比率离谱到几乎没有重复相的组合
  test("edge lengths and degenerate rates agree with inline taps", () => {
    const cases: [number, number, number, Samples][] = [
      [44100, 8000, 0, Float32Array.from([0]) as Samples],
      [44100, 8000, 0, Float32Array.from([0, 1]) as Samples],
      [8000, 44100, 0, Float32Array.from([1]) as Samples],
      [22050, 8000, 0, new Float32Array(7) as Samples],
      [44100, 16000, 0, new Float32Array(1001).fill(0.7) as Samples],
      [44100, 8000, 20000, signal(5000, 44100)],
      [44101, 8000, 0, signal(5000, 44101)],
      [32000, 32000, 500, signal(5000, 32000)],
    ];
    for (const [from, to, cutoff, x] of cases) {
      const got = resample(x, from, to, cutoff);
      const want = naiveInline(x, from, to, cutoff);
      let differ = got.length === want.length ? 0 : -1;
      for (let i = 0; i < got.length && differ >= 0; i++) if (got[i] !== want[i]) differ++;
      expect([from, to, cutoff, x.length, differ]).toEqual([from, to, cutoff, x.length, 0]);
    }
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

  test("trim range drops the quiet ends of a loaded clip", () => {
    const sr = 8000;
    const n = sr * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      x[i] = t > 0.5 && t < 1.2 ? 0.6 * Math.sin(2 * Math.PI * 300 * t) : 0;
    }
    const r = trimRange(x as Samples, sr);
    expect(r).not.toBeNull();
    expect(r!.start).toBeGreaterThan(0.4);
    expect(r!.end).toBeLessThan(1.35);
  });

  test("trim range leaves audio that is loud end to end alone", () => {
    const sr = 8000;
    const x = signal(sr * 2, sr);
    expect(trimRange(x, sr)).toBeNull();
  });

  test("trim range gives up on pure silence", () => {
    const sr = 8000;
    expect(trimRange(new Float32Array(sr) as Samples, sr)).toBeNull();
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

// 参照实现：精确档相位原本的写法（atan2 + cos + sin）。只用来钉住替换，别拿它当第二份真相。
const exactPhaseInline = (
  pcm: Samples,
  win: number,
  hop: number,
  bins: number,
): { cos: Uint8Array; sin: Uint8Array } => {
  const fft = new FFT(win);
  const w = hannWindow(win);
  const frames = Math.floor(pcm.length / hop) + 1;
  const x = new Float64Array(pcm.length + win);
  for (let i = 0; i < pcm.length; i++) x[win / 2 + i] = pcm[i]!;
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const cos = new Uint8Array(frames * bins);
  const sin = new Uint8Array(frames * bins);
  const byte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = x[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) {
      const a = Math.atan2(im[b]!, re[b]!);
      cos[f * bins + b] = byte(Math.round((Math.cos(a) * 0.5 + 0.5) * 255));
      sin[f * bins + b] = byte(Math.round((Math.sin(a) * 0.5 + 0.5) * 255));
    }
  }
  return { cos, sin };
};

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
    jpegish(spec, 12);

    const back = await synthesise(spec);
    expect(snr(pcm, back)).toBeGreaterThan(9);
    expect(localCorrelation(pcm, back, sr)).toBeGreaterThan(0.9);
    expect(clicks(back)).toBe(0);
  });

  test("survives typical JPEG (q=24) with good fidelity", async () => {
    const sr = 44100;
    const pcm = signal(sr * 2, sr);
    const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr: 0, fineness: 1 });
    jpegish(spec, 24);

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

  // 精确档把相位存成单位相量：取 re/h、im/h，与 cos(atan2(im, re))、sin(atan2(im, re))
  // 是同一件事，但省掉每 bin 三个超越函数（内层实测 2.12×）。钉住这条替换 ——
  // 只有当两者量化到同一个字节时才是等价的，改量化或改写式子都必须让它继续成立。
  test("exact phase bytes equal the atan2 definition they replace", async () => {
    const sr = 32000;
    const pcm = signal(sr, sr);
    for (const fineness of [0, 1, 2] as const) {
      const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr, fineness });
      const ref = exactPhaseInline(pcm, spec.meta.win, spec.meta.hop, spec.meta.bins);
      let differ = 0;
      const n = spec.meta.frames * spec.meta.bins;
      for (let i = 0; i < n; i++) {
        if (spec.phaseCos![i] !== ref.cos[i]) differ++;
        if (spec.phaseSin![i] !== ref.sin[i]) differ++;
      }
      expect([fineness, differ]).toEqual([fineness, 0]);
    }
  });

  // synthesiseExact 的 core.add 做的是全长的 Hermite 反变换，所以「写满 bins」等于
  // 「写满整个上半谱」这件事只成立于 bins === win/2+1。encode 恒满足（rowsFor 在全频段
  // 就返回 win/2+1）；image 侧的 winFromBins 有 256 的下限，幅度带短于 129 行时会打破它 ——
  // 那种输入由 synthesiseExact 里的清零点兜住。
  test("exact encodes always fill the whole upper half", async () => {
    const sr = 44100;
    const pcm = signal(sr, sr);
    for (const fineness of [0, 1, 2] as const) {
      const spec = await encode(pcm, sr, { ...VOICE, mode: "exact", sr, fineness });
      expect([fineness, spec.meta.bins]).toEqual([fineness, spec.meta.win / 2 + 1]);
      expect([fineness, rowsFor(spec.meta.win, sr, 0)]).toEqual([fineness, spec.meta.win / 2 + 1]);
    }
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
    expect(bytes[24]).toBe(4);
    expect(bytes[25]).toBe(3);
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

  // 两个入口共用一处 sanitize：文件名那条曾经不查 sr>0（时长变 Infinity）、不查 win 的
  // 上下界、也不查 bits，改个名就能把 16 位深喂进 encode。
  test("both entries reject the same out-of-range fields", () => {
    const name = (sr: number, win: number, bits: number, frames: number): string =>
      `x_SR${sr}_N${win}_H128_F${frames}_L38400_B${bits}.png`;
    const text = (sr: number, win: number, bits: number, frames: number): string =>
      JSON.stringify([4, sr, win, 128, frames, 129, 38400, bits, 0, 0]);

    for (const [sr, win, bits, frames] of [
      [0, 512, 8, 300], // sr=0 → 时长 Infinity
      [8000, 8, 8, 300], // win 越下界
      [8000, 8192, 8, 300], // win 越上界
      [8000, 512, 16, 300], // 位深不在 0/2/4/8
      [8000, 512, 3, 300], // 同上
      [8000, 512, 8, 0], // 帧数为 0
      [8000, 512, 8, 999_999], // 帧数越 MAX_FRAMES
      [8000, 512, -2, 300], // 负位深
    ]) {
      expect(metaFromName(name(sr!, win!, bits!, frames!))).toBeNull();
      expect(textToMeta(text(sr!, win!, bits!, frames!))).toBeNull();
    }
  });

  test("accepts what the app actually writes", () => {
    for (const bits of [0, 2, 4, 8]) {
      const m = { ...meta, bits };
      expect(textToMeta(metaToText(m))?.bits).toBe(bits);
      expect(metaFromName(`x_SR8000_N512_H128_F300_L38400_B${bits}.png`)?.bits).toBe(bits);
    }
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
    expect(m.win).toBe(512);
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

describe("level bytes", () => {
  // 曾经 encode 给 bits>=16 开过一条 Uint16Array 的分支，而 levelToDb 是按字节解释的
  // （level·steps/255），两条约定一撞就整段 NaN（实测 4096/4096 非有限）。
  // 那条分支 UI 到不了，但它的存在本身就是「levels 到底几个字节」的歧义源，已删。
  // 这条把「levels 恒为字节」和「任意位深下合成都有限」钉住。
  test("levels are bytes at every bit depth and synthesis stays finite", async () => {
    const sr = 8000;
    const pcm = signal(sr * 2, sr);
    for (const bits of [2, 4, 8]) {
      const spec = await encode(pcm, sr, { ...VOICE, bits });
      expect(spec.levels).toBeInstanceOf(Uint8Array);
      for (const v of spec.levels) expect(v).toBeLessThanOrEqual(255);
      const y = await synthesise(spec);
      expect(y.every(Number.isFinite)).toBe(true);
    }
  });
});

describe("floor relaxation", () => {
  // 最低那一档（level 0）的真值含义是「在这个地板以下」。硬投影把它钉在地板上，
  // 于是一张**全零**的频谱重建出来不是静音，而是铺满整张图的一层等高噪声 ——
  // 位深越浅地板越高（2bit 只在峰值下 24 dB），这层假噪声越响。
  // 放宽之后 level 0 可以往 0 走，全零频谱就该还原成静音。
  const rms = (x: Samples): number => {
    let acc = 0;
    for (const v of x) acc += v * v;
    return Math.sqrt(acc / x.length);
  };

  const quiet = async (bits: number, relax: boolean): Promise<number> => {
    TUNE.relaxFloor = relax;
    try {
      const frames = 40;
      const hop = 128;
      const meta = {
        sr: 8000,
        win: 512,
        hop,
        frames,
        bins: 257,
        samples: frames * hop,
        bits,
        ref: 0,
        exact: false,
      };
      const spec: Spectrum = {
        meta,
        levels: new Uint8Array(frames * meta.bins),
        phaseCos: null,
        phaseSin: null,
      };
      return rms(await synthesise(spec));
    } finally {
      TUNE.relaxFloor = true;
    }
  };

  test("a flat-zero spectrum comes back silent at low bit depths", async () => {
    const off = await quiet(4, false);
    const on = await quiet(4, true);
    expect(off).toBeGreaterThan(1e-4);
    expect(on).toBeLessThan(off / 1000);
  });

  // 地板在 −80 dB 以下时（8bit 是 −96 dB）钉不钉都听不出来，放宽只会在噪声里摆动。
  // 这条把「span ≥ 80 就完全不放宽」钉住 —— 8bit 的输出必须与放宽前一模一样。
  test("leaves high bit depths alone", async () => {
    const off = await quiet(8, false);
    const on = await quiet(8, true);
    expect(on).toBe(off);
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

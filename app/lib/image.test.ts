import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import { sniff } from "./container";
import { recognizeExact, metaToText, spectrumToPng } from "./image";
import type { Pixels } from "./arrays";
import { startKernel } from "./dsp";
import { RAMP } from "./palette";
import { readMeta } from "./png";
import type { Meta, Spectrum } from "./spectrum";

const ftyp = (major: string) => {
  const b = new Uint8Array(16);
  b.set([0x66, 0x74, 0x79, 0x70], 4);
  b.set([major.charCodeAt(0), major.charCodeAt(1), major.charCodeAt(2), major.charCodeAt(3)], 8);
  return b;
};

describe("sniff", () => {
  test("ordinary image formats are recognised as usual", () => {
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("jpeg");
    expect(sniff(new Uint8Array([0x42, 0x4d, 0x00]))).toBe("bmp");
    expect(sniff(new Uint8Array([0x47, 0x49, 0x46, 0x38])).startsWith("gif")).toBe(true);
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniff(webp)).toBe("webp");
  });

  test("a real AVIF stays avif", () => {
    expect(sniff(ftyp("avif"))).toBe("avif");
    expect(sniff(ftyp("avis"))).toBe("avif");
    expect(sniff(ftyp("mif1"))).toBe("avif");
  });

  test("m4a / mp4 / mov are not mistaken for images", () => {
    expect(sniff(ftyp("M4A "))).toBe("?");
    expect(sniff(ftyp("isom"))).toBe("?");
    expect(sniff(ftyp("mp42"))).toBe("?");
    expect(sniff(ftyp("qt  "))).toBe("?");
  });

  test("wholly unrecognised bytes come back unknown", () => {
    expect(sniff(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe("?");
  });
});

describe("recognizeExact (reversible image pixel signature)", () => {
  function exactPixels(w: number, h: number): Pixels {
    const px = new Uint8ClampedArray(w * h * 4);
    const rows = Math.floor(h / 2);
    for (let y = 0; y < h; y++) {
      const phase = y >= rows;
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        if (phase) {
          const a = ((x / w) * 4 + y * 0.1) * Math.PI * 2;
          px[p] = Math.round((Math.cos(a) * 0.5 + 0.5) * 255);
          px[p + 1] = Math.round((Math.sin(a) * 0.5 + 0.5) * 255);
          px[p + 2] = 0;
        } else {
          const level = 40 + ((x * 7 + y * 3) % 200);
          px[p] = RAMP[level * 3]!;
          px[p + 1] = level;
          px[p + 2] = RAMP[level * 3 + 2]!;
        }
        px[p + 3] = 255;
      }
    }
    return px;
  }

  test("a complete reversible image (even height) hits", () => {
    const w = 64;
    const h = 128;
    expect(recognizeExact(exactPixels(w, h) as Pixels, w, h)).toBe(true);
  });

  test("an odd height after scaling hits too (regression: the old h%2 check rejected it outright)", () => {
    const w = 64;
    const h = 97;
    expect(recognizeExact(exactPixels(w, h) as Pixels, w, h)).toBe(true);
  });

  test("a phase averaged away by scaling (vector collapse) is still recognised as reversible", () => {
    const w = 64;
    const h = 96;
    const src = exactPixels(w, h * 2) as Pixels;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 4; c++)
          px[(y * w + x) * 4 + c] = Math.round(
            (src[((y * 2) * w + x) * 4 + c]! + src[((y * 2 + 1) * w + x) * 4 + c]!) / 2,
          );
    expect(recognizeExact(px as Pixels, w, h)).toBe(true);
  });

  test("an ordinary photo (B channel does not tend to zero) does not hit", () => {
    const w = 64;
    const h = 128;
    const px = new Uint8ClampedArray(w * h * 4);
    let seed = 12345;
    for (let i = 0; i < w * h; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      px[i * 4] = seed & 255;
      px[i * 4 + 1] = (seed >> 8) & 255;
      px[i * 4 + 2] = (seed >> 16) & 255;
      px[i * 4 + 3] = 255;
    }
    expect(recognizeExact(px as Pixels, w, h)).toBe(false);
  });

  test("a pure grey image does not hit (the radius collapses to a point)", () => {
    const w = 64;
    const h = 128;
    const px = new Uint8ClampedArray(w * h * 4).fill(128);
    for (let i = 0; i < w * h; i++) px[i * 4 + 3] = 255;
    expect(recognizeExact(px as Pixels, w, h)).toBe(false);
  });

  test("anything too small is rejected", () => {
    expect(recognizeExact(exactPixels(2, 8) as Pixels, 2, 8)).toBe(false);
  });
});

describe("compact image output", () => {
  beforeAll(() => {
    void startKernel({ fft: false }, compileWasm());
  });

  test("the image comes out and the tEXt meta is not a character off (the stub chain keeps the row count right)", async () => {
    const meta: Meta = {
      sr: 8000,
      win: 256,
      hop: 64,
      frames: 300,
      bins: 129,
      samples: 19200,
      bits: 8,
      ref: 0,
      exact: false,
    };
    const spec: Spectrum = {
      meta,
      levels: Uint8Array.from({ length: meta.frames * meta.bins }, (_, i) => (i * 7) & 255),
      phaseCos: null,
      phaseSin: null,
    };

    const bytes = new Uint8Array(await (await spectrumToPng(spec)).arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(readMeta(bytes)).toBe(metaToText(meta));
  });
});

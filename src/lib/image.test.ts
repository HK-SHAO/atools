import { describe, expect, test } from "bun:test";
import { recognizeExact, sniff } from "./image";
import type { Pixels } from "./arrays";
import { RAMP } from "./palette";

const ftyp = (major: string) => {
  const b = new Uint8Array(16);
  b.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  b.set([major.charCodeAt(0), major.charCodeAt(1), major.charCodeAt(2), major.charCodeAt(3)], 8);
  return b;
};

describe("sniff", () => {
  test("普通图片格式照常识别", () => {
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("jpeg");
    expect(sniff(new Uint8Array([0x42, 0x4d, 0x00]))).toBe("bmp");
    expect(sniff(new Uint8Array([0x47, 0x49, 0x46, 0x38])).startsWith("gif")).toBe(true);
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniff(webp)).toBe("webp");
  });

  test("真正的 AVIF 仍是 avif", () => {
    expect(sniff(ftyp("avif"))).toBe("avif");
    expect(sniff(ftyp("avis"))).toBe("avif");
    expect(sniff(ftyp("mif1"))).toBe("avif");
  });

  test("m4a / mp4 / mov 不被误判成图像", () => {
    expect(sniff(ftyp("M4A "))).toBe("?");
    expect(sniff(ftyp("isom"))).toBe("?");
    expect(sniff(ftyp("mp42"))).toBe("?");
    expect(sniff(ftyp("qt  "))).toBe("?");
  });

  test("完全认不出的二进制归为未知", () => {
    expect(sniff(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe("?");
  });
});

describe("recognizeExact（可逆图像素签名）", () => {

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

  test("完整可逆图（偶高度）命中", () => {
    const w = 64;
    const h = 128;
    expect(recognizeExact(exactPixels(w, h) as Pixels, w, h)).toBe(true);
  });

  test("缩放后的奇数高度也命中（回归：旧版 h%2 直接否掉）", () => {
    const w = 64;
    const h = 97; // 缩放 0.5× 后的典型奇高
    expect(recognizeExact(exactPixels(w, h) as Pixels, w, h)).toBe(true);
  });

  test("相位被缩放平均（矢量塌缩）后仍能认出是可逆图", () => {
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

  test("普通照片（B 通道不趋零）不命中", () => {
    const w = 64;
    const h = 128;
    const px = new Uint8ClampedArray(w * h * 4);
    let seed = 12345;
    for (let i = 0; i < w * h; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      px[i * 4] = seed & 255;
      px[i * 4 + 1] = (seed >> 8) & 255;
      px[i * 4 + 2] = (seed >> 16) & 255; // B 随机，通常远大于 48
      px[i * 4 + 3] = 255;
    }
    expect(recognizeExact(px as Pixels, w, h)).toBe(false);
  });

  test("纯灰图不命中（半径塌缩成点）", () => {
    const w = 64;
    const h = 128;
    const px = new Uint8ClampedArray(w * h * 4).fill(128);
    for (let i = 0; i < w * h; i++) px[i * 4 + 3] = 255;
    expect(recognizeExact(px as Pixels, w, h)).toBe(false);
  });

  test("太小的不认", () => {
    expect(recognizeExact(exactPixels(2, 8) as Pixels, 2, 8)).toBe(false);
  });
});


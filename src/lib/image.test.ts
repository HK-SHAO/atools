import { describe, expect, test } from "bun:test";
import { sniff } from "./image";

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

  // 关键回归：MP4 家族也有 ftyp 盒，但 major brand 不是 avif，
  // 一旦误判成 avif，m4a 会被当成图去 createImageBitmap 而报
  // "The source image could not be decoded"。
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

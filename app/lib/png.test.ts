import { describe, expect, test } from "bun:test";
import { RAMP } from "./palette";
import { indexedPng, isPng, readIndexedRamp, readMeta, withMeta } from "./png";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: number[]): number[] {
  const body = [...type.split("").map(c => c.charCodeAt(0)), ...data];
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const len = data.length;
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
}

const IHDR = chunk("IHDR", [0, 0, 0, 8, 0, 0, 0, 12, 8, 6, 0, 0, 0]);
const IEND = chunk("IEND", []);
const plain = Uint8Array.from([...SIGNATURE, ...IHDR, ...IEND]);

function walk(png: Uint8Array): { type: string; ok: boolean }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; ok: boolean }[] = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    let crc = 0xffffffff;
    for (let i = at + 4; i < at + 8 + len; i++) {
      crc ^= png[i]!;
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    out.push({ type, ok: ((crc ^ 0xffffffff) >>> 0) === view.getUint32(at + 8 + len) });
    at += 12 + len;
  }
  return out;
}

describe("png metadata chunk", () => {
  test("detects png", () => {
    expect(isPng(plain)).toBe(true);
    expect(isPng(Uint8Array.from([1, 2, 3, 4]))).toBe(false);
  });

  test("round trips a text chunk without breaking the file", () => {
    const text = "[1,44100,1,2048,1024,130,1025,132300]";
    const out = withMeta(plain, text);
    expect(isPng(out)).toBe(true);
    expect(walk(out).map(c => c.type)).toEqual(["IHDR", "tEXt", "IEND"]);
    expect(walk(out).every(c => c.ok)).toBe(true);
    expect(readMeta(out)).toBe(text);
    expect(out.length).toBe(plain.length + 12 + 8 + 1 + text.length);
  });

  test("keeps bytes around the injection point intact", () => {
    const out = withMeta(plain, "x");
    expect(out.subarray(0, 33)).toEqual(plain.subarray(0, 33));
    expect(out.subarray(out.length - IEND.length)).toEqual(plain.subarray(33));
  });

  test("returns null when absent", () => {
    expect(readMeta(plain)).toBeNull();
    expect(readMeta(Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  test("rejects corrupt metadata CRC and malformed PNG structure", () => {
    const good = withMeta(plain, "trusted");
    const corrupt = good.slice();
    const corruptAt = corrupt.length - IEND.length - 1;
    corrupt[corruptAt] = corrupt[corruptAt]! ^ 1;
    expect(readMeta(corrupt)).toBeNull();

    const duplicate = Uint8Array.from([...SIGNATURE, ...IHDR, ...IHDR, ...IEND]);
    expect(readMeta(duplicate)).toBeNull();
    const shortHeader = Uint8Array.from([...SIGNATURE, ...chunk("IHDR", [0, 0, 0, 1]), ...IEND]);
    expect(readMeta(shortHeader)).toBeNull();
    const zeroWidth = Uint8Array.from([
      ...SIGNATURE,
      ...chunk("IHDR", [0, 0, 0, 0, 0, 0, 0, 12, 8, 6, 0, 0, 0]),
      ...IEND,
    ]);
    expect(readMeta(zeroWidth)).toBeNull();
  });
});

describe("indexed ramp", () => {
  for (const depth of [1, 2, 4, 8]) {
    test(`round trips at bit depth ${depth}`, async () => {
      const steps = (1 << depth) - 1;
      const width = 37;
      const height = 12;
      const indices = new Uint8Array(width * height);
      for (let i = 0; i < indices.length; i++) indices[i] = (i * 7) % (1 << depth);

      const palette = new Uint8Array((1 << depth) * 3);
      for (let q = 0; q <= steps; q++) {
        const lv = Math.min(255, Math.round((Math.min(q, steps) * 255) / steps));
        palette[q * 3] = RAMP[lv * 3]!;
        palette[q * 3 + 1] = RAMP[lv * 3 + 1]!;
        palette[q * 3 + 2] = RAMP[lv * 3 + 2]!;
      }

      const bytes = await indexedPng(indices, width, height, depth, palette, "x");
      const got = await readIndexedRamp(bytes);
      expect(got).not.toBeNull();
      expect([got!.width, got!.height]).toEqual([width, height]);
      for (let i = 0; i < indices.length; i++) {
        const want = Math.min(255, Math.round((Math.min(indices[i]!, steps) * 255) / steps));
        expect(got!.levels[i]).toBe(want);
      }
    });
  }

  test("rejects corrupt chunks, decompression excess, and truncated files", async () => {
    const palette = Uint8Array.from([...RAMP.subarray(0, 3), ...RAMP.subarray(255 * 3, 256 * 3)]);
    const bytes = await indexedPng(new Uint8Array(16), 4, 4, 1, palette, "x");

    const badCrc = bytes.slice();
    const badCrcAt = badCrc.length - IEND.length - 1;
    badCrc[badCrcAt] = badCrc[badCrcAt]! ^ 1;
    expect(await readIndexedRamp(badCrc)).toBeNull();
    expect(await readIndexedRamp(bytes.subarray(0, bytes.length - 3))).toBeNull();

    const bomb = bytes.slice();
    const view = new DataView(bomb.buffer);
    view.setUint32(20, 1);
    const headerCrc = chunk("IHDR", [...bomb.subarray(16, 29)]).slice(-4);
    bomb.set(headerCrc, 29);
    expect(await readIndexedRamp(bomb)).toBeNull();
  });

  test("deterministic malformed PNG mutations never throw", async () => {
    const palette = Uint8Array.from([...RAMP.subarray(0, 3), ...RAMP.subarray(255 * 3, 256 * 3)]);
    const source = await indexedPng(new Uint8Array(64), 8, 8, 1, palette, "x");
    let seed = 0x9e3779b9;
    for (let i = 0; i < 200; i++) {
      seed = Math.imul(seed ^ (seed >>> 16), 0x21f0aaad) | 0;
      const cut = Math.abs(seed) % (source.length + 1);
      const mutated = source.slice(0, cut);
      if (mutated.length) {
        const at = Math.abs(seed >>> 8) % mutated.length;
        mutated[at] = mutated[at]! ^ (1 << (i % 8));
      }
      expect(() => readMeta(mutated)).not.toThrow();
      await expect(readIndexedRamp(mutated)).resolves.toBeDefined();
    }
  });
});

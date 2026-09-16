import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import type { Pixels } from "./arrays";
import { attachKernel, loadDsp, type Dsp } from "./dsp";
import { decodeStub, drawStub, stubFits, stubLuma, stubRows } from "./stub";

describe("stub (the segment that crosses the boundary)", () => {
  let dsp: Dsp;
  beforeAll(async () => {
    dsp = await loadDsp(compileWasm());
    attachKernel(dsp);
  });

  const sheet = (w: number, h: number, rows: number) => {
    const px = new Uint8ClampedArray(w * h * 4) as Pixels;
    px.fill(7);
    return { px, rows, top: (h - rows) * w * 4 };
  };

  test("rows match the format: it paints the bottom rows and leaves every cell above untouched", () => {
    const w = 400;
    const h = 40;
    const rows = stubRows();
    expect(rows).toBeGreaterThan(0);
    const { px, top } = sheet(w, h, rows);

    drawStub(px, w, h, 44100, 512, true);

    for (let i = top; i < px.length; i += 4) {
      expect(px[i + 3]).toBe(255);
      expect(px[i + 1]).toBe(px[i]);
      expect(px[i + 2]).toBe(px[i]);
    }
    for (let i = 0; i < top; i++) expect(px[i]).toBe(7);
  });

  const profileOf = (px: Pixels, w: number, top: number): Float64Array => {
    const rows = stubRows();
    const prof = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 0; y < rows; y++) s += px[top + y * w * 4 + x * 4]!;
      prof[x] = s / rows;
    }
    return prof;
  };

  test("the packed result unpacks (each of the three width prefixes runs, the two-window case included)", () => {
    for (const [w, sr, win] of [
      [255, 96000, 2048],
      [4095, 44100, 512],
      [65535, 48000, 1024],
    ] as const) {
      const rows = stubRows();
      const { px, top } = sheet(w, rows + 16, rows);
      drawStub(px, w, rows + 16, sr, win, true);
      expect(decodeStub(profileOf(px, w, top)), `w=${w}`).toEqual({
        width: w,
        sr,
        win,
        exact: true,
      });
    }
  });

  test("when stubFits says it fits, painting really paints and decoding really reads it back", () => {
    const rows = stubRows();
    for (const w of [46, 60, 100, 255, 400, 4095, 65535]) {
      if (!stubFits(w)) {
        expect(stubLuma(w, 44100, 512, false), `w=${w} must not be paintable`).toBeNull();
        continue;
      }
      const { px, top } = sheet(w, rows + 16, rows);
      drawStub(px, w, rows + 16, 44100, 512, false);
      let lit = 0;
      for (let i = top; i < px.length; i += 4) if (px[i] !== 20) lit++;
      expect(lit, `w=${w} has not one lit pixel`).toBeGreaterThan(0);
      expect(decodeStub(profileOf(px, w, top)), `w=${w}`).not.toBeNull();
    }
  });

  test("a profile it cannot recognise gives null rather than a bad result", () => {
    expect(decodeStub(Array.from({ length: 400 }, () => 111.2))).toBeNull();
    expect(decodeStub([])).toBeNull();
  });
});

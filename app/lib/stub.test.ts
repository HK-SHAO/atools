import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import type { Pixels } from "./arrays";
import { attachKernel, loadDsp, type Dsp } from "./dsp";
import { decodeStub, drawStub, stubFits, stubLuma, stubRows } from "./stub";

describe("票根（跨边界的那一段）", () => {
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

  test("行数与格式一致：画在底部那几行，上面一格都不动", () => {
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

  test("打包结果拆得回来（三档宽度前缀各走一遍，含双窗口）", () => {
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

  test("stubFits 说装得下，画下去就真的画得出来、也认得回来", () => {
    const rows = stubRows();
    for (const w of [46, 60, 100, 255, 400, 4095, 65535]) {
      if (!stubFits(w)) {
        expect(stubLuma(w, 44100, 512, false), `w=${w} 不该能画`).toBeNull();
        continue;
      }
      const { px, top } = sheet(w, rows + 16, rows);
      drawStub(px, w, rows + 16, 44100, 512, false);
      let lit = 0;
      for (let i = top; i < px.length; i += 4) if (px[i] !== 20) lit++;
      expect(lit, `w=${w} 一个亮像素都没有`).toBeGreaterThan(0);
      expect(decodeStub(profileOf(px, w, top)), `w=${w}`).not.toBeNull();
    }
  });

  test("认不出来的剖面给 null，而不是一个坏结果", () => {
    expect(decodeStub(Array.from({ length: 400 }, () => 111.2))).toBeNull();
    expect(decodeStub([])).toBeNull();
  });
});

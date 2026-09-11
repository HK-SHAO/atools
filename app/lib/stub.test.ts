import { beforeAll, describe, expect, test } from "vitest";
import { compileWasm } from "../../scripts/moon";
import type { Pixels } from "./arrays";
import { attachKernel, loadDsp, type Dsp } from "./dsp";
import { decodeStub, drawStub, stubFits, stubLuma, stubRows } from "./stub";

/**
 * 票根的**实现**整段在内核里，行为断言（逐宽度「装得下 ⟺ 认得回来」、CRC 拦坏位流、
 * 两份冗余、三档宽度前缀）全在 `moon/stub_wbtest.mbt`。这里只剩跨边界的那一段：
 *
 *   ① 内核画出来的 `w × rows` RGBA 被搬到 ImageData 的**底部 8 行**（不是顶部、不是错行）；
 *   ② 内核返回的打包 i32 被拆成 `{width, sr, win, exact}`（梯子问内核要）；
 *   ③ `stubFits` 与 `stubLuma` 两条判据说的是同一件事。
 *
 * 这三件事在 `moon/` 里证不了 —— 它们说的正是「内核之外那一层」。
 */
describe("票根（跨边界的那一段）", () => {
  let dsp: Dsp;
  beforeAll(async () => {
    dsp = await loadDsp(compileWasm());
    attachKernel(dsp);
  });

  /** 一块「图」：只有底部 `rows` 行该被票根覆盖，其余填成醒目的哨兵值。 */
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

    // 块内每一个像素都是不透明的、且 R = G = B（票根只有亮度这一维）
    for (let i = top; i < px.length; i += 4) {
      expect(px[i + 3]).toBe(255);
      expect(px[i + 1]).toBe(px[i]);
      expect(px[i + 2]).toBe(px[i]);
    }
    for (let i = 0; i < top; i++) expect(px[i]).toBe(7);
  });

  /** 抽回一条亮度剖面（内核认的就是这个，不是像素块）。 */
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

  /**
   * `stubFits` 是产品侧唯一会用到的判据（`image.ts` 拿它决定留不留那几行）。
   * 它说装得下，就**必须**真的画得出来、认得回来 —— 反方向不成立，也不必成立：
   * 「画得下但剖面太短」是合法的中间态（`span + 2 ≤ w < 46`），那正是 `stub_min_decode`
   * 存在的理由。真正的双向等价在 `moon/stub_wbtest.mbt`，那里逐宽度走了一遍。
   */
  test("stubFits 说装得下，画下去就真的画得出来、也认得回来", () => {
    const rows = stubRows();
    for (const w of [46, 60, 100, 255, 400, 4095, 65535]) {
      if (!stubFits(w)) {
        // 这个宽度本该被产品侧挡掉，那就不该有人去画它
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
    expect(decodeStub(new Array(400).fill(111.2))).toBeNull();
    expect(decodeStub([])).toBeNull();
  });
});

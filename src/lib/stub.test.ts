import { describe, expect, test } from "bun:test";
import { STUB_ROWS, decodeStub, drawStub, stubBits, stubFits } from "./stub";

/** 画一张 w×h 的 RGBA 图，底部带票根，返回像素。 */
function draw(w: number, h: number, sr: number, win: number, exact: boolean): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = 180;
    px[i * 4 + 1] = 90;
    px[i * 4 + 2] = 40;
    px[i * 4 + 3] = 255;
  }
  drawStub(px, w, h, sr, win, exact);
  return px;
}

/** 模拟缩放：底部 rows 行按因子 s 水平重采样（盒式均值），并叠加模拟 JPEG 的亮度抖动。 */
function resampleProfile(px: Uint8ClampedArray, w: number, h: number, rows: number, s: number, noise: number): number[] {
  const band = (y: number, x: number): number => {
    const p = (y * w + x) * 4;
    return 0.299 * px[p]! + 0.587 * px[p + 1]! + 0.114 * px[p + 2]!;
  };
  const out: number[] = [];
  for (let x = 0; x < Math.round(w * s); x++) {
    // 逆映射到原始坐标的 [x0, x1) 区间求均值（盒式）
    const x0 = x / s;
    const x1 = (x + 1) / s;
    let sum = 0;
    let n = 0;
    for (let xi = Math.floor(x0); xi < Math.max(Math.floor(x0) + 1, Math.ceil(x1)) && xi < w; xi++) {
      let rowSum = 0;
      for (let y = h - rows; y < h; y++) rowSum += band(y, xi);
      rowSum /= rows;
      sum += rowSum;
      n++;
    }
    const base = n > 0 ? sum / n : 0;
    out.push(base + (Math.sin(x * 12.9898) * noise));
  }
  return out;
}

describe("stubBits / drawStub / decodeStub", () => {
  test("1:1 精确往返", () => {
    const w = 400;
    const px = draw(w, 130, 44100, 512, true);
    const profile: number[] = [];
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 130 - STUB_ROWS; y < 130; y++) {
        const p = (y * w + x) * 4;
        s += 0.299 * px[p]! + 0.587 * px[p + 1]! + 0.114 * px[p + 2]!;
      }
      profile.push(s / STUB_ROWS);
    }
    const info = decodeStub(profile);
    expect(info).not.toBeNull();
    expect(info!.width).toBe(w);
    expect(info!.sr).toBe(44100);
    expect(info!.win).toBe(512);
    expect(info!.exact).toBe(true);
  });

  test("缩放 0.5× / 0.75× / 0.9× + 模拟 JPEG 抖动后仍能解码", () => {
    for (const s of [0.5, 0.75, 0.9]) {
      const w = 600;
      const h = 130;
      const px = draw(w, h, 48000, 1024, false);
      const profile = resampleProfile(px, w, h, STUB_ROWS, s, 6);
      const info = decodeStub(profile);
      expect(info, `scale ${s}`).not.toBeNull();
      expect(info!.sr).toBe(48000);
      expect(info!.win).toBe(1024);
      expect(info!.width).toBe(w);
    }
  });

  test("窄图一遍也能解（底 4 行即票根；混入内容行时靠递减行数策略）", () => {
    const w = 160;
    const px = draw(w, 90, 8000, 256, false);
    const rows = (y0: number, y1: number): number[] => {
      const out: number[] = [];
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = y0; y < y1; y++) {
          const p = (y * w + x) * 4;
          s += 0.299 * px[p]! + 0.587 * px[p + 1]! + 0.114 * px[p + 2]!;
        }
        out.push(s / (y1 - y0));
      }
      return out;
    };
    // 底部 4 行 = 纯票根 → 成功
    const info = decodeStub(rows(90 - STUB_ROWS, 90));
    expect(info).not.toBeNull();
    expect(info!.sr).toBe(8000);
    expect(info!.win).toBe(256);
    // 混入大量内容行 → 阈值内对比度被稀释，应当失败（上层会换行数重试）
    expect(decodeStub(rows(0, STUB_ROWS))).toBeNull();
  });

  test("位流参数放不下时返回 null", () => {
    expect(stubBits(400, 12345, 512, false)).toBeNull(); // sr 不在表
    expect(stubBits(400, 44100, 300, false)).toBeNull(); // win 不在表
    expect(stubBits(1, 44100, 512, false)).toBeNull();
  });

  test("太窄的图不写票根", () => {
    expect(stubFits(100)).toBe(true); // 2px/bit：窄图也能写下了
    expect(stubFits(160)).toBe(true);
    expect(stubFits(42)).toBe(true); // 1px/bit：极窄图也能写下
    expect(stubFits(30)).toBe(false); // 30px 连 33bit×1px 都放不下
  });
});

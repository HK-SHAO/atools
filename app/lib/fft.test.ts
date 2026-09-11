import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import { loadDsp, planOf, type Dsp } from "./dsp";
import { FFT, hannWindow } from "./fft";

/**
 * FFT 是整条数值链的地基：STFT、相位重建、归一化全都建在它上面。
 *
 * 判据分两档，因为这里**确实**存在一类不可消除的差异：
 *
 * - **逐位**：位反转索引是纯整数运算，必须 0 处不同。
 * - **ulp 上界**：旋转因子与变换改用「相对峰值的 ulp 距离」上界。
 *   实测 MoonBit 的 `@math.cos` 与 V8 的 `Math.cos` 在约 4% 的输入上差 **恰好 1 ulp**
 *   （最大相对 2.19e-16），于是整条 FFT 的最大相对误差是 1.5~3.4 ulp。
 *   这不是缺陷：两者都是合法的舍入，差异远在 Float32 精度（1.2e-7）之下。
 *   真正需要被挡住的是「算法写错」—— 顺序、除法、符号、旋转因子下标错一处，
 *   误差都会大出好几个数量级，所以上界定在 8 ulp（约 5 倍余量）依然抓得住。
 *
 * 于是「exact 档逐位不变」这条强断言落在**产物**上（u8 层级/相位位平面），
 * 不落在 f64 中间量上。产物侧的逐位门禁见 `spectrum.test.ts`。
 */

const EPSILON = Number.EPSILON;

/** 相对峰值的最大 ulp 距离。FFT 的精度按「后向误差 / 信号峰值」度量才有意义。 */
function peakUlps(got: ArrayLike<number>, ref: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < ref.length; i++) peak = Math.max(peak, Math.abs(ref[i]!));
  if (peak === 0) return 0;
  let worst = 0;
  for (let i = 0; i < got.length; i++)
    worst = Math.max(worst, Math.abs(got[i]! - ref[i]!) / peak / EPSILON);
  return worst;
}

/** 逐字节比两个视图，返回不同的字节数。0 才是「逐位不变」。 */
const differing = (a: ArrayBufferView, b: ArrayBufferView): number => {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (x.length !== y.length) return -1;
  let count = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) count++;
  return count;
};

/** 确定性伪随机：每次跑同一组输入，失败可复现。 */
const noise = (n: number, seed: number): Float64Array => {
  const out = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s / 0xffffffff - 0.5;
  }
  return out;
};

const ULP_BOUND = 8;
const WINS = [256, 512, 1024, 4096];

describe("FFT 内核与 TS 参照实现等价", () => {
  let dsp: Dsp;
  beforeAll(async () => {
    dsp = await loadDsp(compileWasm());
  });

  for (const win of WINS) {
    test(`窗长 ${win}：位反转逐位相同，旋转因子与汉宁窗在 1 ulp 之内`, () => {
      const plan = planOf(dsp, win);
      const levels = Math.log2(win);
      const rev = new Int32Array(win);
      for (let i = 0; i < win; i++) {
        let r = 0;
        for (let b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
        rev[i] = r;
      }
      expect(differing(plan.rev, rev)).toBe(0);

      const half = win / 2;
      const cos = new Float64Array(half);
      const sin = new Float64Array(half);
      for (let i = 0; i < half; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / win);
        sin[i] = Math.sin((2 * Math.PI * i) / win);
      }
      expect(peakUlps(plan.cos, cos)).toBeLessThanOrEqual(1);
      expect(peakUlps(plan.sin, sin)).toBeLessThanOrEqual(1);
      expect(peakUlps(plan.hann, hannWindow(win))).toBeLessThanOrEqual(1);
    });

    test(`窗长 ${win}：正变换、反变换与 TS 一致（≤ ${ULP_BOUND} ulp）`, () => {
      const plan = planOf(dsp, win);
      const inputRe = noise(win, 0x9e3779b9 + win);
      const inputIm = noise(win, 0x85ebca6b + win);

      plan.re.set(inputRe);
      plan.im.set(inputIm);
      plan.forward();
      const gotRe = Float64Array.from(plan.re);
      const gotIm = Float64Array.from(plan.im);

      const refRe = Float64Array.from(inputRe);
      const refIm = Float64Array.from(inputIm);
      new FFT(win).transform(refRe, refIm);

      expect(peakUlps(gotRe, refRe)).toBeLessThanOrEqual(ULP_BOUND);
      expect(peakUlps(gotIm, refIm)).toBeLessThanOrEqual(ULP_BOUND);

      // 反变换跑在正变换的输出上：除法的位置（/n 而不是 ×(1/n)）在这里才检得出来
      plan.re.set(gotRe);
      plan.im.set(gotIm);
      plan.inverse();
      new FFT(win).transform(refRe, refIm, true);

      expect(peakUlps(plan.re, refRe)).toBeLessThanOrEqual(ULP_BOUND);
      expect(peakUlps(plan.im, refIm)).toBeLessThanOrEqual(ULP_BOUND);

      // 与参照实现无关的自洽性：正变换 → 反变换必须回到输入
      expect(peakUlps(plan.re, inputRe)).toBeLessThanOrEqual(ULP_BOUND);
      expect(peakUlps(plan.im, inputIm)).toBeLessThanOrEqual(ULP_BOUND);
    });
  }

  test("不接受非法窗长", () => {
    expect(() => planOf(dsp, 100)).toThrow();
    expect(() => planOf(dsp, 8192)).toThrow();
  });
});

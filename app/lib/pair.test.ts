import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { compileWasm } from "../../scripts/moon";
import { attachKernel, loadDsp } from "./dsp";
import { FFT, mirrorSpectrum } from "./fft";
import { Pair } from "./pair";

/**
 * 两条实序列共用一个复变换 —— 这是把 RTISI 里实变换次数减半的那一步，
 * 所以它的判据必须比「跑得通」严得多：**逐条对参照实现**，两档都卡 ulp 上界。
 *
 * 参照实现就是被它替换掉的那条老路：两条各做一次 `FFT`；反变换侧则是
 * `mirrorSpectrum` + 一次 `FFT(inverse)`。ulp 上界与 `fft.test.ts` 一致（8），
 * 因为多出来的只是 O(N) 的加减，并没有第二处超越函数。
 */

const EPSILON = Number.EPSILON;
const ULP_BOUND = 8;
/** 正变换在「第二条喂零」时对老路的上界：Hermite 对称化带来的纯舍入差，实测 ≤2.27。 */
const FORWARD_ULP = 4;
const WINS = [256, 512, 1024, 4096];

function peakUlps(got: ArrayLike<number>, ref: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < ref.length; i++) peak = Math.max(peak, Math.abs(ref[i]!));
  if (peak === 0) return 0;
  let worst = 0;
  for (let i = 0; i < got.length; i++)
    worst = Math.max(worst, Math.abs(got[i]! - ref[i]!) / peak / EPSILON);
  return worst;
}

/** 逐字节比两个视图，返回不同的字节数。0 才是「逐位相同」。 */
const differing = (a: ArrayBufferView, b: ArrayBufferView): number => {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (x.length !== y.length) return -1;
  let count = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) count++;
  return count;
};

/** |im| 相对**实部峰值**的大小，单位是 ulp。用来量「虚部只是舍入残渣」。 */
function residueUlps(im: ArrayLike<number>, re: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < re.length; i++) peak = Math.max(peak, Math.abs(re[i]!));
  if (peak === 0) return 0;
  let worst = 0;
  for (let i = 0; i < im.length; i++) worst = Math.max(worst, Math.abs(im[i]!));
  return worst / peak / EPSILON;
}

const noise = (n: number, seed: number): Float64Array => {
  const out = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s / 0xffffffff - 0.5;
  }
  return out;
};

/** 老路：一条实序列一次复变换。 */
function soloForward(y: Float64Array, size: number): { re: Float64Array; im: Float64Array } {
  const re = Float64Array.from(y.subarray(0, size));
  const im = new Float64Array(size);
  new FFT(size).transform(re, im);
  return { re, im };
}

/** 老路：半谱 → 实波形，靠 `mirrorSpectrum` 补成整谱。 */
function soloInverse(
  re: Float64Array,
  im: Float64Array,
  size: number,
): { re: Float64Array; im: Float64Array } {
  const half = size / 2 + 1;
  const full = new Float64Array(size);
  const fimi = new Float64Array(size);
  full.set(re.subarray(0, half));
  fimi.set(im.subarray(0, half));
  mirrorSpectrum(full, fimi, half, size);
  new FFT(size).transform(full, fimi, true);
  return { re: full, im: fimi };
}

/**
 * 同一批用例跑两遍：`kernel` 走内核（`moon/pair.mbt`，默认真身），`reference` 走本仓的
 * TS 实现。两遍都对着同一条老路量 ulp，所以「把算法搬进 wasm」这件事在这里是被证的，
 * 而不是被相信的。
 *
 * `make` 里的 `expect(pair.via).toBe(mode)` 是这套门禁的支点：内核槽位只有 6 个，
 * 漏掉 `dispose` 就会静默退回参照实现 —— 那样 `kernel` 那一遍等于什么都没验，而它仍然全绿。
 */
describe.each(["kernel", "reference"] as const)("两条实序列打成一个复变换（%s）", mode => {
  const live: Pair[] = [];

  beforeAll(async () => {
    attachKernel(mode === "kernel" ? await loadDsp(compileWasm()) : null);
  });

  afterAll(() => attachKernel(null));

  afterEach(() => {
    for (const pair of live) pair.dispose();
    live.length = 0;
  });

  /** 造一个 `Pair`，并盯住它真的走了这一遍该走的那条路。 */
  const make = (size: number): Pair => {
    const pair = new Pair(size);
    expect(pair.via).toBe(mode);
    live.push(pair);
    return pair;
  };

  for (const win of WINS) {
    /**
     * 反变换侧是整次改造的**回归锚点**：第二条喂零时 `Pair` 与老路必须逐位相同。
     *
     * 成立是因为 Z = X1：`inverse` 交给 FFT 的整谱与 `mirrorSpectrum` 逐项同源同序，
     * 连 DC 与奈奎斯特点的置零都落在同一处。这条钉住了 Hermite 那套约定没写歪 ——
     * 写歪了不会报错，只会让直流慢慢飘走。
     */
    test(`窗长 ${win}：反变换在第二条喂零时与老路一致`, () => {
      const size = win;
      const half = size / 2 + 1;
      const r = noise(half, 0x846ca68b + win);
      const i = noise(half, 0x9e3779b9 + win);
      const pair = make(size);
      pair.r1.set(r);
      pair.i1.set(i);
      pair.inverse();
      const ref = soloInverse(r, i, size);
      // 参照实现与老路共用同一份旋转因子表（同一台 V8、同一个 `Math.cos`），所以逐位相同。
      // 内核那份表是 MoonBit 的 `@math.cos` 建的，实测约 4% 的输入与 V8 差 1 ulp，于是整次变换
      // 落在 8 ulp 内而**不再逐位** —— 那是唯一的差异来源（见 fft.test.ts 的说明），
      // 所以这一条按实现分档，而不是把「逐位」这个强承诺悄悄放宽。
      if (mode === "reference") expect(differing(pair.x1, ref.re)).toBe(0);
      else expect(peakUlps(pair.x1, ref.re)).toBeLessThanOrEqual(ULP_BOUND);
    });

    /**
     * 正变换侧**做不到逐位**，这要写清楚而不是含糊过去：打包必然做一次 Hermite 对称化
     * （`X1[k] = (Z[k] + conj(Z[N-k]))/2`），而老路直接取实信号 FFT 出来的 `Z[k]`。
     * 两者在「实信号」这个前提下是同一个量，浮点上的差就是**谱的虚部不对称量的一半** ——
     * 纯舍入噪声，实测 1.31~2.27 ulp（随窗长），所以卡 4（实测值的约 1.8 倍余量）。
     * 卡 0 会假红；真正的公式写错会大出好几个数量级，卡 4 一样抓得住。
     */
    test(`窗长 ${win}：正变换在第二条喂零时与老路差不超过 ${FORWARD_ULP} ulp`, () => {
      const size = win;
      const half = size / 2 + 1;
      const zeros = new Float64Array(size);
      const y = noise(size, 0x7feb352d + win);
      const pair = make(size);
      pair.forward(y, zeros);
      const solo = soloForward(y, size);
      expect(peakUlps(pair.r1, solo.re.subarray(0, half))).toBeLessThanOrEqual(FORWARD_ULP);
      expect(peakUlps(pair.i1, solo.im.subarray(0, half))).toBeLessThanOrEqual(FORWARD_ULP);
    });

    test(`窗长 ${win}：两条实序列的正变换与两次独立变换一致（≤ ${ULP_BOUND} ulp）`, () => {
      const size = win;
      const half = size / 2 + 1;
      const y1 = noise(size, 0x9e3779b9 + win);
      const y2 = noise(size, 0xc2b2ae35 + win);

      const pair = make(size);
      pair.forward(y1, y2);

      const a = soloForward(y1, size);
      const b = soloForward(y2, size);

      expect(peakUlps(pair.r1, a.re.subarray(0, half))).toBeLessThanOrEqual(ULP_BOUND);
      expect(peakUlps(pair.i1, a.im.subarray(0, half))).toBeLessThanOrEqual(ULP_BOUND);
      expect(peakUlps(pair.r2, b.re.subarray(0, half))).toBeLessThanOrEqual(ULP_BOUND);
      expect(peakUlps(pair.i2, b.im.subarray(0, half))).toBeLessThanOrEqual(ULP_BOUND);
    });

    test(`窗长 ${win}：正变换 → 反变换回到两条输入（≤ ${ULP_BOUND} ulp）`, () => {
      const size = win;
      const y1 = noise(size, 0x27d4eb2f + win);
      const y2 = noise(size, 0x165667b1 + win);

      const pair = make(size);
      pair.forward(y1, y2);
      pair.inverse();

      expect(peakUlps(pair.x1, y1)).toBeLessThanOrEqual(ULP_BOUND);
      expect(peakUlps(pair.x2, y2)).toBeLessThanOrEqual(ULP_BOUND);
    });

    test(`窗长 ${win}：反变换与 mirrorSpectrum 那条老路一致（≤ ${ULP_BOUND} ulp）`, () => {
      const size = win;
      const half = size / 2 + 1;
      // 刻意用**非 Hermite** 的半谱：`lay` 填的 amp·cos / amp·sin 在 DC 与奈奎斯特点上
      // 并不共轭自洽，老路是靠 mirrorSpectrum 的置零把它们拉回实信号的谱。
      // 只有拿这种输入比，才检得出新路有没有漏掉同一条约定。
      const r1 = noise(half, 0x1000193 + win);
      const i1 = noise(half, 0x1b873593 + win);
      const r2 = noise(half, 0xcc9e2d51 + win);
      const i2 = noise(half, 0x85ebca6b + win);

      const pair = make(size);
      pair.r1.set(r1);
      pair.i1.set(i1);
      pair.r2.set(r2);
      pair.i2.set(i2);
      pair.inverse();

      const a = soloInverse(r1, i1, size);
      const b = soloInverse(r2, i2, size);

      expect(peakUlps(pair.x1, a.re)).toBeLessThanOrEqual(ULP_BOUND);
      expect(peakUlps(pair.x2, b.re)).toBeLessThanOrEqual(ULP_BOUND);
      // 老路出来的是复数组，虚部只是舍入残渣（mirrorSpectrum 之后谱已 Hermite），
      // 新路直接把「虚部」当成第二条波形用 —— 前提就是残渣确实只是残渣。
      // 注意不能拿 `peakUlps(a.im, a.re)` 去量：那是 |im - re| 对 re 的峰值取比值，
      // 结构上恒等于 1/ε，写成断言必然假红。要量的是 |im| 相对**信号峰值**的大小。
      expect(residueUlps(a.im, a.re)).toBeLessThanOrEqual(ULP_BOUND);
      expect(residueUlps(b.im, b.re)).toBeLessThanOrEqual(ULP_BOUND);
    });
  }
});

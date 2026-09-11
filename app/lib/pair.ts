import { kernel, openSlot, pairTables, type Dsp, type Slot } from "./dsp";
import { FFT } from "./fft";

/**
 * 两条实序列共用一个复变换。
 *
 * 实序列的谱是 Hermite 的，两条独立变换等于把同一份冗余算两遍：把 x1、x2 打包成
 * `z = x1 + i·x2` 做**一次**复变换，再按
 *
 * ```
 * X1[k] = (Z[k] + conj(Z[N-k])) / 2
 * X2[k] = (Z[k] - conj(Z[N-k])) / (2i)
 * ```
 *
 * 拆开即可。反变换同理：`Z[k] = X1[k] + i·X2[k]` 补成整谱，一次复变换出来的虚实部
 * 就是两条波形。**FFT 次数因此减半**，多出来的是 O(N) 的加减。
 *
 * 为什么值得：RTISI-LA 每帧要做 2·act 次实变换，实测逆变换里 78% 的时间在它身上，
 * 而其中约八成又是 FFT 本身。这里省下的一半是**唯一**能同时压住那八成的杠杆。
 *
 * 实现有两份：内核（`moon/pair.mbt`，默认真身）与这里的 TS 参照实现。
 * `pair.test.ts` 把两者对着同一批用例各跑一遍。内核没挂上、或槽位池满时自动退回参照 ——
 * 降级而不是崩。无论走哪条路，数字都是同一套（逐位等价由那条门禁守）。
 *
 * 只给紧凑档用。可逆档（exact）走 `FFT` 原路，产物逐位不变 —— 这条契约不能被
 * 「换个更快的算法」动摇，见 docs/migration.md。
 */
export class Pair {
  readonly size: number;
  /** 半谱长度（含 DC 与奈奎斯特点）。 */
  readonly half: number;

  /** 正变换的输出：两条半谱。反变换的输入同样是这四张表。 */
  readonly r1: Float64Array;
  readonly i1: Float64Array;
  readonly r2: Float64Array;
  readonly i2: Float64Array;

  /** 反变换的输出：两条实波形。 */
  readonly x1: Float64Array;
  readonly x2: Float64Array;

  /**
   * 这一次实际走的是哪条路。**门禁要靠它**：内核槽位只有 6 个，忘了 `dispose` 就会
   * 静默退回参照实现，于是一整遍「内核」用例其实什么都没验。宿主代码不看它。
   */
  readonly via: "kernel" | "reference";

  private readonly dsp: Dsp | null;
  private readonly slot: Slot | null;
  /** 参照实现才有的中间量。走内核时这些缓冲都在 wasm 内存里，宿主看不见也不该看见。 */
  private readonly ref: { zr: Float64Array; zi: Float64Array; fft: FFT } | null;

  constructor(size: number) {
    this.size = size;
    this.half = size / 2 + 1;

    const dsp = kernel();
    const slot = dsp ? openSlot(dsp, size) : null;
    if (dsp && slot) {
      const tables = pairTables(dsp, slot);
      this.dsp = dsp;
      this.slot = slot;
      this.ref = null;
      this.via = "kernel";
      this.r1 = tables.r1;
      this.i1 = tables.i1;
      this.r2 = tables.r2;
      this.i2 = tables.i2;
      this.x1 = tables.x1;
      this.x2 = tables.x2;
    } else {
      this.dsp = null;
      this.slot = null;
      this.ref = { zr: new Float64Array(size), zi: new Float64Array(size), fft: new FFT(size) };
      this.via = "reference";
      this.r1 = new Float64Array(this.half);
      this.i1 = new Float64Array(this.half);
      this.r2 = new Float64Array(this.half);
      this.i2 = new Float64Array(this.half);
      this.x1 = new Float64Array(size);
      this.x2 = new Float64Array(size);
    }
  }

  /** 两条实序列 → 两条半谱。y1、y2 只需前 size 个样点。 */
  forward(y1: Float64Array, y2: Float64Array): void {
    const { size } = this;
    if (this.dsp && this.slot) {
      // 走内核时 x1/x2 就是内核内存上的两段，这一步是零拷贝之外的唯一一次搬运（源未必是它们）。
      this.x1.set(y1.subarray(0, size));
      this.x2.set(y2.subarray(0, size));
      this.dsp.kernel.dsp_pair_forward(this.slot.id);
      return;
    }
    const { half, r1, i1, r2, i2 } = this;
    const { zr, zi, fft } = this.ref!;
    zr.set(y1.subarray(0, size));
    zi.set(y2.subarray(0, size));
    fft.transform(zr, zi);

    // k 与 m = size-k 都在原谱上取值，写的是另外四张表，不打架。
    for (let k = 0; k < half; k++) {
      const m = k === 0 ? 0 : size - k;
      const a = zr[k]!;
      const b = zi[k]!;
      const c = zr[m]!;
      const d = zi[m]!;
      r1[k] = 0.5 * (a + c);
      i1[k] = 0.5 * (b - d);
      r2[k] = 0.5 * (b + d);
      i2[k] = -0.5 * (a - c);
    }
  }

  /**
   * 两条半谱 → 两条实波形。
   *
   * 与 `mirrorSpectrum(re, im, full, size)` 同一套约定：DC 与奈奎斯特点的虚部置零。
   * 这一步不能省 —— `lay` 填的 `amp·cos`、`amp·sin` 在 DC 上并不共轭自洽，
   * 原来的实现就是靠 mirror 把它们拉回实信号的谱。少了它，两条波形的直流会飘。
   */
  inverse(): void {
    if (this.dsp && this.slot) {
      this.dsp.kernel.dsp_pair_inverse(this.slot.id);
      return;
    }
    const { size, half, r1, i1, r2, i2, x1, x2 } = this;
    const { zr, zi, fft } = this.ref!;
    i1[0] = 0;
    i2[0] = 0;
    i1[half - 1] = 0;
    i2[half - 1] = 0;

    // Z = X1 + i·X2。Z 是**复**信号的谱，没有 Hermite 对称，所以第二半得从 X1、X2 各推一次
    // （Z[N-k] = conj(X1[k]) + i·conj(X2[k])），不能像 mirrorSpectrum 那样只翻 Z 自己。
    zr[0] = r1[0]!;
    zi[0] = r2[0]!;
    zr[half - 1] = r1[half - 1]!;
    zi[half - 1] = r2[half - 1]!;
    for (let k = 1; k < half - 1; k++) {
      const m = size - k;
      zr[k] = r1[k]! - i2[k]!;
      zi[k] = i1[k]! + r2[k]!;
      zr[m] = r1[k]! + i2[k]!;
      zi[m] = r2[k]! - i1[k]!;
    }
    fft.transform(zr, zi, true);
    x1.set(zr);
    x2.set(zi);
  }

  /**
   * 交还内核槽位。不调就是泄漏 —— 一个 worker 里只有 6 个槽（`moon/session.mbt`），
   * 池满之后所有 `Pair` 会静默退回参照实现，慢得莫名其妙。走参照实现时它什么也不做。
   */
  dispose(): void {
    this.slot?.close();
  }
}

import type { Samples } from "./arrays";
import { fftBuffers, mustKernel, openSlot, planOf, realIfft, type Dsp, type Plan, type Slot } from "./dsp";

/**
 * 短时变换的宿主侧骨架。
 *
 * 这里**没有一条数值式子**：变换、反变换、单边谱翻转都在内核里（`moon/fft.mbt`），
 * 窗函数直接取内核表组里的那一张（`planOf(dsp, win).hann()`）。宿主原先自己建了汉宁窗表
 * 与一张旋转因子表（`app/lib/fft.ts` 的 `FFT` 类），那两份与内核里的是同一条式子 ——
 * 于是「内核做变换时用的窗」与「宿主加权时用的窗」有一天会悄悄分家，症状是数值对不上
 * 却谁都没改过错。现在它们物理上是同一张表。
 *
 * **一个 `Frames` 占内核的一个会话槽，用完必须 `close()`**（`moon/session.mbt` 里只有 6 个
 * 槽，忘了还会在别处开槽时当场抛 —— 这是好事，漏还不会变成「越跑越慢」）。
 * `data()` / `window()` 每次**现切视图**，所以 **`await` 之后必须重新取一次**：等待期间
 * 另一个作业可能 `memory.grow`，把先前切出的视图整片 detach 掉（数据没搬家、地址还在，
 * 但旧视图的 `byteLength` 变成 0）。往 detach 掉的视图里写是**静默丢弃**，不会报错。
 */
export class Frames {
  /** 单边谱行数（含 DC 与奈奎斯特）。 */
  readonly bins: number;
  readonly size: number;
  private readonly dsp: Dsp;
  private readonly slot: Slot;
  private readonly plan: Plan;
  private closed = false;

  constructor(size: number) {
    this.size = size;
    this.dsp = mustKernel();
    this.slot = openSlot(this.dsp, size);
    this.plan = planOf(this.dsp, size);
    this.bins = size / 2 + 1;
  }

  /** 现切的两半视图（实部、虚部）。**`await` 之后要重新调一次**，见文件头。 */
  data(): { re: Float64Array; im: Float64Array } {
    if (this.closed) throw new Error("这一帧的工作区已经还给内核了");
    return fftBuffers(this.slot);
  }

  /** 窗函数（内核表组里的那一张，只读）。同样只在同一个同步块内有效。 */
  window(): Float64Array {
    return this.plan.hann();
  }

  /** 加窗 + 正变换。`x` 是补零对齐过的缓冲，帧从 `start` 起算。 */
  analyse(x: Float64Array, start: number): void {
    const { re, im } = this.data();
    const win = this.window();
    for (let m = 0; m < this.size; m++) {
      re[m] = x[start + m]! * win[m]!;
      im[m] = 0;
    }
    this.dsp.kernel.dsp_fft(this.slot.id);
  }

  /** 单边谱 → 反变换 → 按窗加权叠接进 `acc`（往 `acc[start…]` 上累加）。 */
  add(acc: Float64Array, start: number): void {
    realIfft(this.dsp, this.slot, this.bins);
    const { re } = this.data();
    const win = this.window();
    for (let m = 0; m < this.size; m++) acc[start + m] = acc[start + m]! + re[m]! * win[m]!;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.slot.close();
    }
  }
}

/** 某个窗长的汉宁窗，取内核表组里的那一张（只读，别改）。 */
export const hannOf = (dsp: Dsp, win: number): Float64Array => planOf(dsp, win).hann();

/** 一次 STFT 的幅度与相位。补零约定与 `encode` 同一条（前面垫 `win/2`）。 */
export function stftOf(
  x: Samples,
  win: number,
  hop: number,
  frames: number,
): { mag: Float64Array; ph: Float64Array; bins: number; padded: number } {
  const core = new Frames(win);
  try {
    const bins = core.bins;
    const padded = x.length + win;
    const pad = new Float64Array(padded);
    for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;
    const mag = new Float64Array(frames * bins);
    const ph = new Float64Array(frames * bins);
    const { re, im } = core.data();
    for (let f = 0; f < frames; f++) {
      core.analyse(pad, f * hop);
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        mag[base + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
        ph[base + b] = Math.atan2(im[b]!, re[b]!);
      }
    }
    return { mag, ph, bins, padded };
  } finally {
    core.close();
  }
}

/**
 * 拿一组现成相位做一次加权叠接（WOLA）逆变换 —— 不迭代、不做一致性投影。
 *
 * 两处用同一条：产品链的消融口（`TUNE.rtisi = false`，用来量「RTISI-LA 到底贡献了什么」）
 * 与评测台的探针。写成两份的话，消融读数与探针读数会各说各话。
 */
export function olaFromPhase(
  target: Float64Array,
  phase: Float64Array,
  frames: number,
  bins: number,
  win: number,
  hop: number,
  samples: number,
): Samples {
  const core = new Frames(win);
  try {
    const padded = samples + win;
    const acc = new Float64Array(padded);
    const { re, im } = core.data();
    for (let f = 0; f < frames; f++) {
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        const m = target[base + b]!;
        re[b] = m * Math.cos(phase[base + b]!);
        im[b] = m * Math.sin(phase[base + b]!);
      }
      // `bins` 可能小于 `win/2+1`（图读回来的精确谱被行数夹过）：`bins` 之上不清零的话，
      // 上半谱会带着上一帧反变换出来的时域样本再变一次，帧 0 之后整条输出都被污染。
      for (let b = bins; b < core.bins; b++) {
        re[b] = 0;
        im[b] = 0;
      }
      core.add(acc, f * hop);
    }

    const cover = coverage(win, hop, frames, padded);
    let top = 0;
    for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
    const floor = top * 0.05;
    const y = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const c = cover[win / 2 + i]!;
      y[i] = c > floor ? acc[win / 2 + i]! / c : 0;
    }
    return y;
  } finally {
    core.close();
  }
}

/**
 * 叠接（WOLA）归一化用的覆盖包络：`cover[i] = Σ_f win[i-f·hop]²`。
 *
 * **它为什么还住在宿主**：`Σ` 的结果是一段 `padded`（= 样点数 + 窗长）长的数组，要交给
 * 宿主当普通数组用。内核要把它交出来只能新分配一段 `FixedArray` 再返回首址，而那段数组
 * **没有任何内核侧的引用**：下一次内核分配就可能把它回收掉，宿主手里的视图随即指向别处。
 * 作业区没有这个问题（段被 `job_mem` 拿着，见 arena.mbt），所以真要把它搬进内核，
 * 得走作业区那一套。目前它只在 `synthesise` 的一支里各算一次，收益不值这个界面。
 *
 * 形状与内核那套一致（同一张汉宁表、`hop` 步进），所以两边的归一化是同一件事。
 */
export const coverage = (win: number, hop: number, frames: number, padded: number): Float64Array => {
  const w = hannOf(mustKernel(), win);
  const ww = new Float64Array(win);
  for (let m = 0; m < win; m++) ww[m] = w[m]! * w[m]!;
  const cover = new Float64Array(padded);
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    // 越界的那几格与「旧实现里写进 typed array 的越界下标」同义：丢弃，不报错。
    // 调用方给的 padded = 样点数 + 窗长，正常参数下到不了这里。
    const upto = Math.min(win, padded - s);
    for (let m = 0; m < upto; m++) cover[s + m] = cover[s + m]! + ww[m]!;
  }
  return cover;
};

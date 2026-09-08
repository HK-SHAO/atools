import type { Samples } from "./arrays";
import { FFT, hannWindow } from "./fft";
import { SR_OPTIONS, dbSpanOf, hopOf, srLabel, stepsOf, winOf, type Encode } from "./params";
import { TUNE, phaseFromMagnitude } from "./phase";
import { DEFAULT_BUDGET, rtisiLa } from "./rtisi";

/*
 * 音频 ↔ 图像，单声道。两种布局：
 *
 * 紧凑 —— 图就是频谱图本身：一像素 = 一帧一频点，只有幅度，按位深量化后走暖色 ramp。
 *   不藏相位，还原时 PGHI + RTISI-LA 迭代补回来（可靠，音乐上听感有损但零爆音）。
 *
 * 可逆 —— 两段干净分开，频谱一眼可读，相位单独一层不污染它：
 *   ┌──────────────┐ 0..bins     幅度谱：暖色 ramp（G = 层级），就是那张能看的频谱图
 *   └──────────────┘ bins..2bins  相位：R = cos(相位)、G = sin(相位)。cos/sin 在 2π 处连续，
 *                           有损重编码只平滑漂移、不会在折叠处爆成尖刺；相位彻底丢了也有
 *                           PGHI + RTISI-LA 兜底，绝不出爆音。
 */

/** 可逆图固定两段：上=幅度谱，下=相位。 */
export const BANDS = 2;

export const MIN_WIN = 256;
export const MAX_WIN = 4096;
export const MAX_FRAMES = 20000;
export const MAX_PIXELS = 8_000_000;
export const DEFAULT_SR = 44100;

/** 可逆链路固定量化窗口：压得比 16 bit 音频底噪还低。 */
const DB_MIN = -120;
const DB_MAX = 0;
const DB_SPAN = DB_MAX - DB_MIN;

/** 一次让出主线程前允许跑多久；之后再继续，保证进度条和界面一直动。 */
const SLICE_MS = 12;
/** 相位重建的时间预算：小图早就跑满轮数了，大图到这里就收。 */
const GL_BUDGET_MS = 2600;
const GL_MIN_ITERS = 8;

/** 新任务开始了，旧任务就此打住。 */
export class Aborted extends Error {
  constructor() {
    super("aborted");
    this.name = "Aborted";
  }
}

export interface Meta {
  sr: number;
  win: number;
  hop: number;
  frames: number;
  /** 写进图的行数（已按频率上限裁剪）。 */
  bins: number;
  samples: number;
  /** 幅度位深；0 表示走可逆链路。 */
  bits: number;
  /** 0 dB 参考电平（dB，相对满量程），紧凑链路的量化靠它对齐素材响度。 */
  ref: number;
  /** 是否携带相位。 */
  exact: boolean;
}

export interface Spectrum {
  /** 幅度层级：紧凑模式 ≤8 位为 Uint8Array（0..255），16 位为 Uint16Array（0..65535）。 */
  levels: Uint8Array | Uint16Array;
  /** 相位以 cos/sin 两段存（0..255，各 = (·*0.5+0.5)*255）。
   *  比 MSB/LSB 抗压缩：相位在 2π 处折叠时，cos/sin 是连续的，有损重编码不会在折叠处爆成尖刺。 */
  phaseCos: Uint8Array | null;
  phaseSin: Uint8Array | null;
  meta: Meta;
}

export interface Shape {
  win: number;
  hop: number;
  frames: number;
  bins: number;
  samples: number;
}

export const yieldToUi = (): Promise<void> => new Promise(done => setTimeout(done, 0));

const pow2 = (n: number): number => {
  let v = MIN_WIN;
  while (v < n && v < MAX_WIN) v *= 2;
  return v;
};

export const clampWin = pow2;

/** 频率上限 → 实际写进图的行数。 */
export function rowsFor(win: number, sr: number, fmax: number): number {
  const full = win / 2 + 1;
  if (fmax <= 0) return full;
  const perBin = sr / win;
  return Math.max(8, Math.min(full, Math.floor(fmax / perBin) + 1));
}

export function shapeFor(enc: Encode, sr: number, samples: number): Shape {
  const win = winOf(enc);
  const hop = hopOf(enc);
  const bins = rowsFor(win, sr, enc.mode === "compact" ? enc.fmax : 0);
  const frames = Math.floor(Math.max(1, samples) / hop) + 1;
  const bands = enc.mode === "exact" ? BANDS : 1;

  if (frames > MAX_FRAMES)
    throw new Error(`这段会出 ${frames} 帧，超过 ${MAX_FRAMES}：裁剪区间或调低采样率`);
  if (frames * bins * bands > MAX_PIXELS) throw new Error("频谱图太大了：调低精度或采样率");

  return { win, hop, frames, bins, samples };
}

/** 和 shapeFor 同一套判断，但不抛错：放得下返回 true。 */
function fits(enc: Encode, sr: number, samples: number): boolean {
  const bins = rowsFor(winOf(enc), sr, enc.mode === "compact" ? enc.fmax : 0);
  const frames = Math.floor(Math.max(1, samples) / hopOf(enc)) + 1;
  const bands = enc.mode === "exact" ? BANDS : 1;
  return frames <= MAX_FRAMES && frames * bins * bands <= MAX_PIXELS;
}

/**
 * 载入优先：素材超限时自动降采样率让它放得下，而不是甩错误拒载。
 * srcSamples 是裁剪后、重采样前的样本数；各候选采样率下的帧数按比例折算。
 */
export function fitEncode(
  e: Encode,
  srcSr: number,
  srcSamples: number,
): { enc: Encode; note: string | null } {
  const want = e.sr > 0 ? e.sr : srcSr;
  // 从想要的目标往下试：32k → 16k → 8k。
  const lower = (SR_OPTIONS as readonly number[])
    .filter(s => s > 0 && s < want)
    .sort((a, b) => b - a);
  for (const sr of [want, ...lower]) {
    if (fits(e, sr, Math.ceil((srcSamples * sr) / srcSr) + hopOf(e))) {
      if (sr === want) return { enc: e, note: null };
      return {
        enc: { ...e, sr, fmax: e.fmax >= sr / 2 ? 0 : e.fmax },
        note: `素材较长，采样率已自动降为 ${srLabel(sr)}；想用更高精度可先裁剪区间`,
      };
    }
  }
  // 连 8k 都放不下（超长录音）：只取放得下的前一段。
  const sr = 8000;
  const secs = Math.floor((MAX_FRAMES * hopOf(e)) / sr);
  return {
    enc: { ...e, sr, fmax: 0, end: e.start + secs },
    note: `素材过长，已降为 ${srLabel(sr)} 并只取前 ${secs} 秒`,
  };
}

/** 一段窗口化 FFT 的复用缓冲区，避免每帧新建。 */
class Frames {
  readonly bins: number;
  readonly re: Float64Array;
  readonly im: Float64Array;
  private readonly fft: FFT;
  private readonly win: Float64Array;

  constructor(readonly size: number) {
    this.fft = new FFT(size);
    this.win = hannWindow(size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.bins = size / 2 + 1;
  }

  /** 一帧的正变换：结果留在 re / im 里，调用方就地改完再 add 回去。 */
  analyse(x: Float64Array, start: number): void {
    const { re, im, win, size } = this;
    for (let m = 0; m < size; m++) {
      re[m] = x[start + m]! * win[m]!;
      im[m] = 0;
    }
    this.fft.transform(re, im);
  }

  /**
   * 镜像补齐后逆变换，乘合成窗，重叠相加进 acc。
   *
   * 分析窗和合成窗都用 w（WOLA），配 coverage 里的 Σw² 才是 STFT 的最小二乘逆：
   * 既能精确还原，也是 Griffin-Lim 需要的正交投影 —— 少了合成窗，
   * 迭代只是在做叠加平均，会停在离真解很远的局部极小。
   */
  add(acc: Float64Array, start: number): void {
    const { re, im, win, size } = this;
    im[0] = 0;
    im[this.bins - 1] = 0;
    for (let b = 1; b < this.bins - 1; b++) {
      re[size - b] = re[b]!;
      im[size - b] = -im[b]!;
    }
    this.fft.transform(re, im, true);
    for (let m = 0; m < size; m++) acc[start + m] = acc[start + m]! + re[m]! * win[m]!;
  }
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** 幅度 dB → 层级 0..255（可逆链路固定刻度）。 */
const magToLevel = (db: number): number => clampByte(Math.round(((db - DB_MIN) / DB_SPAN) * 255));
const levelToMagDb = (level: number): number => DB_MIN + (level / 255) * DB_SPAN;

/** 层级（0..255 或 0..65535）→ dB。紧凑与可逆两套刻度。 */
export function levelToDb(level: number, meta: Meta): number {
  if (meta.exact) return levelToMagDb(level);
  const bits = Math.max(1, meta.bits);
  if (bits >= 16) {
    const span = dbSpanOf(bits);
    return meta.ref - span + (level / 65535) * span;
  }
  const steps = stepsOf(bits);
  const q = Math.round((level * steps) / 255);
  return meta.ref - dbSpanOf(bits) + (q / steps) * dbSpanOf(bits);
}

/** 幅度 → 层级（0..255）。 */
function quantize(mag: number, scale: number, floorDb: number, span: number, steps: number): number {
  if (mag <= 0) return 0;
  const db = 20 * Math.log10(mag / scale);
  const q = Math.round(((db - floorDb) / span) * steps);
  if (q <= 0) return 0;
  if (q >= steps) return 255;
  return Math.round((q * 255) / steps);
}

export async function encode(
  pcm: Samples,
  sr: number,
  enc: Encode,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
): Promise<Spectrum> {
  const { win, hop, frames, bins, samples } = shapeFor(enc, sr, pcm.length);
  const core = new Frames(win);
  const full = core.bins;
  const padded = samples + win;
  const x = new Float64Array(padded);
  for (let i = 0; i < samples; i++) x[win / 2 + i] = pcm[i]!;

  const meta: Meta = { sr, win, hop, frames, bins, samples, bits: 0, ref: 0, exact: false };
  const scale = win / 4;
  let next = 0;

  if (enc.mode === "exact") {
    meta.exact = true;
    const levels = new Uint8Array(frames * bins);
    const phaseCos = new Uint8Array(frames * bins);
    const phaseSin = new Uint8Array(frames * bins);

    for (let f = 0; f < frames; f++) {
      core.analyse(x, f * hop);
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        const re = core.re[b]!;
        const im = core.im[b]!;
        const db = 20 * Math.log10(Math.sqrt(re * re + im * im) / scale);
        levels[base + b] = magToLevel(db);
        // 相位存成 cos/sin，抗压缩：有损重编码后仍能平滑解码出相位，不爆尖刺。
        const a = Math.atan2(im, re);
        phaseCos[base + b] = clampByte(((Math.cos(a) * 0.5 + 0.5) * 255) | 0);
        phaseSin[base + b] = clampByte(((Math.sin(a) * 0.5 + 0.5) * 255) | 0);
      }
      if (Date.now() >= next) {
        if (alive && !alive()) throw new Aborted();
        onProgress?.((f + 1) / frames);
        await yieldToUi();
        next = Date.now() + SLICE_MS;
      }
    }
    return { meta, levels, phaseCos, phaseSin };
  }

  const bits = Math.max(1, enc.bits);
  const span = dbSpanOf(bits);
  const steps = stepsOf(bits);
  meta.bits = bits;

  // 先抽样几帧估出谱峰，用它当 0 dB 参考 —— 安静的素材才不会全挤在最底下几级。
  let peak = 0;
  const stride = Math.max(1, Math.floor(frames / 240));
  for (let f = 0; f < frames; f += stride) {
    core.analyse(x, f * hop);
    for (let b = 0; b < bins; b++) {
      const re = core.re[b]!;
      const im = core.im[b]!;
      const m = Math.sqrt(re * re + im * im);
      if (m > peak) peak = m;
    }
  }
  meta.ref = peak > 0 ? 20 * Math.log10(peak / scale) + 1 : 0;
  const floorDb = meta.ref - span;

  // 16 位色深：幅度直接量化到 0..65535，走 16 位灰度 PNG（绕过 8 位 canvas）。
  if (bits >= 16) {
    const levels = new Uint16Array(frames * bins);
    for (let f = 0; f < frames; f++) {
      core.analyse(x, f * hop);
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        const m = Math.sqrt(core.re[b]! * core.re[b]! + core.im[b]! * core.im[b]!);
        const db = 20 * Math.log10(m / scale);
        const v = ((db - floorDb) / span) * 65535;
        levels[base + b] = v <= 0 ? 0 : v >= 65535 ? 65535 : Math.round(v);
      }
      if (Date.now() >= next) {
        if (alive && !alive()) throw new Aborted();
        onProgress?.((f + 1) / frames);
        await yieldToUi();
        next = Date.now() + SLICE_MS;
      }
    }
    return { meta, levels, phaseCos: null, phaseSin: null };
  }

  const levels = new Uint8Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    core.analyse(x, f * hop);
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      const re = core.re[b]!;
      const im = core.im[b]!;
      levels[base + b] = quantize(Math.sqrt(re * re + im * im), scale, floorDb, span, steps);
    }
    if (Date.now() >= next) {
      if (alive && !alive()) throw new Aborted();
      onProgress?.((f + 1) / frames);
      await yieldToUi();
      next = Date.now() + SLICE_MS;
    }
  }

  return { meta, levels, phaseCos: null, phaseSin: null };
}

/**
 * 每个样本被多少个窗"压"过 —— 注意是 w²，不是 w。
 *
 * 逆变换重叠相加得到的是 Σ w·(w·x) = x·Σw²，所以只能拿 Σw² 去除。
 * 这一步同时是 STFT 的最小二乘逆：Griffin-Lim 的每一次投影都靠它，
 * 除错了就只是在 OLA 求和，迭代会卡在一个离真解很远的局部极小里。
 */
const coverage = (win: number, hop: number, frames: number, padded: number): Float64Array => {
  const w = hannWindow(win);
  const cover = new Float64Array(padded);
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    for (let m = 0; m < win; m++) cover[s + m] = cover[s + m]! + w[m]! * w[m]!;
  }
  return cover;
};

/** 可逆链路：幅度谱 + 相位都在，直接逆变换。 */
/** 可逆链路：幅度谱 + 相位都在，直接逆变换。存下的相位已是最优估计，不做迭代。 */
async function synthesiseExact(
  spec: Spectrum,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
): Promise<Samples> {
  const { meta, levels, phaseCos, phaseSin } = spec;
  if (!phaseCos || !phaseSin) return invert(spec, alive, onProgress);
  const { win, hop, bins, frames, samples } = meta;
  const core = new Frames(win);
  const padded = samples + win;
  const acc = new Float64Array(padded);
  const scale = win / 4;

  let next = 0;
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      const m = Math.pow(10, levelToMagDb(levels[base + b]!) / 20) * scale;
      const c = (phaseCos[base + b]! - 127.5) / 127.5;
      const s = (phaseSin[base + b]! - 127.5) / 127.5;
      const a = Math.atan2(s, c);
      core.re[b] = m * Math.cos(a);
      core.im[b] = m * Math.sin(a);
    }
    core.add(acc, f * hop);
    if (Date.now() >= next) {
      if (alive && !alive()) throw new Aborted();
      onProgress?.((f + 1) / frames);
      await yieldToUi();
      next = Date.now() + SLICE_MS;
    }
  }

  const cover = coverage(win, hop, frames, padded);
  let peak = 0;
  for (let i = 0; i < padded; i++) if (cover[i]! > peak) peak = cover[i]!;
  const floor = peak * 0.05;

  const out = new Float32Array(samples);
  const pad = win / 2;
  for (let i = 0; i < samples; i++) {
    const c = cover[pad + i]!;
    out[i] = c > floor ? acc[pad + i]! / c : 0;
  }
  return out;
}

/** 层级数组 → 目标幅度（绝对刻度，跟 encode 里的 scale 对齐）。 */
function targetOf(spec: Spectrum, scale: number): Float64Array {
  const { meta, levels } = spec;
  const out = new Float64Array(meta.frames * meta.bins);
  for (let i = 0; i < out.length; i++)
    out[i] = Math.pow(10, levelToDb(levels[i]!, meta) / 20) * scale;
  return out;
}

/** 收尾：去掉两侧窗沿，钳住峰值防削波；并在首尾加一小段等功率淡入/淡出，
 *  保证无论如何（相位在边界连不连续、或重建带了点起始瞬态）都不会爆音。
 *  淡出长度只有窗宽的零头，听感上几乎无感。 */
function finish(x: Float64Array, win: number, samples: number): Samples {
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const v = Math.abs(x[win / 2 + i]!);
    if (v > peak) peak = v;
  }
  const gain = peak > 0.99 ? 0.99 / peak : 1;
  const fade = Math.min(samples, Math.max(64, Math.floor(win / 4)));
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    let g = 1;
    if (i < fade) g *= Math.sin((Math.PI / 2) * (i / fade));
    else if (i > samples - fade) g *= Math.sin((Math.PI / 2) * ((samples - i) / fade));
    out[i] = x[win / 2 + i]! * gain * g;
  }
  return out;
}

/**
 * 带动量的 Griffin-Lim，就地打磨 x。
 *
 * 每一步把幅度投影回目标值，再沿上一步的方向多走一点（Nesterov）——
 * 比标准 GL 收敛快一个量级。x 是 padded 缓冲，帧 f 覆盖 [f·hop, f·hop+win)。
 */
async function glRefine(
  x: Float64Array,
  target: Float64Array,
  spec: Spectrum,
  iters: number,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
  budgetMs: number = GL_BUDGET_MS,
): Promise<void> {
  const { meta } = spec;
  const { win, hop, bins, frames, samples } = meta;
  const core = new Frames(win);
  const full = core.bins;
  const padded = samples + win;
  const acc = new Float64Array(padded);
  const prevRe = new Float32Array(frames * full);
  const prevIm = new Float32Array(frames * full);

  const cover = coverage(win, hop, frames, padded);
  let top = 0;
  for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
  const floor = top * 0.05;

  const deadline = Date.now() + budgetMs;
  let next = 0;

  for (let it = 0; it < iters; it++) {
    acc.fill(0);
    for (let f = 0; f < frames; f++) {
      const base = f * bins;
      const at = f * full;
      core.analyse(x, f * hop);
      for (let b = 0; b < full; b++) {
        const m = b < bins ? target[base + b]! : 0;
        const cr = core.re[b]!;
        const ci = core.im[b]!;
        const d = Math.sqrt(cr * cr + ci * ci) || 1e-30;
        const pr = (cr / d) * m;
        const pi = (ci / d) * m;

        let nr = pr;
        let ni = pi;
        if (it > 0) {
          nr += TUNE.momentum * (pr - prevRe[at + b]!);
          ni += TUNE.momentum * (pi - prevIm[at + b]!);
        }
        prevRe[at + b] = pr;
        prevIm[at + b] = pi;
        core.re[b] = nr;
        core.im[b] = ni;
      }
      core.add(acc, f * hop);
    }
    for (let i = 0; i < padded; i++) x[i] = cover[i]! > floor ? acc[i]! / cover[i]! : 0;

    onProgress?.((it + 1) / iters);
    if (Date.now() >= next) {
      if (alive && !alive()) throw new Aborted();
      await yieldToUi();
      next = Date.now() + SLICE_MS;
    }
    if (it + 1 >= GL_MIN_ITERS && Date.now() > deadline) break;
  }
}

/**
 * RTISI-LA 逐帧反演（紧凑模式的默认路径，也是可逆图丢了相位时的兜底）。
 *
 * 先让 PGHI 给每一帧一个初始相位（从幅度一次解出，比随机起步少一到两个数量级迭代），
 * RTISI-LA 再一帧一帧往前推：每帧都带着后面 K 帧一起迭代，跟过去和未来都自洽了才定稿。
 * 收尾可选几轮全局 GL 打磨。PGHI 起的步 + RTISI-LA 的逐帧迭代，全程零爆音。
 */
async function invert(
  spec: Spectrum,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
  fine = false,
): Promise<Samples> {
  const { meta } = spec;
  const { win, hop, bins, frames, samples } = meta;
  const scale = win / 4;
  const target = targetOf(spec, scale);
  const padded = samples + win;

  const warm = TUNE.pghi ? phaseFromMagnitude(target, frames, bins, win, hop) : null;
  let next = 0;
  const y = await rtisiLa(target, frames, bins, win, hop, samples, {
    iters: fine ? TUNE.fine.rtisiIters : TUNE.rtisiIters,
    budget: fine ? TUNE.fine.rtisiBudget : DEFAULT_BUDGET,
    warm,
    tick: (m, total) => {
      if (Date.now() < next) return;
      if (alive && !alive()) throw new Aborted();
      onProgress?.(m / total);
      return (async () => {
        await yieldToUi();
        next = Date.now() + SLICE_MS;
      })();
    },
  });

  const x = new Float64Array(padded);
  for (let i = 0; i < samples; i++) x[win / 2 + i] = y[i]!;
  // 全局打磨：RTISI-LA 逐帧定稿后，再整体回头补几轮，把帧间的残余不一致抹平。
  // 精修档始终打磨（算力给足），快速档按调参口决定。
  if (fine || TUNE.rtisiGl > 0)
    await glRefine(
      x,
      target,
      spec,
      fine ? TUNE.fine.glIters : TUNE.rtisiGl,
      alive,
      onProgress,
      fine ? TUNE.fine.glBudgetMs : undefined,
    );
  return finish(x, win, samples);
}

/**
 * 还原质量档：
 *   fast —— 默认。迭代与预算按「交互不卡顿」给，零爆音，大多数场景够用。
 *   fine —— 只对没有存相位的图（紧凑 / 降级 / 陌生）有意义：同一套算法，
 *           算力给足（更多 RTISI 迭代、更大前瞻预算、收尾全局 GL 打磨）。
 *           带相位的可逆图不需要精修 —— 直逆已实测最优，按钮也不出现。
 */
export type Quality = "fast" | "fine";

export async function synthesise(
  spec: Spectrum,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
  quality: Quality = "fast",
): Promise<Samples> {
  const { meta, phaseCos, phaseSin } = spec;
  // 只要带着相位段（无论容器是否有损、图是否被缩放过），就直接逆变换——
  // cos/sin 在有损重编码下只平滑漂移，比退回迭代噪声小得多、也不爆音。
  // 实测（q=12/24 JPEG 模拟）：直逆 0.988/0.983，优于 GL 精修（0.975/0.960）
  // 和 RTISI 暖启动（0.776/0.828）—— 存下的相位本身就是最优估计，无需也不应再迭代。
  if (meta.exact && phaseCos && phaseSin) return synthesiseExact(spec, alive, onProgress);
  // 否则（紧凑图，或相位彻底丢失的图）：PGHI 起手 + RTISI-LA 反演，零爆音。
  // 精修档在这里才有用武之地：算力给足，相位估得更准。
  return invert(spec, alive, onProgress, quality === "fine");
}

/** 陌生/被改过的图 → 参数。bits/exact 沿用调用方给的口径。 */
export function paramsForImage(
  frames: number,
  rows: number,
  sr: number,
  bits: number,
  ref: number,
  exact: boolean,
): Meta {
  const clamped = Math.max(2, Math.min(rows, MAX_WIN / 2 + 1));
  const win = pow2(2 * (clamped - 1));
  const bins = Math.min(clamped, win / 2 + 1);
  const hop = Math.max(1, Math.round(win / 4));
  const count = Math.max(1, Math.min(frames, MAX_FRAMES));
  return { sr, win, hop, frames: count, bins, samples: count * hop, bits, ref, exact };
}

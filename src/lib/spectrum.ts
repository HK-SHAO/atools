import type { Samples } from "./arrays";
import { FFT, hannWindow, mirrorSpectrum } from "./fft";
import { SR_OPTIONS, dbSpanOf, hopOf, stepsOf, winOf, type Encode } from "./params";
import { TUNE, phaseFromMagnitude } from "./phase";
import { DEFAULT_BUDGET, rtisiLa } from "./rtisi";

export const BANDS = 2;

export const MIN_WIN = 256;
export const MAX_WIN = 4096;
export const MAX_FRAMES = 20000;
export const MAX_PIXELS = 8_000_000;
export const DEFAULT_SR = 44100;

const DB_MIN = -120;
const DB_MAX = 0;
const DB_SPAN = DB_MAX - DB_MIN;

export const SYNTH_TUNE = { phaseDeadZone: 0.1 };

const SLICE_MS = 12;

const GL_BUDGET_MS = 2600;
const GL_MIN_ITERS = 8;

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

  bins: number;
  samples: number;

  bits: number;

  ref: number;

  exact: boolean;
}

export interface Spectrum {

  levels: Uint8Array | Uint16Array;

  phaseCos: Uint8Array | null;
  phaseSin: Uint8Array | null;

  // 读图端才有：逐 bin 相位置信度（0-255，圆矢量长度）；weak = 低于强保留阈值、
  // 只作锚定参考不作真值。
  phaseW?: Uint8Array | null;
  phaseWeak?: boolean;

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

  if (frames > MAX_FRAMES) throw new Error("音频太长，图放不下：剪短一点，或调低采样率");
  if (frames * bins * bands > MAX_PIXELS)
    throw new Error("图太大了：把「窗长」或「采样率」调低一些");

  return { win, hop, frames, bins, samples };
}

function fits(enc: Encode, sr: number, samples: number): boolean {
  const bins = rowsFor(winOf(enc), sr, enc.mode === "compact" ? enc.fmax : 0);
  const frames = Math.floor(Math.max(1, samples) / hopOf(enc)) + 1;
  const bands = enc.mode === "exact" ? BANDS : 1;
  return frames <= MAX_FRAMES && frames * bins * bands <= MAX_PIXELS;
}

export function fitEncode(
  e: Encode,
  srcSr: number,
  srcSamples: number,
): { enc: Encode; note: string | null } {
  const want = e.sr > 0 ? e.sr : srcSr;
  const lower = (SR_OPTIONS as readonly number[])
    .filter(s => s > 0 && s < want)
    .sort((a, b) => b - a);
  for (const sr of [want, ...lower]) {
    if (fits(e, sr, Math.ceil((srcSamples * sr) / srcSr) + hopOf(e))) {
      if (sr === want) return { enc: e, note: null };
      return {
        enc: { ...e, sr, fmax: e.fmax >= sr / 2 ? 0 : e.fmax },
        note: "音频较长，已自动调低采样率；想更清晰可先剪短",
      };
    }
  }
  const sr = 8000;
  const secs = Math.floor((MAX_FRAMES * hopOf(e)) / sr);
  return {
    enc: { ...e, sr, fmax: 0, end: e.start + secs },
    note: `音频太长，只保留前 ${secs} 秒`,
  };
}

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

  analyse(x: Float64Array, start: number): void {
    const { re, im, win, size } = this;
    for (let m = 0; m < size; m++) {
      re[m] = x[start + m]! * win[m]!;
      im[m] = 0;
    }
    this.fft.transform(re, im);
  }

  add(acc: Float64Array, start: number): void {
    const { re, im, win, size } = this;
    mirrorSpectrum(re, im, this.bins, size);
    this.fft.transform(re, im, true);
    for (let m = 0; m < size; m++) acc[start + m] = acc[start + m]! + re[m]! * win[m]!;
  }
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

const magToLevel = (db: number): number => clampByte(Math.round(((db - DB_MIN) / DB_SPAN) * 255));
const levelToMagDb = (level: number): number => DB_MIN + (level / 255) * DB_SPAN;

export function levelToDb(level: number, meta: Meta): number {
  if (meta.exact) return levelToMagDb(level);
  const bits = Math.max(1, meta.bits);
  const steps = stepsOf(bits);
  const q = Math.round((level * steps) / 255);
  return meta.ref - dbSpanOf(bits) + (q / steps) * dbSpanOf(bits);
}

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
        const a = Math.atan2(im, re);
        phaseCos[base + b] = clampByte(Math.round((Math.cos(a) * 0.5 + 0.5) * 255));
        phaseSin[base + b] = clampByte(Math.round((Math.sin(a) * 0.5 + 0.5) * 255));
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

const coverage = (win: number, hop: number, frames: number, padded: number): Float64Array => {
  const w = hannWindow(win);
  const cover = new Float64Array(padded);
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    for (let m = 0; m < win; m++) cover[s + m] = cover[s + m]! + w[m]! * w[m]!;
  }
  return cover;
};

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
  const holdC = new Float64Array(bins).fill(1);
  const holdS = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      const m = Math.pow(10, levelToMagDb(levels[base + b]!) / 20) * scale;
      const cr = (phaseCos[base + b]! - 127.5) / 127.5;
      const cs = (phaseSin[base + b]! - 127.5) / 127.5;
      const h = Math.sqrt(cr * cr + cs * cs);
      let c: number;
      let s: number;
      if (h > SYNTH_TUNE.phaseDeadZone) {
        c = cr / h;
        s = cs / h;
        holdC[b] = c;
        holdS[b] = s;
      } else {
        c = holdC[b]!;
        s = holdS[b]!;
      }
      core.re[b] = m * c;
      core.im[b] = m * s;
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

function targetOf(spec: Spectrum, scale: number): Float64Array {
  const { meta, levels } = spec;
  const out = new Float64Array(meta.frames * meta.bins);
  for (let i = 0; i < out.length; i++)
    out[i] = Math.pow(10, levelToDb(levels[i]!, meta) / 20) * scale;
  return out;
}

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

export interface Anchor {
  cos: Uint8Array;
  sin: Uint8Array;
  w: Uint8Array;
}

async function glRefine(
  x: Float64Array,
  target: Float64Array,
  spec: Spectrum,
  iters: number,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
  budgetMs: number = GL_BUDGET_MS,
  anchor?: Anchor | null,
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
        let pr = (cr / d) * m;
        let pi = (ci / d) * m;

        // 锚定投影：向存储相位凸混合，权 = 逐 bin 置信度 × 全局强度。
        // 等价于最小化 ‖|STFT x|−A‖² + λΣw·(1−cos∠(x,φ_ref)) 的交替步。
        if (anchor && b < bins) {
          const wv = (anchor.w[base + b]! / 255) * TUNE.anchorLambda;
          if (wv > 0.01) {
            const ar = ((anchor.cos[base + b]! - 127.5) / 127.5) * m;
            const ai = ((anchor.sin[base + b]! - 127.5) / 127.5) * m;
            const ah = Math.sqrt(ar * ar + ai * ai) || 1e-30;
            pr += wv * ((ar / ah) * m - pr);
            pi += wv * ((ai / ah) * m - pi);
          }
        }

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
  const anchor: Anchor | null =
    fine && spec.phaseCos && spec.phaseSin && spec.phaseW
      ? { cos: spec.phaseCos, sin: spec.phaseSin, w: spec.phaseW }
      : null;
  if (fine || TUNE.rtisiGl > 0)
    await glRefine(
      x,
      target,
      spec,
      fine ? TUNE.fine.glIters : TUNE.rtisiGl,
      alive,
      onProgress,
      fine ? TUNE.fine.glBudgetMs : undefined,
      anchor,
    );
  return finish(x, win, samples);
}

export type Quality = "fast" | "fine";

export async function synthesise(
  spec: Spectrum,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
  quality: Quality = "fast",
): Promise<Samples> {
  const { meta, phaseCos, phaseSin } = spec;
  // 强相位直逆（最快最准）；精修档一律走可锚定的迭代路径（弱相位默认快速幅度重建）。
  if (meta.exact && phaseCos && phaseSin && !spec.phaseWeak && quality !== "fine")
    return synthesiseExact(spec, alive, onProgress);
  return invert(spec, alive, onProgress, quality === "fine");
}

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

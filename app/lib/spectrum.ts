import type { Samples } from "./arrays";
import { SR_OPTIONS, dbSpanOf, hopOf, srLabel, stepsOf, winOf, type Encode } from "./params.ts";
import { TUNE, phaseFromMagnitude } from "./phase.ts";
import { resampledLength } from "./resample.ts";
import { rtisiLa } from "./rtisi.ts";
import { Frames, coverFloor, coverage, olaFromPhase, padOf, uncovered } from "./stft.ts";

export const BANDS = 2;

const MIN_WIN = 256;
const MAX_WIN = 4096;

export const MAX_PIXELS = 16_000_000;

export const MAX_FRAMES = 65535;

export const DEFAULT_SR = 44100;

export const maxFramesFor = (bins: number, bands = 1): number =>
  Math.min(MAX_FRAMES, Math.floor(MAX_PIXELS / (bins * bands)));

const DB_MIN = -120;
const DB_MAX = 0;
const DB_SPAN = DB_MAX - DB_MIN;
const DB_TO_LIN = Math.LN10 / 20;

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
  levels: Uint8Array;

  phaseCos: Uint8Array | null;
  phaseSin: Uint8Array | null;

  phaseW?: Uint8Array | null;
  phaseWeak?: boolean;

  meta: Meta;
}

interface Shape {
  win: number;
  hop: number;
  frames: number;
  bins: number;
  samples: number;
}

const yieldToUi = (): Promise<void> => new Promise(done => setTimeout(done, 0));

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

export const cutoffOf = (enc: Encode): number => (enc.mode === "compact" ? enc.fmax : 0);

interface Plan {
  win: number;
  hop: number;
  bins: number;
  bands: number;
}

const planOf = (enc: Encode, sr: number): Plan => {
  const win = winOf(enc);
  return {
    win,
    hop: hopOf(enc),
    bins: rowsFor(win, sr, cutoffOf(enc)),
    bands: enc.mode === "exact" ? BANDS : 1,
  };
};

export function shapeFor(enc: Encode, sr: number, samples: number): Shape {
  const { win, hop, bins, bands } = planOf(enc, sr);
  const frames = Math.floor(Math.max(1, samples) / hop) + 1;

  if (frames > maxFramesFor(bins, bands)) throw new Error("音频太长，图放不下：调低采样率，或剪短一点");

  return { win, hop, frames, bins, samples };
}

function fits(enc: Encode, sr: number, samples: number): boolean {
  const { hop, bins, bands } = planOf(enc, sr);
  return Math.floor(Math.max(1, samples) / hop) + 1 <= maxFramesFor(bins, bands);
}

function ceilingOf(enc: Encode, sr: number): number {
  const { hop, bins, bands } = planOf(enc, sr);
  return Math.floor(((maxFramesFor(bins, bands) - 1) * hop) / sr);
}

export function fitEncode(
  e: Encode,
  srcSr: number,
  srcSamples: number,
): { enc: Encode; note: string | null } {
  const want = e.sr > 0 ? e.sr : srcSr;
  const at = (sr: number): number => resampledLength(srcSamples, srcSr, sr);
  if (fits(e, want, at(want))) return { enc: e, note: null };

  const secs = Math.round(srcSamples / srcSr);
  const lower = (SR_OPTIONS as readonly number[])
    .filter(s => s > 0 && s < want)
    .sort((a, b) => b - a);
  for (const sr of lower) {
    if (fits(e, sr, at(sr)))
      return {
        enc: { ...e, sr, fmax: e.fmax >= sr / 2 ? 0 : e.fmax },
        note: `音频 ${secs} 秒超出 ${srLabel(want)} 的上限 ${ceilingOf(e, want)} 秒，已降到 ${srLabel(sr)}`,
      };
  }

  const last: Encode = { ...e, sr: 8000, fmax: 0 };
  const keep = Math.max(1, ceilingOf(last, 8000));
  return {
    enc: { ...last, end: e.start + keep },
    note: `音频太长，只保留前 ${keep} 秒`,
  };
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

const magToLevel = (db: number): number => clampByte(Math.round(((db - DB_MIN) / DB_SPAN) * 255));
const levelToMagDb = (level: number): number => DB_MIN + (level / 255) * DB_SPAN;

function levelToDb(level: number, meta: Meta): number {
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
  try {
    const x = padOf(pcm, win);

    const meta: Meta = { sr, win, hop, frames, bins, samples, bits: 0, ref: 0, exact: false };
    const scale = win / 4;
    let next = 0;

    if (enc.mode === "exact") {
      meta.exact = true;
      const levels = new Uint8Array(frames * bins);
      const phaseCos = new Uint8Array(frames * bins);
      const phaseSin = new Uint8Array(frames * bins);

      let { re, im } = core.data();
      for (let f = 0; f < frames; f++) {
        core.analyse(x, f * hop);
        const base = f * bins;
        for (let b = 0; b < bins; b++) {
          const r = re[b]!;
          const c = im[b]!;
          const h = Math.sqrt(r * r + c * c);
          levels[base + b] = magToLevel(20 * Math.log10(h / scale));
          phaseCos[base + b] = h > 0 ? clampByte(Math.round(((r / h) * 0.5 + 0.5) * 255)) : 255;
          phaseSin[base + b] = h > 0 ? clampByte(Math.round(((c / h) * 0.5 + 0.5) * 255)) : 128;
        }
        if (Date.now() >= next) {
          if (alive && !alive()) throw new Aborted();
          onProgress?.((f + 1) / frames);
          await yieldToUi();
          ({ re, im } = core.data());
          next = Date.now() + SLICE_MS;
        }
      }
      return { meta, levels, phaseCos, phaseSin };
    }

    const bits = Math.max(1, enc.bits);
    const span = dbSpanOf(bits);
    const steps = stepsOf(bits);
    meta.bits = bits;

    {
      let { re, im } = core.data();
      let peak = 0;
      const stride = Math.max(1, Math.floor(frames / 240));
      for (let f = 0; f < frames; f += stride) {
        core.analyse(x, f * hop);
        for (let b = 0; b < bins; b++) {
          const r = re[b]!;
          const c = im[b]!;
          const m = Math.sqrt(r * r + c * c);
          if (m > peak) peak = m;
        }
      }
      meta.ref = peak > 0 ? 20 * Math.log10(peak / scale) + 1 : 0;
    }
    const floorDb = meta.ref - span;

    const levels = new Uint8Array(frames * bins);
    let { re, im } = core.data();
    for (let f = 0; f < frames; f++) {
      core.analyse(x, f * hop);
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        const r = re[b]!;
        const c = im[b]!;
        levels[base + b] = quantize(Math.sqrt(r * r + c * c), scale, floorDb, span, steps);
      }
      if (Date.now() >= next) {
        if (alive && !alive()) throw new Aborted();
        onProgress?.((f + 1) / frames);
        await yieldToUi();
        ({ re, im } = core.data());
        next = Date.now() + SLICE_MS;
      }
    }

    return { meta, levels, phaseCos: null, phaseSin: null };
  } finally {
    core.close();
  }
}

async function synthesiseExact(
  spec: Spectrum,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
): Promise<Samples> {
  const { meta, levels, phaseCos, phaseSin } = spec;
  if (!phaseCos || !phaseSin) return invert(spec, alive, onProgress);
  const { win, hop, bins, frames, samples } = meta;
  const core = new Frames(win);
  try {
    const padded = samples + win;
    const acc = new Float64Array(padded);
    const scale = win / 4;

    let next = 0;
    const holdC = new Float64Array(bins).fill(1);
    const holdS = new Float64Array(bins);
    let { re, im } = core.data();
    for (let f = 0; f < frames; f++) {
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        const m = Math.exp(levelToMagDb(levels[base + b]!) * DB_TO_LIN) * scale;
        const cr = (phaseCos[base + b]! - 127.5) / 127.5;
        const cs = (phaseSin[base + b]! - 127.5) / 127.5;
        const h = Math.sqrt(cr * cr + cs * cs);
        let c: number;
        let s: number;
        if (h > TUNE.deadZone) {
          c = cr / h;
          s = cs / h;
          holdC[b] = c;
          holdS[b] = s;
        } else {
          c = holdC[b]!;
          s = holdS[b]!;
        }
        re[b] = m * c;
        im[b] = m * s;
      }
      for (let b = bins; b < core.bins; b++) {
        re[b] = 0;
        im[b] = 0;
      }
      core.add(acc, f * hop);
      if (Date.now() >= next) {
        if (alive && !alive()) throw new Aborted();
        onProgress?.((f + 1) / frames);
        await yieldToUi();
        ({ re, im } = core.data());
        next = Date.now() + SLICE_MS;
      }
    }

    return uncovered(acc, coverage(win, hop, frames, padded), win / 2, samples);
  } finally {
    core.close();
  }
}

function targetOf(spec: Spectrum, scale: number): Float64Array {
  const { meta, levels } = spec;
  const out = new Float64Array(meta.frames * meta.bins);
  for (let i = 0; i < out.length; i++)
    out[i] = Math.exp(levelToDb(levels[i]!, meta) * DB_TO_LIN) * scale;
  return out;
}

type Band = import("./rtisi").Band;

function bandOf(spec: Spectrum, scale: number): Band | null {
  const { meta, levels } = spec;
  const span = dbSpanOf(meta.bits);
  if (meta.exact || !TUNE.relaxFloor || span >= 80) return null;
  if (levels.length < meta.frames * meta.bins) return null;
  const steps = stepsOf(meta.bits);
  const floorDb = meta.ref - span;
  const lo = new Float64Array(256);
  const hi = new Float64Array(256);
  for (let lv = 0; lv < 256; lv++) {
    const q = Math.round((lv * steps) / 255);
    const c = Math.exp((floorDb + (q / steps) * span) * DB_TO_LIN) * scale;
    lo[lv] = q <= 0 ? 0 : c;
    hi[lv] = q >= steps ? Infinity : c;
  }
  return { levels, lo, hi };
}

const fitBand = (band: Band, d: number, i: number): number => {
  const lv = band.levels[i]!;
  const lo = band.lo[lv]!;
  if (d < lo) return lo;
  const hi = band.hi[lv]!;
  return d > hi ? hi : d;
};

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

interface Anchor {
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
  band?: Band | null,
): Promise<void> {
  const { meta } = spec;
  const { win, hop, bins, frames, samples } = meta;
  const core = new Frames(win);
  try {
    const full = core.bins;
    const padded = samples + win;
    const acc = new Float64Array(padded);
    const prevRe = new Float32Array(frames * full);
    const prevIm = new Float32Array(frames * full);

    const cover = coverage(win, hop, frames, padded);
    const floor = coverFloor(cover);

    const deadline = Date.now() + budgetMs;
    let next = 0;
    let { re, im } = core.data();

    for (let it = 0; it < iters; it++) {
      acc.fill(0);
      for (let f = 0; f < frames; f++) {
        const base = f * bins;
        const at = f * full;
        core.analyse(x, f * hop);
        for (let b = 0; b < full; b++) {
          const cr = re[b]!;
          const ci = im[b]!;
          const d = Math.sqrt(cr * cr + ci * ci) || 1e-30;
          const m = b >= bins ? 0 : band ? fitBand(band, d, base + b) : target[base + b]!;
          let pr = (cr / d) * m;
          let pi = (ci / d) * m;

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
          re[b] = nr;
          im[b] = ni;
        }
        core.add(acc, f * hop);
      }
      for (let i = 0; i < padded; i++) x[i] = cover[i]! > floor ? acc[i]! / cover[i]! : 0;

      onProgress?.((it + 1) / iters);
      if (Date.now() >= next) {
        if (alive && !alive()) throw new Aborted();
        await yieldToUi();
        ({ re, im } = core.data());
        next = Date.now() + SLICE_MS;
      }
      if (it + 1 >= GL_MIN_ITERS && Date.now() > deadline) break;
    }
  } finally {
    core.close();
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
  const band = bandOf(spec, scale);

  const warm = TUNE.pghi ? phaseFromMagnitude(target, frames, bins, win, hop) : null;
  const anchor: Anchor | null =
    fine && spec.phaseCos && spec.phaseSin && spec.phaseW
      ? { cos: spec.phaseCos, sin: spec.phaseSin, w: spec.phaseW }
      : null;
  let next = 0;
  const y = TUNE.rtisi
    ? await rtisiLa(target, frames, bins, win, hop, samples, {
        iters: fine ? TUNE.fine.rtisiIters : TUNE.rtisiIters,
        budget: fine ? TUNE.fine.rtisiBudget : TUNE.rtisiBudget,
        warm,
        band,
        tick: (m, total) => {
          if (Date.now() < next) return;
          if (alive && !alive()) throw new Aborted();
          onProgress?.(m / total);
          return (async () => {
            await yieldToUi();
            next = Date.now() + SLICE_MS;
          })();
        },
      })
    : olaFromPhase(
        target,
        warm ?? new Float64Array(frames * bins),
        frames,
        bins,
        win,
        hop,
        samples,
      );

  const x = padOf(y, win);
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
      band,
    );
  return finish(x, win, samples);
}

type Quality = "fast" | "fine";

export async function synthesise(
  spec: Spectrum,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
  quality: Quality = "fast",
): Promise<Samples> {
  const { meta, phaseCos, phaseSin } = spec;
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
  const count = Math.max(1, Math.min(frames, maxFramesFor(bins, exact ? BANDS : 1)));
  return { sr, win, hop, frames: count, bins, samples: count * hop, bits, ref, exact };
}

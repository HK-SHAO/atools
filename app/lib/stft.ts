import type { Samples } from "./arrays";
import { fftBuffers, mustKernel, openSlot, planOf, realIfft, type Dsp, type Plan, type Slot } from "./dsp.ts";

export class Frames {
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

  data(): { re: Float64Array; im: Float64Array } {
    if (this.closed) throw new Error("This frame's work area has already been returned to the kernel");
    return fftBuffers(this.slot);
  }

  window(): Float64Array {
    return this.plan.hann();
  }

  analyse(x: Float64Array, start: number): void {
    const { re, im } = this.data();
    const win = this.window();
    for (let m = 0; m < this.size; m++) {
      re[m] = x[start + m]! * win[m]!;
      im[m] = 0;
    }
    this.dsp.kernel.dsp_fft(this.slot.id);
  }

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

export const hannOf = (dsp: Dsp, win: number): Float64Array => planOf(dsp, win).hann();

export function padOf(x: ArrayLike<number>, win: number): Float64Array {
  const half = win / 2;
  const out = new Float64Array(x.length + win);
  for (let i = 0; i < x.length; i++) out[half + i] = x[i]!;
  return out;
}

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
      for (let b = bins; b < core.bins; b++) {
        re[b] = 0;
        im[b] = 0;
      }
      core.add(acc, f * hop);
    }

    return uncovered(acc, coverage(win, hop, frames, padded), win / 2, samples);
  } finally {
    core.close();
  }
}

export const coverage = (win: number, hop: number, frames: number, padded: number): Float64Array => {
  const w = hannOf(mustKernel(), win);
  const ww = new Float64Array(win);
  for (let m = 0; m < win; m++) ww[m] = w[m]! * w[m]!;
  const cover = new Float64Array(padded);
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    const upto = Math.min(win, padded - s);
    for (let m = 0; m < upto; m++) cover[s + m] = cover[s + m]! + ww[m]!;
  }
  return cover;
};

export function coverFloor(cover: Float64Array): number {
  let top = 0;
  for (let i = 0; i < cover.length; i++) if (cover[i]! > top) top = cover[i]!;
  return top * 0.05;
}

export function uncovered(
  acc: Float64Array,
  cover: Float64Array,
  off: number,
  len: number,
): Samples {
  const floor = coverFloor(cover);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const c = cover[off + i]!;
    out[i] = c > floor ? acc[off + i]! / c : 0;
  }
  return out;
}

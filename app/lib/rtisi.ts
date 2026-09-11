import { jobBytes, jobSlice, mustKernel } from "./dsp.ts";

export interface Band {
  levels: Uint8Array;
  lo: Float64Array;
  hi: Float64Array;
}

interface RtisiOptions {
  iters?: number;
  warm?: Float64Array | null;
  budget?: number;
  band?: Band | null;
  tick?: (m: number, frames: number) => Promise<void> | void;
}

export const DEFAULT_BUDGET = 5e7;

const PART = { mag: 0, warm: 1, y: 2, band: 4 } as const;

const BAND_ITEMS = 512;

export async function rtisiLa(
  mag: Float64Array,
  frames: number,
  bins: number,
  win: number,
  hop: number,
  samples: number,
  opts: RtisiOptions = {},
): Promise<Float64Array> {
  const dsp = mustKernel();
  const k = dsp.kernel;
  const fb = frames * bins;
  const band = opts.band ?? null;
  if (band && band.levels.length < fb)
    throw new Error(`频带表太短：${band.levels.length} < ${fb} 个元素`);
  if (opts.warm && opts.warm.length < fb) throw new Error(`相位初值太短：${opts.warm.length} < ${fb}`);

  const h = k.dsp_rtisi_open(
    frames,
    bins,
    win,
    Math.max(1, Math.round(hop)),
    samples,
    Math.max(1, opts.iters ?? 8),
    opts.warm ? 1 : 0,
    band ? 1 : 0,
    opts.budget ?? DEFAULT_BUDGET,
  );
  if (h === 0) throw new Error(`RTISI 作业开不出来：frames=${frames} win=${win} bins=${bins}`);

  try {
    const view = (which: number, len: number): Float64Array =>
      jobSlice(dsp, h, k.dsp_rtisi_off(h, which), len);
    view(PART.mag, fb).set(mag);
    if (opts.warm) view(PART.warm, fb).set(opts.warm.subarray(0, fb));
    if (band) {
      jobBytes(dsp, h, k.dsp_rtisi_levels(h, 0), fb).set(band.levels.subarray(0, fb));
      const table = view(PART.band, BAND_ITEMS);
      table.set(band.lo, 0);
      table.set(band.hi, 256);
    }

    const tick = opts.tick;
    const chunk = Math.max(1, Math.min(64, frames >>> 6));
    for (let from = 0; from < frames; from += chunk) {
      const to = Math.min(frames, from + chunk);
      k.dsp_rtisi_run(h, from, to);
      if (tick) await tick(to, frames);
    }
    k.dsp_rtisi_finish(h);
    return view(PART.y, samples).slice();
  } finally {
    k.dsp_rtisi_close(h);
  }
}

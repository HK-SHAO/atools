import { jobSlice, mustKernel } from "./dsp.ts";

export const TUNE = {
  pghi: true,
  relaxFloor: true,
  momentum: 0.99,
  gamma: 0.25645,
  tol: [0.1, 1e-10] as [number, number],
  rtisi: true,
  rtisiIters: 8,
  rtisiBudget: 5e7,
  rtisiGl: 0,
  anchorLambda: 0.85,
  deadZone: 0.1,
  fine: {
    rtisiIters: 16,
    rtisiBudget: 2e8,
    glIters: 8,
    glBudgetMs: 12_000,
  },
};

export function phaseFromMagnitude(
  mag: Float64Array,
  frames: number,
  bins: number,
  win: number,
  hop: number,
): Float64Array {
  const n = frames * bins;
  const phase = new Float64Array(n);
  if (frames < 2 || bins < 2 || hop < 1 || mag.length < n) return phase;
  const dsp = mustKernel();
  const k = dsp.kernel;
  const h = k.dsp_pghi_open(frames, bins, win, hop, TUNE.gamma, TUNE.tol[0], TUNE.tol[1]);
  if (h === 0) throw new Error(`PGHI 作业开不出来：frames=${frames} bins=${bins} win=${win}`);
  try {
    jobSlice(dsp, h, k.dsp_pghi_off(h, 0), n).set(mag.subarray(0, n));
    if (k.dsp_pghi_run(h) !== 1) throw new Error(`PGHI 拒绝了作业 ${h}`);
    phase.set(jobSlice(dsp, h, k.dsp_pghi_off(h, 1), n));
  } finally {
    k.dsp_pghi_close(h);
  }
  return phase;
}

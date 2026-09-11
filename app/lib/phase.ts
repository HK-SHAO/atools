import { jobSlice, mustKernel } from "./dsp";

export const TUNE = {
  pghi: true,
  /** 幅度投影时，最低那一档是否允许往 0 走（不再钉在噪声地板上）。见 docs/algorithms.md */
  relaxFloor: true,
  momentum: 0.99,
  gamma: 0.25645,
  tol: [0.1, 1e-10] as [number, number],
  rtisi: true,
  rtisiIters: 8,
  rtisiGl: 0,
  anchorLambda: 0.85,
  fine: {
    rtisiIters: 16,
    rtisiBudget: 2e8,
    glIters: 8,
    glBudgetMs: 12_000,
  },
};

/**
 * 幅度谱 → 相位初值（PGHI：从最响的格按局部相位梯度往外传播）。
 *
 * **实现只有内核那一份**（`moon/pghi.mbt`）。这里只是那层薄壳：幅度进 `dsp_pghi_off(h, 0)`、
 * 相位出 `dsp_pghi_off(h, 1)`，都是同一个作业区的元素偏移，加基址这一步只在 `jobSlice` 里
 * 做一次。`TUNE.gamma` / `TUNE.tol` 仍是宿主的常数，内核把它们当参数收 —— 调参的口子没有
 * 多出一条路。
 *
 * **退化输入给零相位而不是抛**：少于两帧 / 两行、`hop < 1`、幅度谱比 `frames×bins` 短时，
 * 内核在 `dsp_pghi_open` 就把它们拒了，这一层返回零相位（与搬进内核之前的行为一致）。
 * 能量为零的谱由内核自己走完并留下零相位，不是宿主的分支。
 */
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
    // `set` 而不是把视图交出去：`finally` 一关作业，那段内存就还给池子了。
    phase.set(jobSlice(dsp, h, k.dsp_pghi_off(h, 1), n));
  } finally {
    k.dsp_pghi_close(h);
  }
  return phase;
}

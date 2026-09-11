import { jobBytes, jobSlice, mustKernel } from "./dsp";

/**
 * 幅度软约束：真值落在 `[lo[lv], hi[lv]]` 里就不动它，出界才夹回来，`lv` 是**那个字节值**。
 *
 * 表是 256 项的、而不是逐元素的 `frames×bins`：
 * 量化档 `q` 只由存下来的字节决定（`q = round(lv·steps/255)`），所以「那两档边界」
 * 最多 256 组，逐元素存是白白多出两张 `frames×bins` 的表（16M 像素的素材就是 128 MB）。
 * 表由 `spectrum.ts` 的 `bandOf` 按参照语义算好、整段写进内核，内核的 `rt_fit` 只做
 * 一次字节读 + 两次表读 —— 于是同一份约束只有一条实现。
 */
export interface Band {
  /** 逐元素的量化字节，与 `spectrum.ts` 的 `levels` 是同一份。 */
  levels: Uint8Array;
  /** 256 项下界表，下标是字节值。 */
  lo: Float64Array;
  /** 256 项上界表；最高那一档是 `Infinity`（不设上界）。 */
  hi: Float64Array;
}

interface RtisiOptions {
  iters?: number;
  warm?: Float64Array | null;
  budget?: number;
  /** 幅度软约束；不给就是硬投影（钉在目标幅度上）。 */
  band?: Band | null;
  tick?: (m: number, frames: number) => Promise<void> | void;
}

export const DEFAULT_BUDGET = 5e7;

/** 主缓冲里各段的 `which`。名字贴着 `moon/rtisi.mbt` 的布局，改一处必须改两处。 */
const PART = { mag: 0, warm: 1, y: 2, band: 4 } as const;

/** 频带表在布局里的项数：256 项下界 + 256 项上界。 */
const BAND_ITEMS = 512;

/**
 * 逐帧推进的 RTISI-LA 相位重建。**实现只有内核那一份**（`moon/rtisi.mbt`）。
 *
 * 内层每次迭代要做 `act` 次反变换与 `act` 次正变换，全是**实序列**的变换，于是两两打包
 * 共用一个复变换。逆变换里 78% 的时间在 RTISI 上、其中约八成又是 FFT 本身，FFT 次数减半
 * 是唯一能压住那八成的杠杆。而搬进内核省掉的是**围着内核调用的那些 JS 循环**：
 * 中档（frames 1876、win 512、K+1 = 4、iters 8）每帧约 4.9 万个元素操作、全链九千多万个。
 *
 * 分块推进是必要的：`dsp_rtisi_run` 只处理 `[from, to)`，两块之间 `tick` 让出事件循环
 * 报进度、看取消。状态全在作业区里，所以块边界是自由的 —— 内核里没有 `await`。
 *
 * **只走紧凑档**：可逆档承诺产物逐位不变，不从这里过（见 docs/migration.md）。
 */
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
  // 表是按元素下标取的，短了内核会读到段外。参数错就当场说清楚，别让它变成一段噪声。
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
    // 地址这一步集中在 `jobSlice` / `jobBytes` 里：内核只报偏移，宿主负责加基址
    // （见 `dsp.ts` 那两条的注释 —— 自己拼 `+ off * 8` 是会砸到运行时低内存的）。
    const view = (which: number, len: number): Float64Array =>
      jobSlice(dsp, h, k.dsp_rtisi_off(h, which), len);
    view(PART.mag, fb).set(mag);
    if (opts.warm) view(PART.warm, fb).set(opts.warm.subarray(0, fb));
    if (band) {
      // `levels` 住**字节段**，偏移是段内字节偏移 —— 与主缓冲那些元素偏移不是一套坐标。
      jobBytes(dsp, h, k.dsp_rtisi_levels(h, 0), fb).set(band.levels.subarray(0, fb));
      const table = view(PART.band, BAND_ITEMS);
      table.set(band.lo, 0);
      table.set(band.hi, 256);
    }

    const tick = opts.tick;
    // 块边界取「总帧数的 1/64」：长活也有上百次进度回报，短活不会被切碎。
    const chunk = Math.max(1, Math.min(64, frames >>> 6));
    for (let from = 0; from < frames; from += chunk) {
      const to = Math.min(frames, from + chunk);
      k.dsp_rtisi_run(h, from, to);
      if (tick) await tick(to, frames);
    }
    k.dsp_rtisi_finish(h);
    // `slice()` 而不是视图本身：`finally` 一关作业，那段数组就还给池子了。
    return view(PART.y, samples).slice();
  } finally {
    k.dsp_rtisi_close(h);
  }
}

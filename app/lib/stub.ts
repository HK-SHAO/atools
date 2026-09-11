import { mustKernel, openJob } from "./dsp";

/**
 * 票根（stub）：图底部若干行的条码，把「宽 / 采样率 / 窗长 / 是否可逆」写进像素。
 *
 * **实现只有内核那一份**（`moon/stub.mbt`）—— 它是纯整数逻辑，没有 ulp 那种事，
 * 要么逐字节相同要么错。搬进去省掉的正是 JS 那种「每个像素一次循环」：内核按裸地址把
 * `w × rows` 的 RGBA 直接写进作业的字节段，这里一次 `set` 搬进 ImageData。
 *
 * 行为断言全在 `moon/stub_wbtest.mbt`；这里只剩「搬数据 + 拆打包结果」，
 * 连采样率梯子与窗长梯子都问内核要（`dsp_stub_sr` / `dsp_stub_win`）——
 * 它们是格式的一部分，存两份就等着漂移。
 */

/**
 * 票根占的像素行数。与 `moon/stub.mbt` 的 `stub_rows` 是同一个数 —— **问内核要**，
 * 不在宿主侧再写一遍：它决定票根画在图底部哪几行，两处差一个就是「画得出来、读不回来」。
 *
 * 是个函数而不是常量：模块顶层求值时内核还没挂上（挂内核在 worker 启动时）。
 */
export const stubRows = (): number => mustKernel().kernel.dsp_stub_rows();

export interface StubInfo {
  width: number;
  sr: number;
  win: number;
  exact: boolean;
}

/**
 * 拆开内核返回的打包 i32：`width | si << 16 | wi << 20 | exact << 22`，`0` = 没认出来
 * （`width ≥ 2` 保证真结果恒非 0）。下标 → 采样率 / 窗长的那两张梯子由内核给，
 * 与 `moon/stub.mbt` 里那份是同一份。
 */
const unpackStub = (packed: number): StubInfo | null => {
  if (packed === 0) return null;
  const k = mustKernel().kernel;
  return {
    width: packed & 0xffff,
    sr: k.dsp_stub_sr((packed >>> 16) & 0xf),
    win: k.dsp_stub_win((packed >>> 20) & 0x3),
    exact: ((packed >>> 22) & 1) === 1,
  };
};

export function drawStub(
  px: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  sr: number,
  win: number,
  exact: boolean,
): void {
  const dsp = mustKernel();
  const k = dsp.kernel;
  const job = openJob(dsp, 0, k.dsp_stub_paint_bytes(w));
  try {
    // 参数放不下时内核返回 0，那就什么都不画 —— 与「图太窄、没有票根的位置」同一种结果。
    if (!k.dsp_stub_paint(job.handle, w, sr, win, exact ? 1 : 0)) return;
    // 那 rows 行在块内是连续的，所以一次 `set` 就够 —— 搬进 ImageData 的底部。
    px.set(job.b(), (h - stubRows()) * w * 4);
  } finally {
    job.close();
  }
}

export function stubLuma(w: number, sr: number, win: number, exact: boolean): Uint8Array | null {
  const dsp = mustKernel();
  const k = dsp.kernel;
  const job = openJob(dsp, 0, k.dsp_stub_luma_bytes(w));
  try {
    return k.dsp_stub_luma(job.handle, w, sr, win, exact ? 1 : 0) ? job.b().slice() : null;
  } finally {
    job.close();
  }
}

export function decodeStub(profile: ArrayLike<number>): StubInfo | null {
  const dsp = mustKernel();
  const k = dsp.kernel;
  const n = profile.length;
  // 剖面太短内核自己会判（`stub_min_decode`），所以这里不复制那个门槛 —— 复制一份就会漂移，
  // 而「认得出 ⟺ 装得下」正是靠两边共用同一个数守住的（见 moon/stub.mbt）。
  const job = openJob(dsp, k.dsp_stub_decode_words(n), 0);
  try {
    job.d().set(profile);
    return unpackStub(k.dsp_stub_decode(job.handle, n));
  } finally {
    job.close();
  }
}

/** 图的宽度装得下一条**认得回来**的票根吗。纯判据，不开作业区。 */
export const stubFits = (w: number): boolean => mustKernel().kernel.dsp_stub_fits(w) === 1;

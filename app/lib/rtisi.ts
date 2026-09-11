import { FFT, coverage, hannWindow, mirrorSpectrum } from "./fft";
import { Pair } from "./pair";
import { TUNE } from "./phase";

interface RtisiOptions {
  iters?: number;
  warm?: Float64Array | null;
  budget?: number;
  /** 幅度软约束的下/上界（逐 bin）；不给就退化成硬投影（钉在目标幅度上） */
  lo?: Float64Array | null;
  hi?: Float64Array | null;
  /**
   * 两条实变换是否共用一个复变换（默认开）。关掉就是每次只变换一条（第二条喂零）。
   *
   * 它是**消融口，不是「加打包之前的逐位复现」**：正变换侧必然带上 Hermite 对称化，
   * 与老路差 ≤4 ulp（实测 ≤2.27，见 `pair.test.ts`），反变换侧才逐位相同。
   * 想量「打包值不值」就靠它两边各跑一次。
   */
  pair?: boolean;
  tick?: (m: number, frames: number) => Promise<void> | void;
}

export const DEFAULT_BUDGET = 5e7;

/**
 * 逐帧推进的 RTISI-LA 相位重建。
 *
 * 内层每次迭代要做 `act` 次反变换（把当前相位铺回波形）与 `act` 次正变换（再读回来），
 * 而它们全是**实序列**的变换 —— 于是两两打包共用一个复变换（见 `pair.ts`）。
 * 逆变换里 78% 的时间在 RTISI 上、其中约八成又是 FFT 本身，这里是唯一能压住那八成的杠杆：
 * **FFT 次数直接减半**。
 *
 * 槽位是单数时给第二条喂零、丢弃它的结果，代价与一次普通变换相同，
 * 于是不必为此留第二条代码路径。收尾那一次反变换只写槽位 0，凑不出第二条，照旧走单条复变换。
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
  const L = win;
  const a = Math.max(1, Math.round(hop));
  const R = Math.max(1, Math.round(L / a));
  let K = Math.max(0, Math.min(frames - 1, R - 1));
  let iters = Math.max(1, opts.iters ?? 8);
  const warm = opts.warm ?? null;
  const tick = opts.tick;

  const unit = frames * L * Math.max(1, Math.log2(L));
  const budget = opts.budget ?? DEFAULT_BUDGET;
  while (K > 1 && unit * (K + 1) * iters > budget) K--;
  while (iters > 1 && unit * (K + 1) * iters > budget) iters--;

  const w = hannWindow(L);
  const full = L / 2 + 1;
  const padded = samples + L;
  const span = K * a + L;
  // 批大小。关掉打包时 step = 1，此时**绝不能**再给出第二个槽位 ——
  // 曾经这里写成 `k + 1 < act ? k + 1 : -1` 与 step 无关，于是 pair:false 把
  // 相邻两帧互相打包，`read` 还会顺带覆写下一槽的相位。表现是消融口自己错、
  // 而不是快慢有别：两分支的输出差到峰值的 34%（ulp 门禁把它抓了下来）。
  const step = (opts.pair ?? TUNE.pair) === false ? 1 : 2;
  const second = (k: number, act: number): number => (step === 2 && k + 1 < act ? k + 1 : -1);

  const pair = new Pair(L);
  const solo = new FFT(L);
  const out = new Float64Array(padded);
  const local = new Float64Array(span);
  const work = new Float64Array(L);
  const workIm = new Float64Array(L);
  const cos = new Float64Array((K + 1) * bins);
  const sin = new Float64Array((K + 1) * bins);
  const amp = new Float64Array((K + 1) * bins);
  const prevCos = new Float64Array((K + 1) * bins);
  const prevSin = new Float64Array((K + 1) * bins);
  const prevAmp = new Float64Array((K + 1) * bins);
  const lo = opts.lo ?? null;
  const hi = opts.hi ?? null;
  // 给了区间：幅度落在区间内就不动它，出界才夹回来。
  // 没给：退回硬投影 —— 幅度一律写成目标值，与加这套之前逐位相同。
  const fit = (d: number, i: number): number =>
    lo && hi ? (d < lo[i]! ? lo[i]! : d > hi[i]! ? hi[i]! : d) : mag[i]!;

  const load = (at: number): void => {
    local.fill(0);
    const avail = Math.min(span, padded - at);
    if (avail > 0) local.set(out.subarray(at, at + avail));
  };

  const put = (k: number, from: number): void => {
    for (let b = 0; b < bins; b++) {
      const p = warm![from + b]!;
      cos[k * bins + b] = Math.cos(p);
      sin[k * bins + b] = Math.sin(p);
      // 只定相位。幅度如实填 0 —— 这一步覆盖的那些位置，local 里本来就还是空的。
      // 硬投影下幅度恒取目标值、不看 amp，所以这与加软约束之前逐位相同；
      // 软约束下则让它从 0 起步，地板那一档这才真的能落到 0。
      amp[k * bins + b] = 0;
    }
  };

  /** 把槽位 k 的半谱填进 Pair 的第 `side` 条（0 → r1/i1，1 → r2/i2）。 */
  const fill = (f: number, k: number, side: number): void => {
    const base = f * bins;
    const at = k * bins;
    const rr = side === 0 ? pair.r1 : pair.r2;
    const ii = side === 0 ? pair.i1 : pair.i2;
    for (let b = 0; b < bins; b++) {
      const g = fit(amp[at + b]!, base + b);
      rr[b] = g * cos[at + b]!;
      ii[b] = g * sin[at + b]!;
    }
    // 行数可能小于 full（图读回来的精确谱被 win/2+1 夹过）。补零的位置与
    // `mirrorSpectrum` 里那段同义 —— 少了它，上一帧残留的谱线会被当成这一帧的。
    for (let b = bins; b < full; b++) {
      rr[b] = 0;
      ii[b] = 0;
    }
  };

  /**
   * 一次反变换铺两条。`k1 < 0`：只铺 k0，另一条喂零。
   *
   * `m` 是本帧序号，不是幅度行号 —— 槽位 `k` 对应的是**第 `m+k` 帧**的幅度。
   * 两条共用一个 `m` 就会把第二条铺到别人的幅度上（这一处曾经写错过，
   * 表现是相关性掉三成，而测试全绿）。
   */
  const lay = (m: number, k0: number, k1: number): void => {
    fill(m + k0, k0, 0);
    if (k1 >= 0) fill(m + k1, k1, 1);
    else {
      pair.r2.fill(0);
      pair.i2.fill(0);
    }
    pair.inverse();
    // k ≤ K ⇒ from + L ≤ K·a + L = span，不必夹边界（与老路一致）。
    const from0 = k0 * a;
    for (let n = 0; n < L; n++) local[from0 + n] = local[from0 + n]! + pair.x1[n]! * w[n]!;
    if (k1 < 0) return;
    const from1 = k1 * a;
    for (let n = 0; n < L; n++) local[from1 + n] = local[from1 + n]! + pair.x2[n]! * w[n]!;
  };

  const unpack = (k: number, rr: Float64Array, ii: Float64Array): void => {
    const at = k * bins;
    for (let b = 0; b < bins; b++) {
      const r = rr[b]!;
      const i = ii[b]!;
      const d = Math.sqrt(r * r + i * i);
      cos[at + b] = d > 0 ? r / d : 1;
      sin[at + b] = d > 0 ? i / d : 0;
      amp[at + b] = d;
    }
  };

  /** 一次正变换读两条。`k1 < 0`：只读 k0。 */
  const read = (k0: number, k1: number): void => {
    const from0 = k0 * a;
    for (let n = 0; n < L; n++) pair.x1[n] = local[from0 + n]! * w[n]!;
    if (k1 >= 0) {
      const from1 = k1 * a;
      for (let n = 0; n < L; n++) pair.x2[n] = local[from1 + n]! * w[n]!;
    } else pair.x2.fill(0);
    pair.forward(pair.x1, pair.x2);
    unpack(k0, pair.r1, pair.i1);
    if (k1 >= 0) unpack(k1, pair.r2, pair.i2);
  };

  try {
    for (let m = 0; m < frames; m++) {
      const act = Math.min(K + 1, frames - m);
      const at = m * a;

      load(at);

      if (m === 0) {
        if (warm) for (let k = 0; k < act; k++) put(k, k * bins);
        else for (let k = 0; k < act; k += step) read(k, second(k, act));
      } else {
        for (let k = 0; k < act; k++) {
          const next = (k + 1) * bins;
          const here = k * bins;
          if (k <= K - 1) {
            cos.set(prevCos.subarray(next, next + bins), here);
            sin.set(prevSin.subarray(next, next + bins), here);
            amp.set(prevAmp.subarray(next, next + bins), here);
          } else if (warm) put(k, (m + k) * bins);
          else {
            cos.fill(1, here, here + bins);
            sin.fill(0, here, here + bins);
            amp.fill(0, here, here + bins);
          }
        }
        // 第 0 帧的相位从已经写进 out 的过去帧重读：逐帧推进才不会在帧界上出爆音。
        read(0, -1);
      }

      for (let it = 0; it < iters; it++) {
        load(at);
        for (let k = 0; k < act; k += step) lay(m, k, second(k, act));
        for (let k = 0; k < act; k += step) read(k, second(k, act));
      }

      // 收尾：只写槽位 0，凑不出第二条，走单条复变换。
      const base = m * bins;
      for (let b = 0; b < bins; b++) {
        const g = fit(amp[b]!, base + b);
        work[b] = g * cos[b]!;
        workIm[b] = g * sin[b]!;
      }
      for (let b = bins; b < full; b++) {
        work[b] = 0;
        workIm[b] = 0;
      }
      mirrorSpectrum(work, workIm, full, L);
      solo.transform(work, workIm, true);
      const room = Math.min(L, padded - at);
      for (let n = 0; n < room; n++) out[at + n] = out[at + n]! + work[n]! * w[n]!;

      prevCos.set(cos);
      prevSin.set(sin);
      prevAmp.set(amp);
      if (tick) await tick(m + 1, frames);
    }
  } finally {
    // 槽位是内核里有限的资源（6 个），拿去就必须还 —— 中途被作废也一样。
    pair.dispose();
  }

  const cover = coverage(L, a, frames, padded);
  let top = 0;
  for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
  const floor = top * 0.05;

  const y = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const c = cover[L / 2 + i]!;
    y[i] = c > floor ? out[L / 2 + i]! / c : 0;
  }
  return y;
}

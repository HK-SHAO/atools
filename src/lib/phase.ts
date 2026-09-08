/*
 * 只有幅度时怎么把相位找回来。
 *
 * Griffin-Lim 从随机相位起步，要几百次迭代才勉强能用 —— 而且卡在局部极小里出不来。
 * 这里用 PGHI（Phase Gradient Heap Integration，Průša & Balazs 2017）先一次性解出相位，
 * 再交给带动量的 GL 打磨几轮。
 *
 * 原理：STFT 的相位梯度可以从幅度的对数梯度直接算出来（高斯窗下是精确关系，
 * 紧支撑窗是近似），再沿梯度场积分就得到相位。于是相位不再是"猜"的，
 * 而是从幅度本身推出来的 —— 迭代几十轮的活，一轮就做完了。
 */

/** 相位重建的调参口。评测台会临时改这几个值来对比算法，默认即线上值。 */
export const TUNE = {
  /** 用 PGHI 给相位起手；关掉就退回随机相位 + 纯 GL。 */
  pghi: true,
  /** GL 迭代上限。PGHI 起手后 32 轮就够，纯 GL 要几百轮。 */
  iters: 32,
  /** Nesterov 动量。0 = 标准 Griffin-Lim。 */
  momentum: 0.5,
  /** Hann 窗的 γ（= λL，LTFAT 给的 C_g·gl² 系数）。 */
  gamma: 0.25645,
  /** 两遍积分的相对阈值：先只信强区，再让强区把弱区带出来。 */
  tol: [0.1, 1e-10] as [number, number],
  /** 紧凑模式的主反演器：RTISI-LA（带前瞻逐帧迭代）。关掉就退回 PGHI + GL。 */
  rtisi: true,
  /** RTISI-LA 每帧迭代几次。论文说 8 次就够，再往上收益很小。 */
  rtisiIters: 8,
  /** RTISI-LA 之后再拿带动量的 GL 全局打磨几轮。0 = 不打磨。 */
  rtisiGl: 0,
  /**
   * 「精修」档（用户点按钮、愿意多花时间）：迭代和预算都给足。
   * 快速档保可用性，精修档保保真度 —— 两条路用同一套算法，只是给多少算力的区别。
   */
  fine: {
    /** RTISI-LA 每帧迭代次数（快速档 8；实测 16 + GL 打磨最优，24 反而过拟合量化噪声）。 */
    rtisiIters: 16,
    /** RTISI-LA 计算预算（快速档的 4 倍，前瞻帧数更多）。 */
    rtisiBudget: 2e8,
    /** 收尾全局 GL 打磨轮数。 */
    glIters: 8,
    /** 全局 GL 时间预算（毫秒）。 */
    glBudgetMs: 12_000,
  },
};

const TWO_PI = Math.PI * 2;

const wrap = (a: number): number => {
  let v = (a + Math.PI) % TWO_PI;
  if (v < 0) v += TWO_PI;
  return v - Math.PI;
};

/** 按幅度分 256 档做桶排序，得到"从响到轻"的访问序。O(n)。 */
function orderByLevel(mag: Float64Array, top: number, n: number): Uint32Array {
  const B = 256;
  const counts = new Uint32Array(B);
  const keys = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.min(B - 1, (mag[i]! / top) * B) | 0;
    keys[i] = k;
    counts[k] = counts[k]! + 1;
  }
  // start[b] = 比 b 响的一共有多少个，桶 b 就排在它后面。
  const start = new Uint32Array(B + 1);
  for (let b = B - 1; b >= 0; b--) start[b] = start[b + 1]! + counts[b]!;

  const order = new Uint32Array(n);
  const at = new Uint32Array(B);
  for (let b = 0; b < B; b++) at[b] = start[b + 1]!;
  for (let i = 0; i < n; i++) order[at[keys[i]!]!++] = i;
  return order;
}

/**
 * 按幅度出队的最大堆。
 *
 * 漫水的边界长度是 O(√n)，堆里同时最多也就几百上千个元素 ——
 * 但保险起见还是做成能翻倍的，免得真遇上奇形怪状的时频面。
 */
class Heap {
  private idx: Uint32Array;
  private key: Float64Array;
  size = 0;

  constructor(cap = 1024) {
    this.idx = new Uint32Array(cap);
    this.key = new Float64Array(cap);
  }

  private grow(): void {
    const idx = new Uint32Array(this.idx.length * 2);
    idx.set(this.idx);
    const key = new Float64Array(this.key.length * 2);
    key.set(this.key);
    this.idx = idx;
    this.key = key;
  }

  push(value: number, key: number): void {
    if (this.size === this.idx.length) this.grow();
    let c = this.size++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p]! >= key) break;
      this.idx[c] = this.idx[p]!;
      this.key[c] = this.key[p]!;
      c = p;
    }
    this.idx[c] = value;
    this.key[c] = key;
  }

  pop(): number {
    const top = this.idx[0]!;
    const last = --this.size;
    if (last > 0) {
      const value = this.idx[last]!;
      const key = this.key[last]!;
      let c = 0;
      for (;;) {
        let ch = 2 * c + 1;
        if (ch >= last) break;
        if (ch + 1 < last && this.key[ch + 1]! > this.key[ch]!) ch++;
        if (this.key[ch]! <= key) break;
        this.idx[c] = this.idx[ch]!;
        this.key[c] = this.key[ch]!;
        c = ch;
      }
      this.idx[c] = value;
      this.key[c] = key;
    }
    return top;
  }
}

/**
 * 幅度 → 相位。返回 frame-major 的相位（弧度，已折到 [-π, π]）。
 *
 * 两个方向的相位增量（高斯窗下是精确关系，紧支撑窗是近似）：
 *   沿 bin 走一步   dΦ/db = -(γ/L)·∂(log M)/∂t      - π
 *   沿 frame 走一步 dΦ/df = (hop·L/γ)·∂(log M)/∂b   + 2π·hop·b/L
 * 其中 γ = 2πσ²，Hann 窗取 0.25645·L²（LTFAT 的 C_g·gl²）。
 *
 * 那个 -π 不能省：PGHI 的推导把窗中心当时间原点，而我们算的是
 * Σ x[f·hop+m]·w[m]·e^{-2πi bm/L} —— m 从 0 起，原点差半个窗，
 * 正好在每个 bin 上留下 π 的相位差。实测漏掉它，频率方向梯度会差整整 180°。
 * 它必须并进 fgrad 里随积分一步步累加，不能最后统一减 π·b ——
 * 后者只对"纯沿频率走到 b"的路径等价，跨 frame 接过来的点会差一截。
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

  let top = 0;
  for (let i = 0; i < n; i++) if (mag[i]! > top) top = mag[i]!;
  if (top <= 0 || frames < 2 || bins < 2) return phase;

  const floor = top * 1e-12;
  const slog = new Float64Array(n);
  for (let i = 0; i < n; i++) slog[i] = Math.log(Math.max(mag[i]!, floor));

  // 两个方向上的梯度。fgrad = 沿频率走一步的相位增量，tgrad = 沿时间走一步的相位增量。
  const gamma = TUNE.gamma * win * win;
  const cF = gamma / (hop * win);
  const cT = (hop * win) / gamma;
  const fgrad = new Float32Array(n);
  const tgrad = new Float32Array(n);

  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    const up = (f > 0 ? f - 1 : 0) * bins;
    const dn = (f < frames - 1 ? f + 1 : frames - 1) * bins;
    const dt = f > 0 && f < frames - 1 ? 2 : 1;
    for (let b = 0; b < bins; b++) {
      fgrad[base + b] = (-cF * (slog[dn + b]! - slog[up + b]!)) / dt - Math.PI;
    }
  }
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      const lo = b > 0 ? b - 1 : 0;
      const hi = b < bins - 1 ? b + 1 : bins - 1;
      const db = b > 0 && b < bins - 1 ? 2 : 1;
      tgrad[base + b] =
        (cT * (slog[base + hi]! - slog[base + lo]!)) / db + (TWO_PI * hop * b) / win;
    }
  }
  slog.fill(0);

  const done = new Uint8Array(n);
  const queued = new Uint8Array(n);
  const order = orderByLevel(mag, top, n);
  const heap = new Heap();

  /**
   * 从已定下来的点往外漫水，每次取"边界上最响的那个"定下来。
   *
   * 必须是漫水而不是"全局按幅度降序扫一遍"—— 后者一到局部极大值就断了：
   * 它四周都比它轻，全都还没处理，于是只好另起一座孤岛、相位记 0。
   * 语音的时频面上局部极大值成千上万，整张图会被切成同样多的碎块，
   * 每块各带一个任意常数相位，拼起来就是一团乱麻。
   * 漫水则能绕过去：局部极大值迟早会从旁边被接到，整块地只留一个种子。
   */
  const drain = (limit: number): void => {
    while (heap.size > 0) {
      const i = heap.pop();
      if (done[i]) continue;

      const f = (i / bins) | 0;
      const b = i - f * bins;
      let best = -1;
      let bestMag = -1;

      if (b > 0 && done[i - 1]! && mag[i - 1]! > bestMag) {
        best = i - 1;
        bestMag = mag[i - 1]!;
      }
      if (b < bins - 1 && done[i + 1]! && mag[i + 1]! > bestMag) {
        best = i + 1;
        bestMag = mag[i + 1]!;
      }
      if (f > 0 && done[i - bins]! && mag[i - bins]! > bestMag) {
        best = i - bins;
        bestMag = mag[i - bins]!;
      }
      if (f < frames - 1 && done[i + bins]! && mag[i + bins]! > bestMag) {
        best = i + bins;
        bestMag = mag[i + bins]!;
      }

      if (best < 0) {
        // 真的与世隔绝：相位无从推算，先记 0，靠后面的 GL 迭代带出来。
        phase[i] = 0;
      } else if (best === i - 1) {
        phase[i] = wrap(phase[best]! + 0.5 * (fgrad[best]! + fgrad[i]!));
      } else if (best === i + 1) {
        phase[i] = wrap(phase[best]! - 0.5 * (fgrad[best]! + fgrad[i]!));
      } else if (best === i - bins) {
        phase[i] = wrap(phase[best]! + 0.5 * (tgrad[best]! + tgrad[i]!));
      } else {
        phase[i] = wrap(phase[best]! - 0.5 * (tgrad[best]! + tgrad[i]!));
      }
      done[i] = 1;

      if (b > 0) offer(i - 1, limit);
      if (b < bins - 1) offer(i + 1, limit);
      if (f > 0) offer(i - bins, limit);
      if (f < frames - 1) offer(i + bins, limit);
    }
  };

  /** 邻居入队。低于当前阈值的先不进——第二遍放宽阈值时它们会被放进来。 */
  function offer(j: number, limit: number): void {
    if (done[j] || queued[j] || mag[j]! <= limit) return;
    queued[j] = 1;
    heap.push(j, mag[j]!);
  }

  // 两遍：先只信强区（弱区的梯度不可靠），再放宽让强区把弱区带出来。
  for (const limit of [top * TUNE.tol[0], top * TUNE.tol[1]]) {
    for (let k = 0; k < n; k++) {
      const i = order[k]!;
      if (done[i] || mag[i]! <= limit) continue;
      queued[i] = 1;
      heap.push(i, mag[i]!);
      drain(limit);
    }
  }

  // 剩下完全没接上的，给随机相位 —— 反正它们都在噪声底下。
  let seed = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    if (done[i]) continue;
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    phase[i] = ((seed >>> 0) / 0xffffffff) * TWO_PI - Math.PI;
  }

  return phase;
}

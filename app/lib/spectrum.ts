import type { Samples } from "./arrays";
import { SR_OPTIONS, dbSpanOf, hopOf, srLabel, stepsOf, winOf, type Encode } from "./params";
import { TUNE, phaseFromMagnitude } from "./phase";
import { resampledLength } from "./resample";
import { DEFAULT_BUDGET, rtisiLa } from "./rtisi";
import { Frames, coverage, olaFromPhase } from "./stft";

export const BANDS = 2;

const MIN_WIN = 256;
const MAX_WIN = 4096;

/**
 * 像素预算 —— 「能装多久」只有这一个真预算。
 *
 * 像素 = 帧数 × 带宽 ≈ N·重叠/2，**与窗长无关**（见 params.ts 的 hopOf）。实测
 * 0.84 字节/像素，所以预算同时就是文件体积：16M 像素 ≈ 13MB 的 PNG，编码 + 打包 ~1.2s。
 *
 * 为什么是 16M 而不是更大：**65535 列是浏览器的硬墙**（实测 70000 宽的 canvas 会静默
 * 变成空画布，`toBlob` 给 null），而默认档（win 512）在 16M 像素处正好撞上它 ——
 * 再往上加，默认档也装不出更长的音频，等于白加。要更长只能换更长的窗（时间分辨率变粗）
 * 或者把音频切段，那是另一套格式，不是把数字调大。各档的时长天花板都是
 * `min(像素预算, 65535 列)` 里更小的那道，见 docs/algorithms.md 的实测表。
 */
export const MAX_PIXELS = 16_000_000;

/**
 * 单边（帧数就是图宽）上限：canvas 的硬墙。实测 65535 宽仍然画得出、`toBlob` 正常，
 * **65536 就开始静默失败**（画点读回是 0、`toBlob` 给 null），所以取 65535 而不是 2^16。
 * 它管两件事：① 挡住「窄带 + 超长」把图拉成几万比一的长条；② 让省档（win 256）
 * 的列数先于像素预算到顶 —— 省档每秒的列数是最档的两倍，所以它的容量天生只有一半。
 * 读图侧共用这个数（`image.ts` 的 MAX_SIDE）：宽超了的图必须先缩，否则读回来的是静音。
 */
export const MAX_FRAMES = 65535;

export const DEFAULT_SR = 44100;

/** 一张图最多多少帧：像素预算与单边上限的较小者。读写两侧共用同一个预算。 */
export const maxFramesFor = (bins: number, bands = 1): number =>
  Math.min(MAX_FRAMES, Math.floor(MAX_PIXELS / (bins * bands)));

const DB_MIN = -120;
const DB_MAX = 0;
const DB_SPAN = DB_MAX - DB_MIN;
const DB_TO_LIN = Math.LN10 / 20;

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

export function shapeFor(enc: Encode, sr: number, samples: number): Shape {
  const win = winOf(enc);
  const hop = hopOf(enc);
  const bins = rowsFor(win, sr, enc.mode === "compact" ? enc.fmax : 0);
  const frames = Math.floor(Math.max(1, samples) / hop) + 1;
  const bands = enc.mode === "exact" ? BANDS : 1;

  // 只有像素这一个预算，所以只有一条提示 —— 别再写「把窗长调低」：像素 ≈ N·重叠/2，
  // 与窗长无关（见 params.ts 的 hopOf）。能压图的旋钮只有采样率、频宽和时长。
  if (frames > maxFramesFor(bins, bands)) throw new Error("音频太长，图放不下：调低采样率，或剪短一点");

  return { win, hop, frames, bins, samples };
}

function fits(enc: Encode, sr: number, samples: number): boolean {
  const bins = rowsFor(winOf(enc), sr, enc.mode === "compact" ? enc.fmax : 0);
  const frames = Math.floor(Math.max(1, samples) / hopOf(enc)) + 1;
  return frames <= maxFramesFor(bins, enc.mode === "exact" ? BANDS : 1);
}

/** 这个档位在某个采样率下最多能装多少秒 —— 由像素预算决定，三档窗长因此得到同一个上限。 */
function ceilingOf(enc: Encode, sr: number): number {
  const bins = rowsFor(winOf(enc), sr, enc.mode === "compact" ? enc.fmax : 0);
  const bands = enc.mode === "exact" ? BANDS : 1;
  return Math.floor(((maxFramesFor(bins, bands) - 1) * hopOf(enc)) / sr);
}

export function fitEncode(
  e: Encode,
  srcSr: number,
  srcSamples: number,
): { enc: Encode; note: string | null } {
  const want = e.sr > 0 ? e.sr : srcSr;
  // 喂给判据的必须是**真实编出来的**样点数：resample 给 round(N·to/from)，多一个 hop 就多一帧。
  // 曾经这里是 ceil(...) + hopOf(e)，两处各多算一帧，于是「刚好装得下」的请求被判成装不下
  // （166 秒的素材在 24k 差 0.05% 就被退回 16k，有一半是这个多算出来的）。
  const at = (sr: number): number => resampledLength(srcSamples, srcSr, sr);
  if (fits(e, want, at(want))) return { enc: e, note: null };

  // 装不下就沿采样率往下走，每一步都把「为什么」说清楚：这段多少秒、你要的那档上限多少秒。
  // 只说「已自动调低采样率」而不给上限，用户没法知道该剪到多短。
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

  // 8k 都装不下：按像素预算剪到最长，其余保持不变。窗长这一维没有可换的 —— 像素 ≈ N·重叠/2
  // 与窗长无关，三档的容量只差千分之几，为这点差别换档是噪声不是收益。
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
  // 一帧变换的工作区借自内核（会话槽），整段活干完才还 —— 池满会当场抛，见 stft.ts。
  const core = new Frames(win);
  try {
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

      // 视图只现切、不跨 `await` 持有：等待期间别的作业可能 `memory.grow`，把旧视图整片
      // detach 掉（写进去是静默丢弃）。所以每次让出之后重新取一次，见 stft.ts 的 Frames。
      let { re, im } = core.data();
      for (let f = 0; f < frames; f++) {
        core.analyse(x, f * hop);
        const base = f * bins;
        for (let b = 0; b < bins; b++) {
          const r = re[b]!;
          const c = im[b]!;
          const h = Math.sqrt(r * r + c * c);
          levels[base + b] = magToLevel(20 * Math.log10(h / scale));
          // 单位相量直接取 re/h 与 im/h：与 cos(atan2(im, re)) 是同一件事，
          // 但省掉 atan2 + cos + sin 三个超越函数（内层实测 2.12×）。h = 0 时
          // 原式给 cos=1、sin=0，这里照样填 255 / 128。
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

    // 峰值扫描不跨 `await`：一次取视图、一口气读完。
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

    // 无论位深多少，level 一律是字节：quantize 把量化档按 255 展开。
    // 曾经这里给 bits>=16 开过 Uint16Array 的分支，而 levelToDb 是按字节解释的
    // （level·steps/255），两条约定一撞就是整段 NaN（实测 4096/4096 非有限）。
    // 位深只由 params.ts 的 BITS_OPTIONS（2/4/8）给，那条分支从来到不了。
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
        if (h > SYNTH_TUNE.phaseDeadZone) {
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
      // bins 可能小于 win/2+1（图读回来的精确谱，行数被 win/2+1 夹过）。
      // 反变换做的是全长的共轭翻转，上半谱不清零的话，上一帧反变换出来的时域样本会被
      // 当成本帧的谱线再变一次 —— 帧 0 之后整条输出都被污染。
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

/** 幅度投影的目标区间：按**量化字节**查的 256 项表。见 `rtisi.ts` 的 `Band`。 */
type Band = import("./rtisi").Band;

/**
 * 幅度是**量化**存下来的，level 说的是「落在第 q 档」，不是「等于档中心」。
 * 绝大多数假约束出现在**最低那一档**：`q = 0` 的真值含义是「在这个地板以下」，
 * 可硬投影把它钉在地板上 —— 于是整张频谱里所有安静的地方都被填成同一个非零值，
 * 等于凭空铺一层等高的噪声地板。位深越浅，地板越高（2bit 只到峰值下 24 dB），
 * 这层假噪声就越响。
 *
 * 这里只放宽这一档：让它可以往 0 走（上界仍是档中心，不让它盖过邻近档）。
 * 最高那一档同理给到 +∞。其余档位仍钉在中心 —— **试过把每一档都放宽 ±半档，
 * 收益为零甚至略负**：2bit 相关只到 0.179（本版 0.198）、包络 13/18（本版 18/18），
 * 而 8bit 的谱差反而显著变差。地板这一档是唯一真正被钉错的地方。
 *
 * 交给迭代的语义是「幅度落在 [lo, hi] 内就不动它，出界才夹回来」，
 * 即 ADMM 类相位重建里的幅度软约束；训练无关、零依赖、零额外耗时。
 * 可逆档（exact）没有量化这一步，返回 null。
 *
 * 表按 256 个**字节值**建，而不是逐元素建两张 `frames×bins` 的表：量化档只由那个字节
 * 决定（`q = round(lv·steps/255)`），所以逐元素存是白白多出 16M 像素素材的 128 MB。
 * 这张表由宿主按量化约定算好、整段交给内核的 `rt_fit`，所以「同一个字节值定出哪一段边界」
 * 只有这一处。
 */
function bandOf(spec: Spectrum, scale: number): Band | null {
  const { meta, levels } = spec;
  const span = dbSpanOf(meta.bits);
  // 地板落在峰值下 span dB。span 大到地板已经在感知地板（−80 dB）之下时，
  // 钉不钉它都听不出来 —— 实测 8bit（−96 dB）上放宽之后各项指标只是在噪声里摆动，
  // 而 4bit（−48 dB）与 2bit（−24 dB）上这层假噪声又响又脏，放宽是巨赢。
  if (meta.exact || !TUNE.relaxFloor || span >= 80) return null;
  // 表是按元素下标取的：levels 短了内核就会读到段外（它拿到的是裸段地址，没有边界）。
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

/** 软约束的取法。与内核 `rt_fit` 里那一条是同一条式子 —— 表由这里建、由内核读。 */
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
    let top = 0;
    for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
    const floor = top * 0.05;

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
          // 硬投影：幅度一律改写成档中心。软约束：已在 [lo, hi] 内就原样留着。
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
  const padded = samples + win;

  const warm = TUNE.pghi ? phaseFromMagnitude(target, frames, bins, win, hop) : null;
  const anchor: Anchor | null =
    fine && spec.phaseCos && spec.phaseSin && spec.phaseW
      ? { cos: spec.phaseCos, sin: spec.phaseSin, w: spec.phaseW }
      : null;
  let next = 0;
  const y = TUNE.rtisi
    ? await rtisiLa(target, frames, bins, win, hop, samples, {
        iters: fine ? TUNE.fine.rtisiIters : TUNE.rtisiIters,
        budget: fine ? TUNE.fine.rtisiBudget : DEFAULT_BUDGET,
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

  const x = new Float64Array(padded);
  for (let i = 0; i < samples; i++) x[win / 2 + i] = y[i]!;
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

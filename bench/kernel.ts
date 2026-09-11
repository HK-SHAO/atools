// 内核 A/B：同一批用例在「内核挂上」与「摘掉内核（TS 参照实现）」两条路上各跑一遍。
//
// 为什么不是浏览器评测台：这里量的是数值内核本身，与 DOM / canvas 无关，
// 放在 Node 侧能一轮跑完且不用起 Chromium。真实页面里的端到端另有 `bun bench/run.ts`。
//
// 判据是**比值**而不是绝对值 —— 两条路在同一台机器、同一轮里跑，机器噪声对消，
// 于是这条比值可以当门禁。先例是 `bench/perf.ts` 的相位表倍数。
//
// 用法：bun bench/kernel.ts        （SECS=30 改素材时长）

import type { Samples } from "../app/lib/arrays";
import { attachKernel, loadDsp, type Dsp } from "../app/lib/dsp";
import type { Encode } from "../app/lib/params";
import { Pair } from "../app/lib/pair";
import { resample } from "../app/lib/resample";
import { encode, synthesise, type Spectrum } from "../app/lib/spectrum";
import { compileWasm } from "../scripts/moon";

const SECS = Number(process.env.SECS ?? 30);
const SRC_SR = 44100;

/** 内核要赢到这么多才算「比纯 TS 更好」，不是「没变慢」。 */
const GAIN_GATE = 0.95;
/** 不经过内核的档位（可逆档走 `synthesiseExact`）：只要求绕一圈没变慢。 */
const NEUTRAL_GATE = 1.05;
/** 波形是 Float32，两条路的差只有相对峰值才有意义；超过这个数就是算法写错了。 */
const WAVE_TOL = 0.05;

const TERMS = [
  [220, 0.5],
  [554.37, 0.32],
  [1318.51, 0.2],
  [3087.4, 0.11],
] as const;

/** 确定性素材：四个非谐波分量 + 慢包络，与 `bench/quality.ts` 同一条思路（可复现，不读磁盘）。 */
function material(samples: number, sr: number): Float32Array<ArrayBuffer> {
  const x = new Float32Array(samples);
  const env = 0.55 + 0.45 * Math.sin((2 * Math.PI * 0.7 * samples) / sr);
  for (let i = 0; i < samples; i++) {
    const t = i / sr;
    let v = 0;
    for (const [hz, amp] of TERMS) v += amp * Math.sin(2 * Math.PI * hz * t);
    const fade = Math.min(1, i / (0.05 * sr), (samples - i) / (0.05 * sr));
    x[i] = (v / 1.6) * env * Math.max(0, fade) * 0.8;
  }
  return x;
}

const mk = (mode: Encode["mode"], fineness: 0 | 1 | 2, sr = 8000): Encode => ({
  mode,
  sr,
  bits: 8,
  fineness,
  fmax: 0,
  start: 0,
  end: 0,
});

/**
 * `kernel` 指这一档**该不该**由内核拿下：紧凑档的还原走 `Pair`（内核），
 * 可逆档走 `synthesiseExact`（内核里没有对应实现，绕一圈必须一模一样）。
 */
const TIERS: { label: string; enc: Encode; kernel: boolean }[] = [
  { label: "省 win256", enc: mk("compact", 0), kernel: true },
  { label: "中 win512", enc: mk("compact", 1), kernel: true },
  { label: "细 win1024", enc: mk("compact", 2), kernel: true },
  { label: "细 精确档", enc: mk("exact", 2), kernel: false },
];

interface Run {
  spec: Spectrum;
  out: Samples;
  ms: { resample: number; encode: number; synthesise: number };
}

/** 走一遍真实链路的形态：重采样 → 编码 → 还原（Worker 里也是这三步分开走）。 */
async function run(dsp: Dsp | null, pcm: Samples, enc: Encode): Promise<Run> {
  attachKernel(dsp);
  const t0 = performance.now();
  const tuned = resample(pcm, SRC_SR, enc.sr, enc.fmax);
  const t1 = performance.now();
  const spec = await encode(tuned, enc.sr, enc);
  const t2 = performance.now();
  const out = await synthesise(spec, undefined, undefined, "fast");
  const t3 = performance.now();
  return {
    spec,
    out,
    ms: { resample: t1 - t0, encode: t2 - t1, synthesise: t3 - t2 },
  };
}

const countDiff = (a: Uint8Array, b: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

/** 峰值相对偏差。 */
function peakDelta(a: Float32Array, b: Float32Array): number {
  let peak = 0;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]!);
    if (v > peak) peak = v;
  }
  if (peak === 0) return 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst / peak;
}

const ms = (v: number): string => `${v.toFixed(1)}ms`;

const dsp = await loadDsp(compileWasm());

// 先证明内核这条路真被走到了：`Pair` 是「内核挂上」的唯一入口，槽位池满或 ABI 错配
// 都会让它静默退回参照实现 —— 那样整轮 A/B 其实什么都没比，数字会一样好看。
attachKernel(dsp);
const probe = new Pair(512);
const live = probe.via === "kernel";
probe.dispose();
attachKernel(null);
if (!live) throw new Error("内核没挂上：Pair 退回了参照实现，这轮 A/B 不成立");

const pcm = material(Math.round(SECS * SRC_SR), SRC_SR);
const total = (r: Run): number => r.ms.resample + r.ms.encode + r.ms.synthesise;

const ROUNDS = 3;

/**
 * 两条路**交替**跑 N 轮，各自取最快的一轮。
 *
 * 最小值是无偏的估计量：调度与 GC 只会让某轮变慢、不会让它变快。而必须交替是为了
 * 抵消漂移 —— 先跑完参照的三轮再跑内核的三轮时，堆状态与频率调节会在两段之间变化，
 * 实测同一份代码在两个位置能差出 35%（可逆档的编码就撞上过）。交替之后同一份代码的两侧
 * 差在 2% 以内。
 */
const compare = async (
  enc: Encode,
): Promise<{ ref: Run; ker: Run }> => {
  let ref: Run | null = null;
  let ker: Run | null = null;
  for (let i = 0; i < ROUNDS; i++) {
    const r = await run(null, pcm, enc);
    if (!ref || total(r) < total(ref)) ref = r;
    const k = await run(dsp, pcm, enc);
    if (!ker || total(k) < total(ker)) ker = k;
  }
  return { ref: ref!, ker: ker! };
};

console.log(`素材 ${SECS}s @ ${SRC_SR}Hz · ${TIERS.length} 档 · 两条路交替 ${ROUNDS} 轮、各自取最快\n`);
console.log("档位         重采样(内/参)      编码(内/参)       还原(内/参)      合计 内核/参照  判  level 波形差");
console.log("─".repeat(96));

const failures: string[] = [];

for (const { label, enc, kernel: wantsKernel } of TIERS) {
  const { ref, ker } = await compare(enc);

  const got = total(ker);
  const want = total(ref);
  const gate = wantsKernel ? GAIN_GATE : NEUTRAL_GATE;
  const rate = got / want;
  const levelDiff = countDiff(ker.spec.levels, ref.spec.levels);
  const wave = peakDelta(ker.out, ref.out);
  const cell = (a: number, b: number): string => `${ms(a)}/${ms(b)}`.padStart(17);

  console.log(
    `${label.padEnd(11)} ${cell(ker.ms.resample, ref.ms.resample)} ${cell(ker.ms.encode, ref.ms.encode)} ` +
      `${cell(ker.ms.synthesise, ref.ms.synthesise)} ${ms(got).padStart(8)} ${rate.toFixed(2)}× ${rate <= gate ? "✓" : "✗"} ` +
      `${String(levelDiff).padStart(4)} ${wave.toExponential(1)}`,
  );

  if (rate > gate)
    failures.push(
      `${label}：内核 ${ms(got)} 对参照 ${ms(want)} = ${rate.toFixed(2)}×，` +
        `未达 ${wantsKernel ? `「要更快」的 ${GAIN_GATE}×` : `「不变慢」的 ${NEUTRAL_GATE}×`}`,
    );
  if (levelDiff > 0) failures.push(`${label}：level 字节差 ${levelDiff} 处`);
  if (!wantsKernel && wave !== 0) failures.push(`${label}：不经过内核的档位，波形却不逐位相同（${wave.toExponential(1)}）`);
  if (wave > WAVE_TOL) failures.push(`${label}：波形差到峰值的 ${wave.toExponential(1)}，超 ${WAVE_TOL}`);
}

console.log("─".repeat(96));
if (failures.length) {
  console.log("不合格：");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`全部达标：内核在紧凑档更快（门禁 ${GAIN_GATE}×），可逆档绕一圈逐位不变（门禁 ${NEUTRAL_GATE}×、波形 0 差）。`);

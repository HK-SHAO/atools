// 数值链的**单路计时**：重采样 → 编码 → 还原，按档位分开量。
//
// **这里没有 A/B，因为已经没有第二条路可比了。** 核心数值逻辑整段搬进内核（`moon/`），
// 不再有 TS 参照实现 —— 曾经那条「内核比参照快多少」的比值门禁随之作废（它量的是两份
// 实现的关系，而第二份已经不存在）。留下的是**用户真正在意的那把尺子**：算一分钟音频
// 要多少秒。
//
// 判据因此是**实时倍率**而不是相对比值：`总耗时 / 音频时长`。它不依赖谁的实现更快，
// 只依赖「比播放快多少」，而后者才是「操作不要卡」这句话的可判形式。阈值由
// `RT_GATE` 环境变量给（默认 0.05；实测四档在 0.004~0.007×，也就是比实时快约 150 倍）。
//
// 为什么不是浏览器评测台：这里量的是数值链本身，与 DOM / canvas 无关，放在 Node 侧
// 能一轮跑完且不用起 Chromium。真实页面里的端到端另有 `bun bench/run.ts`，
// 浏览器侧的分阶段耗时另有 `bun bench/perf.ts`。
//
// 用法：bun bench/kernel.ts        （SECS=30 改素材时长，RT_GATE=0.5 改阈值）

import type { Samples } from "../app/lib/arrays";
import { loadDsp, warmKernel } from "../app/lib/dsp";
import type { Encode } from "../app/lib/params";
import { resample } from "../app/lib/resample";
import { encode, synthesise, type Spectrum } from "../app/lib/spectrum";
import { compileWasm } from "../scripts/moon";

const SECS = Number(process.env.SECS ?? 30);
const SRC_SR = 44100;
/** 算一段音频最多允许多少倍实时。实测四档在 0.004~0.007×，门禁留约 8 倍余量。 */
const RT_GATE = Number(process.env.RT_GATE ?? 0.05);

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

const TIERS: { label: string; enc: Encode }[] = [
  { label: "省 win256", enc: mk("compact", 0) },
  { label: "中 win512", enc: mk("compact", 1) },
  { label: "细 win1024", enc: mk("compact", 2) },
  { label: "细 精确档", enc: mk("exact", 2) },
];

interface Run {
  spec: Spectrum;
  out: Samples;
  ms: { resample: number; encode: number; synthesise: number };
}

/** 走一遍真实链路的形态：重采样 → 编码 → 还原（Worker 里也是这三步分开走）。 */
async function run(pcm: Samples, enc: Encode): Promise<Run> {
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

const ms = (v: number): string => `${v.toFixed(1)}ms`;

// 内核是这条链的唯一实现，挂不上就直接失败 —— 没有参照实现可退，跑出「数字好看」也没意义。
warmKernel(await loadDsp(compileWasm()));

const pcm = material(Math.round(SECS * SRC_SR), SRC_SR);
const total = (r: Run): number => r.ms.resample + r.ms.encode + r.ms.synthesise;

// 交替跑两次取最快：最小值是无偏的估计量（调度与 GC 只会让某轮变慢，不会让它变快）。
const ROUNDS = 2;

console.log(`素材 ${SECS}s @ ${SRC_SR}Hz · ${TIERS.length} 档 · 每档跑 ${ROUNDS} 轮取最快\n`);
console.log("档位         重采样      编码       还原      合计   实时倍率  判");
console.log("─".repeat(76));

const failures: string[] = [];
const budget = SECS * 1000;

for (const { label, enc } of TIERS) {
  let best: Run | null = null;
  for (let i = 0; i < ROUNDS; i++) {
    const r = await run(pcm, enc);
    if (!best || total(r) < total(best)) best = r;
  }
  const r = best!;
  const got = total(r);
  const rt = got / budget;
  const ok = rt <= RT_GATE;

  console.log(
    `${label.padEnd(11)} ${ms(r.ms.resample).padStart(9)} ${ms(r.ms.encode).padStart(9)} ` +
      `${ms(r.ms.synthesise).padStart(9)} ${ms(got).padStart(8)} ${rt.toFixed(3).padStart(8)}×  ${ok ? "✓" : "✗"}`,
  );

  if (!ok) failures.push(`${label}：${ms(got)} 算 ${SECS}s 音频 = ${rt.toFixed(3)}× 实时，未达 ${RT_GATE}×`);
  // 数值侧只挡「跑着但结果是垃圾」：NaN / Inf 与全零都能悄悄通过时间门禁。
  for (let i = 0; i < r.out.length; i += 97)
    if (!Number.isFinite(r.out[i]!)) {
      failures.push(`${label}：输出第 ${i} 个样点不是有限数`);
      break;
    }
  let peak = 0;
  for (const v of r.out) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) failures.push(`${label}：输出整条为 0`);
  for (const lv of r.spec.levels)
    if (!Number.isFinite(lv)) {
      failures.push(`${label}：levels 里有非有限数`);
      break;
    }
}

console.log("─".repeat(76));
if (failures.length) {
  console.log("不合格：");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`全部达标：每档都在 ${RT_GATE}× 实时以内，且输出是有限的非零信号。`);

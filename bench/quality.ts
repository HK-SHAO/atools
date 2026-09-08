/**
 * 纯 Bun 质量回归：无浏览器、无素材依赖，任何时候都能跑。
 *
 *   bun run quality              # 人读表格
 *   bun bench/quality.ts --json  # 机器可读（便于归档对比）
 *   bun bench/quality.ts --gate  # 质量门禁：低于阈值退出码 1，可挂在 CI / 提交前
 *
 * 原理：三种确定性合成信号（谐波人声、和弦乐声、白噪+冲击严苛素材）
 * → 走真正的 encode() → synthesise() 链路（与线上同一份代码）
 * → 用 metric.compare() 算波形 SNR / 相关系数 / 对数谱距离。
 *
 * 覆盖的是「编解码内核」：量化 + 相位重建。图片容器层（PNG/JPEG/缩放）
 * 的往返损耗由 bench/run.ts（浏览器评测台）负责，两边互补。
 *
 * 指标口径：
 *   snr  波形信噪比 dB，越高越好（对齐后）
 *   corr 波形相关系数，1 = 完全一致
 *   lsd  对数谱距离 dB，越低越好（谱像不像，比波形更接近听感）
 */

import type { Samples } from "../src/lib/arrays";
import { compare, magnitudes, spectral } from "../src/lib/metric";
import { TUNE } from "../src/lib/phase";
import type { Encode } from "../src/lib/params";
import { encode, synthesise } from "../src/lib/spectrum";

/* --tune='{"rtisiGl":8}'：临时改相位重建调参口做对比实验，一行就能复现。 */
const tuneArg = process.argv.find(a => a.startsWith("--tune="));
if (tuneArg) {
  Object.assign(TUNE, JSON.parse(tuneArg.slice(7)) as Partial<typeof TUNE>);
  console.log(`TUNE 覆盖：${tuneArg.slice(7)}\n`);
}

/* ── 确定性合成素材 ─────────────────────────────────────────── */

/** xorshift：固定种子，每次跑出来的素材完全一致，数字才可以横比。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

const env = (t: number, period: number, duty: number): number => {
  const p = t % period;
  return p < period * duty ? Math.sin((Math.PI / 2) * (p / (period * duty))) : 0;
};

/** 谐波人声：基频带颤音 + 4 个泛音 + 音节包络 + 一点气声。 */
function voice(sr: number, seconds: number): Samples {
  const n = Math.floor(sr * seconds);
  const x = new Float32Array(n);
  const noise = rng(0x1234);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = 180 * Math.pow(2, 0.12 * Math.sin(2 * Math.PI * 2.3 * t));
    let v = 0;
    for (let h = 1; h <= 4; h++) v += (0.9 / h) * Math.sin(2 * Math.PI * f0 * h * t);
    x[i] = 0.35 * v * env(t, 0.42, 0.72) + 0.004 * noise();
  }
  return x as Samples;
}

/** 和弦乐声：三和弦 + 缓慢幅度起伏，无打击成分。 */
function music(sr: number, seconds: number): Samples {
  const n = Math.floor(sr * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const amp = 0.3 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t));
    x[i] =
      amp *
      (Math.sin(2 * Math.PI * 261.6 * t) +
        0.8 * Math.sin(2 * Math.PI * 329.6 * t) +
        0.6 * Math.sin(2 * Math.PI * 392.0 * t)) *
      Math.exp(-((t % 1.2) * 1.5));
  }
  return x as Samples;
}

/** 严苛素材：白噪爆发 + 短促点击 + 快速扫频 + 静音段。专治相位重建。 */
function harsh(sr: number, seconds: number): Samples {
  const n = Math.floor(sr * seconds);
  const x = new Float32Array(n);
  const noise = rng(0xbeef);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    if (t % 1 < 0.18) v += 0.5 * noise(); // 白噪爆发
    if (Math.abs((t % 0.5) - 0.25) < 0.0015) v += 0.9 * (i % 2 ? 1 : -1); // 点击
    const sweepT = t % 1.3;
    if (sweepT < 0.9)
      v += 0.3 * Math.sin(2 * Math.PI * (200 + (3300 * sweepT * sweepT) / 0.81) * sweepT);
    x[i] = v;
  }
  return x as Samples;
}

const SIGNALS: [string, (sr: number, sec: number) => Samples][] = [
  ["人声", voice],
  ["乐声", music],
  ["严苛", harsh],
];

/* ── 评测用例 ───────────────────────────────────────────────── */

interface Row {
  signal: string;
  label: string;
  snr: number;
  corr: number;
  /** 谱收敛 dB（越低越好）：合成谱与目标幅度的差，量「迭代收敛了没」。 */
  conv: number;
  lsd: number;
  ms: number;
}

const SECONDS = 2.5;

async function runCase(name: string, gen: (sr: number, sec: number) => Samples, enc: Encode, doublePass = false): Promise<Row> {
  const sr = enc.sr > 0 ? enc.sr : 8000;
  const ref = gen(sr, SECONDS);
  const t0 = performance.now();
  const spec1 = await encode(ref, sr, enc);
  const y1 = await synthesise(spec1);
  const t1 = performance.now();
  const got = doublePass
    ? await synthesise(await encode(y1, sr, enc)) // 来回转换两趟：量累积损失
    : y1;
  const m = compare(ref, got);
  const conv = spectral(magnitudes(ref, 1024, 256), magnitudes(got, 1024, 256)).conv;
  return {
    signal: name,
    label: doublePass ? `${caseLabel(enc)} ×2 往返` : caseLabel(enc),
    snr: Math.round(m.snr * 10) / 10,
    corr: Math.round(m.corr * 1000) / 1000,
    conv: Math.round(conv * 10) / 10,
    lsd: Math.round(m.lsd * 10) / 10,
    ms: Math.round(t1 - t0),
  };
}

function caseLabel(enc: Encode): string {
  if (enc.mode === "exact") return `可逆 ${enc.sr / 1000}k`;
  return `紧凑 ${enc.sr / 1000}k ${enc.bits}bit`;
}

const CASES: { enc: Encode; double?: boolean }[] = [
  { enc: { mode: "exact", sr: 8000, bits: 0, fineness: 1, fmax: 0, start: 0, end: 0 } },
  { enc: { mode: "compact", sr: 8000, bits: 8, fineness: 1, fmax: 0, start: 0, end: 0 } },
  { enc: { mode: "compact", sr: 8000, bits: 4, fineness: 1, fmax: 0, start: 0, end: 0 } },
  { enc: { mode: "compact", sr: 16000, bits: 8, fineness: 1, fmax: 0, start: 0, end: 0 } },
  { enc: { mode: "compact", sr: 8000, bits: 8, fineness: 1, fmax: 0, start: 0, end: 0 }, double: true },
];

/* ── 质量门禁 ─────────────────────────────────────────────────
 * 数字来自基线实测 + 余量。改算法后若这里红了，要么是退步（先查），
 * 要么是真实提升（把阈值提到新基线，防止将来回退）。 */

/** [signal, label 片段, corr 下限, lsd 上限, conv 上限] */
const GATE: [string, string, number, number, number][] = [
  ["严苛", "可逆 8k", 0.99, 3.5, -10],
  ["人声", "紧凑 8k 8bit", 0.15, 9, -8],
  ["严苛", "紧凑 8k 8bit", 0.05, 12, -3.5],
];

function gate(rows: Row[]): boolean {
  let ok = true;
  for (const [signal, tag, minCorr, maxLsd, maxConv] of GATE) {
    const row = rows.find(r => r.signal === signal && r.label.startsWith(tag));
    if (!row) {
      console.log(`  ✗ 门禁用例缺失：${signal} / ${tag}`);
      ok = false;
      continue;
    }
    const pass = row.corr >= minCorr && row.lsd <= maxLsd && row.conv <= maxConv;
    if (!pass) ok = false;
    console.log(
      `  ${pass ? "✓" : "✗"} ${signal} ${tag}  相关 ${row.corr} (≥${minCorr})  谱差 ${row.lsd} (≤${maxLsd})  收敛 ${row.conv} (≤${maxConv})`,
    );
  }
  return ok;
}

/* ── 主流程 ─────────────────────────────────────────────────── */

const json = process.argv.includes("--json");
const doGate = process.argv.includes("--gate");

const rows: Row[] = [];
for (const [name, gen] of SIGNALS)
  for (const c of CASES) rows.push(await runCase(name, gen, c.enc, c.double));

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`合成素材各 ${SECONDS}s，encode → synthesise 全链路，指标来自 metric.compare\n`);
  console.log(
    "信号  用例".padEnd(24) +
      "SNR dB".padStart(9) +
      "相关".padStart(8) +
      "收敛 dB".padStart(9) +
      "谱差 dB".padStart(9) +
      "耗时 ms".padStart(9),
  );
  for (const r of rows)
    console.log(
      `${r.signal.padEnd(4)} ${r.label.padEnd(18)}` +
        String(r.snr.toFixed(1)).padStart(9) +
        r.corr.toFixed(3).padStart(8) +
        r.conv.toFixed(1).padStart(9) +
        r.lsd.toFixed(1).padStart(9) +
        String(r.ms).padStart(9),
    );
  if (doGate) {
    console.log("\n质量门禁：");
    process.exitCode = gate(rows) ? 0 : 1;
  }
}

import type { Samples } from "../app/lib/arrays";
import { resample } from "../app/lib/resample.ts";

const SECS = Number(process.env.SECS ?? 60);
const SR = 44100;

const signal = (n: number, sr: number): Samples => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = 0.5 * (0.4 + 0.6 * Math.sin((2 * Math.PI * 3 * i) / sr)) * Math.sin((2 * Math.PI * 220 * i) / sr);
  return out as Samples;
};

const naive = (x: Samples, from: number, to: number): Float32Array => {
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(x.length / ratio)));
  const nyq = 0.5 * Math.min(1, to / from);
  const fc = nyq * 0.92;
  const half = Math.min(64, Math.max(3, Math.round(2 / Math.max(fc, 1e-5))));
  for (let j = 0; j < out.length; j++) {
    const center = j * ratio;
    const i0 = Math.floor(center);
    const frac = center - i0;
    let acc = 0;
    let wsum = 0;
    for (let m = 1 - half; m <= half; m++) {
      const d = m - frac;
      const t = d / (half + 0.5);
      const w =
        (d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d)) *
        (0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t));
      const i = i0 + m;
      if (i >= 0 && i < x.length) {
        acc += x[i]! * w;
        wsum += w;
      }
    }
    out[j] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
};

const failures: string[] = [];
let sink = 0;
const ms = (run: () => unknown, rounds = 3): number => {
  run();
  const at = performance.now();
  for (let i = 0; i < rounds; i++) sink += (run() as Float32Array).length;
  return (performance.now() - at) / rounds;
};

const pcm = signal(SR * SECS, SR);
console.log(`resample phase table (${SECS}s @${SR / 1000}k, ${(pcm.length / 1e6).toFixed(1)}M samples)`);
console.log("  target   table      plain          ratio");
for (const to of [8000, 16000, 48000]) {
  const table = ms(() => resample(pcm, SR, to));
  const plain = ms(() => naive(pcm, SR, to));
  const ratio = plain / table;
  console.log(
    `  ${String(to / 1000).padEnd(8)} ${table.toFixed(1).padStart(7)} ms ${plain.toFixed(1).padStart(11)} ms ${ratio.toFixed(1).padStart(8)}×`,
  );
  if (ratio < 3) failures.push(`→${to}: the phase table is only ${ratio.toFixed(1)}× faster; the cache did not take effect or was bypassed again`);
}

console.log("\ncombinations with the most distinct phases (where the phase table degrades most)");
console.log("  pair             samples       table         plain    ratio");
for (const [from, to] of [
  [11025, 16000],
  [11025, 32000],
  [22050, 32000],
  [11025, 8000],
] as [number, number][]) {
  const src = signal(from * SECS, from);
  const table = ms(() => resample(src, from, to));
  const plain = ms(() => naive(src, from, to));
  const ratio = plain / table;
  console.log(
    `${from}→${to}`.padEnd(18) +
      String(src.length).padStart(8) +
      `${table.toFixed(1)} ms`.padStart(12) +
      `${plain.toFixed(1)} ms`.padStart(14) +
      `${ratio.toFixed(2)}×`.padStart(9),
  );
  if (ratio < 1.05)
    failures.push(`${from}→${to}: the phase table is ${ratio.toFixed(2)}×, slower than per-sample computation once the phase count passes the budget`);
}

void sink;
if (failures.length) {
  console.error(`\nfailed ${failures.length} checks:`);
  for (const why of failures) console.error(`  - ${why}`);
  process.exit(1);
}
console.log("\nperformance check passed");

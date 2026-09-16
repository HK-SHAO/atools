import type { Samples } from "../app/lib/arrays";
import { loadDsp, warmKernel } from "../app/lib/dsp.ts";
import type { Encode } from "../app/lib/params";
import { resample } from "../app/lib/resample.ts";
import { encode, synthesise, type Spectrum } from "../app/lib/spectrum.ts";
import { compileWasm } from "../scripts/moon.ts";

const SECS = Number(process.env.SECS ?? 30);
const SRC_SR = 44100;
const RT_GATE = Number(process.env.RT_GATE ?? 0.05);

const TERMS = [
  [220, 0.5],
  [554.37, 0.32],
  [1318.51, 0.2],
  [3087.4, 0.11],
] as const;

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

const mk = (mode: Encode["mode"], fineness: 0 | 1 | 2 | 3 | 4, sr = 8000): Encode => ({
  mode,
  sr,
  bits: 8,
  fineness,
  fmax: 0,
  start: 0,
  end: 0,
});

const TIERS: { label: string; enc: Encode }[] = [
  { label: "win256", enc: mk("compact", 0) },
  { label: "win512", enc: mk("compact", 1) },
  { label: "win1024", enc: mk("compact", 2) },
  { label: "win2048", enc: mk("compact", 3) },
  { label: "win4096", enc: mk("compact", 4) },
  { label: "win1024 exact", enc: mk("exact", 2) },
];

interface Run {
  spec: Spectrum;
  out: Samples;
  ms: { resample: number; encode: number; synthesise: number };
}

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

warmKernel(await loadDsp(compileWasm()));

const pcm = material(Math.round(SECS * SRC_SR), SRC_SR);
const total = (r: Run): number => r.ms.resample + r.ms.encode + r.ms.synthesise;

const ROUNDS = 2;

console.log(`material ${SECS}s @ ${SRC_SR}Hz · ${TIERS.length} tiers · best of ${ROUNDS} rounds\n`);
console.log("tier        resample  encode    synthesise total   realtime  ok");
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

  if (!ok) failures.push(`${label}: ${ms(got)} for ${SECS}s of audio = ${rt.toFixed(3)}× realtime, over the ${RT_GATE}× gate`);
  for (let i = 0; i < r.out.length; i += 97)
    if (!Number.isFinite(r.out[i]!)) {
      failures.push(`${label}: sample ${i} of the output is not finite`);
      break;
    }
  let peak = 0;
  for (const v of r.out) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) failures.push(`${label}: the whole output is zero`);
  for (const lv of r.spec.levels)
    if (!Number.isFinite(lv)) {
      failures.push(`${label}: levels hold a non-finite value`);
      break;
    }
}

console.log("─".repeat(76));
if (failures.length) {
  console.log("failures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`every tier passes: within ${RT_GATE}× realtime, with finite non-zero output`);

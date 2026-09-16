import { loadDsp, warmKernel } from "../app/lib/dsp.ts";
import { Frames, olaFromPhase, padOf } from "../app/lib/stft.ts";
import { compileWasm } from "../scripts/moon.ts";

const samples = Array.from({ length: 8192 }, (_, i) => {
  const t = i / 16000;
  return (
    0.53 * Math.sin(2 * Math.PI * 233 * t) +
    0.29 * Math.sin(2 * Math.PI * 997 * t + 0.37) +
    0.11 * Math.sin(2 * Math.PI * (300 + 2100 * t) * t)
  );
});

warmKernel(await loadDsp(compileWasm()));

const compare = (win: number) => {
  const hop = win / 4;
  const frames = Math.floor(samples.length / hop) + 1;
  const core = new Frames(win);
  const padded = padOf(samples, win);
  const re: number[] = [];
  const im: number[] = [];
  const mag = new Float64Array(frames * core.bins);
  const phase = new Float64Array(mag.length);
  try {
    for (let f = 0; f < frames; f++) {
      core.analyse(padded, f * hop);
      const data = core.data();
      for (let b = 0; b < core.bins; b++) {
        const r = data.re[b]!;
        const j = data.im[b]!;
        re.push(r);
        im.push(j);
        const i = f * core.bins + b;
        mag[i] = Math.hypot(r, j);
        phase[i] = Math.atan2(j, r);
      }
    }
  } finally {
    core.close();
  }
  const result = {
    win,
    re,
    im,
    restored: Array.from(
      olaFromPhase(mag, phase, frames, core.bins, win, hop, samples.length),
    ),
  };
  return result;
};

const wins = [256, 512, 1024, 2048, 4096];
const cases = wins.map(compare);

const python = process.env.PYTHON ?? "python3";
const run = Bun.spawn([python, new URL("./librosa_ref.py", import.meta.url).pathname], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
run.stdin.write(JSON.stringify({ samples, cases }));
run.stdin.end();
if ((await run.exited) !== 0) throw new Error((await new Response(run.stderr).text()) || `无法运行 ${python}`);

interface Comparison {
  win: number;
  stft_peak: number;
  stft_rms: number;
  atools_roundtrip: number;
  librosa_roundtrip: number;
  inverse_cross: number;
}

const result = JSON.parse(await new Response(run.stdout).text()) as {
  librosa: string;
  rows: Comparison[];
};
console.log(`librosa ${result.librosa} · 8192 samples · 16 kHz · periodic Hann · center=true`);
console.log("win   STFT peak rel   STFT RMS rel");
for (const row of result.rows)
  console.log(
    `${row.win.toString().padStart(4)}   ${row.stft_peak.toExponential(3).padStart(13)}   ` +
      `${row.stft_rms.toExponential(3).padStart(12)}`,
  );

const failures = result.rows.filter(
  row => row.stft_peak > 1e-12 || row.stft_rms > 1e-12 || row.inverse_cross > 1e-6,
);
if (failures.length) {
  console.error(`超出门限：${failures.map(row => row.win).join(", ")}`);
  process.exit(1);
}

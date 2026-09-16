import type { Samples } from "../app/lib/arrays.ts";
import { decodeAudioFile } from "../app/lib/audio.ts";
import { loadDsp, warmKernel } from "../app/lib/dsp.ts";
import { compare, envelopeCorr, magnitudes, spectral } from "../app/lib/metric.ts";
import { phaseFromMagnitude } from "../app/lib/phase.ts";
import { resample } from "../app/lib/resample.ts";
import { rtisiLa } from "../app/lib/rtisi.ts";
import { Frames, olaFromPhase, padOf } from "../app/lib/stft.ts";
import { compileWasm } from "../scripts/moon.ts";

const sr = 8000;
const seconds = 2.5;
const win = 512;
const hop = 128;
const iters = 8;
const far = 32;

const CLIPS: [string, string, number][] = [
  ["演示", `${import.meta.dirname}/../app/assets/demo.ogg`, 4],
  ["语音", `${import.meta.dirname}/../fixtures/speech-nb.amr`, 6],
  ["音乐", `${import.meta.dirname}/../docs/audio-examples/love-story.m4a`, 30],
];

interface Arm {
  name: string;
  ref: Samples;
  ceiling: Samples;
  initial: Float64Array;
  local: [string, Samples][];
  magnitude: Float64Array;
  frames: number;
  bins: number;
}

const rms = (x: Samples): number => {
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i]! * x[i]!;
  return Math.sqrt(acc / Math.max(x.length, 1));
};

const score = (ref: Samples, got: Samples) => {
  const base = compare(ref, got);
  const spec = spectral(magnitudes(ref, win, hop), magnitudes(got, win, hop));
  return {
    gain: 20 * Math.log10(rms(got) / rms(ref)),
    corr: base.corr,
    snr: base.snr,
    lsd: spec.lsd,
    conv: spec.conv,
    env: envelopeCorr(ref, got, sr),
  };
};

type Row = ReturnType<typeof score>;

const line = (one: string, two: string, s: Row): string =>
  `${one.padEnd(5)} ${two.padEnd(21)}` +
  `${s.gain.toFixed(2).padStart(8)}${s.corr.toFixed(3).padStart(8)}${s.snr.toFixed(2).padStart(9)}` +
  `${s.lsd.toFixed(2).padStart(8)}${s.conv.toFixed(2).padStart(9)}${s.env.toFixed(3).padStart(8)}`;

warmKernel(await loadDsp(compileWasm()));

const arms: Arm[] = [];
for (const [name, path, start] of CLIPS) {
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw new Error(`缺素材 ${path}：相位重建对标读取本地音频，见 bench/README.md`);
  const { pcm, sr: rate } = await decodeAudioFile(await file.arrayBuffer());
  const from = Math.min(Math.round(start * rate), pcm.length - 1);
  const ref = resample(pcm.subarray(from, from + Math.round(seconds * rate)) as Samples, rate, sr);
  const frames = Math.floor(ref.length / hop) + 1;
  const bins = win / 2 + 1;
  const magnitude = magnitudes(ref, win, hop);

  const core = new Frames(win);
  const pad = padOf(ref, win);
  const truth = new Float64Array(frames * bins);
  const { re, im } = core.data();
  for (let f = 0; f < frames; f++) {
    core.analyse(pad, f * hop);
    for (let b = 0; b < bins; b++) truth[f * bins + b] = Math.atan2(im[b]!, re[b]!);
  }
  core.close();

  const initial = phaseFromMagnitude(magnitude, frames, bins, win, hop);
  const local: [string, Samples][] = [
    [
      "PGHI+RTISI-LA",
      Float32Array.from(await rtisiLa(magnitude, frames, bins, win, hop, ref.length, { iters, warm: initial })),
    ],
    [
      "RTISI-LA 零相位初值",
      Float32Array.from(await rtisiLa(magnitude, frames, bins, win, hop, ref.length, { iters, warm: null })),
    ],
  ];
  arms.push({
    name,
    ref,
    ceiling: olaFromPhase(magnitude, truth, frames, bins, win, hop, ref.length),
    initial,
    local,
    magnitude,
    frames,
    bins,
  });
}

const python = process.env.PYTHON ?? "python3";
const child = Bun.spawn([python, `${import.meta.dirname}/librosa_phase_ref.py`], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
child.stdin.write(
  JSON.stringify({
    cases: arms.map(a => ({
      name: a.name,
      magnitude: Array.from(a.magnitude),
      phase: Array.from(a.initial),
      frames: a.frames,
      bins: a.bins,
      win,
      hop,
      samples: a.ref.length,
      iters: [iters, far],
    })),
  }),
);
child.stdin.end();
if ((await child.exited) !== 0)
  throw new Error((await new Response(child.stderr).text()) || `无法运行 ${python}`);
const other = JSON.parse(await new Response(child.stdout).text()) as {
  librosa: string;
  rows: { name: string; drift: number; runs: { iters: number; random: number[]; warm: number[] }[] }[];
};

console.log(`${seconds}s @ ${sr} Hz · win ${win} · hop ${hop} · ${iters} 次迭代 · librosa ${other.librosa}\n`);
console.log(
  "素材  方法".padEnd(27) +
    "增益 dB".padStart(8) +
    "相关".padStart(8) +
    "SNR dB".padStart(9) +
    "LSD dB".padStart(8) +
    "收敛 dB".padStart(9) +
    "包络".padStart(8),
);

for (const a of arms) {
  const peer = other.rows.find(row => row.name === a.name)!;
  const head = score(a.ref, a.ceiling);
  if (head.corr < 0.999 || head.lsd > 0.05 || Math.abs(head.gain) > 0.05)
    throw new Error(`${a.name} 的真实相位上限不成立：相关 ${head.corr} LSD ${head.lsd} 增益 ${head.gain}`);
  const eight = peer.runs.find(run => run.iters === iters)!;
  const peers: [string, number[]][] = [
    ["Griffin-Lim 随机初值", eight.random],
    ["Griffin-Lim PGHI 初值", eight.warm],
  ];
  for (const [method, got] of [...a.local, ...peers.map(([tag, x]) => [tag, Float32Array.from(x)] as [string, Samples])])
    console.log(line(a.name, method, score(a.ref, got)));
  console.log(line(a.name, "真实相位（上限）", head));
  console.log("");
}

console.log(`谱收敛随迭代预算的变化（dB，越低越好）；Griffin-Lim 复现漂移 ${other.rows[0]!.drift.toExponential(1)}`);
console.log("素材   本项目 8 次   GL·PGHI 8 次   GL·随机 8 次   GL·随机 32 次");
for (const a of arms) {
  const peer = other.rows.find(row => row.name === a.name)!;
  const near = peer.runs.find(run => run.iters === iters)!;
  const away = peer.runs.find(run => run.iters === far)!;
  const conv = (got: Samples) => spectral(a.magnitude, magnitudes(got, win, hop)).conv;
  console.log(
    `${a.name.padEnd(5)} ${conv(a.local[0]![1]).toFixed(2).padStart(11)} ` +
      `${conv(Float32Array.from(near.warm)).toFixed(2).padStart(14)} ` +
      `${conv(Float32Array.from(near.random)).toFixed(2).padStart(14)} ` +
      `${conv(Float32Array.from(away.random)).toFixed(2).padStart(15)}`,
  );
}

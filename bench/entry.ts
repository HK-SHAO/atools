import { decodeAudioFile } from "../app/lib/audio";
import { startKernel } from "../app/lib/dsp";
import { align, levelGap, magnitudes, spectral } from "../app/lib/metric";
import { downloadName } from "../app/lib/container";
import { READ_TUNE, imageToSpectrum, spectrumToPng } from "../app/lib/image";
import { FINENESS, type Encode, type Mode } from "../app/lib/params";
import { resample, slice } from "../app/lib/resample";
import { encode, synthesise, type Spectrum } from "../app/lib/spectrum";
import { TUNE } from "../app/lib/phase";
import type { Samples } from "../app/lib/arrays";

await startKernel({ fft: true });

interface Case {
  sr: number;
  bits: number;
  fineness: 0 | 1 | 2;
  fmax: number;
  mode: Mode;
  via:
    | "png"
    | "jpeg"
    | "half"
    | "jpeg-anon"
    | "half-anon"
    | "s75"
    | "s90"
    | "jpeg75"
    | "none";
}

interface Metrics {
  snr: number;
  corr: number;
  conv: number;
  lsd: number;
  magSnr: number;
  levelGap: number;
}

export interface Row {
  file: string;
  group: string;
  case: string;
  ms: number;
  bytes: number;
  frames: number;
  bins: number;
  seconds: number;
  rel: number | null;
  readMode: string;
  m: Metrics;
}

const log10 = Math.log10;

function magSnr(ref: Samples, spec: Spectrum): number {
  const { meta, levels } = spec;
  const { win, hop, bins, frames } = meta;
  const scale = win / 4;
  const truth = magnitudes(ref, win, hop);
  let se = 0;
  let sa = 0;
  const n = Math.min(frames * bins, truth.length);
  for (let i = 0; i < n; i++) {
    const f = Math.floor(i / bins);
    const b = i % bins;
    const t = truth[f * (win / 2 + 1) + b]!;
    const db = targetDb(levels[i]!, meta);
    const got = Math.pow(10, db / 20) * scale;
    const d = got - t;
    se += d * d;
    sa += t * t;
  }
  return 10 * log10(Math.max(sa, 1e-30) / Math.max(se, 1e-30));
}

function targetDb(level: number, meta: Spectrum["meta"]): number {
  const bits = Math.max(1, meta.bits || 8);
  const steps = (1 << bits) - 1;
  const span = 12 * bits;
  const q = Math.round((level * steps) / 255);
  return (meta.exact ? -120 : meta.ref - span) + (q / steps) * (meta.exact ? 120 : span);
}

const VIA_SPEC: Record<string, { scale: number; type: "image/png" | "image/jpeg" }> = {
  png: { scale: 1, type: "image/png" },
  jpeg: { scale: 1, type: "image/jpeg" },
  half: { scale: 0.5, type: "image/png" },
  s75: { scale: 0.75, type: "image/png" },
  s90: { scale: 0.9, type: "image/png" },
  jpeg75: { scale: 0.75, type: "image/jpeg" },
};

async function degrade(blob: Blob, via: Case["via"]): Promise<Blob> {
  if (via === "png") return blob;
  const spec = VIA_SPEC[via]!;
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const w = Math.max(1, Math.round(bitmap.width * spec.scale));
  const h = Math.max(1, Math.round(bitmap.height * spec.scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await new Promise<Blob | null>(done => canvas.toBlob(done, spec.type, 0.72));
  canvas.width = 0;
  canvas.height = 0;
  return out ?? blob;
}

export async function loadAudio(url: string): Promise<{ pcm: Samples; sr: number }> {
  const cached = await fetch(url.replace(/^\/audio\//, "/pcm/")).catch(() => null);
  if (cached?.ok) {
    const buf = await cached.arrayBuffer();
    const sr = new DataView(buf).getUint32(0, true);
    return { pcm: new Float32Array(buf, 4), sr };
  }
  const bytes = await (await fetch(url)).arrayBuffer();
  return decodeAudioFile(bytes);
}

export function setTune(
  t: Partial<{
    pghi: boolean;
    momentum: number;
    gamma: number;
    rtisi: boolean;
    rtisiIters: number;
    rtisiBudget: number;
    rtisiGl: number;
    relaxFloor: boolean;
    phaseReliable: number;
    phaseDeadZone: number;
    anchorLambda: number;
    fine: Partial<{ rtisiIters: number; rtisiBudget: number; glIters: number; glBudgetMs: number }>;
  }>,
): string {
  if (t.pghi !== undefined) TUNE.pghi = t.pghi;
  if (t.momentum !== undefined) TUNE.momentum = t.momentum;
  if (t.gamma !== undefined) TUNE.gamma = t.gamma;
  if (t.rtisi !== undefined) TUNE.rtisi = t.rtisi;
  if (t.rtisiIters !== undefined) TUNE.rtisiIters = t.rtisiIters;
  if (t.rtisiBudget !== undefined) TUNE.rtisiBudget = t.rtisiBudget;
  if (t.rtisiGl !== undefined) TUNE.rtisiGl = t.rtisiGl;
  if (t.relaxFloor !== undefined) TUNE.relaxFloor = t.relaxFloor;
  if (t.phaseReliable !== undefined) READ_TUNE.phaseReliable = t.phaseReliable;
  if (t.phaseDeadZone !== undefined) TUNE.deadZone = t.phaseDeadZone;
  if (t.anchorLambda !== undefined) TUNE.anchorLambda = t.anchorLambda;
  if (t.fine) Object.assign(TUNE.fine, t.fine);
  return JSON.stringify(TUNE);
}

export async function runCase(
  srcPcm: Samples,
  srcSr: number,
  name: string,
  c: Case,
  group = "",
): Promise<Row> {
  const t0 = performance.now();
  const enc: Encode = {
    mode: c.mode,
    sr: c.sr,
    bits: c.bits,
    fineness: c.fineness,
    fmax: c.fmax,
    start: 0,
    end: 0,
  };
  const sr = c.sr > 0 ? c.sr : srcSr;
  const tuned = resample(slice(srcPcm, srcSr, 0, 0), srcSr, sr, c.mode === "compact" ? c.fmax : 0);

  const spec = await encode(tuned, sr, enc);
  let back = spec;
  let bytes = 0;
  let rel: number | null = null;
  let dims = "?";
  let readMode = "";
  if (c.via !== "none") {
    const png = await spectrumToPng(spec);
    const anon = c.via.endsWith("-anon");
    const viaKey = (anon ? c.via.slice(0, -5) : c.via) as Case["via"];
    const isJpeg = viaKey.startsWith("jpeg");
    const fileName = anon
      ? isJpeg
        ? "untitled.jpg"
        : "untitled.png"
      : downloadName(name, spec.meta);
    const degraded = await degrade(png, viaKey);
    bytes = degraded.size;
    const read = await imageToSpectrum(degraded, fileName);
    back = read.spec;
    rel = read.phaseReliability;
    readMode = read.mode;
    dims = `${read.width}x${read.height}`;
  }
  const quality = new URLSearchParams(location.search).get("synth") === "fine" ? "fine" : "fast";
  const y = await synthesise(back, undefined, undefined, quality);

  const ref = tuned.subarray(0, Math.min(tuned.length, y.length)) as Samples;
  const a = align(ref, y, Math.min(2048, Math.floor(ref.length / 4)));
  const win = 1024;
  const hop = 256;
  const s = spectral(magnitudes(ref, win, hop), magnitudes(y, win, hop));

  return {
    file: name,
    group,
    case: `${c.mode}/${c.sr || "原"}/${c.bits}b/${FINENESS[c.fineness]!.label}/${c.via}/${(back.meta.samples / back.meta.sr).toFixed(2)}s/${dims}`,
    ms: Math.round(performance.now() - t0),
    bytes,
    frames: spec.meta.frames,
    bins: spec.meta.bins,
    seconds: Math.round((spec.meta.samples / sr) * 10) / 10,
    rel,
    readMode,
    m: {
      snr: Math.round(a.snr * 10) / 10,
      corr: Math.round(a.corr * 1000) / 1000,
      conv: Math.round(s.conv * 10) / 10,
      lsd: Math.round(s.lsd * 10) / 10,
      magSnr: Math.round(magSnr(ref, back) * 10) / 10,
      levelGap: levelGap(spec, back),
    },
  };
}

export async function pngCheck(bits: number[]): Promise<string[]> {
  const out: string[] = [];
  for (const b of bits) {
    const frames = 37;
    const bins = 129;
    const levels = new Uint8Array(frames * bins);
    for (let i = 0; i < levels.length; i++) levels[i] = (i * 7) % 256;
    const spec: Spectrum = {
      meta: { sr: 8000, win: 256, hop: 64, frames, bins, samples: frames * 64, bits: b, ref: 0, exact: false },
      levels,
      phaseCos: null,
      phaseSin: null,
    };
    try {
      const blob = await spectrumToPng(spec);
      const { spec: back } = await imageToSpectrum(blob, downloadName("probe", spec.meta));
      out.push(`${b} bit: ${blob.size}B  层级最大偏差 ${levelGap(spec, back)}`);
    } catch (e) {
      out.push(`${b} bit: 失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

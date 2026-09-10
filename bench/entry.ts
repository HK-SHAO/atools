import { decodeAudioFile } from "../src/lib/audio";
import { FFT, hannWindow } from "../src/lib/fft";
import { READ_TUNE, imageToSpectrum, downloadName, spectrumToPng } from "../src/lib/image";
import { FINENESS, type Encode, type Mode } from "../src/lib/params";
import { SYNTH_TUNE } from "../src/lib/spectrum";
import { resample, slice } from "../src/lib/resample";
import { encode, synthesise, type Spectrum } from "../src/lib/spectrum";
import { phaseFromMagnitude, TUNE } from "../src/lib/phase";
import type { Samples } from "../src/lib/arrays";

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
  levelErr: number;
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

interface NeuralWeights {
  c1w: number[][][][];
  c1b: number[];
  c2w: number[][][][];
  c2b: number[];
  fcw: number[][];
  fcb: number[];
  patch: number;
}
let NEURAL: NeuralWeights | null = null;

export function setNeural(w: NeuralWeights | null): void {
  NEURAL = w;
}

function neuralRefine(spec: Spectrum): number {
  if (!NEURAL || !spec.phaseCos || !spec.phaseSin || !spec.phaseW) return 0;
  if (NEURAL.patch !== 7) throw new Error("neuralRefine 仅支持 patch=7");
  const { frames: F, bins: B } = spec.meta;
  const Pt = 7;
  const { c1w, c1b, c2w, c2b, fcw, fcb } = NEURAL;
  const W = c1w.length;
  const cos = spec.phaseCos;
  const sin = spec.phaseSin;
  const w = spec.phaseW;
  const lv = spec.levels;
  let lvMax = 0;
  for (let i = 0; i < lv.length; i++) if (lv[i]! > lvMax) lvMax = lv[i]!;
  const outC = new Uint8Array(cos);
  const outS = new Uint8Array(sin);
  const ch = new Float64Array(6 * Pt * Pt);
  const a1 = new Float64Array(W * 9);
  const feat = new Float64Array(W);
  let done = 0;
  for (let f = 0; f < F; f++) {
    for (let b = 0; b < B; b++) {
      const i = f * B + b;
      if (w[i]! === 0 || lv[i]! < lvMax * 0.05) continue;
      for (let df = 0; df < Pt; df++) {
        const ff = Math.min(F - 1, Math.max(0, f + df - 3));
        const fp = (ff / Math.max(F - 1, 1)) * 2 - 1;
        for (let db = 0; db < Pt; db++) {
          const bb = Math.min(B - 1, Math.max(0, b + db - 3));
          const j = ff * B + bb;
          const base = df * Pt + db;
          ch[base] = (cos[j]! - 127.5) / 127.5;
          ch[Pt * Pt + base] = (sin[j]! - 127.5) / 127.5;
          ch[2 * Pt * Pt + base] = (lv[j]! / 65535) * 2 - 1;
          ch[3 * Pt * Pt + base] = w[j]! / 127.5 - 1;
          ch[4 * Pt * Pt + base] = fp;
          ch[5 * Pt * Pt + base] = (bb / Math.max(B - 1, 1)) * 2 - 1;
        }
      }
      for (let o = 0; o < W; o++) {
        const cw = c1w[o]!;
        for (let y = 0; y < 3; y++)
          for (let x = 0; x < 3; x++) {
            let v = c1b[o]!;
            for (let c = 0; c < 6; c++)
              for (let k = 0; k < 5; k++)
                for (let l = 0; l < 5; l++)
                  v += cw[c]![k]![l]! * ch[(c * Pt + y + k) * Pt + x + l]!;
            a1[o * 9 + y * 3 + x] = v > 0 ? v : 0;
          }
      }
      for (let o = 0; o < W; o++) {
        const kw = c2w[o]!;
        let v = c2b[o]!;
        for (let m = 0; m < W; m++)
          for (let k = 0; k < 3; k++)
            for (let l = 0; l < 3; l++)
              v += kw[m]![k]![l]! * a1[m * 9 + k * 3 + l]!;
        feat[o] = v > 0 ? v : 0;
      }
      let dx = fcb[0]!;
      let dy = fcb[1]!;
      for (let m = 0; m < W; m++) {
        dx += fcw[0]![m]! * feat[m]!;
        dy += fcw[1]![m]! * feat[m]!;
      }
      const cr = (cos[i]! - 127.5) / 127.5 + dx;
      const cs = (sin[i]! - 127.5) / 127.5 + dy;
      const h = Math.hypot(cr, cs);
      const k = h > 1e-6 ? 127.5 / h : 0;
      outC[i] = Math.max(0, Math.min(255, Math.round(cr * k + 127.5)));
      outS[i] = Math.max(0, Math.min(255, Math.round(cs * k + 127.5)));
      done++;
    }
  }
  spec.phaseCos = outC;
  spec.phaseSin = outS;
  return done;
}

function stftPhase(x: Samples, win: number, hop: number, frames: number): { cos: Uint8Array; sin: Uint8Array } {
  const bins = win / 2 + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const pad = new Float64Array(x.length + win);
  for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const cos = new Uint8Array(frames * bins);
  const sin = new Uint8Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) {
      const mg = Math.hypot(re[b]!, im[b]!);
      const i = f * bins + b;
      if (mg < 1e-12) {
        cos[i] = 127;
        sin[i] = 127;
        continue;
      }
      cos[i] = Math.max(0, Math.min(255, Math.round((re[b]! / mg) * 127.5 + 127.5)));
      sin[i] = Math.max(0, Math.min(255, Math.round((im[b]! / mg) * 127.5 + 127.5)));
    }
  }
  return { cos, sin };
}

function resamplePhase(
  cos: Uint8Array,
  sin: Uint8Array,
  F: number,
  B: number,
  F2: number,
  B2: number,
): { cos: Uint8Array; sin: Uint8Array } {
  const outC = new Uint8Array(F2 * B2);
  const outS = new Uint8Array(F2 * B2);
  for (let f = 0; f < F2; f++) {
    const tf = F2 > 1 ? (f / (F2 - 1)) * (F - 1) : 0;
    const f0 = Math.min(F - 1, Math.floor(tf));
    const f1 = Math.min(F - 1, f0 + 1);
    const af = tf - f0;
    for (let b = 0; b < B2; b++) {
      const tb = B2 > 1 ? (b / (B2 - 1)) * (B - 1) : 0;
      const b0 = Math.min(B - 1, Math.floor(tb));
      const b1 = Math.min(B - 1, b0 + 1);
      const ab = tb - b0;
      let cr = 0;
      let cs = 0;
      for (const [ff, wf] of [[f0, 1 - af], [f1, af]] as const)
        for (const [bb, wb] of [[b0, 1 - ab], [b1, ab]] as const) {
          const i = ff * B + bb;
          const wt = wf * wb;
          cr += ((cos[i]! - 127.5) / 127.5) * wt;
          cs += ((sin[i]! - 127.5) / 127.5) * wt;
        }
      const h = Math.hypot(cr, cs);
      const k = h > 1e-6 ? 127.5 / h : 0;
      outC[f * B2 + b] = Math.max(0, Math.min(255, Math.round(cr * k + 127.5)));
      outS[f * B2 + b] = Math.max(0, Math.min(255, Math.round(cs * k + 127.5)));
    }
  }
  return { cos: outC, sin: outS };
}

export async function dumpPair(srcPcm: Samples, srcSr: number, c: Case): Promise<string> {
  const enc: Encode = { mode: c.mode, sr: c.sr, bits: c.bits, fineness: c.fineness, fmax: c.fmax, start: 0, end: 0 };
  const sr = c.sr > 0 ? c.sr : srcSr;
  const tuned = resample(slice(srcPcm, srcSr, 0, 0), srcSr, sr, c.mode === "compact" ? c.fmax : 0);
  const spec = await encode(tuned, sr, enc);
  const png = await spectrumToPng(spec);
  const viaKey = (c.via.endsWith("-anon") ? c.via.slice(0, -5) : c.via) as Case["via"];
  const degraded = await degrade(png, viaKey);
  const read = await imageToSpectrum(degraded, "untitled.png");
  const { win, hop, frames, bins, bits, ref, exact } = read.spec.meta;
  const encFrames = spec.meta.frames;
  const encBins = spec.meta.bins;
  const truth = stftPhase(tuned as Samples, spec.meta.win, spec.meta.hop, encFrames);
  const aligned =
    encFrames === frames && encBins === bins
      ? truth
      : resamplePhase(truth.cos, truth.sin, encFrames, encBins, frames, bins);
  const head = new ArrayBuffer(40);
  const dv = new DataView(head);
  dv.setUint32(0, frames, true);
  dv.setUint32(4, bins, true);
  dv.setUint32(8, win, true);
  dv.setUint32(12, hop, true);
  dv.setUint32(16, sr, true);
  dv.setUint32(20, bits, true);
  dv.setUint32(24, exact ? 1 : 0, true);
  dv.setFloat32(28, ref, true);
  dv.setUint32(36, read.spec.phaseW ? 1 : 0, true);
  const lv = new Uint16Array(read.spec.levels.length);
  for (let i = 0; i < lv.length; i++) lv[i] = read.spec.levels[i]!;
  const parts: BlobPart[] = [head, lv];
  for (const arr of [read.spec.phaseCos, read.spec.phaseSin, read.spec.phaseW]) {
    if (!arr) return "";
    parts.push(Uint8Array.from(arr));
  }
  parts.push(aligned.cos as BlobPart, aligned.sin as BlobPart);
  const buf = await new Blob(parts).arrayBuffer();
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000)
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function atRate(pcm: Samples, sr: number, to: number): { pcm: Samples; sr: number } {
  return { pcm: resample(pcm, sr, to, 0), sr: to };
}

function align(a: Samples, b: Samples, span: number): { corr: number; snr: number } {
  const n = Math.min(a.length, b.length);
  let best = 0;
  let bv = -2;
  for (let lag = -span; lag <= span; lag++) {
    let sa = 0;
    let sb = 0;
    let sab = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      sa += a[i]! * a[i]!;
      sb += b[j]! * b[j]!;
      sab += a[i]! * b[j]!;
    }
    const v = sab / Math.sqrt(Math.max(sa * sb, 1e-30));
    if (v > bv) {
      bv = v;
      best = lag;
    }
  }
  let sa = 0;
  let se = 0;
  for (let i = 0; i < n; i++) {
    const j = i + best;
    if (j < 0 || j >= n) continue;
    const d = a[i]! - b[j]!;
    sa += a[i]! * a[i]!;
    se += d * d;
  }
  return { corr: bv, snr: 10 * log10(Math.max(sa, 1e-30) / Math.max(se, 1e-30)) };
}

function chunkCorr(a: Samples, b: Samples, chunk: number, span: number): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let cnt = 0;
  for (let s = 0; s + chunk <= n; s += chunk) {
    let best = -2;
    for (let lag = -span; lag <= span; lag++) {
      let sa = 0;
      let sb = 0;
      let sab = 0;
      for (let i = s; i < s + chunk; i++) {
        const j = i + lag;
        if (j < 0 || j >= n) continue;
        sa += a[i]! * a[i]!;
        sb += b[j]! * b[j]!;
        sab += a[i]! * b[j]!;
      }
      const v = sab / Math.sqrt(Math.max(sa * sb, 1e-30));
      if (v > best) best = v;
    }
    sum += best;
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}

function magnitudes(x: Samples, win: number, hop: number): Float64Array {
  const fft = new FFT(win);
  const w = hannWindow(win);
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const pad = new Float64Array(x.length + win);
  for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const out = new Float64Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) out[f * bins + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
  }
  return out;
}

function spectral(ref: Float64Array, got: Float64Array): { conv: number; lsd: number } {
  const n = Math.min(ref.length, got.length);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = ref[i]! - got[i]!;
    num += d * d;
    den += ref[i]! * ref[i]!;
  }
  const conv = 10 * log10(Math.max(num, 1e-30) / Math.max(den, 1e-30));

  let topA = 0;
  let topB = 0;
  for (let i = 0; i < n; i++) {
    if (ref[i]! > topA) topA = ref[i]!;
    if (got[i]! > topB) topB = got[i]!;
  }
  const floorA = Math.log(Math.max(topA, 1e-30)) - 80 / 8.686;
  const floorB = Math.log(Math.max(topB, 1e-30)) - 80 / 8.686;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const la = Math.max(Math.log(Math.max(ref[i]!, 1e-30)), floorA);
    const lb = Math.max(Math.log(Math.max(got[i]!, 1e-30)), floorB);
    const d = (la - floorA) - (lb - floorB);
    acc += d * d;
  }
  return { conv, lsd: 8.686 * Math.sqrt(acc / Math.max(n, 1)) };
}

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

const VIA_SPEC: Record<
  string,
  { scale: number; type: "image/png" | "image/jpeg" }
> = {
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
    iters: number;
    momentum: number;
    gamma: number;
    rtisi: boolean;
    rtisiIters: number;
    rtisiGl: number;
    phaseReliable: number;
    phaseDeadZone: number;
    anchorLambda: number;
    fine: Partial<{ rtisiIters: number; rtisiBudget: number; glIters: number; glBudgetMs: number }>;
  }>,
): string {
  if (t.pghi !== undefined) TUNE.pghi = t.pghi;
  if (t.iters !== undefined) TUNE.iters = t.iters;
  if (t.momentum !== undefined) TUNE.momentum = t.momentum;
  if (t.gamma !== undefined) TUNE.gamma = t.gamma;
  if (t.rtisi !== undefined) TUNE.rtisi = t.rtisi;
  if (t.rtisiIters !== undefined) TUNE.rtisiIters = t.rtisiIters;
  if (t.rtisiGl !== undefined) TUNE.rtisiGl = t.rtisiGl;
  if (t.phaseReliable !== undefined) READ_TUNE.phaseReliable = t.phaseReliable;
  if (t.phaseDeadZone !== undefined) SYNTH_TUNE.phaseDeadZone = t.phaseDeadZone;
  if (t.anchorLambda !== undefined) TUNE.anchorLambda = t.anchorLambda;
  if (t.fine) Object.assign(TUNE.fine, t.fine);
  return JSON.stringify(TUNE);
}

export async function synthProbe(
  pcm: Samples,
  sr: number,
  win: number,
  hop: number,
  bits: number,
  seconds = 4,
): Promise<string> {
  const x = pcm.subarray(0, Math.min(pcm.length, Math.floor(sr * seconds))) as Samples;
  const samples = x.length;
  const bins = win / 2 + 1;
  const frames = Math.floor(samples / hop) + 1;
  const scale = win / 4;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const padded = samples + win;
  const pad = new Float64Array(padded);
  for (let i = 0; i < samples; i++) pad[win / 2 + i] = x[i]!;

  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(frames * bins);
  const truth = new Float64Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
      truth[f * bins + b] = Math.atan2(im[b]!, re[b]!);
    }
  }

  let peak = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i]! > peak) peak = mag[i]!;
  const span = bits * 12;
  const steps = (1 << bits) - 1;
  const ref = 20 * Math.log10(Math.max(peak, 1e-30) / scale) + 1;
  const floorDb = ref - span;
  const levels = new Uint8Array(frames * bins);
  const target = new Float64Array(frames * bins);
  for (let i = 0; i < levels.length; i++) {
    const db = 20 * Math.log10(Math.max(mag[i]!, 1e-30) / scale);
    const q = Math.round(((db - floorDb) / span) * steps);
    const c = q <= 0 ? 0 : q >= steps ? steps : q;
    levels[i] = Math.round((c * 255) / steps);
    target[i] = Math.pow(10, (floorDb + (c / steps) * span) / 20) * scale;
  }
  const spec: Spectrum = {
    meta: { sr, win, hop, frames, bins, samples, bits, ref, exact: false },
    levels,
    phaseCos: null,
    phaseSin: null,
  };

  const wola = (ph: Float64Array): Samples => {
    const acc = new Float64Array(padded);
    const cover = new Float64Array(padded);
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < bins; b++) {
        re[b] = target[f * bins + b]! * Math.cos(ph[f * bins + b]!);
        im[b] = target[f * bins + b]! * Math.sin(ph[f * bins + b]!);
      }
      im[0] = 0;
      im[bins - 1] = 0;
      for (let b = 1; b < bins - 1; b++) {
        re[win - b] = re[b]!;
        im[win - b] = -im[b]!;
      }
      fft.transform(re, im, true);
      for (let m = 0; m < win; m++) {
        acc[f * hop + m] = acc[f * hop + m]! + re[m]! * w[m]!;
        cover[f * hop + m] = cover[f * hop + m]! + w[m]! * w[m]!;
      }
    }
    let top = 0;
    for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++)
      out[i] = cover[win / 2 + i]! > top * 0.05 ? acc[win / 2 + i]! / cover[win / 2 + i]! : 0;
    return out;
  };

  const ref0 = x as Samples;
  const show = (label: string, y: Samples, ms: number): string => {
    const a = align(ref0, y, Math.min(2048, Math.floor(samples / 4)));
    const s = spectral(magnitudes(ref0, 1024, 256), magnitudes(y, 1024, 256));
    const cc = chunkCorr(ref0, y, Math.round(sr * 0.05), Math.round(sr * 0.012));
    return `${label} ${a.snr.toFixed(1)}dB/${a.corr.toFixed(3)}/窗内${cc.toFixed(3)}/LSD${s.lsd.toFixed(1)}/${Math.round(ms)}ms`;
  };

  const out: string[] = [];
  let t = performance.now();
  out.push(show("上限", wola(truth), performance.now() - t));

  const gl0 = TUNE.rtisiGl;
  const runs: [string, () => Promise<Samples>][] = [
    ["PGHI+GL", () => (TUNE.rtisi = false, synthesise(spec))],
    ["RTISI", () => {
      TUNE.rtisi = true;
      TUNE.rtisiGl = 0;
      return synthesise(spec);
    }],
    ["RTISI+GL", () => {
      TUNE.rtisi = true;
      TUNE.rtisiGl = gl0;
      return synthesise(spec);
    }],
  ];
  for (const [label, go] of runs) {
    t = performance.now();
    const y = await go();
    out.push(show(label, y, performance.now() - t));
  }
  return `win=${win} hop=${hop} ${bits}bit  ${out.join("  ")}`;
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
  if (NEURAL && back.phaseCos) neuralRefine(back);
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
      levelErr: levelErr(spec, back),
    },
  };
}

function levelErr(a: Spectrum, b: Spectrum): number {
  const n = Math.min(a.levels.length, b.levels.length);
  if (n === 0 || a.meta.bins !== b.meta.bins) return 255;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.levels[i]! - b.levels[i]!);
    if (d > worst) worst = d;
  }
  return worst;
}

async function sigProbeBlob(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: "none" });
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  bitmap.close();
  canvas.width = 0;
  canvas.height = 0;
  const rows = Math.floor(h / 2);
  const stepX = Math.max(1, Math.floor(w / 48));
  const stepY = Math.max(1, Math.floor(rows / 24));
  let total = 0;
  let okB = 0;
  let okR = 0;
  let ok = 0;
  let bMax = 0;
  let rMin = 1e9;
  let rMax = 0;
  for (let y = 0; y < rows; y += stepY)
    for (let x = 0; x < w; x += stepX) {
      const p = ((rows + y) * w + x) * 4;
      total++;
      const b = px[p + 2]!;
      if (b > bMax) bMax = b;
      if (b <= 48) okB++;
      const cr = px[p]! - 127.5;
      const cs = px[p + 1]! - 127.5;
      const r = Math.sqrt(cr * cr + cs * cs);
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (r >= 20 && r <= 200) okR++;
      if (b <= 48 && r >= 20 && r <= 200) ok++;
    }
  const hit = await imageToSpectrum(new Blob([bytes.slice()]), "untitled.bin");
  return (
    `${w}×${h} rows=${rows} 采样 ${total}  B≤48: ${((okB / total) * 100).toFixed(0)}% (max ${bMax})  ` +
    `半径20-200: ${((okR / total) * 100).toFixed(0)}% (${rMin.toFixed(0)}..${rMax.toFixed(0)})  ` +
    `全过: ${((ok / total) * 100).toFixed(0)}%  → 认图 ${hit.mode}${hit.guessed ? "/guessed" : ""} rel=${hit.phaseReliability?.toFixed(2) ?? "-"}`
  );
}

export async function sigProbe(
  srcPcm: Samples,
  srcSr: number,
  via: Case["via"],
): Promise<string> {
  const enc: Encode = { mode: "exact", sr: 0, bits: 8, fineness: 1, fmax: 0, start: 0, end: 0 };
  const sr = srcSr;
  const tuned = resample(slice(srcPcm, srcSr, 0, 0), srcSr, sr, 0);
  const spec = await encode(tuned, sr, enc);
  const png = await spectrumToPng(spec);
  const anon = via.endsWith("-anon");
  const viaKey = (anon ? via.slice(0, -5) : via) as Case["via"];
  const degraded = await degrade(png, viaKey);
  return sigProbeBlob(new Uint8Array(await degraded.arrayBuffer()));
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
      out.push(`${b} bit: ${blob.size}B  层级最大偏差 ${levelErr(spec, back)}`);
    } catch (e) {
      out.push(`${b} bit: 失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export function phaseProbe(
  pcm: Samples,
  sr: number,
  win: number,
  hop: number,
  gamma: number | null,
  seconds = 3,
): string {
  if (gamma !== null) TUNE.gamma = gamma;
  const x = pcm.subarray(0, Math.min(pcm.length, Math.floor(sr * seconds))) as Samples;
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const pad = new Float64Array(x.length + win);
  for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(frames * bins);
  const truth = new Float64Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
      truth[f * bins + b] = Math.atan2(im[b]!, re[b]!);
    }
  }
  const est = phaseFromMagnitude(mag, frames, bins, win, hop);
  let cr = 0;
  let ci = 0;
  let den0 = 0;
  for (let i = 0; i < mag.length; i++) {
    const wt = mag[i]! ** 2;
    const d = est[i]! - truth[i]!;
    cr += wt * Math.cos(d);
    ci += wt * Math.sin(d);
    den0 += wt;
  }
  const k = Math.atan2(ci, cr);
  let num = 0;
  for (let i = 0; i < mag.length; i++) {
    const wt = mag[i]! ** 2;
    let d = est[i]! - truth[i]! - k;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    num += wt * d * d;
  }
  const raw = Math.sqrt((1 - Math.hypot(cr, ci) / den0) * 2);
  const rms = (Math.sqrt(num / Math.max(den0, 1e-30)) * 180) / Math.PI;
  return (
    `win=${win} hop=${hop} a/M=${(hop / win).toFixed(3)} γ=${TUNE.gamma}  ` +
    `总误差 ${((raw * 180) / Math.PI).toFixed(0)}°  常数 ${((k * 180) / Math.PI).toFixed(0)}°  ` +
    `去常数后 ${rms.toFixed(0)}°`
  );
}

export function reconProbe(
  pcm: Samples,
  sr: number,
  win: number,
  hop: number,
  quant: number,
  seconds = 3,
): string {
  const x = pcm.subarray(0, Math.min(pcm.length, Math.floor(sr * seconds))) as Samples;
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const padded = x.length + win;
  const pad = new Float64Array(padded);
  for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;

  const re = new Float64Array(win);
  const im = new Float64Array(win);
  let mag = new Float64Array(frames * bins);
  const truth = new Float64Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
      truth[f * bins + b] = Math.atan2(im[b]!, re[b]!);
    }
  }

  if (quant > 0) {
    let peak = 0;
    for (let i = 0; i < mag.length; i++) if (mag[i]! > peak) peak = mag[i]!;
    const span = quant * 12;
    const steps = (1 << quant) - 1;
    const lo = Math.log10(Math.max(peak, 1e-30)) - span / 20;
    const q = new Float64Array(mag.length);
    for (let i = 0; i < mag.length; i++) {
      const db = 20 * Math.log10(Math.max(mag[i]!, 1e-30));
      const t = Math.round(((db - 20 * lo) / span) * steps);
      q[i] = Math.pow(10, (20 * lo + (Math.max(0, Math.min(steps, t)) / steps) * span) / 20);
    }
    mag = q;
  }

  const synth = (ph: Float64Array): Float64Array => {
    const acc = new Float64Array(padded);
    const cover = new Float64Array(padded);
    for (let f = 0; f < frames; f++) {
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        re[b] = mag[base + b]! * Math.cos(ph[base + b]!);
        im[b] = mag[base + b]! * Math.sin(ph[base + b]!);
      }
      im[0] = 0;
      im[bins - 1] = 0;
      for (let b = 1; b < bins - 1; b++) {
        re[win - b] = re[b]!;
        im[win - b] = -im[b]!;
      }
      fft.transform(re, im, true);
      for (let m = 0; m < win; m++) {
        acc[f * hop + m] = acc[f * hop + m]! + re[m]! * w[m]!;
        cover[f * hop + m] = cover[f * hop + m]! + w[m]! * w[m]!;
      }
    }
    let top = 0;
    for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
    const out = new Float64Array(x.length);
    for (let i = 0; i < out.length; i++)
      out[i] = cover[win / 2 + i]! > top * 0.05 ? acc[win / 2 + i]! / cover[win / 2 + i]! : 0;
    return out;
  };

  const gl = (ph: Float64Array, iters: number): Float64Array => {
    const cover = new Float64Array(padded);
    for (let f = 0; f < frames; f++)
      for (let m = 0; m < win; m++) cover[f * hop + m] = cover[f * hop + m]! + w[m]! * w[m]!;
    let top = 0;
    for (let i = 0; i < padded; i++) if (cover[i]! > top) top = cover[i]!;
    const cur = synth(ph);
    const buf = new Float64Array(padded);
    for (let i = 0; i < x.length; i++) buf[win / 2 + i] = cur[i]!;
    for (let it = 0; it < iters; it++) {
      const acc = new Float64Array(padded);
      const cc = new Float64Array(padded);
      for (let f = 0; f < frames; f++) {
        const base = f * bins;
        for (let m = 0; m < win; m++) {
          re[m] = buf[f * hop + m]! * w[m]!;
          im[m] = 0;
        }
        fft.transform(re, im);
        for (let b = 0; b < bins; b++) {
          const d = Math.sqrt(re[b]! ** 2 + im[b]! ** 2) || 1e-30;
          re[b] = (re[b]! / d) * mag[base + b]!;
          im[b] = (im[b]! / d) * mag[base + b]!;
        }
        im[0] = 0;
        im[bins - 1] = 0;
        for (let b = 1; b < bins - 1; b++) {
          re[win - b] = re[b]!;
          im[win - b] = -im[b]!;
        }
        fft.transform(re, im, true);
        for (let m = 0; m < win; m++) {
          acc[f * hop + m] = acc[f * hop + m]! + re[m]! * w[m]!;
          cc[f * hop + m] = cc[f * hop + m]! + w[m]! * w[m]!;
        }
      }
      for (let i = 0; i < padded; i++)
        buf[i] = cc[i]! > top * 0.05 ? acc[i]! / cc[i]! : 0;
    }
    const out = new Float64Array(x.length);
    for (let i = 0; i < out.length; i++) out[i] = buf[win / 2 + i]!;
    return out;
  };

  const rand = (): Float64Array => {
    const p = new Float64Array(mag.length);
    let s = 0x9e3779b9;
    for (let i = 0; i < p.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      p[i] = ((s >>> 0) / 0xffffffff) * 2 * Math.PI - Math.PI;
    }
    return p;
  };

  const fit = (y: Float64Array): number => {
    const full = new Float64Array(padded);
    for (let i = 0; i < y.length; i++) full[win / 2 + i] = y[i]!;
    let num = 0;
    let den = 0;
    for (let f = 0; f < frames; f++) {
      for (let m = 0; m < win; m++) {
        re[m] = full[f * hop + m]! * w[m]!;
        im[m] = 0;
      }
      fft.transform(re, im);
      for (let b = 0; b < bins; b++) {
        const got = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
        num += (got - mag[f * bins + b]!) ** 2;
        den += mag[f * bins + b]! ** 2;
      }
    }
    return 10 * Math.log10(Math.max(den, 1e-30) / Math.max(num, 1e-30));
  };

  const pghi = phaseFromMagnitude(mag, frames, bins, win, hop);
  const ref = x as Samples;
  const show = (label: string, y: Float64Array) => {
    const a = align(ref, Float32Array.from(y) as Samples, Math.min(2048, Math.floor(x.length / 4)));
    return `${label} ${a.snr.toFixed(1)}dB/${a.corr.toFixed(3)}/谱拟合${fit(y).toFixed(1)}`;
  };

  return (
    `win=${win} hop=${hop}${quant ? ` ${quant}bit` : " 未量化"}  ` +
    [
      show("真相位", synth(truth)),
      show("PGHI", synth(pghi)),
      show("PGHI+GL30", gl(pghi, 30)),
      show("PGHI+GL300", gl(pghi, 300)),
      show("随机+GL300", gl(rand(), 300)),
      show("随机+GL2000", gl(rand(), 2000)),
    ].join("  ")
  );
}

export function gradProbe(pcm: Samples, sr: number, win: number, hop: number): string[] {
  const x = pcm.subarray(0, Math.min(pcm.length, Math.floor(sr * 3))) as Samples;
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const pad = new Float64Array(x.length + win);
  for (let i = 0; i < x.length; i++) pad[win / 2 + i] = x[i]!;
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(frames * bins);
  const ph = new Float64Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < win; m++) {
      re[m] = pad[f * hop + m]! * w[m]!;
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0; b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b]! ** 2 + im[b]! ** 2);
      ph[f * bins + b] = Math.atan2(im[b]!, re[b]!);
    }
  }
  let top = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i]! > top) top = mag[i]!;
  const floor = top * 1e-12;
  const slog = new Float64Array(mag.length);
  for (let i = 0; i < mag.length; i++) slog[i] = Math.log(Math.max(mag[i]!, floor));

  const gamma = 0.25645 * win * win;
  const cF = gamma / (hop * win);
  const cT = (hop * win) / gamma;
  const wrapd = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

  const stat = (label: string, get: (f: number, b: number) => number | null) => {
    let num = 0;
    let den = 0;
    let raw = 0;
    for (let f = 1; f < frames - 1; f++)
      for (let b = 1; b < bins - 1; b++) {
        if (mag[f * bins + b]! < top * 0.1) continue;
        const v = get(f, b);
        if (v === null) continue;
        const d = wrapd(v);
        num += d * d;
        raw += v * v;
        den++;
      }
    return `${label}: 样本 ${den}  梯度 RMS ${Math.sqrt(raw / Math.max(den, 1)).toFixed(2)} rad  残差 ${((Math.sqrt(num / Math.max(den, 1)) * 180) / Math.PI).toFixed(1)}°`;
  };

  const dF = (f: number, b: number) =>
    wrapd(ph[f * bins + b + 1]! - ph[f * bins + b]!) -
    (-cF * (slog[(f + 1) * bins + b]! - slog[(f - 1) * bins + b]!) / 2);
  const dT = (f: number, b: number) =>
    wrapd(ph[(f + 1) * bins + b]! - ph[f * bins + b]!) -
    (cT * (slog[f * bins + b + 1]! - slog[f * bins + b - 1]!) / 2 + (2 * Math.PI * hop * b) / win);
  return [stat("频率方向 Δb", dF), stat("时间方向 Δf", dT)];
}

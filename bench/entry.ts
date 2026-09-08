/*
 * 浏览器里的端到端评测台。
 *
 * 只做测量，不带界面：加载 docs 里的真实音频 → 走完整的 encode → PNG → 读图 → synthesise
 * 链路，再算几个标准指标。dev 用，不进 src。
 */

import { decodeAudioFile } from "../src/lib/audio";
import { FFT, hannWindow } from "../src/lib/fft";
import { imageToSpectrum, downloadName, spectrumToPng } from "../src/lib/image";
import { dbSpanOf, FINENESS, hopOf, winOf, VOICE, type Encode, type Mode } from "../src/lib/params";
import { resample, slice } from "../src/lib/resample";
import { encode, synthesise, type Spectrum } from "../src/lib/spectrum";
import { phaseFromMagnitude, TUNE } from "../src/lib/phase";
import type { Samples } from "../src/lib/arrays";

export interface Case {
  /** 采样率；0 = 跟随素材 */
  sr: number;
  bits: number;
  fineness: 0 | 1 | 2;
  fmax: number;
  mode: Mode;
  /** 图片降级方式；none = 不落盘，直接拿内存里的谱还原 */
  via: "png" | "jpeg" | "half" | "jpeg-anon" | "none";
}

export interface Metrics {
  /** 对齐后的波形信噪比 dB，越高越好 */
  snr: number;
  /** 波形相关系数，1 = 完全一致 */
  corr: number;
  /** 谱收敛 dB（标准指标），越低越好（负值） */
  conv: number;
  /** 对数谱距离 dB，越低越好 */
  lsd: number;
  /** 幅度与原始谱的一致性 dB，越高越好 */
  magSnr: number;
  /** 读回来的层级与原层级的最大偏差（0 = 完全一致） */
  levelErr: number;
}

export interface Row {
  file: string;
  case: string;
  ms: number;
  bytes: number;
  frames: number;
  bins: number;
  seconds: number;
  m: Metrics;
}

const log10 = Math.log10;

/** 全局找最佳时延后的相关系数与 SNR。 */
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

/**
 * 分窗各自对齐后的平均相关。
 *
 * 全局只找一个时延，重建里那种"慢慢地飘几个样本"的误差就把相关拉到 0.3 了 ——
 * 可听感上它是对的。分窗对齐能量出"局部到底对不对"：分窗高而全局低 = 时延漂移，
 * 两者都低 = 相位本身错了。
 */
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

/** 一遍 STFT 幅度，用来算谱收敛与对数谱距离。 */
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

  // 对数谱距离：先各自归一化到峰值，再比 dB，底下 -80 dB 截断。
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

/** 按谱算：解码出来的幅度 vs 原始谱幅度。 */
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

async function degrade(blob: Blob, via: Case["via"], name: string): Promise<Blob> {
  if (via === "png") return blob;
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const scale = via === "half" ? 0.5 : 1;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const type = via === "jpeg" || via === "jpeg-anon" ? "image/jpeg" : "image/png";
  const out = await new Promise<Blob | null>(done => canvas.toBlob(done, type, 0.72));
  canvas.width = 0;
  canvas.height = 0;
  void name;
  return out ?? blob;
}

export async function loadAudio(url: string): Promise<{ pcm: Samples; sr: number }> {
  const bytes = await (await fetch(url)).arrayBuffer();
  return decodeAudioFile(bytes);
}

/** 调相位重建的旋钮，评测时用来对比。 */
export function setTune(
  t: Partial<{
    pghi: boolean;
    iters: number;
    momentum: number;
    gamma: number;
    rtisi: boolean;
    rtisiIters: number;
    rtisiGl: number;
  }>,
): string {
  if (t.pghi !== undefined) TUNE.pghi = t.pghi;
  if (t.iters !== undefined) TUNE.iters = t.iters;
  if (t.momentum !== undefined) TUNE.momentum = t.momentum;
  if (t.gamma !== undefined) TUNE.gamma = t.gamma;
  if (t.rtisi !== undefined) TUNE.rtisi = t.rtisi;
  if (t.rtisiIters !== undefined) TUNE.rtisiIters = t.rtisiIters;
  if (t.rtisiGl !== undefined) TUNE.rtisiGl = t.rtisiGl;
  return JSON.stringify(TUNE);
}

/**
 * 反演器横评。同一份量化幅度，只换相位重建算法：
 *   上限   真幅度 + 真相位（这套参数能到的最好结果）
 *   PGHI   PGHI 起手 + 带动量 GL（旧路径）
 *   RTISI  RTISI-LA 逐帧反演
 *   +GL    RTISI-LA 之后再全局打磨
 */
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

  // 量化：跟 encode 里的口径完全一致（峰值作 0 dB 参考，位深换动态范围）。
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
    fine: null,
    phaseHi: null,
    phaseLo: null,
  };

  /** 给定相位直接 WOLA 合成（只用来算上限）。 */
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

/** 重采样到目标率，供探针使用。 */
export function atRate(pcm: Samples, sr: number, to: number): { pcm: Samples; sr: number } {
  return { pcm: resample(pcm, sr, to, 0), sr: to };
}

export async function runCase(
  srcPcm: Samples,
  srcSr: number,
  name: string,
  c: Case,
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
  if (c.via !== "none") {
    const png = await spectrumToPng(spec);
    const fileName = c.via === "jpeg-anon" ? "untitled.jpg" : downloadName(name, spec.meta);
    const degraded = await degrade(png, c.via, fileName);
    bytes = degraded.size;
    back = (await imageToSpectrum(degraded, fileName)).spec;
  }
  const y = await synthesise(back);

  const ref = tuned.subarray(0, Math.min(tuned.length, y.length)) as Samples;
  const a = align(ref, y, Math.min(2048, Math.floor(ref.length / 4)));
  const win = 1024;
  const hop = 256;
  const s = spectral(magnitudes(ref, win, hop), magnitudes(y, win, hop));

  return {
    file: name,
    case: `${c.mode}/${c.sr || "原"}/${c.bits}b/${FINENESS[c.fineness]!.label}/${c.via}`,
    ms: Math.round(performance.now() - t0),
    bytes,
    frames: spec.meta.frames,
    bins: spec.meta.bins,
    seconds: Math.round((spec.meta.samples / sr) * 10) / 10,
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

/** 读回来的层级 vs 原层级：最大偏差。0 表示这条链路无损。 */
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

/** 单独体检：各 bit 深的索引色 PNG 能不能被浏览器原样解回来。 */
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
      fine: null,
      phaseHi: null,
      phaseLo: null,
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

/**
 * PGHI 体检：拿真实 STFT 相位跟它解出来的比。
 * 返回按能量加权的 RMS 相位误差（度）。随机相位 ≈ 104°，完美 = 0°。
 */
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
  // 分成两部分：整体转了多少（k，等价于全通/希尔伯特旋转，听感上无损但波形对不上），
  // 以及去掉 k 之后还剩多少（这才是 PGHI 本身的本事）。
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

/**
 * 把"相位恢复"和"量化"两件事分开量。
 *
 * 用未量化的真实幅度，只换相位来源：真相位（上限）/ PGHI / PGHI+GL / 随机+GL。
 * 若"真幅度 + PGHI"就很好，说明相位够了，剩下的差距全是位深的事；
 * 若它也很差，那就是相位恢复本身没到位。
 */
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

  // 量化成 quant 位（0 = 不量化）
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

  /** Griffin-Lim：拿给定相位起步，只换幅度不换相位地迭代。 */
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

  /** 合成后的谱与目标幅度差多少（同一网格）—— 用来分辨"没收敛"和"收敛到错的解"。 */
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
    const s = spectral(magnitudes(ref, 1024, 256), magnitudes(Float32Array.from(y) as Samples, 1024, 256));
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

/** 逐个方向核对梯度：真实相邻点相位差 vs 公式算出来的梯度。 */
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

export const DEFAULTS = {
  VOICE,
  hopOf,
  winOf,
  dbSpanOf,
};

export const CASE_TAGS = { FINENESS };

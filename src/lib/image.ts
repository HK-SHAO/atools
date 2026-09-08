import type { Pixels } from "./arrays";
import { FROM_LUMA, RAMP, luma } from "./palette";
import { gray16Png, indexedPng, readGray16, readMeta, withMeta } from "./png";
import { BANDS, MAX_FRAMES, paramsForImage, type Meta, type Spectrum } from "./spectrum";
import { stepsOf } from "./params";

/* 任何一张图都要能出声。读取链路分四档：
 *   可逆   —— 无损容器 + 两段齐全（上=幅度谱、下=相位）+ 尺寸对得上：直接逆变换
 *   紧凑   —— 我们出的紧凑图，尺寸未变：幅度按亮度反查，相位 PGHI + RTISI-LA 补
 *   降级   —— 认得出是我们的图，但被转码/缩放过：同上，只是要重采样
 *   通用   —— 完全陌生的图：整张就是幅度，一样能放
 */

/**
 * 格式版本契约（完整规范见 docs/format-spec.md）：
 *
 *   tEXt("spectrum") = [版本, sr, win, hop, frames, bins, samples, bits, ref, exact, ...扩展]
 *
 *   —— 前 10 个字段自 v3 起冻结：只增不改、永不重排。读端认 3..当前版本；
 *   对未来版本也按前缀解（追加字段不影响前缀语义），所以旧应用读新图、
 *   新应用读旧图都优雅降级，绝无损毁。文件名文法同样冻结，作为 tEXt 丢失后的兜底。
 */
export const FORMAT_VERSION = 4;
const MIN_VERSION = 3;

export function metaToText(meta: Meta): string {
  return JSON.stringify([
    FORMAT_VERSION,
    meta.sr,
    meta.win,
    meta.hop,
    meta.frames,
    meta.bins,
    meta.samples,
    meta.bits,
    Math.round(meta.ref * 10) / 10,
    meta.exact ? 1 : 0,
  ]);
}

export function textToMeta(text: string): Meta | null {
  try {
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v)) return null;
    // 前缀冻结契约：认得 3..未来版本的前缀就按前缀解，扩展字段忽略。
    const ver = v[0];
    if (typeof ver !== "number" || !Number.isInteger(ver) || ver < MIN_VERSION) return null;
    if (v.length < 10) return null;
    const n = (v as unknown[]).slice(1, 10).map(Number);
    if (n.some(x => !Number.isFinite(x))) return null;
    const [sr, win, hop, frames, bins, samples, bits, ref, exact] = n as number[];
    if (sr! <= 0 || win! <= 0 || hop! <= 0 || frames! <= 0 || bins! <= 0 || samples! < 0) return null;
    if ((win! & (win! - 1)) !== 0 || win! < 256 || win! > 4096) return null;
    if (hop! < 1 || hop! > win!) return null;
    if (bins! > win! / 2 + 1) return null;
    return {
      sr: sr!,
      win: win!,
      hop: hop!,
      frames: frames!,
      bins: bins!,
      samples: samples!,
      bits: bits!,
      ref: ref!,
      exact: exact! === 1,
    };
  } catch {
    return null;
  }
}

/** `name_SR8000_N256_H128_F626_L50000_B8.png` —— tEXt 丢了还有文件名兜底。
 *  转格式、改尺寸之后只要名字还在，就还认得出是我们自己出的图。 */
export function metaFromName(name: string): Meta | null {
  const m =
    /_SR(\d+)_N(\d+)_H(\d+)_F(\d+)_L(\d+)(?:_B(\d+))?\.(?:png|jpe?g|jpe|webp|avif|bmp|gif)$/i.exec(
      name,
    );
  if (!m) return null;
  const [sr, win, hop, frames, samples, bits] = [1, 2, 3, 4, 5, 6].map(i =>
    m[i] === undefined ? Number.NaN : Number(m[i]),
  );
  if (![sr, win, hop, frames, samples].every(x => Number.isFinite(x!) && x! > 0)) return null;
  if ((win! & (win! - 1)) !== 0) return null;
  const b = Number.isFinite(bits) ? bits! : 0;
  return {
    sr: sr!,
    win: win!,
    hop: Math.min(win!, hop!),
    frames: frames!,
    bins: win! / 2 + 1,
    samples: samples!,
    bits: b,
    ref: 0,
    exact: b === 0,
  };
}

export function downloadName(base: string, meta: Meta): string {
  const stem = base.replace(/\.[^.]+$/, "") || "spectrum";
  return `${stem}_SR${meta.sr}_N${meta.win}_H${meta.hop}_F${meta.frames}_L${meta.samples}_B${meta.bits}.png`;
}

export type Container = "png" | "bmp" | "webp-lossless" | "jpeg" | "webp" | "gif" | "avif" | "?";

export function sniff(bytes: Uint8Array): Container {
  const tag = (at: number, s: string) =>
    s.split("").every((c, i) => bytes[at + i] === c.charCodeAt(0));
  if (bytes[0] === 0x89 && tag(1, "PNG")) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (tag(0, "BM")) return "bmp";
  if (tag(0, "GIF8")) return "gif";
  if (tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8L")) return "webp-lossless";
    return "webp";
  }
  // MP4 家族（m4a / mp4 / mov）同样以 ftyp 盒起步，但 major brand 不是 avif；
  // 只认真正的 AVIF（major brand 为 avif / avis / mif1），其余一律当"未知"，
  // 让上层按音频去走解码，免得把 m4a 错当成图去 createImageBitmap 而报
  // "The source image could not be decoded"。
  if (tag(4, "ftyp")) {
    const major = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (major === "avif" || major === "avis" || major === "mif1") return "avif";
    return "?";
  }
  return "?";
}

const MAX_SOURCE_PIXELS = 24_000_000;
const FOREIGN_FRAMES = 6000;

function surface(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!ctx) throw new Error("这个浏览器不支持 canvas");
  return { canvas, ctx };
}

/**
 * 拾取一个频段，按目标 bins / frames 重采样。
 *
 * 图里第 0 行永远是最高频（频谱图的惯例），写图时翻过一次，这里翻回来，
 * 所以 out 的第 0 行是最低频 —— 和 STFT 的 bin 序一致。
 */
export function sampleBand(
  data: Pixels,
  width: number,
  rowTop: number,
  rowCount: number,
  frames: number,
  bins: number,
  pick: (r: number, g: number, b: number) => number,
): Uint8Array {
  const out = new Uint8Array(frames * bins);
  const sx = width / frames;
  const sy = rowCount / bins;

  // 图里第 0 行是最高频 —— 先把每个 bin 对应的行号算好（要翻过来）。
  const rows = new Int32Array(bins);
  for (let b = 0; b < bins; b++) {
    const up = Math.min(rowCount - 1, Math.floor((b + 0.5) * sy));
    rows[b] = rowTop + rowCount - 1 - up;
  }

  // 输出必须是 frame-major（levels[f * bins + b]），别写成 bin-major。
  for (let f = 0; f < frames; f++) {
    const col = Math.min(width - 1, Math.floor((f + 0.5) * sx)) * 4;
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      const p = rows[b]! * width * 4 + col;
      out[base + b] = pick(data[p]!, data[p + 1]!, data[p + 2]!);
    }
  }
  return out;
}

/**
 * 图被缩放/转码过，但还认得出是我们出的：频段划分照原样，
 * 只是列数变了 —— 把帧数换成列数，跳距跟着变，总时长保持不变。
 */
function rescaled(meta: Meta, width: number): Meta {
  const frames = Math.max(2, Math.min(width, MAX_FRAMES));
  const hop = Math.max(1, Math.min(meta.win, Math.round(meta.samples / frames)));
  return { ...meta, frames, bins: meta.bins, hop, samples: frames * hop, exact: false };
}

/** 紧凑图 16 位：直接用 16 位灰度 PNG 的原始字节读出幅度，绕过 8 位 canvas。 */
async function readCompact16(bytes: Uint8Array, meta: Meta): Promise<Spectrum> {
  const g = await readGray16(bytes);
  const levels = new Uint8Array(meta.frames * meta.bins);
  if (g) {
    const sx = g.width / meta.frames;
    const sy = g.height / meta.bins;
    for (let f = 0; f < meta.frames; f++) {
      const col = Math.min(g.width - 1, Math.floor((f + 0.5) * sx));
      for (let b = 0; b < meta.bins; b++) {
        const row = Math.min(g.height - 1, Math.floor((b + 0.5) * sy));
        levels[f * meta.bins + b] = Math.min(255, (g.data[row * g.width + col]! * 255) / 65535) | 0;
      }
    }
  }
  return { meta, levels, phaseCos: null, phaseSin: null };
}

export type ReadMode = "exact" | "compact" | "degraded" | "foreign";

export interface Decoded {
  spec: Spectrum;
  mode: ReadMode;
  container: Container;
  width: number;
  height: number;
}

export async function imageToSpectrum(file: Blob, fileName: string): Promise<Decoded> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const container = sniff(bytes);
  const meta = textToMeta(readMeta(bytes) ?? "") ?? metaFromName(fileName);

  let bitmap = await createImageBitmap(file, { colorSpaceConversion: "none" });
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    if (width * height > MAX_SOURCE_PIXELS) {
      const k = Math.sqrt(MAX_SOURCE_PIXELS / (width * height));
      const scaled = await createImageBitmap(bitmap, {
        resizeWidth: Math.max(1, Math.round(width * k)),
        resizeHeight: Math.max(1, Math.round(height * k)),
      });
      bitmap.close();
      bitmap = scaled;
    }
    const { canvas, ctx } = surface(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const w = bitmap.width;
    const h = bitmap.height;
    const pixels = ctx.getImageData(0, 0, w, h).data as Pixels;
    canvas.width = 0;
    canvas.height = 0;

    const known = meta !== null;
    const exact = known && meta.exact;
    const bandRows = exact ? Math.max(1, Math.floor(h / BANDS)) : h;
    const intact = known && w === meta.frames && bandRows === meta.bins;

    // 16 位紧凑图：幅度藏在 16 位灰度里，canvas 读不到，走原始字节。
    if (known && !meta.exact && meta.bits >= 16 && w === meta.frames && h === meta.bins) {
      return {
        spec: await readCompact16(bytes, meta),
        mode: "compact",
        container,
        width: w,
        height: h,
      };
    }

    // 可逆图：上段幅度谱、下段相位。无论有损重编码还是被缩放，都直接逆变换——
    // cos/sin 平滑漂移、不爆尖刺；缩放只是重采样，相位照用。
    if (exact) {
      const next = intact ? { ...meta } : { ...rescaled(meta, w), exact: true };
      const levels = sampleBand(pixels, w, 0, bandRows, next.frames, next.bins, (r, g, b) =>
        FROM_LUMA[luma(r, g, b)]!,
      );
      const cosRaw = sampleBand(pixels, w, bandRows, bandRows, next.frames, next.bins, r => r);
      const sinRaw = sampleBand(pixels, w, bandRows, bandRows, next.frames, next.bins, (_r, g) => g);
      const mode: ReadMode = intact ? "exact" : "degraded";
      return {
        spec: { meta: { ...next, exact: true }, levels, phaseCos: cosRaw, phaseSin: sinRaw },
        mode,
        container,
        width: w,
        height: h,
      };
    }

    const frames = known ? Math.min(w, meta.frames) : Math.min(w, FOREIGN_FRAMES);
    const rows = Math.max(2, Math.min(intact ? meta.bins : bandRows, 1025));
    // 三段互斥：intact 是我们原图且尺寸对得上；否则认得出是自己的图（转过格式 /
    // 改过尺寸）就沿用原窗与频段、只把帧数换成列数；再否则就是完全陌生的图，
    // 整张当幅度谱，按通用默认参数起手。
    let next: Meta;
    if (intact) {
      next = { ...meta, bins: meta.bins };
    } else if (meta !== null) {
      next = rescaled(meta, w);
    } else {
      next = paramsForImage(frames, rows, 44100, 8, 0, false);
    }

    const levels = sampleBand(pixels, w, 0, bandRows, next.frames, next.bins, (r, g, b) =>
      FROM_LUMA[luma(r, g, b)]!,
    );

    const mode: ReadMode = !known ? "foreign" : intact ? "compact" : "degraded";
    return {
      spec: { meta: next, levels, phaseCos: null, phaseSin: null },
      mode,
      container,
      width: w,
      height: h,
    };
  } finally {
    bitmap.close();
  }
}

/** 可逆模式：上段幅度谱（暖色 ramp，G=层级），下段相位（R=cos / G=sin）。只在导出时调用。 */
export function exactPixels(spec: Spectrum): { pixels: Pixels; width: number; height: number } {
  const { meta, levels, phaseCos, phaseSin } = spec;
  const { frames, bins } = meta;
  const width = frames;
  const height = BANDS * bins;
  const pixels = new Uint8ClampedArray(width * height * 4) as Pixels;
  let p = 0;

  // 上段：幅度谱。暖色 ramp，绿色通道严格等于层级（G === level），
  // 读回时按 G（或亮度）精确还原 8 位幅度，不依赖反查表。
  for (let row = 0; row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0; f < frames; f++) {
      const c = levels[f * bins + b]! * 3;
      pixels[p] = RAMP[c]!;
      pixels[p + 1] = levels[f * bins + b]!;
      pixels[p + 2] = RAMP[c + 2]!;
      pixels[p + 3] = 255;
      p += 4;
    }
  }

  // 下段：相位。R = cos(相位)、G = sin(相位)。cos/sin 在 2π 处连续，
  // 有损重编码只平滑漂移，不会在折叠处爆成尖刺。
  for (let row = 0; row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0; f < frames; f++) {
      const i = f * bins + b;
      pixels[p] = phaseCos?.[i] ?? 0;
      pixels[p + 1] = phaseSin?.[i] ?? 0;
      pixels[p + 2] = 0;
      pixels[p + 3] = 255;
      p += 4;
    }
  }

  return { pixels, width, height };
}

async function exactPng(spec: Spectrum): Promise<Blob> {
  const { pixels, width, height } = exactPixels(spec);
  const { canvas, ctx } = surface(width, height);
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);

  const raw = await new Promise<Blob | null>(done => canvas.toBlob(done, "image/png"));
  if (!raw) throw new Error("频谱图生成失败");

  // 尽快把这块大画布还给浏览器。
  canvas.width = 0;
  canvas.height = 0;

  const bytes = new Uint8Array(await raw.arrayBuffer());
  return new Blob([withMeta(bytes, metaToText(spec.meta))], { type: "image/png" });
}

/**
 * 紧凑图：一像素一帧一频点，纯幅度。
 * 调色板只有 2^bits 个颜色，位深越低 → 图里颜色越少 → PNG 越小。
 * 16 位走 16 位灰度 PNG（原始字节，绕过 8 位 canvas）。
 */
async function compactPng(spec: Spectrum): Promise<Blob> {
  const { meta, levels } = spec;
  if (meta.bits >= 16) {
    const g16 = new Uint16Array(levels.length);
    for (let i = 0; i < levels.length; i++) {
      const v = levels[i]!;
      // 16 位紧凑图本来就是 Uint16Array（0..65535）；8 位兜底时升到 16 位。
      g16[i] = v > 255 ? v : ((v * 65535) / 255) | 0;
    }
    const bytes = await gray16Png(g16, meta.frames, meta.bins, metaToText(meta));
    return new Blob([bytes], { type: "image/png" });
  }

  const steps = stepsOf(meta.bits);
  // PNG 索引色只认 1/2/4/8 位深，6 位之类的只能往上靠到 8。
  const depth = steps <= 1 ? 1 : steps <= 3 ? 2 : steps <= 15 ? 4 : 8;
  const count = 1 << depth;

  const indices = new Uint8Array(levels.length);
  for (let i = 0; i < levels.length; i++)
    indices[i] = Math.round((levels[i]! * steps) / 255) & (count - 1);

  const palette = new Uint8Array(count * 3);
  for (let q = 0; q < count; q++) {
    const c = Math.min(255, Math.round((Math.min(q, steps) * 255) / steps)) * 3;
    palette[q * 3] = RAMP[c]!;
    palette[q * 3 + 1] = RAMP[c + 1]!;
    palette[q * 3 + 2] = RAMP[c + 2]!;
  }

  // 第 0 行是最高频 —— 和读图时的行序对齐。
  const { frames, bins } = meta;
  const packed = new Uint8Array(frames * bins);
  for (let row = 0; row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0; f < frames; f++) packed[row * frames + f] = indices[f * bins + b]!;
  }

  const bytes = await indexedPng(
    packed,
    frames,
    bins,
    depth,
    palette,
    metaToText(meta),
  );
  return new Blob([bytes], { type: "image/png" });
}

export function spectrumToPng(spec: Spectrum): Promise<Blob> {
  return spec.meta.exact ? exactPng(spec) : compactPng(spec);
}

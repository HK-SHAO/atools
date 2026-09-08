import type { Pixels } from "./arrays";
import { FROM_LUMA, RAMP, luma } from "./palette";
import { indexedPng, readMeta, withMeta } from "./png";
import { BANDS, COLOR_BANDS, MAX_FRAMES, clampByte, paramsForImage, type Meta, type Spectrum } from "./spectrum";
import { stepsOf } from "./params";

/* 任何一张图都要能出声。读取链路分四档：
 *   可逆   —— 无损容器 + 四段齐全 + 尺寸对得上：16 位幅度 + 16 位相位
 *   紧凑   —— 我们出的紧凑图，尺寸未变：幅度按亮度反查，相位 Griffin-Lim 补
 *   降级   —— 认得出是我们的图，但被转码/缩放过：同上，只是要重采样
 *   通用   —— 完全陌生的图：整张就是幅度，一样能放
 */

const VERSION = 3;

export function metaToText(meta: Meta): string {
  return JSON.stringify([
    VERSION,
    meta.sr,
    meta.win,
    meta.hop,
    meta.frames,
    meta.bins,
    meta.samples,
    meta.bits,
    Math.round(meta.ref * 10) / 10,
    meta.exact ? 1 : 0,
    meta.color ? 1 : 0,
  ]);
}

export function textToMeta(text: string): Meta | null {
  try {
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v) || v.length < 10 || v[0] !== VERSION) return null;
    const n = (v as unknown[]).slice(1).map(Number);
    if (n.some(x => !Number.isFinite(x))) return null;
    const [sr, win, hop, frames, bins, samples, bits, ref, exact, color] = n as number[];
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
      color: color! === 1,
    };
  } catch {
    return null;
  }
}

/** `name_SR8000_N256_H128_F626_L50000_B4.png` —— tEXt 丢了还有文件名兜底。
 *  转格式、改尺寸之后只要名字还在，就还认得出这是我们自己出的图。
 *  老文件名没有 _B，一律按可逆链路解读。 */
export function metaFromName(name: string): Meta | null {
  const m =
    /_SR(\d+)_N(\d+)_H(\d+)_F(\d+)_L(\d+)(?:_B(\d+))?(?:_C(\d+))?\.(?:png|jpe?g|jpe|webp|avif|bmp|gif)$/i.exec(
      name,
    );
  if (!m) return null;
  const [sr, win, hop, frames, samples, bits, color] = [1, 2, 3, 4, 5, 6, 7].map(i =>
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
    // 色彩标记只信文件名里的 _C1：没有就按老灰度可逆图处理，真正的彩色判定
    // 交给 imageToSpectrum 里的几何识别（高度 2 段 / 4 段），免得改过名的图错位。
    color: Number.isFinite(color) ? color! === 1 : false,
  };
}

export function downloadName(base: string, meta: Meta): string {
  const stem = base.replace(/\.[^.]+$/, "") || "spectrum";
  return `${stem}_SR${meta.sr}_N${meta.win}_H${meta.hop}_F${meta.frames}_L${meta.samples}_B${meta.bits}_C${
    meta.color ? 1 : 0
  }.png`;
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

/** 把读到的两段相位字节还原成 cos/sin 字节（0..255）。
 *  新版存的就是 cos/sin（cos²+sin²≈1）；老版存的是 MSB/LSB（16 位折叠相位），
 *  这里自动认出来转成 cos/sin，老图也能继续用。 */
function toCosSin(cRaw: Uint8Array, sRaw: Uint8Array): { cos: Uint8Array; sin: Uint8Array } {
  const n = cRaw.length;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i += 97) {
    const c = (cRaw[i]! - 127.5) / 127.5;
    const s = (sRaw[i]! - 127.5) / 127.5;
    sum += c * c + s * s;
    cnt++;
  }
  const mean = cnt ? sum / cnt : 0;
  if (mean > 0.5 && mean < 1.5) return { cos: cRaw, sin: sRaw };
  const cos = new Uint8Array(n);
  const sin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const code = (cRaw[i]! << 8) | sRaw[i]!;
    const a = (code / 65536) * Math.PI * 2 - Math.PI;
    cos[i] = clampByte((Math.cos(a) * 0.5 + 0.5) * 255);
    sin[i] = clampByte((Math.sin(a) * 0.5 + 0.5) * 255);
  }
  return { cos, sin };
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
  // 兜底分支里还要读它的字段，先留一份不被控制流收窄的引用。
  const hint: Meta | null = meta;

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
    // 彩色与否：优先信 meta.color（tEXt 或文件名 _C）；认不出色彩标记时，
    // 用图像高度判断是 2 段（彩色）还是 4 段（老灰度）——这样改过名、丢了
    // _C 的 JPEG/WebP 也能正确挑出彩色相位谱，不会误当 4 段灰度去错位采样。
    const geomColor = exact && Math.abs(h - 2 * (meta?.bins ?? 0)) <= Math.abs(h - 4 * (meta?.bins ?? 0));
    const color = exact && ((known && meta.color) || geomColor);
    // 段高：彩色可逆=2 段、灰度可逆=4 段、紧凑/陌生=整张。
    const bandRows = exact
      ? color
        ? Math.max(1, Math.floor(h / COLOR_BANDS))
        : Math.max(1, Math.floor(h / BANDS))
      : h;
    const intact = known && w === meta.frames && bandRows === meta.bins;

    // 只要认得出是自己出的可逆图（无论有损重编码成 JPEG/WebP、还是被缩放过），
    // 就继续用存进去的相位直接逆变换 —— 比退回 Griffin-Lim / RTISI 噪声小、也不爆音。
    if (exact) {
      const frames = known ? Math.min(w, meta.frames) : Math.min(w, FOREIGN_FRAMES);
      const next = intact ? { ...meta, bins: meta.bins } : rescaled(meta, w);

      // 彩色相位谱：上 1/2 是 RGB（R=cos 相位 / G=sin 相位 / B=幅度粗），
      // 下 1/2 是灰度细幅度。cos/sin 在 2π 处连续，有损重编码后只平滑漂移、不爆尖刺。
      if (color) {
        const cosRaw = sampleBand(pixels, w, 0, bandRows, frames, next.bins, r => r);
        const sinRaw = sampleBand(pixels, w, 0, bandRows, frames, next.bins, (_r, g) => g);
        const levels = sampleBand(pixels, w, 0, bandRows, frames, next.bins, (_r, _g, b) => b);
        const fine = sampleBand(pixels, w, bandRows, bandRows, frames, next.bins, (_r, g) => g);
        const { cos, sin } = toCosSin(cosRaw, sinRaw);
        const mode: ReadMode = intact ? "exact" : "degraded";
        return {
          spec: { meta: { ...next, exact: true, color: true }, levels, fine, phaseCos: cos, phaseSin: sin },
          mode,
          container,
          width: w,
          height: h,
        };
      }

      // 老版四段灰度可逆图（读历史文件用）。
      const levels = sampleBand(pixels, w, 0, bandRows, next.frames, next.bins, (r, g, b) =>
        FROM_LUMA[luma(r, g, b)]!,
      );
      const fine = sampleBand(pixels, w, bandRows, bandRows, frames, next.bins, (_r, g) => g);
      const cosRaw = sampleBand(pixels, w, 2 * bandRows, bandRows, frames, next.bins, (_r, g) => g);
      const sinRaw = sampleBand(pixels, w, 3 * bandRows, bandRows, frames, next.bins, (_r, g) => g);
      const { cos, sin } = toCosSin(cosRaw, sinRaw);
      const mode: ReadMode = intact ? "exact" : "degraded";
      return {
        spec: { meta: { ...next, exact: true, color: false }, levels, fine, phaseCos: cos, phaseSin: sin },
        mode,
        container,
        width: w,
        height: h,
      };
    }

    const frames = known ? Math.min(w, meta.frames) : Math.min(w, FOREIGN_FRAMES);
    const rows = Math.max(2, Math.min(intact ? meta.bins : bandRows, 1025));
    const next = intact
      ? { ...meta, bins: meta.bins }
      : meta !== null
        ? // 认得出是自己的图（转过格式 / 改过尺寸）：沿用原来的窗与频段，
          // 只把帧数换成图上的列数、跳距相应放大 —— 时长和音高才对得上。
          // 早先直接拿行数当频段数，结果图一缩小整个音高就降了八度。
          rescaled(meta, w)
        : paramsForImage(
            frames,
            rows,
            hint?.sr ?? 44100,
            hint?.bits && hint.bits > 0 ? hint.bits : 8,
            hint?.ref ?? 0,
            false,
          );

    const levels = sampleBand(pixels, w, 0, bandRows, next.frames, next.bins, (r, g, b) =>
      FROM_LUMA[luma(r, g, b)]!,
    );

    const mode: ReadMode = !known ? "foreign" : intact ? "compact" : "degraded";
    return {
      spec: { meta: next, levels, fine: null, phaseCos: null, phaseSin: null },
      mode,
      container,
      width: w,
      height: h,
    };
  } finally {
    bitmap.close();
  }
}

/** 可逆模式：彩色（2 段）或老版四段灰度，只在导出时调用。 */
export function exactPixels(spec: Spectrum): { pixels: Pixels; width: number; height: number } {
  const { meta, levels, fine, phaseCos, phaseSin } = spec;
  const { frames, bins } = meta;

  // 彩色相位谱：上 1/2 是 RGB（R=cos 相位、G=sin 相位、B=幅度粗 8 位），
  // 下 1/2 是灰度细幅度。看着像经典 STFT 彩虹图，相位在颜色里，抗有损压缩。
  if (meta.color) {
    const width = frames;
    const height = COLOR_BANDS * bins;
    const pixels = new Uint8ClampedArray(width * height * 4) as Pixels;
    let p = 0;
    for (let row = 0; row < bins; row++) {
      const b = bins - 1 - row;
      for (let f = 0; f < frames; f++) {
        const i = f * bins + b;
        pixels[p] = phaseCos?.[i] ?? 0; // R = cos(相位)
        pixels[p + 1] = phaseSin?.[i] ?? 0; // G = sin(相位)
        pixels[p + 2] = levels[i] ?? 0; // B = 幅度·粗
        pixels[p + 3] = 255;
        p += 4;
      }
    }
    for (let row = 0; row < bins; row++) {
      const b = bins - 1 - row;
      for (let f = 0; f < frames; f++) {
        const v = fine?.[f * bins + b] ?? 0;
        pixels[p] = v;
        pixels[p + 1] = v;
        pixels[p + 2] = v;
        pixels[p + 3] = 255;
        p += 4;
      }
    }
    return { pixels, width, height };
  }

  // 老版四段灰度（只用来读历史图，不再产出）。
  const width = frames;
  const height = BANDS * bins;
  const pixels = new Uint8ClampedArray(width * height * 4) as Pixels;
  let p = 0;

  for (let row = 0; row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0; f < frames; f++) {
      const c = levels[f * bins + b]! * 3;
      pixels[p] = RAMP[c]!;
      pixels[p + 1] = RAMP[c + 1]!;
      pixels[p + 2] = RAMP[c + 2]!;
      pixels[p + 3] = 255;
      p += 4;
    }
  }

  const gray = (get: (i: number) => number) => {
    for (let row = 0; row < bins; row++) {
      const b = bins - 1 - row;
      for (let f = 0; f < frames; f++) {
        const v = get(f * bins + b);
        pixels[p] = v;
        pixels[p + 1] = v;
        pixels[p + 2] = v;
        pixels[p + 3] = 255;
        p += 4;
      }
    }
  };

  gray(i => fine?.[i] ?? 0);
  gray(i => phaseCos?.[i] ?? 0);
  gray(i => phaseSin?.[i] ?? 0);

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
 */
async function compactPng(spec: Spectrum): Promise<Blob> {
  const { meta, levels } = spec;
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

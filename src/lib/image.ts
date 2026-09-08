import type { Pixels } from "./arrays";
import { FROM_LUMA, RAMP, luma } from "./palette";
import { gray16Png, indexedPng, readGray16, readIndexedRamp, readMeta, withMeta } from "./png";
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
    // 除 ref（允许一位小数）外全字段必须是整数 —— meta 被人为改坏（小数/乱码）
    // 宁可拒认、走几何认图兜底，也不能让小数帧数/频点数混进逆变换产出全 NaN 音频。
    if (n.some((x, i) => (i === 7 ? !Number.isFinite(x) : !Number.isInteger(x)))) return null;
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

/** 猜窗宽：bins = win/2 + 1 是本格式的固定关系，往上取不到就退到 2 的幂。 */
function winFromBins(bins: number): number {
  const raw = Math.max(2, (bins - 1) * 2);
  let win = 256;
  while (win * 2 <= Math.min(raw, 4096)) win *= 2;
  return win;
}

/**
 * 没有 tEXt、文件名也被改掉时的最后兜底：靠图本身的几何与签名反推参数。
 * sr 无从得知，按工具默认 8k 解读（界面会提示这是猜的）。
 */
export function metaFromGeometry(frames: number, bins: number, exact: boolean, bits: number): Meta {
  const win = winFromBins(bins);
  return {
    sr: 8000,
    win,
    hop: win / 2,
    frames: Math.max(2, Math.min(frames, MAX_FRAMES)),
    bins: Math.min(bins, win / 2 + 1),
    samples: Math.max(2, Math.min(frames, MAX_FRAMES)) * (win / 2),
    bits,
    ref: 0,
    exact,
  };
}

/**
 * 像素签名认可逆图：下半段必须是相位段 —— B≈0 且 (R,G) 落在以 (127.5,127.5)
 * 为圆心的单位圆上。随机照片/纯色图几乎不可能撞上这个签名。
 */
export function recognizeExact(pixels: Pixels, w: number, h: number): boolean {
  if (w < 4 || h < 8 || h % 2 !== 0) return false;
  const rows = h / 2;
  const stepX = Math.max(1, Math.floor(w / 48));
  const stepY = Math.max(1, Math.floor(rows / 24));
  let checked = 0;
  for (let y = 0; y < rows; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const p = ((rows + y) * w + x) * 4;
      if (pixels[p + 2]! > 8) return false;
      const cr = pixels[p]! - 127.5;
      const cs = pixels[p + 1]! - 127.5;
      const rad2 = cr * cr + cs * cs;
      // 量化 ±0.7、有损压缩漂移、缩放平均都放得下；纯黑/纯灰图会被半径卡掉。
      if (rad2 < 2600 || rad2 > 29000) return false;
      checked++;
    }
  }
  return checked >= 12;
}

function surface(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!ctx) throw new Error("这个浏览器不支持 canvas");
  return { canvas, ctx };
}

/**
 * 面积平均读幅度段。图被缩放后一个输出格覆盖多个像素，取格内亮度均值再反查
 * 层级 —— 比最邻近采样稳得多（不会跳采丢能量）；1:1 时就是精确单像素读数。
 *
 * 图里第 0 行永远是最高频（频谱图的惯例），写图时翻过一次，这里翻回来，
 * 所以 out 的第 0 行是最低频 —— 和 STFT 的 bin 序一致。
 */
export function sampleLevels(
  data: Pixels,
  width: number,
  rowTop: number,
  rowCount: number,
  frames: number,
  bins: number,
): Uint8Array {
  const out = new Uint8Array(frames * bins);
  const sx = width / frames;
  const sy = rowCount / bins;
  for (let f = 0; f < frames; f++) {
    const x0 = Math.min(width - 1, Math.floor(f * sx));
    const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((f + 1) * sx)));
    for (let b = 0; b < bins; b++) {
      // bin 0 = 最低频 = 图里最下面的行；格在「翻转前」的行坐标里取。
      const y0 = Math.min(rowCount - 1, Math.floor(b * sy));
      const y1 = Math.min(rowCount, Math.max(y0 + 1, Math.ceil((b + 1) * sy)));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const imgRow = rowTop + rowCount - 1 - y;
        for (let x = x0; x < x1; x++) {
          const p = (imgRow * width + x) * 4;
          sum += luma(data[p]!, data[p + 1]!, data[p + 2]!);
          n++;
        }
      }
      out[f * bins + b] = FROM_LUMA[Math.round(sum / Math.max(1, n)) & 255]!;
    }
  }
  return out;
}

/**
 * 面积平均读相位段：格内对 (cos, sin) 做矢量均值再归一化 —— 相位是角度，
 * 直接平均数值是错的，矢量平均才是正确的「平均相位」。
 * 同时返回平均矢量长度比（0..1）：相互抵消越厉害比值越低，是相位可靠性的直接度量。
 */
export function samplePhase(
  data: Pixels,
  width: number,
  rowTop: number,
  rowCount: number,
  frames: number,
  bins: number,
): { cos: Uint8Array; sin: Uint8Array; reliability: number } {
  const cos = new Uint8Array(frames * bins);
  const sin = new Uint8Array(frames * bins);
  const sx = width / frames;
  const sy = rowCount / bins;
  let sumLen = 0;
  let cells = 0;
  for (let f = 0; f < frames; f++) {
    const x0 = Math.min(width - 1, Math.floor(f * sx));
    const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((f + 1) * sx)));
    for (let b = 0; b < bins; b++) {
      const y0 = Math.min(rowCount - 1, Math.floor(b * sy));
      const y1 = Math.min(rowCount, Math.max(y0 + 1, Math.ceil((b + 1) * sy)));
      let sc = 0;
      let ss = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const imgRow = rowTop + rowCount - 1 - y;
        for (let x = x0; x < x1; x++) {
          const p = (imgRow * width + x) * 4;
          sc += data[p]! - 127.5;
          ss += data[p + 1]! - 127.5;
          n++;
        }
      }
      const cr = sc / n;
      const cs = ss / n;
      const h = Math.sqrt(cr * cr + cs * cs);
      sumLen += h;
      cells++;
      const k = h > 1e-6 ? 127.5 / h : 0;
      cos[f * bins + b] = Math.max(0, Math.min(255, Math.round(cr * k + 127.5)));
      sin[f * bins + b] = Math.max(0, Math.min(255, Math.round(cs * k + 127.5)));
    }
  }
  return { cos, sin, reliability: cells > 0 ? sumLen / cells / 127.5 : 0 };
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
  /** 相位段平均矢量长度比（0..1）；无相位段为 null。低于阈值时相位已被弃用。 */
  phaseReliability: number | null;
  /** meta 全丢（tEXt 被剥、文件名被改）靠几何签名认出来时为 true。 */
  guessed: boolean;
}

/** 相位可靠阈值：矢量长度比低于它说明相位已被缩放/压缩平均到不可信，
 * 保留只会更糟 —— 弃用相位、退回幅度重建（实测缩放 0.5× 时比值 0.41）。 */
const PHASE_RELIABLE = 0.8;

export async function imageToSpectrum(file: Blob, fileName: string): Promise<Decoded> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const container = sniff(bytes);
  let meta = textToMeta(readMeta(bytes) ?? "") ?? metaFromName(fileName);

  // ---- meta 全丢的兜底（不走 canvas，直接认原始字节）----
  if (meta === null) {
    // 16 位灰度 PNG：几乎只可能是我们的紧凑 16 位导出。
    const g16 = await readGray16(bytes);
    if (g16 && g16.width * g16.height <= MAX_SOURCE_PIXELS) {
      const gmeta = metaFromGeometry(g16.width, g16.height, false, 16);
      const levels = new Uint8Array(gmeta.frames * gmeta.bins);
      const sx = g16.width / gmeta.frames;
      const sy = g16.height / gmeta.bins;
      for (let f = 0; f < gmeta.frames; f++) {
        const col = Math.min(g16.width - 1, Math.floor((f + 0.5) * sx));
        for (let b = 0; b < gmeta.bins; b++) {
          const row = Math.min(g16.height - 1, Math.floor((b + 0.5) * sy));
          levels[f * gmeta.bins + b] =
            Math.min(255, (g16.data[row * g16.width + col]! * 255) / 65535) | 0;
        }
      }
      return {
        spec: { meta: gmeta, levels, phaseCos: null, phaseSin: null },
        mode: "compact",
        container,
        width: g16.width,
        height: g16.height,
        phaseReliability: null,
        guessed: true,
      };
    }
    // 索引色 PNG 且调色板与暖色 ramp 逐项一致：我们的紧凑图。
    const idx = await readIndexedRamp(bytes);
    if (idx && idx.width * idx.height <= MAX_SOURCE_PIXELS) {
      const gmeta = metaFromGeometry(
        idx.width,
        idx.height,
        false,
        8, // 层级已还原成 0..255，按 8 位刻度解读
      );
      const levels = new Uint8Array(gmeta.frames * gmeta.bins);
      const sx = idx.width / gmeta.frames;
      const sy = idx.height / gmeta.bins;
      for (let f = 0; f < gmeta.frames; f++) {
        const col = Math.min(idx.width - 1, Math.floor((f + 0.5) * sx));
        for (let b = 0; b < gmeta.bins; b++) {
          const row = Math.min(idx.height - 1, Math.floor((b + 0.5) * sy));
          levels[f * gmeta.bins + b] = idx.levels[row * idx.width + col]!;
        }
      }
      return {
        spec: { meta: gmeta, levels, phaseCos: null, phaseSin: null },
        mode: "compact",
        container,
        width: idx.width,
        height: idx.height,
        phaseReliability: null,
        guessed: true,
      };
    }
  }

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

    // ---- 像素签名兜底：连调色板/灰度签名都没认出来，试试可逆图的相位段签名 ----
    let m0 = meta;
    if (m0 === null && recognizeExact(pixels, w, h)) {
      m0 = metaFromGeometry(w, Math.floor(h / 2), true, 0);
    }

    const known = m0 !== null;
    const exact = m0 !== null && m0.exact;
    const bandRows = exact ? Math.max(1, Math.floor(h / BANDS)) : h;
    const intact = m0 !== null && w === m0.frames && bandRows === m0.bins;

    // 16 位紧凑图（带 meta）：幅度藏在 16 位灰度里，canvas 读不到，走原始字节。
    if (m0 !== null && !m0.exact && m0.bits >= 16 && w === m0.frames && h === m0.bins) {
      return {
        spec: await readCompact16(bytes, m0),
        mode: "compact",
        container,
        width: w,
        height: h,
        phaseReliability: null,
        guessed: false,
      };
    }

    // 可逆图：上段幅度谱、下段相位。相位可靠性不够（被缩放平均/严重压损）
    // 就弃用，退回幅度重建 —— 存着垃圾相位只会更糟。
    if (exact && m0) {
      const next = intact ? { ...m0 } : { ...rescaled(m0, w), exact: true };
      const levels = sampleLevels(pixels, w, 0, bandRows, next.frames, next.bins);
      const ph = samplePhase(pixels, w, bandRows, bandRows, next.frames, next.bins);
      const keep = ph.reliability >= PHASE_RELIABLE;
      const mode: ReadMode = intact ? "exact" : "degraded";
      return {
        spec: {
          meta: { ...next, exact: true },
          levels,
          phaseCos: keep ? ph.cos : null,
          phaseSin: keep ? ph.sin : null,
        },
        mode,
        container,
        width: w,
        height: h,
        phaseReliability: ph.reliability,
        guessed: !known,
      };
    }

    const frames = m0 !== null ? Math.min(w, m0.frames) : Math.min(w, FOREIGN_FRAMES);
    const rows = Math.max(2, Math.min(intact && m0 ? m0.bins : bandRows, 1025));
    // 三段互斥：intact 是我们原图且尺寸对得上；否则认得出是自己的图（转过格式 /
    // 改过尺寸）就沿用原窗与频段、只把帧数换成列数；再否则就是完全陌生的图，
    // 整张当幅度谱，按通用默认参数起手。
    let next: Meta;
    if (m0 !== null && intact) {
      next = { ...m0, bins: m0.bins };
    } else if (m0 !== null) {
      next = rescaled(m0, w);
    } else {
      next = paramsForImage(frames, rows, 44100, 8, 0, false);
    }

    const levels = sampleLevels(pixels, w, 0, bandRows, next.frames, next.bins);

    const mode: ReadMode = !known ? "foreign" : intact ? "compact" : "degraded";
    return {
      spec: { meta: next, levels, phaseCos: null, phaseSin: null },
      mode,
      container,
      width: w,
      height: h,
      phaseReliability: null,
      // 走到这里说明像素签名没命中：带 meta 就是确定的，不带就是真陌生图。
      guessed: false,
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

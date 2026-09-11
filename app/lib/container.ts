import type { Meta } from "./spectrum.ts";

/**
 * 读图这条链上**主线程自己要用的**那几件：容器嗅探、结果档位、下载文件名。
 *
 * 其余部分（像素 → 谱、谱 → 像素、PNG 字节层）整个在 worker 里跑，连同它拖着的 png / stub /
 * 内核加载器一起不进主包。单列出来是因为它们非留在主线程不可：`sniff` 要在**送进 worker 之前**
 * 判断拖进来的是图还是音频（决定走哪条路），`downloadName` 要交给浏览器的下载动作。
 * 像素与谱的处理没有这个约束 —— 它们搬得动，就搬走了。
 */

export type Container = "png" | "bmp" | "webp-lossless" | "jpeg" | "webp" | "gif" | "avif" | "?";

export type ReadMode = "exact" | "compact" | "degraded" | "foreign";

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
  if (tag(4, "ftyp")) {
    const major = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (major === "avif" || major === "avis" || major === "mif1") return "avif";
    return "?";
  }
  return "?";
}

export function downloadName(base: string, meta: Meta): string {
  const stem = base.replace(/\.[^.]+$/, "") || "spectrum";
  return `${stem}_SR${meta.sr}_N${meta.win}_H${meta.hop}_F${meta.frames}_L${meta.samples}_B${meta.bits}.png`;
}

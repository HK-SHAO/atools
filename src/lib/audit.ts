import type { Samples } from "./arrays";
import { downloadName, imageToSpectrum } from "./image";
import { compare } from "./metric";
import { Aborted, synthesise, type Spectrum } from "./spectrum";

/*
 * 往返自检：把这张图真的存一遍、再真的读回来、再真的还原成声音，跟原素材逐项对比。
 *
 * 三条路：
 *   原图   —— PNG 原样往返，量的是「编码 + 相位重建」的总损失
 *   有损   —— 转成 JPEG（微信、相册最爱干的事），量的是压缩后还能剩多少
 *   半尺寸 —— 长宽各砍一半，量的是分辨率被砍后还能不能听
 *
 * 用户点一下就能看到这几个数，不用靠耳朵猜。
 */

export interface LossRow {
  label: string;
  /** 波形信噪比 dB */
  snr: number;
  /** 波形相关系数，1 = 完全一致 */
  corr: number;
  /** 对数谱距离 dB，越小越像 */
  lsd: number;
  /** 读回来的层级与原层级的最大偏差；0 = 这一趟无损 */
  level: number;
  /** 这趟实际存下来的字节数 */
  bytes: number;
}

/** 把图按给定方式折腾一遍：转 JPEG 或缩尺寸。 */
async function recode(blob: Blob, mode: "jpeg" | "half"): Promise<Blob> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const scale = mode === "half" ? 0.5 : 1;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return blob;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await new Promise<Blob | null>(done =>
    canvas.toBlob(done, mode === "jpeg" ? "image/jpeg" : "image/png", 0.72),
  );
  canvas.width = 0;
  canvas.height = 0;
  return out ?? blob;
}

/** 尺寸被改过就没法逐个比层级了，给 -1 表示"这一趟不适用"。 */
function levelGap(a: Spectrum, b: Spectrum): number {
    if (a.meta.bins !== b.meta.bins || a.meta.frames !== b.meta.frames) return -1;
    const n = Math.min(a.levels.length, b.levels.length);
    if (n === 0) return -1;
    const to8 = (v: number): number => (v > 255 ? v >> 8 : v);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(to8(a.levels[i]!) - to8(b.levels[i]!));
      if (d > worst) worst = d;
    }
    return worst;
  }

async function one(
  label: string,
  ref: Samples,
  spec: Spectrum,
  blob: Blob,
  fileName: string,
  alive?: () => boolean,
): Promise<LossRow> {
  const back = (await imageToSpectrum(blob, fileName)).spec;
  if (alive && !alive()) throw new Aborted();
  const y = await synthesise(back, alive);
  if (alive && !alive()) throw new Aborted();
  const m = compare(ref, y as Samples);
  return {
    label,
    snr: Math.round(m.snr * 10) / 10,
    corr: Math.round(m.corr * 1000) / 1000,
    lsd: Math.round(m.lsd * 10) / 10,
    level: levelGap(spec, back),
    bytes: blob.size,
  };
}

/** 跑三条路，返回各自的损失。 */
export async function audit(
  ref: Samples,
  spec: Spectrum,
  png: Blob,
  name: string,
  alive?: () => boolean,
): Promise<LossRow[]> {
  const own = downloadName(name, spec.meta);
  const out: LossRow[] = [];
  out.push(await one("原图", ref, spec, png, own, alive));

  for (const [label, mode] of [
    ["有损", "jpeg"],
    ["半尺寸", "half"],
  ] as const) {
    const blob = await recode(png, mode);
    if (alive && !alive()) throw new Aborted();
    const fileName = mode === "jpeg" ? `${own.replace(/\.png$/i, "")}.jpg` : own;
    out.push(await one(label, ref, spec, blob, fileName, alive));
  }
  return out;
}

/** 一句话总结：给不想看数字的人。 */
export function verdict(rows: LossRow[], exact: boolean): string {
  const own = rows[0];
  if (!own) return "";
  if (exact && own.level === 0 && own.corr > 0.999) return "可逆模式：往返完全一致，零损失";
  const parts: string[] = [];
  parts.push(`原图 相关 ${own.corr.toFixed(2)} · ${own.snr.toFixed(0)}dB`);
  for (const r of rows.slice(1)) parts.push(`${r.label} ${r.corr.toFixed(2)}`);
  return parts.join("　");
}

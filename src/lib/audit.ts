import type { Samples } from "./arrays";
import { downloadName, imageToSpectrum } from "./image";
import { compare } from "./metric";
import { Aborted, synthesise, type Spectrum } from "./spectrum";

export interface LossRow {
  label: string;
  snr: number;
  corr: number;
  lsd: number;
  level: number;
  bytes: number;
}

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

export function verdict(rows: LossRow[], exact: boolean): string {
  const own = rows[0];
  if (!own) return "";
  if (exact && own.level === 0 && own.corr > 0.999) return "可逆模式：往返完全一致，零损失";
  const parts: string[] = [];
  parts.push(`原图 相关 ${own.corr.toFixed(2)} · ${own.snr.toFixed(0)}dB`);
  for (const r of rows.slice(1)) parts.push(`${r.label} ${r.corr.toFixed(2)}`);
  return parts.join("　");
}

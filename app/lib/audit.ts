import type { Samples } from "./arrays";
import { downloadName } from "./container";
import { imageToSpectrum } from "./image";
import { compare, levelGap } from "./metric";
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
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return blob;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await canvas.convertToBlob(
    mode === "jpeg" ? { type: "image/jpeg", quality: 0.72 } : { type: "image/png" },
  );
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

async function one(
  label: string,
  ref: Samples,
  spec: Spectrum,
  blob: Blob,
  fileName: string,
  alive?: () => boolean,
  report?: (p: number) => void,
): Promise<LossRow> {
  const back = (await imageToSpectrum(blob, fileName)).spec;
  if (alive && !alive()) throw new Aborted();
  const y = await synthesise(back, alive, report, "fast");
  if (alive && !alive()) throw new Aborted();
  const m = compare(ref, y);
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
  onProgress?: (p: number) => void,
): Promise<LossRow[]> {
  const own = downloadName(name, spec.meta);
  const cases: [string, Blob, string][] = [["原图", png, own]];
  for (const [label, mode] of [
    ["有损", "jpeg"],
    ["半尺寸", "half"],
  ] as const) {
    const blob = await recode(png, mode);
    if (alive && !alive()) throw new Aborted();
    cases.push([label, blob, mode === "jpeg" ? `${own.replace(/\.png$/i, "")}.jpg` : own]);
  }

  const out: LossRow[] = [];
  for (const [i, [label, blob, fileName]] of cases.entries()) {
    onProgress?.(i / cases.length);
    out.push(
      await one(label, ref, spec, blob, fileName, alive, p =>
        onProgress?.((i + p) / cases.length),
      ),
    );
  }
  onProgress?.(1);
  return out;
}

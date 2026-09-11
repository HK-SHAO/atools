import type { Samples } from "./arrays";
import { downloadName, imageToSpectrum } from "./image";
import type { Metrics } from "./metric";
import { Aborted, type Spectrum } from "./spectrum";

/**
 * 还原一段声音。调用方注入：这条链的还原跑在 Worker 上，但质检不该知道线程的事。
 *
 * 指标也一样注入，而且**必须**注入：`compare` 里的 `align` 在 ±span 个时延上各扫一遍全长
 * 信号（span 到 2048，也就是四千多倍素材长度），留在主线程就是一次实打实的卡顿。
 * 所以这个模块本身不碰数值实现，只在浏览器侧被 `useAudit` 接上 Worker。
 */
type Synth = (spec: Spectrum) => Promise<Samples>;
type MetricsOf = (ref: Samples, got: Samples) => Promise<Metrics>;

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
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.levels[i]! - b.levels[i]!);
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
  synth: Synth,
  metrics: MetricsOf,
  alive?: () => boolean,
): Promise<LossRow> {
  const back = (await imageToSpectrum(blob, fileName)).spec;
  if (alive && !alive()) throw new Aborted();
  const y = await synth(back);
  if (alive && !alive()) throw new Aborted();
  const m = await metrics(ref, y as Samples);
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
  synth: Synth,
  metrics: MetricsOf,
  alive?: () => boolean,
): Promise<LossRow[]> {
  const own = downloadName(name, spec.meta);
  const out: LossRow[] = [];
  out.push(await one("原图", ref, spec, png, own, synth, metrics, alive));

  for (const [label, mode] of [
    ["有损", "jpeg"],
    ["半尺寸", "half"],
  ] as const) {
    const blob = await recode(png, mode);
    if (alive && !alive()) throw new Aborted();
    const fileName = mode === "jpeg" ? `${own.replace(/\.png$/i, "")}.jpg` : own;
    out.push(await one(label, ref, spec, blob, fileName, synth, metrics, alive));
  }
  return out;
}

import type { Samples } from "./arrays";
import { downloadName } from "./container";
import { imageToSpectrum } from "./image";
import { compare, levelGap } from "./metric";
import { Aborted, hasStrongPhase, synthesise, type Meta, type Spectrum } from "./spectrum";

export interface LossRow {
  label: string;
  snr: number;
  corr: number;
  lsd: number;
  level: number;
  bytes: number;
}

// 读回的谱与编码谱逐字段一致时，「原图」一档才能直接复用现成的精修音频
// （此时 synthesise(back) 与 cached 必然是同一结果）；任何字段对不上都宁可重算。
export function sameSpectrum(a: Spectrum, b: Spectrum): boolean {
  const meta = (m: Meta): string =>
    [m.sr, m.win, m.hop, m.frames, m.bins, m.samples, m.bits, m.ref, m.exact].join("/");
  const bytes = (p?: Uint8Array | null, q?: Uint8Array | null): boolean =>
    p === q || (!!p && !!q && p.length === q.length && p.every((v, i) => v === q[i]));
  return (
    meta(a.meta) === meta(b.meta) &&
    a.phaseWeak === b.phaseWeak &&
    bytes(a.phaseCos, b.phaseCos) &&
    bytes(a.phaseSin, b.phaseSin) &&
    bytes(a.phaseW, b.phaseW) &&
    levelGap(a, b) === 0
  );
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

// 评估一档：给定读回的谱 back，与基准 ref 比对。导出以便测试
// （imageToSpectrum 依赖浏览器 canvas API，bun 里测不到端到端，由 ui 门禁覆盖）。
export async function evaluateRow(
  ref: Samples,
  spec: Spectrum,
  back: Spectrum,
  reuse: Samples | null,
  strongPhase: boolean,
  alive?: () => boolean,
  report?: (p: number) => void,
): Promise<Omit<LossRow, "label" | "bytes">> {
  // 与播放一致的标准：可逆强相位走直读相位的精确路径（精修此时不可用），
  // 其余（紧凑 / 相位弱）走精修档合成。
  const hit = reuse !== null && sameSpectrum(spec, back);
  const y = hit
    ? reuse
    : await synthesise(back, alive, report, strongPhase ? "fast" : "fine");
  if (alive && !alive()) throw new Aborted();
  const m = compare(ref, y);
  return {
    snr: Math.round(m.snr * 10) / 10,
    corr: Math.round(m.corr * 1000) / 1000,
    lsd: Math.round(m.lsd * 10) / 10,
    level: levelGap(spec, back),
  };
}

async function one(
  label: string,
  ref: Samples,
  spec: Spectrum,
  blob: Blob,
  fileName: string,
  reuse: Samples | null,
  strongPhase: boolean,
  alive?: () => boolean,
  report?: (p: number) => void,
): Promise<LossRow> {
  const back = (await imageToSpectrum(blob, fileName)).spec;
  if (alive && !alive()) throw new Aborted();
  const row = await evaluateRow(ref, spec, back, reuse, strongPhase, alive, report);
  return { ...row, label, bytes: blob.size };
}

export async function audit(
  ref: Samples,
  spec: Spectrum,
  png: Blob,
  name: string,
  alive?: () => boolean,
  onProgress?: (p: number) => void,
  cached?: Samples | null,
): Promise<LossRow[]> {
  const own = downloadName(name, spec.meta);
  const strongPhase = hasStrongPhase(spec);
  const canRecode =
    typeof createImageBitmap === "function" && typeof OffscreenCanvas !== "undefined";
  const cases: [string, Blob, string][] = [["原图", png, own]];
  if (canRecode)
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
      await one(
        label,
        ref,
        spec,
        blob,
        fileName,
        i === 0 ? (cached ?? null) : null,
        strongPhase,
        alive,
        p => onProgress?.((i + p) / cases.length),
      ),
    );
  }
  onProgress?.(1);
  return out;
}

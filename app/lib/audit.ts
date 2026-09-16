import type { Samples } from "./arrays";
import { downloadName } from "./container";
import { imageToSpectrum } from "./image";
import { compare, levelGap } from "./metric";
import { Aborted, hasStrongPhase, synthesise, type Meta, type Spectrum } from "./spectrum";

export type LossKind = "original" | "lossy" | "half";

export interface LossRow {
  kind: LossKind;
  snr: number;
  corr: number;
  lsd: number;
  level: number;
  bytes: number;
}

// Only the "original" case may reuse ready-made fine audio, and only when the spectrum read back
// matches the encoded one field for field (then synthesise(back) and the cached audio are the same
// result); any field that disagrees is worth recomputing.
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

// Score one case: compare the spectrum read back from an image against the reference. Exported for
// tests (imageToSpectrum needs the browser canvas API, so bun cannot cover it end to end; the ui
// gate does).
export async function evaluateRow(
  ref: Samples,
  spec: Spectrum,
  back: Spectrum,
  reuse: Samples | null,
  strongPhase: boolean,
  alive?: () => boolean,
  report?: (p: number) => void,
): Promise<Omit<LossRow, "kind" | "bytes">> {
  // Same standard as playback: exact images with strong phase take the precise
  // read-the-phase path (fine rendering is unavailable there); everything else
  // (compact, weak phase) goes through fine synthesis.
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
  kind: LossKind,
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
  return { ...row, kind, bytes: blob.size };
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
  const cases: [LossKind, Blob, string][] = [["original", png, own]];
  if (canRecode)
    for (const [kind, mode] of [
      ["lossy", "jpeg"],
      ["half", "half"],
    ] as const) {
      const blob = await recode(png, mode);
      if (alive && !alive()) throw new Aborted();
      cases.push([kind, blob, mode === "jpeg" ? `${own.replace(/\.png$/i, "")}.jpg` : own]);
    }

  const out: LossRow[] = [];
  for (const [i, [kind, blob, fileName]] of cases.entries()) {
    onProgress?.(i / cases.length);
    out.push(
      await one(
        kind,
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

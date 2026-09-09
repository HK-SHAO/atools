import type { Pixels } from "./arrays";
import { FROM_LUMA, RAMP, luma } from "./palette";
import { indexedPng, readIndexedRamp, readMeta, withMeta } from "./png";
import { BANDS, DEFAULT_SR, MAX_FRAMES, paramsForImage, type Meta, type Spectrum } from "./spectrum";
import { stepsOf } from "./params";
import { STUB_ROWS, decodeStub, drawStub, stubFits, stubLuma, type StubInfo } from "./stub";

export const FORMAT_VERSION = 4;

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
    const ver = v[0];
    if (ver !== FORMAT_VERSION) return null;
    if (v.length < 10) return null;
    const n = (v as unknown[]).slice(1, 10).map(Number);
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

export function metaFromName(name: string): Meta | null {
  const m =
    /_SR(\d+)_N(\d+)_H(\d+)_F(\d+)_L(\d+)_B(\d+)\.(?:png|jpe?g|jpe|webp|avif|bmp|gif)$/i.exec(
      name,
    );
  if (!m) return null;
  const [sr, win, hop, frames, samples, bits] = [1, 2, 3, 4, 5, 6].map(i => Number(m[i]));
  if (![sr, win, hop, frames, samples, bits].every(x => Number.isFinite(x!) && x! >= 0)) return null;
  if ((win! & (win! - 1)) !== 0) return null;
  return {
    sr: sr!,
    win: win!,
    hop: Math.min(win!, hop!),
    frames: frames!,
    bins: win! / 2 + 1,
    samples: samples!,
    bits: bits!,
    ref: 0,
    exact: bits! === 0,
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
  if (tag(4, "ftyp")) {
    const major = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (major === "avif" || major === "avis" || major === "mif1") return "avif";
    return "?";
  }
  return "?";
}

const MAX_SOURCE_PIXELS = 24_000_000;
const FOREIGN_FRAMES = 6000;

function winFromBins(bins: number): number {
  const raw = Math.max(2, (bins - 1) * 2);
  let win = 256;
  while (win * 2 <= Math.min(raw, 4096)) win *= 2;
  return win;
}

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

export function recognizeExact(pixels: Pixels, w: number, h: number): boolean {
  if (w < 4 || h < 8) return false;
  const rows = Math.floor(h / 2);
  const stepX = Math.max(1, Math.floor(w / 48));
  const stepY = Math.max(1, Math.floor(rows / 24));
  let ok = 0;
  let total = 0;
  for (let y = 0; y < rows; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const p = ((rows + y) * w + x) * 4;
      total++;
      if (pixels[p + 2]! > 48) continue;
      const cr = pixels[p]! - 127.5;
      const cs = pixels[p + 1]! - 127.5;
      const rad2 = cr * cr + cs * cs;
      if (rad2 < 400 || rad2 > 40000) continue;
      ok++;
    }
  }
  return ok >= 12 && ok / Math.max(1, total) >= 0.55;
}

function surface(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!ctx) throw new Error("这个浏览器不支持 canvas");
  return { canvas, ctx };
}

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

export function samplePhase(
  data: Pixels,
  width: number,
  rowTop: number,
  rowCount: number,
  frames: number,
  bins: number,
): { cos: Uint8Array; sin: Uint8Array; w: Uint8Array; reliability: number } {
  const cos = new Uint8Array(frames * bins);
  const sin = new Uint8Array(frames * bins);
  const w = new Uint8Array(frames * bins);
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
      w[f * bins + b] = Math.min(255, Math.round((h / 127.5) * 255));
      const k = h > 1e-6 ? 127.5 / h : 0;
      cos[f * bins + b] = Math.max(0, Math.min(255, Math.round(cr * k + 127.5)));
      sin[f * bins + b] = Math.max(0, Math.min(255, Math.round(cs * k + 127.5)));
    }
  }
  return { cos, sin, w, reliability: cells > 0 ? sumLen / cells / 127.5 : 0 };
}

function rescaled(meta: Meta, width: number, maxHop: number): Meta {
  const hop = Math.max(
    1,
    Math.min(Math.round(maxHop), Math.round(meta.samples / Math.max(2, width))),
  );
  const frames = Math.max(2, Math.min(MAX_FRAMES, Math.round(meta.samples / hop)));
  return { ...meta, frames, bins: meta.bins, hop, samples: frames * hop, exact: false };
}

export type ReadMode = "exact" | "compact" | "degraded" | "foreign";

export interface Decoded {
  spec: Spectrum;
  mode: ReadMode;
  container: Container;
  width: number;
  height: number;
  phaseReliability: number | null;
  guessed: boolean;
}

export const READ_TUNE = {
  phaseReliable: 0.5,
  phaseReliableJpeg: 0.3,
  phaseAnchor: 0.15,
};

function stubFromPixels(pixels: Pixels, w: number, h: number): StubInfo | null {
  for (let rows = STUB_ROWS; rows >= 2; rows--) {
    if (h <= rows) break;
    const prof: number[] = [];
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = h - rows; y < h; y++) {
        const p = (y * w + x) * 4;
        s += 0.299 * pixels[p]! + 0.587 * pixels[p + 1]! + 0.114 * pixels[p + 2]!;
      }
      prof.push(s / rows);
    }
    const info = decodeStub(prof);
    if (info) return info;
  }
  return null;
}

export async function imageToSpectrum(file: Blob, fileName: string): Promise<Decoded> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const container = sniff(bytes);
  let meta = textToMeta(readMeta(bytes) ?? "") ?? metaFromName(fileName);

  if (meta === null) {
    const idx = await readIndexedRamp(bytes);
    if (idx && idx.width * idx.height <= MAX_SOURCE_PIXELS) {
      let stub: StubInfo | null = null;
      for (let rows = STUB_ROWS; rows >= 2 && !stub; rows--) {
        if (idx.height <= rows) break;
        const prof: number[] = [];
        for (let x = 0; x < idx.width; x++) {
          let s = 0;
          for (let y = idx.height - rows; y < idx.height; y++)
            s += idx.levels[y * idx.width + x]!;
          prof.push(s / rows);
        }
        stub = decodeStub(prof);
      }
      if (stub) {
        const hEff = idx.height - STUB_ROWS;
        const bins0 = stub.win / 2 + 1;
        const gmeta: Meta = {
          sr: stub.sr,
          win: stub.win,
          hop: stub.win / 2,
          frames: stub.width,
          bins: bins0,
          samples: stub.width * (stub.win / 2),
          bits: 8,
          ref: 0,
          exact: false,
        };
        const levels = new Uint8Array(gmeta.frames * gmeta.bins);
        const sx = idx.width / gmeta.frames;
        const sy = hEff / gmeta.bins;
        for (let f = 0; f < gmeta.frames; f++) {
          const x0 = Math.min(idx.width - 1, Math.floor(f * sx));
          const x1 = Math.min(idx.width, Math.max(x0 + 1, Math.ceil((f + 1) * sx)));
          for (let b = 0; b < gmeta.bins; b++) {
            const y0 = Math.min(hEff - 1, Math.floor(b * sy));
            const y1 = Math.min(hEff, Math.max(y0 + 1, Math.ceil((b + 1) * sy)));
            let sum = 0;
            let n = 0;
            for (let x = x0; x < x1; x++)
              for (let y = y0; y < y1; y++) {
                sum += idx.levels[y * idx.width + x]!;
                n++;
              }
            levels[f * gmeta.bins + b] = n > 0 ? Math.round(sum / n) : 0;
          }
        }
        return {
          spec: { meta: gmeta, levels, phaseCos: null, phaseSin: null },
          mode: "degraded",
          container,
          width: idx.width,
          height: idx.height,
          phaseReliability: null,
          guessed: false,
        };
      }
      const gmeta = metaFromGeometry(
        idx.width,
        idx.height,
        false,
        8,
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
    let h = bitmap.height;
    const pixels = ctx.getImageData(0, 0, w, h).data as Pixels;
    canvas.width = 0;
    canvas.height = 0;

    const stub = stubFromPixels(pixels, w, h);
    if (stub) h = Math.max(2, h - Math.max(1, Math.round((STUB_ROWS * w) / stub.width)));

    if (stub && (meta === null || w < stub.width * 0.95)) {
      const bins0 = stub.win / 2 + 1;
      const frames0 = stub.width;
      const meta0: Meta = {
        sr: stub.sr,
        win: stub.win,
        hop: stub.win / 2,
        frames: frames0,
        bins: bins0,
        samples: frames0 * (stub.win / 2),
        bits: stub.exact ? 0 : 8,
        ref: meta?.ref ?? 0,
        exact: stub.exact,
      };
      if (stub.exact) {
        const bandRows = Math.max(1, Math.floor(h / BANDS));
        const levels = sampleLevels(pixels, w, 0, bandRows, frames0, bins0);
        const ph = samplePhase(pixels, w, bandRows, bandRows, frames0, bins0);
        const scaled = w < stub.width * 0.95;
        const th = scaled ? READ_TUNE.phaseReliable : READ_TUNE.phaseReliableJpeg;
        const strong = ph.reliability >= th;
        // 缩放混合对相位的损伤是系统性的（方向有偏），迭代纠不回来；JPEG 损伤近似随机。
        // 故缩放过狠（<0.6×）时相位只能整体丢弃。
        const weak =
          !strong && w >= stub.width * 0.6 && ph.reliability >= READ_TUNE.phaseAnchor;
        const keep = strong || weak;
        return {
          spec: {
            meta: meta0,
            levels,
            phaseCos: keep ? ph.cos : null,
            phaseSin: keep ? ph.sin : null,
            phaseW: keep ? ph.w : null,
            phaseWeak: weak,
          },
          mode: "degraded",
          container,
          width: w,
          height: h,
          phaseReliability: ph.reliability,
          guessed: false,
        };
      }
      return {
        spec: {
          meta: meta0,
          levels: sampleLevels(pixels, w, 0, h, frames0, bins0),
          phaseCos: null,
          phaseSin: null,
        },
        mode: "degraded",
        container,
        width: w,
        height: h,
        phaseReliability: null,
        guessed: false,
      };
    }

    let m0 = meta;
    if (m0 === null && recognizeExact(pixels, w, h)) {
      m0 = metaFromGeometry(w, Math.floor(h / 2), true, 0);
    }

    const known = m0 !== null;
    const exact = m0 !== null && m0.exact;
    const bandRows = exact ? Math.max(1, Math.floor(h / BANDS)) : h;
    const intact = m0 !== null && w === m0.frames && bandRows === m0.bins;

    if (exact && m0) {
      const binsFit0 = Math.min(m0.bins, bandRows);
      const winFit = winFromBins(binsFit0);
      const binsFit = Math.min(binsFit0, winFit / 2 + 1);
      const rs = rescaled(m0, w, winFit / 2);
      const next =
        intact && binsFit === m0.bins
          ? { ...m0 }
          : { ...rs, bins: binsFit, win: winFit, exact: true };
      const levels = sampleLevels(pixels, w, 0, bandRows, next.frames, next.bins);
      const ph = samplePhase(pixels, w, bandRows, bandRows, next.frames, next.bins);
      const strong = ph.reliability >= READ_TUNE.phaseReliable;
      const weak =
        !strong && w >= m0.frames * 0.6 && ph.reliability >= READ_TUNE.phaseAnchor;
      const keep = strong || weak;
      const mode: ReadMode = intact ? "exact" : "degraded";
      return {
        spec: {
          meta: { ...next, exact: true },
          levels,
          phaseCos: keep ? ph.cos : null,
          phaseSin: keep ? ph.sin : null,
          phaseW: keep ? ph.w : null,
          phaseWeak: weak,
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
    let next: Meta;
    if (m0 !== null && intact) {
      next = { ...m0, bins: m0.bins };
    } else if (m0 !== null) {
      const binsFit0 = Math.min(m0.bins, bandRows);
      const winFit = winFromBins(binsFit0);
      const rs = rescaled(m0, w, winFit / 2);
      next = { ...rs, bins: Math.min(binsFit0, winFit / 2 + 1), win: winFit };
    } else {
      next = paramsForImage(frames, rows, DEFAULT_SR, 8, 0, false);
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
      guessed: false,
    };
  } finally {
    bitmap.close();
  }
}

export function exactPixels(spec: Spectrum): { pixels: Pixels; width: number; height: number } {
  const { meta, levels, phaseCos, phaseSin } = spec;
  const { frames, bins } = meta;
  const width = frames;
  const stubRows = stubFits(frames) ? STUB_ROWS : 0;
  const height = BANDS * bins + stubRows;
  const pixels = new Uint8ClampedArray(width * height * 4) as Pixels;
  let p = 0;

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

  if (stubRows) drawStub(pixels, width, height, meta.sr, meta.win, true);

  return { pixels, width, height };
}

async function exactPng(spec: Spectrum): Promise<Blob> {
  const { pixels, width, height } = exactPixels(spec);
  const { canvas, ctx } = surface(width, height);
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);

  const raw = await new Promise<Blob | null>(done => canvas.toBlob(done, "image/png"));
  if (!raw) throw new Error("频谱图生成失败");

  canvas.width = 0;
  canvas.height = 0;

  const bytes = new Uint8Array(await raw.arrayBuffer());
  return new Blob([withMeta(bytes, metaToText(spec.meta))], { type: "image/png" });
}

async function compactPng(spec: Spectrum): Promise<Blob> {
  const { meta, levels } = spec;
  const steps = stepsOf(meta.bits);
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

  const { frames, bins } = meta;
  const stub = stubFits(frames) ? stubLuma(frames, meta.sr, meta.win, false) : null;
  const stubRows = stub ? STUB_ROWS : 0;
  const packed = new Uint8Array(frames * (bins + stubRows));
  for (let row = 0; row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0; f < frames; f++) packed[row * frames + f] = indices[f * bins + b]!;
  }
  if (stub) {
    const dark = 0;
    const light = steps;
    for (let i = 0; i < STUB_ROWS * frames; i++)
      packed[bins * frames + i] = stub[i % frames]! > 125 ? light : dark;
  }

  const bytes = await indexedPng(
    packed,
    frames,
    bins + stubRows,
    depth,
    palette,
    metaToText(meta),
  );
  return new Blob([bytes], { type: "image/png" });
}

export function spectrumToPng(spec: Spectrum): Promise<Blob> {
  return spec.meta.exact ? exactPng(spec) : compactPng(spec);
}

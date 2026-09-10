import type { Pixels } from "../lib/arrays";
import { RAMP } from "../lib/palette";
import type { Spectrum } from "../lib/spectrum";

export interface Raster {
  width: number;
  height: number;
  data: Pixels;
}

const MAX_SHEET_WIDTH = 2400;

export function buildSheet(spec: Spectrum, rows: number, maxWidth = MAX_SHEET_WIDTH): Raster {
  const { levels, meta } = spec;
  const { bins, frames } = meta;

  const width = Math.max(1, Math.min(frames, maxWidth));
  const height = Math.max(1, Math.min(rows, bins));
  const data = new Uint8ClampedArray(width * height * 4).fill(255) as Pixels;

  const sx = frames / width;
  const best = new Uint8Array(width);

  for (let y = 0; y < height; y++) {
    best.fill(0);
    const hi = Math.round(bins * (1 - y / height));
    const lo = Math.max(0, Math.round(bins * (1 - (y + 1) / height)));

    for (let b = bins - hi; b <= bins - 1 - lo; b++) {
      for (let x = 0; x < width; x++) {
        const from = Math.floor(x * sx);
        const to = Math.min(frames, Math.max(from + 1, Math.floor((x + 1) * sx)));
        let m = 0;
        for (let f = from; f < to; f++) {
          const lv = levels[f * bins + b]!;
          if (lv > m) m = lv;
        }
        if (m > best[x]!) best[x] = m;
      }
    }

    let o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const c = best[x]! * 3;
      data[o] = RAMP[c]!;
      data[o + 1] = RAMP[c + 1]!;
      data[o + 2] = RAMP[c + 2]!;
      o += 4;
    }
  }

  return { width, height, data };
}

const STOPS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [24, 34, 6],
  [64, 110, 22],
  [112, 190, 52],
  [168, 232, 120],
  [216, 250, 190],
  [255, 255, 255],
];

export const RAMP = new Uint8Array(256 * 3);

export const FROM_LUMA = new Uint8Array(256);

function build(): void {
  for (let level = 0; level < 256; level++) {
    let k = 0;
    while (k < STOPS.length - 2 && level > STOPS[k + 1]![0]) k++;
    const a = STOPS[k]!;
    const b = STOPS[k + 1]!;
    const f = (level - a[0]) / (b[0] - a[0]);
    RAMP[level * 3] = Math.round(a[1] + (b[1] - a[1]) * f);
    RAMP[level * 3 + 1] = level;
    RAMP[level * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
  }

  let level = 0;
  for (let y = 0; y < 256; y++) {
    while (
      level < 255 &&
      luma(RAMP[(level + 1) * 3]!, RAMP[(level + 1) * 3 + 1]!, RAMP[(level + 1) * 3 + 2]!) <= y
    )
      level++;
    FROM_LUMA[y] = level;
  }
}

export function luma(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

build();

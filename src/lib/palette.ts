/*
 * 频谱图的配色不是纯装饰：它同时是数据。
 *
 * 约束：绿色通道必须严格等于层级（G === level）。
 *   —— 这样从 PNG 读回时能按 G 精确还原 8 位幅度，不依赖任何反查表；
 *   —— 换格式/压缩/缩放后 G 被破坏，但亮度仍单调，可以按亮度反查继续用。
 * 因此两端只能是纯黑与纯白（亮度 0 与 255 只有一种 RGB 组合），
 * 暖色只出现在中间调 —— 正好是想要的效果。
 */

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

/** 亮度 → 层级。压缩过的图按亮度反查，误差 ±1 级，落在噪声里无所谓。 */
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

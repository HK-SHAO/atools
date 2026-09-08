/*
 * 转换参数。默认按「人类语音够用」给到最低：8 kHz、4 bit、N=256。
 *
 * 空间 = 帧数 × 行数 × 位深，三个方向都能压：
 *   采样率 ↓  → 帧数 ↓，同时把带宽也裁掉了
 *   位深   ↓  → 每张图里的不同颜色少了，PNG 压得更狠
 *   精度   ↓  → 行数 ↓（窗口小）、帧数 ↓（跳距大）
 *   上限   ↓  → 行数 ↓（只留人声那一段频率）
 *   区间裁剪   → 帧数 ↓
 */

export type Mode = "compact" | "exact";

export interface Encode {
  mode: Mode;
  /** 目标采样率；0 = 跟随素材 */
  sr: number;
  /** 幅度位深（紧凑模式）：每个像素承载几位 */
  bits: number;
  /** 精度档：窗口与跳距 */
  fineness: 0 | 1 | 2;
  /** 频率上限 Hz；0 = 到奈奎斯特 */
  fmax: number;
  /** 时间裁剪，秒。end = 0 表示到结尾 */
  start: number;
  end: number;
}

export const FINENESS = [
  { label: "省", win: 256, div: 2 },
  { label: "中", win: 512, div: 2 },
  { label: "细", win: 1024, div: 4 },
] as const;

export const SR_OPTIONS = [8000, 16000, 32000, 0] as const;
/** 位深：2/4/8 走索引色 PNG，16 走 16 位灰度 PNG。一位换 12 dB。 */
export const BITS_OPTIONS = [2, 4, 8, 16] as const;
export const FMAX_OPTIONS = [0, 2000, 4000, 6000, 8000] as const;

/** 紧凑默认：跟随原音频（sr:0）、8 位色深、全频段 —— 不高于原素材参数。 */
export const VOICE: Encode = {
  mode: "compact",
  sr: 0,
  bits: 8,
  fineness: 1,
  fmax: 0,
  start: 0,
  end: 0,
};

export const winOf = (e: Encode): number => FINENESS[e.fineness]!.win;
export const hopOf = (e: Encode): number => {
  const f = FINENESS[e.fineness]!;
  return f.win / f.div;
};

/** 位深决定动态范围：一位换 12 dB，4 bit → 48 dB / 16 级。 */
export const dbSpanOf = (bits: number): number => 12 * Math.max(1, bits);
export const stepsOf = (bits: number): number => (1 << Math.max(1, bits)) - 1;

export const srLabel = (sr: number): string =>
  sr === 0 ? "原" : sr % 1000 === 0 ? `${sr / 1000}k` : `${(sr / 1000).toFixed(1)}k`;

export const hzLabel = (hz: number): string =>
  hz === 0 ? "全" : hz % 1000 === 0 ? `${hz / 1000}k` : `${hz}`;

/** 换素材时保留参数习惯，只把区间放开。 */
export const reopen = (e: Encode): Encode => ({ ...e, start: 0, end: 0 });

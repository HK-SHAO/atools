export type Mode = "compact" | "exact";

export interface Encode {
  mode: Mode;
  sr: number;
  bits: number;
  fineness: 0 | 1 | 2 | 3 | 4;
  fmax: number;
  start: number;
  end: number;
}

// 窗长档位：内核 FFT 计划表支持 256~4096（moon/plan.mbt），菜单给满五档。
// 窗长越长频率分辨率越细（每格 sr/win Hz），时间分辨率越粗（瞬态更糊）；
// 像素总量与窗长基本无关（帧数 ∝ 1/win，bin 数 ∝ win）。
export const FINENESS = [
  { label: "256", win: 256 },
  { label: "512", win: 512 },
  { label: "1024", win: 1024 },
  { label: "2048", win: 2048 },
  { label: "4096", win: 4096 },
] as const;

export const SR_OPTIONS = [8000, 16000, 24000, 32000, 0] as const;
export const BITS_OPTIONS = [2, 4, 8] as const;

export const FMAX_OPTIONS = [0, 2000, 4000, 8000, 12000, 16000] as const;

export const VOICE: Encode = {
  mode: "compact",
  sr: 8000,
  bits: 8,
  // 默认 1024：8k 采样率下每格 7.8 Hz 已近收益顶点；2048 时间分辨率代价大，留给用户选。
  fineness: 2,
  fmax: 0,
  start: 0,
  end: 0,
};

export const winOf = (e: Encode): number => FINENESS[e.fineness]!.win;

export const OVERLAP = 4;

export const hopOf = (e: Encode): number => winOf(e) / OVERLAP;

export const hopOfWin = (win: number): number => win / OVERLAP;

export const dbSpanOf = (bits: number): number => 12 * Math.max(1, bits);
export const stepsOf = (bits: number): number => (1 << Math.max(1, bits)) - 1;

export const srLabel = (sr: number): string =>
  sr === 0 ? "原" : sr % 1000 === 0 ? `${sr / 1000}k` : `${(sr / 1000).toFixed(1)}k`;

export const hzLabel = (hz: number): string =>
  hz === 0 ? "全" : hz % 1000 === 0 ? `${hz / 1000}k` : `${hz}`;

export const reopen = (e: Encode): Encode => ({ ...e, start: 0, end: 0 });

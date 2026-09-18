import { t } from "./i18n";

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

// Window sizes: the kernel FFT plan table covers 256~4096 (moon/plan.mbt), so the menu offers all five.
// A longer window resolves frequency more finely (each cell is sr/win Hz) and time more coarsely
// (transients blur); total pixels barely depend on the window, since frames ∝ 1/win and bins ∝ win.
export const FINENESS = [
  { label: "256", win: 256 },
  { label: "512", win: 512 },
  { label: "1024", win: 1024 },
  { label: "2048", win: 2048 },
  { label: "4096", win: 4096 },
] as const;

export const SR_MIN = 8000;
export const SR_MAX = 96000;

export const BITS_OPTIONS = [2, 4, 8] as const;

export const VOICE: Encode = {
  mode: "compact",
  sr: 0,
  bits: 8,
  // 1024 by default: at 44.1 kHz each cell is 43 Hz; 2048 is left to the user.
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
  sr === 0 ? t("rateSource") : sr % 1000 === 0 ? `${sr / 1000}k` : `${(sr / 1000).toFixed(1)}k`;

export const hzLabel = (hz: number): string => {
  if (hz === 0) return t("bandFull");
  if (hz % 1000 === 0) return `${hz / 1000}k`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)}k`;
  return `${Math.round(hz)}`;
};

export const sourceSr = (srcSr: number): number => {
  const src = Number.isFinite(srcSr) && srcSr > 0 ? Math.round(srcSr) : SR_MIN;
  return Math.min(Math.max(src, SR_MIN), SR_MAX);
};

export const clampEncode = (e: Encode, srcSr: number): Encode => {
  const src = sourceSr(srcSr);
  const sr = e.sr > 0 && e.sr < src ? Math.max(SR_MIN, Math.round(e.sr)) : 0;
  const nyq = (sr || src) / 2;
  const fmax = e.fmax > 0 && e.fmax < nyq ? Math.round(e.fmax) : 0;
  return { ...e, sr, fmax };
};

export const reopen = (e: Encode): Encode => ({ ...e, start: 0, end: 0 });

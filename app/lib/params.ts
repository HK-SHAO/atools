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

export const SR_OPTIONS = [8000, 16000, 24000, 32000, 0] as const;
export const BITS_OPTIONS = [2, 4, 8] as const;

export const FMAX_OPTIONS = [0, 2000, 4000, 8000, 12000, 16000] as const;

export const VOICE: Encode = {
  mode: "compact",
  sr: 8000,
  bits: 8,
  // 1024 by default: at 8 kHz each cell is 7.8 Hz, already near the point of diminishing
  // returns; 2048 costs too much time resolution, so it is left to the user.
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

export const hzLabel = (hz: number): string =>
  hz === 0 ? t("bandFull") : hz % 1000 === 0 ? `${hz / 1000}k` : `${hz}`;

export const reopen = (e: Encode): Encode => ({ ...e, start: 0, end: 0 });

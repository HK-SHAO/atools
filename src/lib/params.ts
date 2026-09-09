export type Mode = "compact" | "exact";

export interface Encode {
  mode: Mode;
  sr: number;
  bits: number;
  fineness: 0 | 1 | 2;
  fmax: number;
  start: number;
  end: number;
}

export const FINENESS = [
  { label: "省", win: 256, div: 2 },
  { label: "中", win: 512, div: 2 },
  { label: "细", win: 1024, div: 4 },
] as const;

export const SR_OPTIONS = [8000, 16000, 32000, 0] as const;

export const BITS_OPTIONS = [2, 4, 8] as const;
export const FMAX_OPTIONS = [0, 2000, 4000, 6000, 8000] as const;

export const VOICE: Encode = {
  mode: "compact",
  sr: 8000,
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

export const dbSpanOf = (bits: number): number => 12 * Math.max(1, bits);
export const stepsOf = (bits: number): number => (1 << Math.max(1, bits)) - 1;

export const srLabel = (sr: number): string =>
  sr === 0 ? "原" : sr % 1000 === 0 ? `${sr / 1000}k` : `${(sr / 1000).toFixed(1)}k`;

export const hzLabel = (hz: number): string =>
  hz === 0 ? "全" : hz % 1000 === 0 ? `${hz / 1000}k` : `${hz}`;

export const reopen = (e: Encode): Encode => ({ ...e, start: 0, end: 0 });

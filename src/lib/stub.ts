export const STUB_ROWS = 8;

const bitPx = (w: number): number => (w >= 160 ? 4 : w >= 70 ? 2 : 1);
const MAGIC = 0b1011;
const DARK = 20;
const LIGHT = 230;

const CRC_POLY = 0x07;

const STUB_SR = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 176400, 192000,
] as const;

const WIN_TABLE = [256, 512, 1024, 2048] as const;

export interface StubInfo {

  width: number;
  sr: number;
  win: number;
  exact: boolean;
}

const srIndex = (sr: number): number => STUB_SR.indexOf(sr as (typeof STUB_SR)[number]);

function crc8(bits: number[]): number {
  let crc = 0xff;
  for (const b of bits) {
    crc ^= b << 7;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ CRC_POLY) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function stubBits(width: number, sr: number, win: number, exact: boolean): number[] | null {
  const si = srIndex(sr);
  const wi = WIN_TABLE.indexOf(win as (typeof WIN_TABLE)[number]);
  if (si < 0 || wi < 0 || width < 2 || width > 0xffff) return null;
  const [pre, wbits] = width <= 0xff ? [0, 8] : width <= 0xfff ? [1, 12] : [2, 16];
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  put(0b1010, 4);
  put(MAGIC, 4);
  put(pre, 2);
  put(width, wbits);
  put(si, 4);
  put(wi, 2);
  put(exact ? 1 : 0, 1);
  put(crc8(bits.slice(4)), 8);
  return bits;
}

const stubSpan = (w: number): number => {
  const bits = 25 + (w <= 0xff ? 8 : w <= 0xfff ? 12 : 16);
  return 2 + bits * bitPx(w);
};

export function stubLuma(w: number, sr: number, win: number, exact: boolean): Uint8Array | null {
  const bits = stubBits(w, sr, win, exact);
  if (!bits || w < stubSpan(w) + 2) return null;
  const row = new Uint8Array(w).fill(DARK);
  const span = stubSpan(w);
  const step = bitPx(w);
  const starts = w >= 2 * span + 6 ? [2, w - span] : [2];
  for (const x0 of starts) {
    for (let x = x0; x < Math.min(w, x0 + span); x++) {
      const at = x - x0;
      const bit = at < 2 ? 0 : bits[Math.floor((at - 2) / step)]!;
      row[x] = bit ? LIGHT : DARK;
    }
  }
  return row;
}

export function drawStub(
  px: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  sr: number,
  win: number,
  exact: boolean,
  toIndex?: (lum: number) => number,
): void {
  const row = stubLuma(w, sr, win, exact);
  if (!row) return;
  for (let y = h - STUB_ROWS; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const lum = row[x]!;
      if (toIndex) px[p] = toIndex(lum);
      else {
        px[p] = lum;
        px[p + 1] = lum;
        px[p + 2] = lum;
      }
      px[p + 3] = 255;
    }
  }
}

export function decodeStub(profile: ArrayLike<number>): StubInfo | null {
  const n = profile.length;
  if (n < 46) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = profile[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const th = (lo + hi) / 2;
  if (hi - lo < 120) return null;

  const runs: Array<[number, number]> = [];
  let cur = profile[0]! >= th ? 1 : 0;
  let len = 0;
  for (let i = 0; i < n; i++) {
    const v = profile[i]! >= th ? 1 : 0;
    if (v === cur) len++;
    else {
      runs.push([cur, len]);
      cur = v;
      len = 1;
    }
  }
  runs.push([cur, len]);

  for (let r = 0; r + 4 < runs.length; r++) {
    if (runs[r]![0] !== 1 || runs[r + 1]![0] !== 0 || runs[r + 2]![0] !== 1 || runs[r + 3]![0] !== 0)
      continue;
    const total = runs[r]![1] + runs[r + 1]![1] + runs[r + 2]![1] + runs[r + 3]![1];
    const unit = total / 4;
    if (unit < 0.3) continue;
    if (
      Math.round(runs[r]![1] / unit) !== 1 ||
      Math.round(runs[r + 1]![1] / unit) !== 1 ||
      Math.round(runs[r + 2]![1] / unit) !== 1 ||
      Math.round(runs[r + 3]![1] / unit) !== 1
    )
      continue;

    const bits: number[] = [];
    let totalBits = -1;
    let wN = 0;
    let bad = false;
    for (let j = r + 4; j < runs.length; j++) {
      const [v, l] = runs[j]!;
      const count = Math.max(1, Math.round(l / unit));
      for (let k = 0; k < count; k++) {
        bits.push(v);
        if (totalBits < 0 && bits.length >= 6) {
          const magic = (bits[0]! << 3) | (bits[1]! << 2) | (bits[2]! << 1) | bits[3]!;
          wN = [8, 12, 16, 0][bits[4]! * 2 + bits[5]!] ?? 0;
          if (magic !== MAGIC || !wN) {
            bad = true;
            break;
          }
          totalBits = 6 + wN + 15;
        }
        if (totalBits > 0 && bits.length >= totalBits) break;
      }
      if (bad || (totalBits > 0 && bits.length >= totalBits)) break;
    }
    if (bad || totalBits < 0 || bits.length !== totalBits) continue;
    const get = (at: number, w2: number): number => {
      let v = 0;
      for (let i = 0; i < w2; i++) v = (v << 1) | bits[at + i]!;
      return v;
    };
    if (crc8(bits.slice(0, 13 + wN)) !== get(13 + wN, 8)) continue;
    const width = get(6, wN);
    const si = get(6 + wN, 4);
    const wi = get(10 + wN, 2);
    if (si >= STUB_SR.length || width < 2) continue;
    return { width, sr: STUB_SR[si]!, win: WIN_TABLE[wi]!, exact: get(12 + wN, 1) === 1 };
  }
  return null;
}

export const stubFits = (w: number): boolean => w >= stubSpan(w) + 4;

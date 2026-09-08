/*
 * 条码票根（stub barcode）：导出图最底部 8px 高的黑白游程码。
 *
 * 为什么需要它：meta（tEXt）会被微信等平台的重压缩剥掉，文件名会被改，
 * 缩放后几何全变 —— 而采样率/窗长/原始宽度无法从缩放后的像素反推，
 * 读端只能瞎猜（这正是「加速、升频、大失真」的根源）。票根是唯一能在
 * 「JPEG 重压缩 + 等比缩放」下存活的通道：游程边沿随缩放等比移动，
 * 解码按「前导四游程估比例尺」，天然免疫等比缩放；大块黑白对 JPEG 稳健。
 *
 * 位流（可变长，MSB first）：
 *   前导 4bit (1010，同步+比例尺) · magic 4bit (1011) · 宽度前缀 2bit
 *   · 原始宽度 8/12/16bit · 采样率表索引 4bit · 窗长档 2bit (256/512/1024/2048)
 *   · 可逆布局 1bit · CRC8 8bit（覆盖 magic..exact）
 *
 * 物理编码：每 bit 占 4px（宽图）/ 2px（窄图 <160px）宽的竖条（1=浅、0=深），
 * 连续同值合并成游程；条底色为深，条高 8px。图够宽时写两遍。
 */

export const STUB_ROWS = 8;
/** 1 bit 占多少原始像素宽：宽图 4px（最稳），窄图 2px（换取写得下）。 */
const bitPx = (w: number): number => (w >= 160 ? 4 : w >= 70 ? 2 : 1);
const MAGIC = 0b1011;
const DARK = 20;
const LIGHT = 230;
/** CRC8 多项式（初值 0xFF，覆盖 magic..exact 共 26bit） */
const CRC_POLY = 0x07;

/** 采样率档位表（索引 14/15 保留） */
export const STUB_SR = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 176400, 192000,
] as const;

const WIN_TABLE = [256, 512, 1024, 2048] as const;

export interface StubInfo {
  /** 原始图宽（= 帧数） */
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

/**
 * 位流（可变长，0/1，MSB first）：
 *   前导 4bit (1010) · magic 4bit (1011) · 宽度前缀 2bit（0/1/2 = 8/12/16 bit 宽度）
 *   · 原始宽度 · 采样率表索引 4bit · 窗长档 2bit · 可逆布局 1bit · CRC8 8bit
 * CRC 覆盖 magic..exact。参数放不进表里返回 null。
 */
export function stubBits(width: number, sr: number, win: number, exact: boolean): number[] | null {
  const si = srIndex(sr);
  const wi = WIN_TABLE.indexOf(win as (typeof WIN_TABLE)[number]);
  if (si < 0 || wi < 0 || width < 2 || width > 0xffff) return null;
  const [pre, wbits] = width <= 0xff ? [0, 8] : width <= 0xfff ? [1, 12] : [2, 16];
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  put(0b1010, 4); // 前导：亮暗亮暗四游程（与深色锚异值，不粘连）→ 同步 + 比例尺
  put(MAGIC, 4);
  put(pre, 2);
  put(width, wbits);
  put(si, 4);
  put(wi, 2);
  put(exact ? 1 : 0, 1);
  put(crc8(bits.slice(4)), 8); // CRC 覆盖 magic..exact
  return bits;
}

/** 位流物理宽度（像素）：左 2px 深色锚 + 位流×位宽。位流 = 前导4+magic4+前缀2+宽度+7+8。 */
const stubSpan = (w: number): number => {
  const bits = 25 + (w <= 0xff ? 8 : w <= 0xfff ? 12 : 16);
  return 2 + bits * bitPx(w);
};

/**
 * 生成一整行票根亮度（长度 = 图宽；0..255）。放不下或参数非法返回 null。
 * 三种导出端复用：RGB 直接写三通道；索引色经调色板映射；16 位灰度 ×257。
 */
export function stubLuma(w: number, sr: number, win: number, exact: boolean): Uint8Array | null {
  const bits = stubBits(w, sr, win, exact);
  if (!bits || w < stubSpan(w) + 2) return null;
  const row = new Uint8Array(w).fill(DARK);
  const span = stubSpan(w);
  const step = bitPx(w);
  // 两遍：第二遍贴右缘，中段留深色间隔；不够就只画一遍。
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

/**
 * 把票根画进 RGBA/索引像素矩阵的最底部 8 行。
 * 索引色传 toIndex 把亮度映射成调色板索引。
 */
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
      // alpha 必须显式写 255：调用方的 RGBA 矩阵是零初始化的，漏写会导出成
      // 全透明行，canvas 预乘读回 RGB 全 0，票根直接消失（exact 模式实测踩过）。
      px[p + 3] = 255;
    }
  }
}

/**
 * 从底部行带的平均亮度剖面（1D，长度=图宽）解码票根。
 * 缩放/JPEG 后调用方应从满 8 行开始，失败则递减行数重试。
 */
export function decodeStub(profile: ArrayLike<number>): StubInfo | null {
  const n = profile.length;
  if (n < 46) return null; // 最小配置（2px 位宽、8bit 宽度）也要 ~68px，放宽到 46 防御
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = profile[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const th = (lo + hi) / 2;
  if (hi - lo < 120) return null; // 对比度不足，不像票根

  // 游程分解：[值(1=亮), 长度]
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

  // 同步：找连续 4 个均匀交替游程（前导 1010 → 亮,暗,亮,暗），
  // 用四个游程的总长估比例尺 —— 总长估计能抵消缩放插值的边沿模糊。
  for (let r = 0; r + 4 < runs.length; r++) {
    if (runs[r]![0] !== 1 || runs[r + 1]![0] !== 0 || runs[r + 2]![0] !== 1 || runs[r + 3]![0] !== 0)
      continue;
    const total = runs[r]![1] + runs[r + 1]![1] + runs[r + 2]![1] + runs[r + 3]![1];
    const unit = total / 4; // 1 bit 的像素宽（每个前导游程恰好 1 bit）
    if (unit < 0.3) continue;
    // 每个前导游程都应是 1 bit 宽
    if (
      Math.round(runs[r]![1] / unit) !== 1 ||
      Math.round(runs[r + 1]![1] / unit) !== 1 ||
      Math.round(runs[r + 2]![1] / unit) !== 1 ||
      Math.round(runs[r + 3]![1] / unit) !== 1
    )
      continue;

    // 收位：先收 magic(4)+宽度前缀(2) 确定总长，再收到总长。
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
          totalBits = 6 + wN + 15; // + 采样率4 + 窗2 + 可逆1 + CRC8
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

/** 图宽是否够写票根（不够则导出时不画，读端回退几何猜测） */
export const stubFits = (w: number): boolean => w >= stubSpan(w) + 4;

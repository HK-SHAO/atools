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
  { label: "省", win: 256 },
  { label: "中", win: 512 },
  { label: "细", win: 1024 },
] as const;

/**
 * 采样率：电话 8k / 宽带语音 16k / 通用音频 24k / 广播 32k，外加「原」（不降采样，
 * 用源自己的采样率）。相邻至少差 33%，跨度上看就是一条 ×2 的梯子中间插了一档。
 *
 * 不塞 11.025 / 22.05 kHz：它们与相邻档的差别在带宽、图长、听感上都分辨不出
 * （22.05 与 24 只差 8.8%），加进来只是让梯子多一格、让人多犹豫一次。
 * 高于源采样率的档位也造不出带宽，所以梯子到此为止。
 */
export const SR_OPTIONS = [8000, 16000, 24000, 32000, 0] as const;
export const BITS_OPTIONS = [2, 4, 8] as const;

/**
 * 频宽（保留到多少 Hz）—— 每档正好是某档采样率的奈奎斯特：4k=8k/2、8k=16k/2、
 * 12k=24k/2、16k=32k/2，再加 2k（窄到只剩语音的骨干频段）。界面上只列出**小于**当前
 * 奈奎斯特的档（等于奈奎斯特就是「全」，重复）。
 *
 * 曾经最大只到 8k，于是 32k 采样（可用到 16k）也最多只能选 8k —— 花了高采样率的像素
 * 却拿不到更宽的带，且没有任何说明。梯子本身不该有上限，上限是奈奎斯特。
 */
export const FMAX_OPTIONS = [0, 2000, 4000, 8000, 12000, 16000] as const;

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

/** 重叠倍数。4 倍是幅度量化 + 相位重建的甜点，见 hopOf 的注释。 */
export const OVERLAP = 4;

/**
 * hop 恒为 win/4，三档一致 —— 不再按档给不同的重叠倍数。
 *
 * 曾经「省/中」是 win/2、「细」是 win/4，理由是让三档的图差不多大。实测这是个真缺陷：
 * 幅度量化 + 相位重建下 hop=win/2 是**临界采样**，重叠只有 2 倍，帧间约束不足以定住
 * 包络，窗越长越糟。18 段配对（8k 8bit，中位数）：
 *
 * | win | hop=win/2 | hop=win/4 |
 * | --- | --- | --- |
 * | 256 | 包络 0.938 / LSD 6.08 | 0.998 / 4.06 |
 * | 512 | 0.737 / 5.56 | 0.991 / 2.62 |
 * | 1024 | 0.461 / 7.14 | 0.962 / 2.75 |
 *
 * 于是三档里**窗最长的「中」被叠了两个劣势**（win/2 且窗长），成了三者中最差的一档，
 * 而它正是默认档。统一到 win/4 后三档的图面积仍然相同（像素 ≈ N·重叠/2，与窗长无关），
 * 梯子变成纯粹按窗长 —— 与界面标签「窗长」一致。win/8 试过：三档里两项变差且图翻倍。
 *
 * 这条常量也被无元数据时的几何反推（`image.ts` 的 metaFromGeometry 与票根路径）使用，
 * 改这里必须同步改那两处。
 */
export const hopOf = (e: Encode): number => winOf(e) / OVERLAP;

/** 同一个常量的「只有 win」入口：无元数据时按几何反推参数要用（见 image.ts）。 */
export const hopOfWin = (win: number): number => win / OVERLAP;

export const dbSpanOf = (bits: number): number => 12 * Math.max(1, bits);
export const stepsOf = (bits: number): number => (1 << Math.max(1, bits)) - 1;

export const srLabel = (sr: number): string =>
  sr === 0 ? "原" : sr % 1000 === 0 ? `${sr / 1000}k` : `${(sr / 1000).toFixed(1)}k`;

export const hzLabel = (hz: number): string =>
  hz === 0 ? "全" : hz % 1000 === 0 ? `${hz / 1000}k` : `${hz}`;

export const reopen = (e: Encode): Encode => ({ ...e, start: 0, end: 0 });

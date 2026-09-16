export type Lang = "en" | "zh";

const en = {
  title: "Spectrum: sound ↔ image",
  brand: "SPECTRUM",
  tagline: "sound ↔ image",

  about: "About",
  clear: "Clear",
  demo: "Demo",

  dropLead: "Sound becomes an image, and back again",
  dropFormats: "mp3, wav, flac, m4a, ogg, amr ↔ png, jpg, webp",
  dropPrivacy: "Files are processed locally; nothing is uploaded",
  pickFile: "Choose file",

  aboutTitle: "Sound can be an image",
  aboutLead1: "Drop in audio to get a spectrogram; drop the image back to hear it again.",
  aboutLead2: "It is an ordinary image: forward it, compress it, keep it in a photo album.",
  aboutLead3: "What you hear back depends on what the image has been through.",
  aboutTech: "Technical",
  aboutKernel: "The kernel is MoonBit compiled to WebAssembly, called straight from the browser.",
  aboutUi: "The interface is React and TypeScript, built with Bun; the output is a static page.",
  aboutCore:
    "The core is a short-time Fourier transform. Compact mode rebuilds phase with PGHI and RTISI-LA; exact mode writes the phase into the image.",
  aboutMeasured: "Measured",
  aboutSpeed: "Encoding and restoring 30 seconds of audio takes 172 ms, about 170× real time.",
  aboutError:
    "Worst-case STFT error against librosa 0.11.0 is 6.1e-16; the FFT stays within 1e-12 of a naive DFT.",
  credit: "{name} created by",
  source: "Source",
  close: "Close",

  play: "Play",
  pause: "Pause",
  busy: "…",

  storeCompact: "compact: phase omitted",
  storeExact: "exact: phase stored",
  readExact: "Phase loaded; lossless images sound better",
  readDegraded: "Lossy image, sound will be distorted",
  readForeign: "Not a spectrum image; loading it is not advised",
  sampleRate: "Sample rate",
  lossLsd: "Spectral distance: ",
  lossAll: "Correlation, SNR, spectral distance: ",
  selfCheck: "Self-check: saved and read back, bit for bit",
  saveImage: "Save image",
  saveAudio: "Save audio",
  verify: "Verify",
  verifying: "Verifying {pct}%",
  rebuildPhase: "Rebuild phase",
  timeline: "Playhead: click to play, drag to scrub, arrow keys to nudge",

  advanced: "Advanced",
  mode: "Mode",
  compact: "Compact",
  exact: "Exact",
  rate: "Rate",
  rateSource: "Source",
  depth: "Depth",
  window: "Window",
  band: "Band",
  bandFull: "Full",
  range: "Range",
  rangeFrom: "from",
  rangeTo: "to",
  rangeFromAria: "Start time in seconds",
  rangeToAria: "End time in seconds",

  stageConvert: "Converting",
  stageEncode: "Encoding image",
  stagePack: "Packing",
  stageRefine: "Refining",
  stageRestore: "Restoring",
  stageDecode: "Decoding",
  stageRead: "Reading",
  stageReadImage: "Reading image",
  stageSynthesise: "Synthesising",

  errConvert: "Conversion failed",
  errRestore: "Restore failed",
  errFile: "Can't process this file",
  errDemo: "Couldn't load the demo",
  errKernel: "The numeric kernel is not running",
  errKernelMessage: "The kernel message could not be parsed",
  errPipeline: "The pipeline failed",
  errEmptyFile: "This file is empty",
  errAudio: "Couldn't decode this audio{head}. {help}",
  errAudioAmr: "Couldn't decode this AMR audio. {help}",
  decodeHelp:
    "Supported: mp3, wav, flac, m4a, ogg, opus, amr. Convert SILK voice notes and video files to one of these first.",
  headDetected: " (detected {head})",
  errImage: "Image files must be at most 64 MiB",
  errTooLong: "Audio too long for one image: lower the rate or trim it",
  hintTrim: "Audio too long, keeping the first {keep} s",
  hintFit: "Audio of {secs} s exceeds the {want} limit of {ceiling} s, dropped to {sr}",
  hintGuessed:
    "The parameters recorded in this image were stripped, usually by compression or forwarding, so defaults were used; adjust the settings below if the duration or pitch is off",
  hintWeakPhase:
    "The phase reference in this image is weak; Rebuild phase can recover better quality from it",
  hintNoPhase: "The phase in this image could not be read; Rebuild phase can regenerate it",
  hintRefined: "Phase rebuilt",

  case: "original",
  caseLossy: "lossy",
  caseHalf: "half size",

  sep: "; ",
} as const;

export type Key = keyof typeof en;

const zh: Record<Key, string> = {
  title: "留声 SPECTRUM：声音与图像双向转换",
  brand: "留声 SPECTRUM",
  tagline: "声音 ↔ 图像",

  about: "关于",
  clear: "清空",
  demo: "演示",

  dropLead: "声音转换成图像，还能转换回去",
  dropFormats: "mp3, wav, flac, m4a, ogg, amr ↔ png, jpg, webp",
  dropPrivacy: "音频与图片在本地处理，不上传文件",
  pickFile: "选文件",

  aboutTitle: "声音可以是一张图",
  aboutLead1: "拖入音频，得到频谱图；把图拖回来，听见原来的声音。",
  aboutLead2: "它是一张普通图片，能转发、压缩、存进相册。",
  aboutLead3: "读回来的质量取决于它经历过什么。",
  aboutTech: "技术",
  aboutKernel: "内核 MoonBit，编译为 Wasm，浏览器直接调用。",
  aboutUi: "界面 React 与 TypeScript，构建 Bun；产物是纯静态页面。",
  aboutCore: "原理是短时傅里叶变换。紧凑模式用 PGHI 与 RTISI-LA 重建相位，可逆模式把相位写进图片。",
  aboutMeasured: "实测",
  aboutSpeed: "30 秒音频的编码与还原 172 ms，约 170 倍实时。",
  aboutError: "STFT 与 librosa 0.11.0 的最差相对误差 6.1e-16，FFT 与朴素 DFT 在 1e-12 以内。",
  credit: "{name} 作者",
  source: "源代码",
  close: "关闭",

  play: "播放",
  pause: "暂停",
  busy: "中",

  storeCompact: "紧凑：不保存相位信息",
  storeExact: "可逆模式：保存相位信息",
  readExact: "相位已载入。无损图片的音质更好",
  readDegraded: "此图片有损，音质会失真",
  readForeign: "不建议加载非专用图片",
  sampleRate: "采样率",
  lossLsd: "谱距离：",
  lossAll: "相关度，信噪比，谱距离：",
  selfCheck: "自检：存出再读回，完全一致",
  saveImage: "存频谱图",
  saveAudio: "存音频",
  verify: "质检",
  verifying: "质检 {pct}%",
  rebuildPhase: "重建相位",
  timeline: "播放进度：点按即播，拖动可擦洗，左右方向键微调",

  advanced: "进阶参数",
  mode: "模式",
  compact: "紧凑",
  exact: "可逆",
  rate: "采样",
  rateSource: "原",
  depth: "位深",
  window: "窗长",
  band: "频宽",
  bandFull: "全",
  range: "区间",
  rangeFrom: "起",
  rangeTo: "止",
  rangeFromAria: "起点秒数",
  rangeToAria: "终点秒数",

  stageConvert: "转换",
  stageEncode: "生成图片",
  stagePack: "打包",
  stageRefine: "精修",
  stageRestore: "还原",
  stageDecode: "解码",
  stageRead: "读取",
  stageReadImage: "读图",
  stageSynthesise: "还原声音",

  errConvert: "转换失败",
  errRestore: "还原失败",
  errFile: "这个文件处理不了",
  errDemo: "示例加载失败",
  errKernel: "数值内核没能启动",
  errKernelMessage: "数值内核的消息解析失败",
  errPipeline: "数值流水线出错",
  errEmptyFile: "这是个空文件",
  errAudio: "解不出这段音频{head}。{help}",
  errAudioAmr: "解不出这段 AMR 音频。{help}",
  decodeHelp: "支持 mp3、wav、flac、m4a、ogg、opus、amr。SILK 微信语音与视频文件请先转存为上述音频格式",
  headDetected: "（识别为 {head}）",
  errImage: "图片文件不能超过 64 MiB",
  errTooLong: "音频太长，图放不下：调低采样率，或剪短一点",
  hintTrim: "音频太长，只保留前 {keep} 秒",
  hintFit: "音频 {secs} 秒超出 {want} 的上限 {ceiling} 秒，已降到 {sr}",
  hintGuessed:
    "图里记录的参数被剥掉了（多半是压缩或转发所致），已按默认设置解读；若时长或音高不对，可在下方参数里调整",
  hintWeakPhase: "图中相位参考置信度较低，点「重建相位」可借它还原出更高音质",
  hintNoPhase: "图里的相位没能读回来，点「重建相位」可重新生成",
  hintRefined: "相位已重建",

  case: "原图",
  caseLossy: "有损",
  caseHalf: "半尺寸",

  sep: "；",
};

const DICT: Record<Lang, Record<Key, string>> = { en, zh };

export const strings = (lang: Lang): Record<Key, string> => DICT[lang];

export const pickLang = (tags: readonly string[] = []): Lang =>
  tags.some(tag => /^zh(?:[-_]|$)/i.test(tag)) ? "zh" : "en";

export const LANG: Lang = pickLang(
  typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]),
);

export const t = (key: Key, vars?: Record<string, string>): string => {
  const text = DICT[LANG][key];
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole) : text;
};

export const applyHead = (lang: Lang = LANG): void => {
  document.documentElement.lang = lang;
  document.title = strings(lang).title;
};

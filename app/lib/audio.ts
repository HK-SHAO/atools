import type { Samples } from "./arrays";

export interface Decoded {
  pcm: Samples;
  sr: number;
}

export function sniffAudio(b: Uint8Array): string {
  const ascii = (at: number, len: number): string =>
    String.fromCharCode(...b.subarray(at, at + len));
  if (b.length > 12) {
    const brand = ascii(8, 4);
    if (brand.startsWith("3gp")) return "3GP（手机通话录音常用）";
    if (ascii(4, 4) === "ftyp") return "M4A/MP4";
  }
  if (ascii(0, 5) === "#!AMR") return "AMR（微信等语音常用）";
  if (ascii(1, 9) === "#!SILK_V3" || ascii(0, 9) === "#!SILK_V3") return "SILK（微信语音专有）";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "WebM/MKV";
  if (ascii(0, 4) === "OggS") return ascii(28, 8) === "OpusHead" ? "OGG/Opus" : "OGG";
  if (ascii(0, 4) === "fLaC") return "FLAC";
  if (ascii(0, 4) === "RIFF") return "WAV";
  if (ascii(0, 3) === "ID3") return "MP3";
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)
    return (b[1]! & 0x06) === 0 ? "AAC（ADTS 裸流）" : "MP3";
  return "";
}

const DECODE_HELP =
  "支持 mp3、wav、flac、m4a、ogg、opus、amr。SILK 微信语音与视频文件请先转存为上述音频格式";

function decodeRaw(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((ok, no) => {
    const p = ctx.decodeAudioData(data, ok, err =>
      no(err instanceof Error ? err : new Error(String(err ?? "解码失败"))),
    );
    void p?.catch(() => {}); // 回调式的返回 Promise 弃用之，reject 会成未捕获异常
  });
}

/** `@audio/decode-*` 的 `meta` 子路径只随包发了 .js，类型在 audio-meta.d.ts 里补。 */
type MetaParser = { parseMeta(bytes: Uint8Array): { sampleRate?: number } | null };

/**
 * 各容器的「只读元数据」入口。认识容器这份活交给 `@audio/decode-*` 自带的解析器 ——
 * 同一个作者、同一份格式知识，不再手写第六份容器解析（WAV 的 `fmt ` 曾在这里手抄过一遍）。
 *
 * **M4A/MP4 刻意不在表里。** 它的 `mp4a` 条目在 HE-AAC v1 上写的是**核**速率而不是解出来的
 * 速率（本仓 `he-aac.m4a` 写 22050，解码器给 44100）。照 22050 建上下文，浏览器会先把 SBR
 * 展开到 44100、再为迁就上下文把它压回 22050 —— 那一道**丢掉整条 11k~22k 的高频带**，比多
 * 转一道重采样糟得多。同一个字段在实际文件里两种写法都有（Apple 系写输出速率），容器自己都
 * 没定论，就别猜。M4A 于是照旧走 `DECODE_RATE`，代价只是多一道重采样 —— 而且只在**原生解得开**
 * 时付：原生解不开就落到 WASM 兜底，那边解码器自己会报出 44100。
 */
const META_PARSERS: Record<string, () => Promise<MetaParser>> = {
  FLAC: () => import("@audio/decode-flac/meta"),
  WAV: () => import("@audio/decode-wav/meta"),
  OGG: () => import("@audio/decode-vorbis/meta"),
  "OGG/Opus": () => import("@audio/decode-opus/meta"),
};

/**
 * 采样率的合理窗口。窗口外的值只会来自被读坏的字段，一律不认。
 *
 * 上界与解码上下文能接受的上界是同一个数（`OfflineAudioContext` 的 `sampleRate` 只收
 * 8000~96000）：再高的速率我们连上下文都建不出来，认了也只能落到 `DECODE_RATE`，
 * 那还不如在这里就说不认识 —— 一个边界只有一个地方写。
 */
const SR_MIN = 8000;
const SR_MAX = 96000;

/**
 * 容器里读不出采样率时的解码速率（M4A 是主要的一类，见 `META_PARSERS` 的注释）。
 *
 * 过去这里是「设备速率」：`new AudioContext()` 不给参数就是这个值。但那个构造本身要
 * **135 ms**（实测，headless Chromium），而且它是主线程上一个实打实的长任务 ——
 * 用户点「演示」或拖进一个音频文件，界面就卡在那里一动不动，跟解码毫无关系
 * （同一份素材实测：构造 135 ms，真正解码 17 ms，还跑在别的线程上）。改成定值换来两件事：
 * 不必为了问一个速率去建设备上下文；**同一个文件不再随机器变**（44.1k 设备上过去解出
 * 44100，现在解出 48000）。
 *
 * 代价要认：这类文件在「原」档下拿到的速率跟着变。但两边都不是素材的真实速率 ——
 * 真实速率只有 WASM 兜底那条路报得出来（解码器自己给的）。
 */
const DECODE_RATE = 48000;

/** MPEG1 的三个采样率档；MPEG2 减半、MPEG2.5 再减半。 */
const MP3_RATES = [44100, 48000, 32000] as const;

/**
 * mp3 的采样率 —— 库的 `meta` 只解析 ID3，帧头得自己看，所以这里补上这一处。
 *
 * 帧头在 ID3 标签之后（`parseId3v2` 给出的 `size` 就是它的偏移）。三处保留值可以当场否掉误判：
 * 版本位 01、层位 00 都不是合法帧，采样率索引 11（=3）也保留。撞上 ID3 正文里的假同步时，
 * 这几道检查几乎必然拦下 —— 拦不下的后果也只是白转一道。
 */
async function mp3Rate(bytes: Uint8Array): Promise<number> {
  const { parseId3v2 } = await import("@audio/decode-mp3/meta");
  const at = parseId3v2(bytes)?.size ?? 0;
  for (let i = at; i + 4 <= bytes.length && i < at + 2048; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1]! >> 3) & 0x03;
    const layer = (bytes[i + 1]! >> 1) & 0x03;
    const index = (bytes[i + 2]! >> 2) & 0x03;
    if (version === 1 || layer === 0 || index === 3) continue;
    // 版本位：3=MPEG1、2=MPEG2、0=MPEG2.5（01 已在上面否掉）
    return MP3_RATES[index]! >> (version === 3 ? 0 : version === 2 ? 1 : 2);
  }
  return 0;
}

/**
 * 素材自己的采样率 —— 拿不到就返回 null（退回 `DECODE_RATE`）。
 *
 * 为什么非要它：`decodeAudioData` 把结果重采样到**解码上下文的采样率**，而上下文一旦按默认值
 * 建就是**设备**速率（本机 headless Chromium 实测 48000）。44.1k 的素材于是先被转到 48k、再由
 * 我们转到目标档：多一道不可控的重采样、慢得多（同一段 60s 素材 65ms 对 17ms），而且「原声档」
 * 拿到的其实是 48k —— 名不副实。容器里本来就写着这个数。
 *
 * 猜错的后果不重：上下文速率不对只是让浏览器替我们多转一道，音高与时长都不变；但「原」就不再是
 * 原，那一道重采样也白付。所以窗口之外、解析抛错、认不出的容器，一律退回 `DECODE_RATE`。
 */
export async function containerRate(head: string, bytes: Uint8Array): Promise<number | null> {
  let rate = 0;
  try {
    const load = META_PARSERS[head];
    rate = head === "MP3" ? await mp3Rate(bytes) : load ? ((await load()).parseMeta(bytes)?.sampleRate ?? 0) : 0;
  } catch {
    return null; // 解析器对着畸形文件抛错是它的事，这里只关心「拿不到」
  }
  return Number.isInteger(rate) && rate >= SR_MIN && rate <= SR_MAX ? rate : null;
}

function mixdown(channels: Float32Array[]): Samples {
  const n = channels[0]!.length;
  if (channels.length === 1) return Float32Array.from(channels[0]!);
  const pcm = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) pcm[i] = pcm[i]! + ch[i]!;
  for (let i = 0; i < n; i++) pcm[i] = pcm[i]! / channels.length;
  return pcm;
}

const WASM_DECODERS = {
  amr: () => import("@audio/decode-amr"),
  aac: () => import("@audio/decode-aac"),
  mp3: () => import("@audio/decode-mp3"),
  wav: () => import("@audio/decode-wav"),
  vorbis: () => import("@audio/decode-vorbis"),
  opus: () => import("@audio/decode-opus"),
  flac: () => import("@audio/decode-flac"),
};

type Engine = keyof typeof WASM_DECODERS;

const FALLBACKS: Record<string, Engine[]> = {
  "M4A/MP4": ["aac"],
  "AAC（ADTS 裸流）": ["aac"],
  "OGG/Opus": ["opus", "vorbis"],
  OGG: ["vorbis", "opus"],
  FLAC: ["flac"],
  MP3: ["mp3"],
  WAV: ["wav"],
};

async function decodeWasm(engine: Engine, bytes: Uint8Array): Promise<Decoded> {
  const decode = (await WASM_DECODERS[engine]()).default;
  const { channelData, sampleRate } = await decode(bytes);
  if (!channelData[0] || channelData[0].length === 0) throw new Error("空流");
  return { pcm: mixdown(channelData), sr: sampleRate };
}

/**
 * 解码上下文：**刻意不用 `AudioContext`**，用 `OfflineAudioContext`。
 *
 * 两者都是 `BaseAudioContext`，`decodeAudioData` 的行为**逐样点相同**（同一份 ogg 在
 * 8000 / 44100 / 48000 三档各比位一次，0 个样点不同、长度与返回速率也都一致），
 * 但构造代价差两个数量级：`new AudioContext(...)` 实测 135 ms，`OfflineAudioContext` 0~1 ms。
 * 那 135 ms 就是用户点「演示」时主线程上那个长任务；换掉之后整段只剩解码本身（17 ms，
 * 本来就在别的线程上跑）。顺带两件事：解码不输出声音，本就不该去碰音频设备；
 * 也不受自动播放策略约束（不需要用户手势）。
 *
 * OfflineAudioContext **没有 `close()`**，也不需要 —— 它不占音频设备，
 * 解码出来的缓冲随引用一起回收（`hasClose` 实测 undefined）。
 */
function decodeContext(rate: number): BaseAudioContext {
  const Ctor =
    typeof OfflineAudioContext !== "undefined"
      ? OfflineAudioContext
      : (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
          .webkitOfflineAudioContext;
  if (!Ctor) throw new Error("这个浏览器不支持离线音频上下文");
  return new Ctor(1, 1, rate);
}

async function decodeNative(data: ArrayBuffer, rate: number | null): Promise<Decoded | null> {
  let ctx: BaseAudioContext;
  try {
    // 知识别出来的原生速率就先按它建上下文，免得被 `DECODE_RATE` 偷换一道。
    ctx = decodeContext(rate ?? DECODE_RATE);
  } catch {
    return null; // 老浏览器没有这个接口 —— 那就走 WASM 兜底
  }

  try {
    const buffer = await decodeRaw(ctx, data.slice(0));
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    if (channels[0]!.length === 0) throw new Error("空流");
    return { pcm: mixdown(channels), sr: buffer.sampleRate };
  } catch (e) {
    console.error("原生解码失败，尝试 WASM 兜底", e);
    return null;
  }
}

export async function decodeAudioFile(data: ArrayBuffer): Promise<Decoded> {
  if (data.byteLength === 0) throw new Error("这是个空文件");
  const bytes = new Uint8Array(data);
  const head = sniffAudio(bytes);

  if (head.startsWith("AMR")) {
    try {
      return await decodeWasm("amr", bytes);
    } catch (e) {
      console.error(e);
      throw new Error(`解不出这段 AMR 音频。${DECODE_HELP}`);
    }
  }

  const native = await decodeNative(data, await containerRate(head, bytes));
  if (native) return native;

  for (const engine of FALLBACKS[head] ?? []) {
    try {
      return await decodeWasm(engine, bytes);
    } catch (e) {
      console.error(`WASM ${engine} 引擎解码失败`, e);
    }
  }

  throw new Error(`解不出这段音频${head ? `（识别为 ${head}）` : ""}。${DECODE_HELP}`);
}

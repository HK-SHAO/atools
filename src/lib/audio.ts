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

// 原生 decodeAudioData 各家支持参差（Safari 不认 OGG、部分安卓 WebView 不认 ALAC 等），
// 按嗅探结果落到对应 WASM 引擎；Ogg 容器按首包魔数定序，另一编码留作次选兜底。
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

async function decodeNative(data: ArrayBuffer): Promise<Decoded | null> {
  let ctx: AudioContext | null = null;
  try {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor!;
    const buffer = await decodeRaw(ctx, data.slice(0));
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    if (channels[0]!.length === 0) throw new Error("空流");
    return { pcm: mixdown(channels), sr: buffer.sampleRate };
  } catch {
    return null;
  } finally {
    void ctx?.close();
  }
}

export async function decodeAudioFile(data: ArrayBuffer): Promise<Decoded> {
  if (data.byteLength === 0) throw new Error("这是个空文件");
  const bytes = new Uint8Array(data);
  const head = sniffAudio(bytes);

  if (head.startsWith("AMR")) {
    try {
      return await decodeWasm("amr", bytes);
    } catch {
      throw new Error(`解不出这段 AMR 音频。${DECODE_HELP}`);
    }
  }

  const native = await decodeNative(data);
  if (native) return native;

  for (const engine of FALLBACKS[head] ?? []) {
    try {
      return await decodeWasm(engine, bytes);
    } catch {}
  }

  throw new Error(`解不出这段音频${head ? `（识别为 ${head}）` : ""}。${DECODE_HELP}`);
}

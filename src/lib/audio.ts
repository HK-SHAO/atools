import type { Samples } from "./arrays";

const DEMO_SECONDS = 3.2;

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
  if (ascii(0, 4) === "OggS") return "OGG";
  if (ascii(0, 4) === "fLaC") return "FLAC";
  if (ascii(0, 4) === "RIFF") return "WAV";
  if (ascii(0, 3) === "ID3") return "MP3";
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)
    return (b[1]! & 0x06) === 0 ? "AAC（ADTS 裸流）" : "MP3";
  return "";
}

const DECODE_HELP =
  "支持 mp3、wav、flac、m4a、ogg、opus、amr、3gp、webm。SILK 微信语音请先转存为上述格式";

function decodeRaw(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((ok, no) => {
    void ctx.decodeAudioData(data, ok, err =>
      no(err instanceof Error ? err : new Error(String(err ?? "解码失败"))),
    );
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
  mp4: () => import("@audio/decode-mp4"),
  mp3: () => import("@audio/decode-mp3"),
  wav: () => import("@audio/decode-wav"),
  vorbis: () => import("@audio/decode-vorbis"),
  opus: () => import("@audio/decode-opus"),
  flac: () => import("@audio/decode-flac"),
  webm: () => import("@audio/decode-webm"),
};

type Engine = keyof typeof WASM_DECODERS;

// 原生 decodeAudioData 各家支持参差（Safari 不认 OGG、部分安卓 WebView 不认 ALAC 等），
// 按嗅探结果落到对应 WASM 引擎；OGG 容器可能是 Vorbis 或 Opus，两个都试。
const FALLBACKS: Record<string, Engine[]> = {
  "M4A/MP4": ["aac"],
  "AAC（ADTS 裸流）": ["aac"],
  "3GP（手机通话录音常用）": ["mp4"],
  OGG: ["vorbis", "opus"],
  FLAC: ["flac"],
  MP3: ["mp3"],
  WAV: ["wav"],
  "WebM/MKV": ["webm"],
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

export function demoTrack(sr: number): Samples {
  const n = Math.round(sr * DEMO_SECONDS);
  const pcm = new Float32Array(n);
  let seed = 20260908;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

  const f0 = 140;
  const f1 = 9000;
  const ratio = f1 / f0;
  const k = (2 * Math.PI * f0 * DEMO_SECONDS) / Math.log(ratio);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    pcm[i] = 0.34 * Math.sin(k * (Math.pow(ratio, t / DEMO_SECONDS) - 1));
  }

  const chord = [110, 164.81, 220, 277.18];
  chord.forEach((f, idx) => {
    const gain = 0.2 / (1 + idx * 0.4);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 1.1) * (1 - Math.exp(-t * 220));
      pcm[i] = pcm[i]! + gain * env * Math.sin(2 * Math.PI * f * t + Math.sin(2 * Math.PI * 5 * t) * 0.6);
    }
  });

  for (const [at, len] of [
    [0.35, 0.05],
    [2.1, 0.03],
  ] as const) {
    const from = Math.round(at * sr);
    const size = Math.round(len * sr);
    for (let i = 0; i < size && from + i < n; i++) {
      const env = Math.pow(1 - i / size, 3);
      pcm[from + i] = pcm[from + i]! + 0.3 * env * rand();
    }
  }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  if (peak > 0) for (let i = 0; i < n; i++) pcm[i] = (pcm[i]! / peak) * 0.92;

  return pcm;
}

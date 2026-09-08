import type { Samples } from "./arrays";

const DEMO_SECONDS = 3.2;

/* 一律单声道：多声道在这里混成一路，后面所有环节只需要处理一条轨。 */
export interface Decoded {
  pcm: Samples;
  sr: number;
}

/**
 * 按文件头认音频容器。返回人话格式名，decode 失败时给用户指路用。
 * 手机录音的高频坑：微信语音（AMR/SILK）、通话录音（3GP/AMR）浏览器根本
 * 不带解码器，裸报 "Unable to decode audio data" 等于没说。
 */
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
  if (ascii(0, 4) === "OggS") return "OGG";
  if (ascii(0, 4) === "fLaC") return "FLAC";
  if (ascii(0, 4) === "RIFF") return "WAV";
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return "MP3";
  return "";
}

const DECODE_HELP =
  "支持 m4a、mp3、wav、ogg、flac。若来自微信或通话录音，请先用录音 App 另存为这些格式";

/** decodeAudioData 的回调式包装 —— 旧 webkit 实现不认 Promise 形式，
 *  调了既不报错也不回调（永远挂起），回调式在所有实现上都可用。 */
function decodeRaw(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((ok, no) => {
    void ctx.decodeAudioData(data, ok, err =>
      no(err instanceof Error ? err : new Error(String(err ?? "解码失败"))),
    );
  });
}

export async function decodeAudioFile(data: ArrayBuffer): Promise<Decoded> {
  const Ctor =
    window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("这个浏览器不支持 Web Audio");

  const head = sniffAudio(new Uint8Array(data));
  const ctx = new Ctor();
  try {
    // data 会被 decodeAudioData 拿走所有权，先留一份副本，
    // 免得调用方还想拿同一份字节干别的事时拿到空的。
    const buffer = await decodeRaw(ctx, data.slice(0));
    const tracks = buffer.numberOfChannels;
    const n = buffer.length;
    if (n === 0) throw new Error("这段音频是空的");
    const pcm = new Float32Array(n);

    if (tracks === 1) {
      pcm.set(buffer.getChannelData(0));
    } else {
      const parts: Float32Array[] = [];
      for (let c = 0; c < tracks; c++) parts.push(buffer.getChannelData(c));
      for (let c = 0; c < tracks; c++) {
        const src = parts[c]!;
        for (let i = 0; i < n; i++) pcm[i] = pcm[i]! + src[i]!;
      }
      for (let i = 0; i < n; i++) pcm[i] = pcm[i]! / tracks;
    }

    return { pcm, sr: buffer.sampleRate };
  } catch (e) {
    if (e instanceof Error && /空/.test(e.message)) throw e;
    // Chrome 的原始报错 "Unable to decode audio data" 对用户没有信息量，
    // 换成格式 + 出路的说法。Flac/ogg 在 Safari 老版本解不开也走这里。
    if (head === "AMR（微信等语音常用）" || head === "SILK（微信语音专有）" || head.startsWith("3GP"))
      throw new Error(`解不出：这是${head}，浏览器不带这个解码器。${DECODE_HELP}`);
    throw new Error(`解不出这段音频${head ? `（识别为 ${head}）` : ""}。${DECODE_HELP}`);
  } finally {
    void ctx.close();
  }
}

/** 扫频 + 一个衰减和弦 + 两记噪声 —— 频谱图上看得出结构。 */
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

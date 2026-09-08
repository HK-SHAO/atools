import type { Samples } from "./arrays";

const DEMO_SECONDS = 3.2;

/* 一律单声道：多声道在这里混成一路，后面所有环节只需要处理一条轨。 */
export interface Decoded {
  pcm: Samples;
  sr: number;
}

export async function decodeAudioFile(data: ArrayBuffer): Promise<Decoded> {
  const Ctor =
    window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("这个浏览器不支持 Web Audio");

  const ctx = new Ctor();
  try {
    // data 会被 decodeAudioData 拿走所有权，先留一份副本，
    // 免得调用方还想拿同一份字节干别的事时拿到空的。
    const buffer = await ctx.decodeAudioData(data.slice(0));
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
    throw new Error(`解不出这段音频：${e instanceof Error ? e.message : String(e)}`);
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

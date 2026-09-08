import { useCallback, useEffect, useRef, useState } from "react";
import { clock } from "./usePlayback";

/** 最长录约 100 秒：即便麦克风是 48kHz，紧凑模式默认窗下也压在频谱图帧数上限内，
 *  不会录完却因"超过 20000 帧"而编码失败。 */
const MAX_SECONDS = 100;

export interface CapturedSamples {
  pcm: Float32Array<ArrayBuffer>;
  sr: number;
  name: string;
}

function audioCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/**
 * 麦克风录制：直接抓单声道 PCM（不走"容器编码 → decodeAudioData 再解码"的弯路）。
 *
 * 之所以不落容器：Safari 等浏览器的 MediaRecorder 产物（mp4/aac）经常让
 * decodeAudioData 抛出 "Unable to decode audio data"，录音几秒就崩在"解不出这段音频"。
 * 这里走 Web Audio 采集图，onaudioprocess 里把采样直接攒成 Float32，
 * 拿到的就是我们要的素材，零编解码依赖、跨浏览器一致。
 *
 * 只管采集与收尾，结果经 onCaptured 交出去；卸载时静默丢弃，绝不回调已死的组件。
 */
export function useMic(onCaptured: (s: CapturedSamples) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const totalRef = useRef(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onRef = useRef(onCaptured);
  onRef.current = onCaptured;
  const disposedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  /** 停掉采集图、灭灯、收掉流与 AudioContext。不发射结果。 */
  const stopGraph = useCallback(() => {
    clearTimer();
    const node = nodeRef.current;
    nodeRef.current = null;
    if (node) {
      node.onaudioprocess = null;
      try {
        node.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    gainRef.current?.disconnect();
    gainRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    void ctx?.close();
  }, []);

  /** 收尾并交出去（用户点停止 / 到上限自动停时走这条）。 */
  const finalize = useCallback(() => {
    if (!recording) return;
    const sr = ctxRef.current?.sampleRate ?? 44100;
    const total = totalRef.current;
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunksRef.current) {
      pcm.set(c, off);
      off += c.length;
    }
    chunksRef.current = [];
    totalRef.current = 0;
    stopGraph();
    setRecording(false);
    if (total > 0 && !disposedRef.current) onRef.current({ pcm, sr, name: `录音 ${clock(seconds)}` });
  }, [recording, seconds, stopGraph]);

  const start = useCallback(async () => {
    setError(null);
    if (recording) return; // 防重入：采集中的再点一次直接忽略
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("这个浏览器不支持录音");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      setError(name === "NotAllowedError" ? "没给麦克风权限" : "打不开麦克风");
      return;
    }

    const Ctor = audioCtor();
    if (!Ctor) {
      stream.getTracks().forEach(t => t.stop());
      setError("这个浏览器不支持录音");
      return;
    }

    const ctx = new Ctor();
    try {
      await ctx.resume();
    } catch {
      /* 某些浏览器在用户手势里 resume 才生效，失败也无妨 */
    }

    try {
      const srcNode = ctx.createMediaStreamSource(stream);
      // ScriptProcessor 是 deprecated 但仍全平台可用、且零额外模块；
      // 必须接到 destination 才会触发 onaudioprocess，中间串一个静音 gain 防回声/外放。
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const gain = ctx.createGain();
      gain.gain.value = 0;

      chunksRef.current = [];
      totalRef.current = 0;
      proc.onaudioprocess = ev => {
        const ch = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(ch.length);
        copy.set(ch);
        chunksRef.current.push(copy);
        totalRef.current += copy.length;
      };

      srcNode.connect(proc);
      proc.connect(gain);
      gain.connect(ctx.destination);

      streamRef.current = stream;
      ctxRef.current = ctx;
      nodeRef.current = proc;
      gainRef.current = gain;

      setSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    } catch {
      stream.getTracks().forEach(t => t.stop());
      void ctx.close();
      setError("这个浏览器不支持录音");
    }
  }, [recording]);

  // 到上限自动停。
  useEffect(() => {
    if (recording && seconds >= MAX_SECONDS) finalize();
  }, [recording, seconds, finalize]);

  // 卸载时静默收尾，别让麦克风一直亮着、也别向已死的组件回调。
  useEffect(
    () => () => {
      disposedRef.current = true;
      clearTimer();
      chunksRef.current = [];
      totalRef.current = 0;
      stopGraph();
      setRecording(false);
    },
    [stopGraph],
  );

  return { recording, seconds, error, start, stop: finalize };
}

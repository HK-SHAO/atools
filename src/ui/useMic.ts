import { useCallback, useEffect, useRef, useState } from "react";
import { clock } from "./usePlayback";

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

const CAPTURE_CODE = `
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      let i = 0;
      while (i < ch.length) {
        const n = Math.min(ch.length - i, this.batch.length - this.fill);
        this.batch.set(ch.subarray(i, i + n), this.fill);
        this.fill += n;
        i += n;
        if (this.fill === this.batch.length) {
          this.port.postMessage(this.batch.slice(0));
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("mic-capture", MicCapture);
`;

export function useMic(onCaptured: (s: CapturedSamples) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const urlRef = useRef<string | null>(null);
  const chunksRef = useRef<Float32Array<ArrayBuffer>[]>([]);
  const totalRef = useRef(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onRef = useRef(onCaptured);
  onRef.current = onCaptured;
  const deadRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopGraph = useCallback(() => {
    clearTimer();
    const node = nodeRef.current;
    nodeRef.current = null;
    if (node) {
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {

      }
    }
    srcRef.current?.disconnect();
    srcRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    const url = urlRef.current;
    urlRef.current = null;
    if (url) URL.revokeObjectURL(url);
    const ctx = ctxRef.current;
    ctxRef.current = null;
    void ctx?.close();
  }, []);

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
    const deliver = total > 0 && !deadRef.current;
    deadRef.current = true;
    if (deliver) onRef.current({ pcm, sr, name: `录音 ${clock(seconds)}` });
  }, [recording, seconds, stopGraph]);

  function explainMicError(e: unknown): string {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      const inFrame = window.self !== window.top;
      if (inFrame) return "当前窗口不给录音：本页嵌在别的页面里。请在浏览器中单独打开本站再录";
      return "麦克风权限被拒了：请在浏览器地址栏的权限设置里允许麦克风，然后重试";
    }
    if (name === "NotReadableError" || name === "TrackStartError")
      return "麦克风被占用：请关掉其他正在录音或通话的程序再试";
    if (name === "OverconstrainedError") return "这个设备的麦克风参数不支持";
    return "打不开麦克风";
  }

  async function openStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      if (name === "OverconstrainedError" || name === "NotFoundError") {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      throw e;
    }
  }

  const start = useCallback(async () => {
    setError(null);
    if (recording) return; // 防重入：采集中的再点一次直接忽略
    if (!navigator.mediaDevices?.getUserMedia || !audioCtor()) {
      setError("这个浏览器不支持录音");
      return;
    }
    if (window.isSecureContext === false) {
      setError("录音需要安全环境：请用 https 或在本机 localhost 打开本页");
      return;
    }
    deadRef.current = false;

    setSeconds(0);
    setRecording(true);
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);

    let stream: MediaStream;
    try {
      stream = await openStream();
    } catch (e) {
      stopGraph();
      setRecording(false);
      setError(explainMicError(e));
      return;
    }
    if (deadRef.current) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }

    const Ctor = audioCtor()!;
    const ctx = new Ctor();
    try {
      await ctx.resume();
    } catch {

    }

    try {
      const url = URL.createObjectURL(new Blob([CAPTURE_CODE], { type: "application/javascript" }));
      urlRef.current = url;
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      urlRef.current = null;

      const node = new AudioWorkletNode(ctx, "mic-capture");
      node.port.onmessage = (ev: MessageEvent) => {
        const data = ev.data as Float32Array<ArrayBuffer>;
        chunksRef.current.push(data);
        totalRef.current += data.length;
      };
      const src = ctx.createMediaStreamSource(stream);
      src.connect(node);
      node.connect(ctx.destination);

      if (deadRef.current) {
        stopGraph();
        return;
      }

      streamRef.current = stream;
      ctxRef.current = ctx;
      nodeRef.current = node;
      srcRef.current = src;
      chunksRef.current = [];
      totalRef.current = 0;
      setSeconds(0);
    } catch {
      stopGraph();
      setRecording(false);
      setError("这个浏览器不支持录音");
    }
  }, [recording, stopGraph]);

  useEffect(() => {
    if (recording && seconds >= MAX_SECONDS) finalize();
  }, [recording, seconds, finalize]);

  useEffect(
    () => () => {
      deadRef.current = true;
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

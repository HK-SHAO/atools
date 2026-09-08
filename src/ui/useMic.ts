import { useCallback, useEffect, useRef, useState } from "react";
import { clock } from "./usePlayback";

/** 最长录约 100 秒：即便 48kHz，紧凑默认窗也压在频谱图帧数上限内，不会录完却编码失败。 */
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
 * 采集 worklet：把输入拷贝攒批，经 port 发回主线程。
 * 以 Blob 内联加载 —— 不需要独立 worklet 文件，构建零配置。
 * process() 从不写输出：节点直连 destination 也只送静音（无回声），
 * 同时保证节点被渲染图持续拉取 —— 这是官方的 mic-capture 模式。
 */
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

/**
 * 麦克风录制：AudioWorklet 直采单声道 PCM。
 *
 * 为什么不用 MediaRecorder：它产 webm/mp4 容器，Safari 等浏览器的产物
 * decodeAudioData 经常解不开（"Unable to decode audio data"），录完就崩。
 * 为什么不用 ScriptProcessorNode：deprecated，且 Safari 上
 * MediaStreamSource → ScriptProcessor 有出全零的著名 bug。
 * AudioWorklet（Chrome 66+ / Firefox 76+ / Safari 14.1+）是当下的标准做法：
 * 渲染线程里拷采样，主线程只收批，可靠且不卡 UI。
 */
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

  /** 停图、灭灯、收掉流与 AudioContext。不发射结果。 */
  const stopGraph = useCallback(() => {
    clearTimer();
    const node = nodeRef.current;
    nodeRef.current = null;
    if (node) {
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        /* 已断开 */
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
    // 本会话就此作废；下次 start 复位。StrictMode 的挂载-卸载-再挂载会让 cleanup
    // 提前跑一次 —— 不复位的话录完永远不交付，这正是上一版的坑。
    // 置位还堵住一个竞态：权限弹窗还挂着时收场，start 的后续代码不得再建图。
    const deliver = total > 0 && !deadRef.current;
    deadRef.current = true;
    if (deliver) onRef.current({ pcm, sr, name: `录音 ${clock(seconds)}` });
  }, [recording, seconds, stopGraph]);

  /** 麦克风失败的一句话解释。区分：非安全环境 / 内嵌窗口没授权 / 权限被拒 / 设备被占。 */
  function explainMicError(e: unknown): string {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      // 内嵌 iframe（预览面板、聊天内置浏览器）没有麦克风授权时，
      // 就算系统权限已给、getUserMedia 也一律拒绝 —— Android 上的高频坑。
      const inFrame = window.self !== window.top;
      if (inFrame) return "当前窗口不给录音：本页嵌在别的页面里。请在浏览器中单独打开本站再录";
      return "麦克风权限被拒了：请在浏览器地址栏的权限设置里允许麦克风，然后重试";
    }
    if (name === "NotReadableError" || name === "TrackStartError")
      return "麦克风被占用：请关掉其他正在录音或通话的程序再试";
    if (name === "OverconstrainedError") return "这个设备的麦克风参数不支持";
    return "打不开麦克风";
  }

  /** 打开麦克风流。先按单声道请求，设备不认就退回默认参数。 */
  async function openStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      if (name === "OverconstrainedError" || name === "NotFoundError") {
        // 部分安卓设备对任何硬参数都不认 —— 裸请求必成。
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
      // getUserMedia 只在 https / localhost 存在。手机用局域网 IP 访问开发
      // 服务器时正是这种场景，提前说明比一句「不支持」有用。
      setError("录音需要安全环境：请用 https 或在本机 localhost 打开本页");
      return;
    }
    deadRef.current = false;

    // 先亮 UI：点下立刻进"录制中"，权限弹窗、建图的等待不再让人以为没点上。
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
      // 等权限期间被收场/卸载了：把刚拿到的流也停掉，静默退出。
      stream.getTracks().forEach(t => t.stop());
      return;
    }

    const Ctor = audioCtor()!;
    const ctx = new Ctor();
    try {
      await ctx.resume();
    } catch {
      /* 用户手势里创建的上下文通常会自动运行，失败无妨 */
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
      // worklet 不写输出 → 直连 destination 也只送静音：无回声，且节点保证被拉取。
      node.connect(ctx.destination);

      if (deadRef.current) {
        // 等权限/建图期间组件被卸载了：静默收尾。
        stopGraph();
        return;
      }

      streamRef.current = stream;
      ctxRef.current = ctx;
      nodeRef.current = node;
      srcRef.current = src;
      chunksRef.current = [];
      totalRef.current = 0;
      setSeconds(0); // 计时从真正开始采集这一刻起算
    } catch {
      stopGraph();
      setRecording(false);
      setError("这个浏览器不支持录音");
    }
  }, [recording, stopGraph]);

  // 到上限自动停。
  useEffect(() => {
    if (recording && seconds >= MAX_SECONDS) finalize();
  }, [recording, seconds, finalize]);

  // 卸载时静默收尾，别让麦克风一直亮着、也别向已死的组件回调。
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

import { useCallback, useEffect, useRef, useState } from "react";

/** 最长录 2 分钟，避免缓冲区无上限地涨。 */
const MAX_SECONDS = 120;

type Captured = (file: File) => void;

/** 挑一个浏览器能录、又解得出来的容器。 */
function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  for (const c of cands) if (MediaRecorder.isTypeSupported(c)) return c;
  return "";
}

function extOf(type: string): string {
  if (type.includes("webm")) return "webm";
  if (type.includes("mp4") || type.includes("aac") || type.includes("m4a")) return "m4a";
  return "webm";
}

/**
 * 麦克风录制：拿到一段音频就当作文件加载。
 * 只管录制与收尾，结果通过 onCaptured 交出去，复用已有的文件解码链路。
 */
export function useMic(onCaptured: Captured) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onRef = useRef<Captured>(onCaptured);
  onRef.current = onCaptured;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stop = useCallback(() => {
    clearTimer();
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
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

    const mime = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      for (const t of stream.getTracks()) t.stop();
      setError("这个浏览器不支持录音");
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    rec.ondataavailable = e => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const type = rec.mimeType || mime || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      for (const t of stream.getTracks()) t.stop();
      streamRef.current = null;
      recRef.current = null;
      setRecording(false);
      if (chunksRef.current.length === 0) return;
      onRef.current(new File([blob], `录音.${extOf(type)}`, { type }));
    };
    rec.onerror = () => {
      setError("录音出错了");
      setRecording(false);
      for (const t of stream.getTracks()) t.stop();
    };

    recRef.current = rec;
    setSeconds(0);
    rec.start();
    setRecording(true);
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
  }, [stop]);

  // 到上限自动停。
  useEffect(() => {
    if (recording && seconds >= MAX_SECONDS) stop();
  }, [recording, seconds, stop]);

  // 卸载时收尾，别让麦克风一直亮着。
  useEffect(() => {
    return () => {
      clearTimer();
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return { recording, seconds, error, start, stop };
}

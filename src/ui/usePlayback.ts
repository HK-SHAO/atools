import { useCallback, useEffect, useRef, useState } from "react";
import type { Samples } from "../lib/arrays";

export function clock(t: number): string {
  const safe = Math.max(0, t);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Ctor = typeof AudioContext;

function audioCtor(): Ctor | undefined {
  return (
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext
  );
}

/**
 * 播放**图里装的声音**（`useStudio` 的 `listen()` 负责按需还原），不是编码前的原声。
 *
 * 时间轴长度取自 `meta.samples / meta.sr`，与是否已经还原无关 —— 否则音频还没算出来时
 * 时长会显示成 0、进度条也会失灵。音频没就绪时按播放会先等 `prepare()`，进度由 stage 显示。
 */
export function usePlayback(
  audio: Samples | null,
  sr: number,
  duration: number,
  prepare: () => Promise<Samples | null>,
) {
  const [playing, setPlaying] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<AudioBuffer | null>(null);

  const bufPcmRef = useRef<Samples | null>(null);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef(0);
  const posRef = useRef(0);
  const atRef = useRef(0);
  const t0Ref = useRef(0);

  const headRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  const liveRef = useRef(false);
  const startedRef = useRef(-1);

  const paint = useCallback(
    (pos: number) => {
      const at = duration > 0 ? Math.min(1, Math.max(0, pos / duration)) : 0;
      const head = headRef.current;
      if (head) {
        head.style.left = `${at * 100}%`;
        head.style.opacity = at <= 0 && !liveRef.current ? "0" : "1";
      }
      if (timeRef.current) timeRef.current.textContent = clock(Math.min(pos, duration));
    },
    [duration],
  );

  const halt = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    const node = nodeRef.current;
    nodeRef.current = null;
    if (!node) return;
    node.onended = null;
    try {
      node.stop();
    } catch {}
    node.disconnect();
  }, []);

  const ensure = useCallback(async (): Promise<AudioContext | null> => {
    let pcm = audio;
    if (!pcm) {
      pcm = await prepare();
      // 等的时候参数被改过：这一份已经不是「现在这张图」的声音，这一声不放。
      if (!pcm) return null;
    }
    let ctx = ctxRef.current;
    if (!ctx) {
      const Ctor = audioCtor();
      if (!Ctor) throw new Error("这个浏览器不支持 Web Audio");
      ctx = new Ctor();
      ctxRef.current = ctx;
    }
    const buf = bufRef.current;
    if (!buf || bufPcmRef.current !== pcm || buf.sampleRate !== sr) {
      const next = ctx.createBuffer(1, pcm.length, sr);
      next.copyToChannel(pcm, 0);
      bufRef.current = next;
      bufPcmRef.current = pcm;
    }
    return ctx;
  }, [audio, prepare, sr]);

  const start = useCallback(
    async (at: number) => {
      let ctx: AudioContext | null = null;
      try {
        ctx = await ensure();
      } catch (e) {
        console.error(e);
      }
      if (!ctx) return;
      halt();
      void ctx.resume();

      const node = ctx.createBufferSource();
      node.buffer = bufRef.current;
      node.connect(ctx.destination);

      const from = Math.min(Math.max(0, at), Math.max(0, duration - 0.005));
      node.onended = () => {
        if (nodeRef.current !== node) return;
        nodeRef.current = null;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        posRef.current = duration;
        paint(duration);
        setPlaying(false);
      };

      node.start(0, from);
      nodeRef.current = node;
      atRef.current = from;
      startedRef.current = from;
      t0Ref.current = ctx.currentTime;
      liveRef.current = true;
      setPlaying(true);

      const tick = () => {
        if (nodeRef.current !== node) return;
        const pos = atRef.current + (ctx.currentTime - t0Ref.current);
        posRef.current = Math.min(Math.max(0, pos), duration);
        paint(posRef.current);
        rafRef.current = requestAnimationFrame(tick);
      };
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    },
    [duration, ensure, halt, paint],
  );

  const toggle = useCallback(() => {
    if (nodeRef.current) {
      const at = posRef.current;
      halt();
      paint(at);
      setPlaying(false);
      return;
    }
    void start(posRef.current >= duration - 0.02 ? 0 : posRef.current);
  }, [duration, halt, paint, start]);

  const seek = useCallback(
    (ratio: number) => {
      const pos = Math.min(duration, Math.max(0, ratio * duration));
      posRef.current = pos;
      liveRef.current = true;
      paint(pos);
      void start(pos);
    },
    [duration, paint, start],
  );

  const scrub = useCallback(
    (ratio: number) => {
      const pos = Math.min(duration, Math.max(0, ratio * duration));
      posRef.current = pos;
      liveRef.current = true;
      paint(pos);
    },
    [duration, paint],
  );

  const commit = useCallback(() => {
    if (Math.abs(posRef.current - startedRef.current) > 1e-4) void start(posRef.current);
  }, [start]);

  // 换一段音频才回到起点 —— 参数变动会重算还原结果，但进度位置不该跟着跳。
  useEffect(() => {
    halt();
    posRef.current = 0;
    startedRef.current = -1;
    liveRef.current = false;
    setPlaying(false);
    paint(0);
  }, [duration, sr, halt, paint]);

  useEffect(
    () => () => {
      halt();
      const ctx = ctxRef.current;
      ctxRef.current = null;
      bufRef.current = null;
      bufPcmRef.current = null;
      void ctx?.close();
    },
    [halt],
  );

  const nudge = useCallback(
    (delta: number) => {
      seek(duration > 0 ? (posRef.current + delta * duration) / duration : 0);
    },
    [duration, seek],
  );

  return { playing, toggle, seek, scrub, commit, nudge, headRef, timeRef };
}

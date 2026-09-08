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
 * AudioContext 只在用户第一次点播放时才建，AudioBuffer 按需重建，
 * 卸载时节点、动画帧、context 一起收掉 —— 不留悬挂的图。
 */
export function usePlayback(pcm: Samples, sr: number) {
  const duration = pcm.length / sr;
  const [playing, setPlaying] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<AudioBuffer | null>(null);
  /** 建缓冲时用的 pcm 引用：只比长度+采样率会在换同长素材时复用旧声音，必须比引用。 */
  const bufPcmRef = useRef<Samples | null>(null);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef(0);
  const posRef = useRef(0);
  const atRef = useRef(0);
  const t0Ref = useRef(0);

  const headRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  /** 一旦放过或拖过，竖线就一直留着；只有完全没动过的初始态才藏起来。 */
  const liveRef = useRef(false);
  const startedRef = useRef(-1);

  const paint = useCallback(
    (pos: number) => {
      const at = duration > 0 ? Math.min(1, Math.max(0, pos / duration)) : 0;
      const head = headRef.current;
      if (head) {
        head.style.left = `${at * 100}%`;
        // 再往左挪"自身宽度 × at"：at=0 贴左沿、at=1 贴右沿，
        // 两头都整整齐齐待在画面里，不会探出去也压不到频谱的边缘。
        head.style.transform = `translateX(${-at * 100}%)`;
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
    } catch {
      /* 已经停了 */
    }
    node.disconnect();
  }, []);

  const ensure = useCallback((): AudioContext => {
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
  }, [pcm, sr]);

  const start = useCallback(
    (at: number) => {
      const ctx = ensure();
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
    start(posRef.current >= duration - 0.02 ? 0 : posRef.current);
  }, [duration, halt, paint, start]);

  /**
   * 点下去：停着的话就地开始放，正在放的话跳过去继续。
   * 「拖进度条自动播放」就是这里 —— 想听哪一段，点一下就响。
   */
  const seek = useCallback(
    (ratio: number) => {
      const pos = Math.min(duration, Math.max(0, ratio * duration));
      posRef.current = pos;
      liveRef.current = true;
      paint(pos);
      start(pos);
    },
    [duration, paint, start],
  );

  /** 拖动过程中只挪竖线，不反复重建音频节点 —— 重建会咔咔响。 */
  const scrub = useCallback(
    (ratio: number) => {
      const pos = Math.min(duration, Math.max(0, ratio * duration));
      posRef.current = pos;
      liveRef.current = true;
      paint(pos);
    },
    [duration, paint],
  );

  /** 松手：真的跳过去。位置没变就不折腾。 */
  const commit = useCallback(() => {
    if (Math.abs(posRef.current - startedRef.current) > 1e-4) start(posRef.current);
  }, [start]);

  // 换素材：停掉、归零、画一遍。依赖 pcm/sr，确保任何换素材（含同长度）都重跑。
  useEffect(() => {
    halt();
    posRef.current = 0;
    startedRef.current = -1;
    liveRef.current = false;
    paint(0);
  }, [pcm, sr, halt, paint]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      const node = nodeRef.current;
      nodeRef.current = null;
      if (node) {
        node.onended = null;
        try {
          node.stop();
        } catch {
          /* 已经停了 */
        }
        node.disconnect();
      }
      const ctx = ctxRef.current;
      ctxRef.current = null;
      bufRef.current = null;
      bufPcmRef.current = null;
      void ctx?.close();
    },
    [],
  );

  const nudge = useCallback(
    (delta: number) => {
      seek(duration > 0 ? (posRef.current + delta * duration) / duration : 0);
    },
    [duration, seek],
  );

  return { playing, duration, toggle, seek, scrub, commit, nudge, headRef, timeRef };
}

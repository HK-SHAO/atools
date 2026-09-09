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

export function usePlayback(pcm: Samples, sr: number) {
  const duration = pcm.length / sr;
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
    if (Math.abs(posRef.current - startedRef.current) > 1e-4) start(posRef.current);
  }, [start]);

  useEffect(() => {
    halt();
    posRef.current = 0;
    startedRef.current = -1;
    liveRef.current = false;
    setPlaying(false);
    paint(0);
  }, [pcm, sr, halt, paint]);

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

  return { playing, duration, toggle, seek, scrub, commit, nudge, headRef, timeRef };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { Samples } from "../lib/arrays";

export function clock(t: number): string {
  const safe = Math.max(0, t);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function usePlayback(
  audio: Samples | null,
  sr: number,
  duration: number,
  prepare: () => Promise<Samples | null>,
) {
  const [playing, setPlaying] = useState<{ of: number | null; on: boolean }>({ of: null, on: false });

  const ctxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<AudioBuffer | null>(null);

  const bufPcmRef = useRef<Samples | null>(null);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef(0);
  const posRef = useRef(0);

  const headRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  const liveRef = useRef(false);
  const startedRef = useRef(-1);
  const playingRef = useRef(false);
  const mark = useCallback(
    (on: boolean) => {
      playingRef.current = on;
      setPlaying({ of: duration, on });
    },
    [duration],
  );
  const live = playing.of === duration && playing.on;

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
      if (!pcm) return null;
    }
    let ctx = ctxRef.current;
    if (!ctx) {
      ctx = new AudioContext();
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
      playingRef.current = true;
      let ctx: AudioContext | null = null;
      try {
        ctx = await ensure();
      } catch (e) {
        console.error(e);
      }
      if (!ctx) {
        playingRef.current = false;
        return;
      }
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
        mark(false);
      };

      node.start(0, from);
      nodeRef.current = node;
      startedRef.current = from;
      const t0 = ctx.currentTime;
      liveRef.current = true;
      mark(true);

      const tick = () => {
        if (nodeRef.current !== node) return;
        const pos = from + (ctx.currentTime - t0);
        posRef.current = Math.min(Math.max(0, pos), duration);
        paint(posRef.current);
        rafRef.current = requestAnimationFrame(tick);
      };
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    },
    [duration, ensure, halt, paint, mark],
  );

  const toggle = useCallback(() => {
    if (nodeRef.current) {
      const at = posRef.current;
      halt();
      paint(at);
      mark(false);
      return;
    }
    void start(posRef.current >= duration - 0.02 ? 0 : posRef.current);
  }, [duration, halt, paint, start, mark]);

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

  useEffect(() => {
    halt();
    posRef.current = 0;
    startedRef.current = -1;
    liveRef.current = false;
    playingRef.current = false;
    paint(0);
  }, [halt, paint]);

  const followedRef = useRef<Samples | null>(null);
  useEffect(() => {
    if (!playingRef.current || followedRef.current === audio) return;
    followedRef.current = audio;
    if (audio && bufPcmRef.current === audio) return;
    const resume = () => {
      if (playingRef.current) void start(posRef.current);
    };
    if (audio) void start(posRef.current);
    else void prepare().then(y => (y ? resume() : undefined));
  }, [audio, prepare, start]);

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

  return { playing: live, toggle, seek, scrub, commit, nudge, headRef, timeRef };
}

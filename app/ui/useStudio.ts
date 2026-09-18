import { useCallback, useEffect, useRef, useState } from "react";
import DEMO_URL from "../assets/demo.ogg";
import { decodeAudioFile } from "../lib/audio";
import type { Samples } from "../lib/arrays";
import { sniff, type Container, type ReadMode } from "../lib/container";
import { t } from "../lib/i18n";
import { FINENESS, VOICE, clampEncode, reopen, type Encode } from "../lib/params";
import { slice, trimRange } from "../lib/resample";
import { Aborted, cutoffOf, fitEncode, type Meta, type Spectrum } from "../lib/spectrum";
import { scope } from "./pipeline";

interface Source {
  pcm: Samples;
  sr: number;
  name: string;
}

interface Job {
  spec: Spectrum;
  png: Blob;
  ref: Samples;
  audio: Samples | null;
  audioFine: boolean; // whether audio came from fine rendering (the audit reuses it only then)
}

export type Stage = { label: string; value: number } | null;

const IMAGE_EXT = /\.(png|jpe?g|jpe|webp|gif|bmp|avif)$/i;

const nextFrame = () => new Promise<void>(done => setTimeout(done, 0));

function adoptMeta(meta: Meta): Encode {
  const at = FINENESS.findIndex(f => f.win >= meta.win);
  return {
    mode: meta.exact ? "exact" : "compact",
    sr: 0,
    bits: meta.bits > 0 ? meta.bits : 8,
    fineness: (at < 0 ? FINENESS.length - 1 : at) as Encode["fineness"],
    fmax: 0,
    start: 0,
    end: 0,
  };
}

export function useStudio() {
  const [source, setSource] = useState<Source | null>(null);
  const [pick, setPick] = useState<{ enc: Encode; note: string | null }>({ enc: VOICE, note: null });
  const [job, setJob] = useState<Job | null>(null);
  const [mode, setMode] = useState<ReadMode>("compact");
  const [stage, setStage] = useState<Stage>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const genRef = useRef(0);
  const io = scope("studio");
  const enc = pick.enc;

  const generation = useCallback((): (() => boolean) => {
    io.cancel();
    const my = ++genRef.current;
    return () => genRef.current === my;
  }, [io]);

  const jobRef = useRef<Job | null>(null);
  const pendingRef = useRef<{ spec: Spectrum; p: Promise<Samples | null> } | null>(null);
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const wantedRef = useRef(false);
  // Loading an image brings its own job (the spectrum read back), so the next encode pass is let through
  const skipEncodeRef = useRef(false);

  const putJob = useCallback((next: Job | null) => {
    jobRef.current = next;
    setJob(next);
  }, []);

  const setEnc = useCallback((next: Encode | ((e: Encode) => Encode)) => {
    setPick(p => ({ enc: typeof next === "function" ? next(p.enc) : next, note: null }));
    setHint(null);
  }, []);

  useEffect(() => {
    generation();
    let released = false;
    let unlock!: () => void;
    readyRef.current = new Promise<void>(r => (unlock = r));
    const release = () => {
      if (!released) {
        released = true;
        unlock();
      }
    };

    if (!source) {
      release();
      return release;
    }
    if (skipEncodeRef.current) {
      skipEncodeRef.current = false;
      release();
      return release;
    }
    let cancelled = false;
    const alive = () => !cancelled;

    void (async () => {
      setStage({ label: t("stageConvert"), value: 0.05 });
      try {
        const clipped = slice(source.pcm, source.sr, enc.start, enc.end);
        const fit = fitEncode(enc, source.sr, clipped.length);
        if (fit.enc !== enc) {
          setPick({ enc: fit.enc, note: fit.note });
          return;
        }
        const sr = enc.sr > 0 ? enc.sr : source.sr;
        const tuned = await io.resample(clipped, source.sr, sr, cutoffOf(enc));
        if (cancelled) return;
        await nextFrame();

        const spec = await io.encode(tuned, sr, enc, v => {
          if (!cancelled) setStage({ label: t("stageEncode"), value: v });
        });
        if (cancelled) return;

        setStage({ label: t("stagePack"), value: 1 });
        await nextFrame();
        const png = await io.png(spec);
        if (cancelled) return;

        putJob({ spec, png, ref: tuned, audio: null, audioFine: false });
        setError(null);
      } catch (e) {
        if (cancelled || e instanceof Aborted) return;
        console.error(e);
        setError(e instanceof Error ? e.message : t("errConvert"));
      } finally {
        release();
        if (alive()) setStage(null);
      }
    })();

    return () => {
      cancelled = true;
      io.cancel();
      release();
    };
  }, [source, enc, putJob, generation, io]);

  const render = useCallback(
    async (spec: Spectrum, fine: boolean, show: boolean): Promise<Samples | null> => {
      const alive = generation();
      const label = fine ? t("stageRefine") : t("stageRestore");
      const note = (next: Stage): void => {
        if (show || wantedRef.current) setStage(next);
      };
      note({ label, value: 0 });
      try {
        const audio = await io.synthesise(spec, fine, v => {
          if (alive()) note({ label, value: v });
        });
        if (!alive()) return null;
        const cur = jobRef.current;
        if (!cur || cur.spec !== spec) return null;
        putJob({ ...cur, audio, audioFine: fine });
        return audio;
      } catch (e) {
        if (e instanceof Aborted) return null;
        console.error(e);
        if (alive()) setError(e instanceof Error ? e.message : t("errRestore"));
        return null;
      } finally {
        if (alive()) note(null);
      }
    },
    [io, putJob, generation],
  );

  const bake = useCallback(
    (spec: Spectrum, show: boolean): Promise<Samples | null> => {
      const pend = pendingRef.current;
      if (pend && pend.spec === spec) return pend.p;
      const p = render(spec, false, show);
      pendingRef.current = { spec, p };
      void p.then(() => {
        if (pendingRef.current?.p === p) pendingRef.current = null;
      });
      return p;
    },
    [render],
  );

  const listen = useCallback(async (): Promise<Samples | null> => {
    for (;;) {
      const wait = readyRef.current;
      await wait;
      if (readyRef.current === wait) break;
    }
    const j = jobRef.current;
    if (!j) return null;
    if (j.audio) return j.audio;
    if (pendingRef.current?.spec !== j.spec) return bake(j.spec, true);
    wantedRef.current = true;
    setStage({ label: t("stageRestore"), value: 0 });
    try {
      return await bake(j.spec, true);
    } finally {
      wantedRef.current = false;
      setStage(null);
    }
  }, [bake]);

  useEffect(() => {
    if (job && !job.audio) void bake(job.spec, false);
  }, [job, bake]);

  // Shared by the demo and file loading: decode → compact mode → range → source.
  const loadAudio = useCallback(
    async (bytes: ArrayBuffer, name: string, alive: () => boolean): Promise<void> => {
      setStage({ label: t("stageDecode"), value: 0 });
      await nextFrame();
      const { pcm: mono, sr } = await decodeAudioFile(bytes);
      if (!alive()) return;

      setMode("compact");
      setPick(p => ({ enc: clampEncode({ ...reopen(p.enc), ...trimRange(mono, sr) }, sr), note: null }));
      setSource({ pcm: mono, sr, name });
    },
    [],
  );

  const open = useCallback(
    async (file: File) => {
      const alive = generation();
      setError(null);
      setStage({ label: t("stageRead"), value: 0 });
      try {
        const bytes = await file.arrayBuffer();
        const container: Container = sniff(new Uint8Array(bytes));
        const looksImage =
          container !== "?" || file.type.startsWith("image/") || IMAGE_EXT.test(file.name);

        if (looksImage) {
          setStage({ label: t("stageReadImage"), value: 0 });
          await nextFrame();
          const { spec, mode: readMode, guessed } = await io.readImage(
            new Blob([bytes]),
            file.name,
          );
          if (!alive()) return;

          const label = t("stageSynthesise");
          setStage({ label, value: 0 });
          await nextFrame();
          const pcm = await io.synthesise(spec, false, v => {
            if (alive()) setStage({ label, value: v });
          });
          if (!alive()) return;

          setMode(readMode);
          setEnc(() => adoptMeta(spec.meta));
          setSource({ pcm, sr: spec.meta.sr, name: file.name });
          // Take the spectrum read back as the job: the phase reference (weak ones included) survives,
          // so "Rebuild phase" has something to work from; re-encoding recomputes phase on the spot and
          // throws the reference away. The user touching a parameter returns to the normal path.
          skipEncodeRef.current = true;
          putJob({
            spec,
            png: new Blob([bytes], { type: file.type || "image/png" }),
            ref: pcm,
            audio: pcm,
            audioFine: false,
          });
          if (guessed)
            setHint(t("hintGuessed"));
          else if (spec.meta.exact && spec.phaseWeak)
            setHint(t("hintWeakPhase"));
          else if (spec.meta.exact && !spec.phaseCos)
            setHint(t("hintNoPhase"));
          return;
        }

        await loadAudio(bytes, file.name, alive);
      } catch (e) {
        if (!alive() || e instanceof Aborted) return;
        console.error(e);
        setError(e instanceof Error ? e.message : t("errFile"));
      } finally {
        if (alive()) setStage(null);
      }
    },
    [generation, io, loadAudio, putJob, setEnc],
  );

  const refine = useCallback(async () => {
    const j = jobRef.current;
    if (!j) return;
    setError(null);
    if (await render(j.spec, true, true)) setHint(t("hintRefined"));
  }, [render]);

  const demo = useCallback(async () => {
    const alive = generation();
    setError(null);
    setStage({ label: t("stageRead"), value: 0 });
    try {
      const bytes = await (await fetch(DEMO_URL)).arrayBuffer();
      await loadAudio(bytes, "demo", alive);
    } catch (e) {
      if (!alive() || e instanceof Aborted) return;
      console.error(e);
      setError(e instanceof Error ? e.message : t("errDemo"));
    } finally {
      if (alive()) setStage(null);
    }
  }, [generation, loadAudio]);

  const clear = useCallback(() => {
    generation();
    pendingRef.current = null;
    putJob(null);
    setPick(p => (p.note === null ? p : { ...p, note: null }));
    setSource(null);
    setError(null);
    setHint(null);
  }, [generation, putJob]);

  return {
    source,
    enc,
    setEnc,
    job,
    mode,
    stage,
    error,
    hint: [pick.note, hint].filter(Boolean).join(t("sep")) || null,
    open,
    listen,
    refine,
    demo,
    clear,
  };
}

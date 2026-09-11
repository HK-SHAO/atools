import { useCallback, useEffect, useRef, useState } from "react";
import DEMO_URL from "../assets/fade-demo.ogg";
import { decodeAudioFile } from "../lib/audio";
import type { Samples } from "../lib/arrays";
import { imageToSpectrum, sniff, spectrumToPng, type Container, type ReadMode } from "../lib/image";
import { FINENESS, SR_OPTIONS, VOICE, reopen, type Encode } from "../lib/params";
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
}

export type Stage = { label: string; value: number } | null;

const IMAGE_EXT = /\.(png|jpe?g|jpe|webp|gif|bmp|avif)$/i;

const nextFrame = () => new Promise<void>(done => setTimeout(done, 0));

function adoptMeta(meta: Meta): Encode {
  const at = FINENESS.findIndex(f => f.win >= meta.win);
  return {
    mode: meta.exact ? "exact" : "compact",
    sr: (SR_OPTIONS as readonly number[]).includes(meta.sr) ? meta.sr : 0,
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
    let cancelled = false;
    const alive = () => !cancelled;

    void (async () => {
      setStage({ label: "转换", value: 0.05 });
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
          if (!cancelled) setStage({ label: "生成图片", value: v });
        });
        if (cancelled) return;

        setStage({ label: "打包", value: 1 });
        await nextFrame();
        const png = spec.meta.exact ? await spectrumToPng(spec) : await io.png(spec);
        if (cancelled) return;

        putJob({ spec, png, ref: tuned, audio: null });
        setError(null);
      } catch (e) {
        if (cancelled || e instanceof Aborted) return;
        console.error(e);
        setError(e instanceof Error ? e.message : "转换失败");
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
    async (spec: Spectrum, fine: boolean): Promise<Samples | null> => {
      const alive = generation();
      const label = fine ? "精修" : "还原";
      setStage({ label, value: 0 });
      try {
        const audio = await io.synthesise(spec, fine, v => {
          if (alive()) setStage({ label, value: v });
        });
        if (!alive()) return null;
        const cur = jobRef.current;
        if (!cur || cur.spec !== spec) return null;
        putJob({ ...cur, audio });
        return audio;
      } catch (e) {
        if (e instanceof Aborted) return null;
        console.error(e);
        if (alive()) setError(e instanceof Error ? e.message : "还原失败");
        return null;
      } finally {
        if (alive()) setStage(null);
      }
    },
    [io, putJob, generation],
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
    const pend = pendingRef.current;
    if (pend && pend.spec === j.spec) return pend.p;
    const p = render(j.spec, false);
    pendingRef.current = { spec: j.spec, p };
    void p.then(() => {
      if (pendingRef.current?.p === p) pendingRef.current = null;
    });
    return p;
  }, [render]);

  const open = useCallback(
    async (file: File) => {
      const alive = generation();
      setError(null);
      setStage({ label: "读取", value: 0 });
      try {
        const bytes = await file.arrayBuffer();
        const container: Container = sniff(new Uint8Array(bytes));
        const looksImage =
          container !== "?" || file.type.startsWith("image/") || IMAGE_EXT.test(file.name);

        if (looksImage) {
          setStage({ label: "读图", value: 0 });
          await nextFrame();
          const { spec, mode: readMode, guessed, phaseReliability } = await imageToSpectrum(
            new Blob([bytes]),
            file.name,
          );
          if (!alive()) return;

          const label = "还原声音";
          setStage({ label, value: 0 });
          await nextFrame();
          const pcm = await io.synthesise(spec, false, v => {
            if (alive()) setStage({ label, value: v });
          });
          if (!alive()) return;

          setMode(readMode);
          setEnc(() => adoptMeta(spec.meta));
          setSource({ pcm, sr: spec.meta.sr, name: file.name });
          if (guessed)
            setHint(
              "图里记录的参数被剥掉了（多半是压缩或转发所致），已按默认设置解读；若时长或音高不对，可在下方参数里调整",
            );
          else if (phaseReliability !== null && phaseReliability < 0.5)
            setHint("图中相位参考置信度较低，点「重建相位」可借它还原出更高音质");
          return;
        }

        setStage({ label: "解码", value: 0 });
        await nextFrame();
        const { pcm: mono, sr } = await decodeAudioFile(bytes);
        if (!alive()) return;

        setMode("compact");
        setEnc(e => ({ ...reopen(e), ...trimRange(mono, sr) }));
        setSource({ pcm: mono, sr, name: file.name });
      } catch (e) {
        if (!alive() || e instanceof Aborted) return;
        console.error(e);
        setError(e instanceof Error ? e.message : "这个文件处理不了");
      } finally {
        if (alive()) setStage(null);
      }
    },
    [generation, io, setEnc],
  );

  const refine = useCallback(async () => {
    const j = jobRef.current;
    if (!j) return;
    setError(null);
    if (await render(j.spec, true)) setHint("相位已重建");
  }, [render]);

  const demo = useCallback(async () => {
    const alive = generation();
    try {
      const buf = await (await fetch(DEMO_URL)).arrayBuffer();
      const { pcm, sr } = await decodeAudioFile(buf);
      if (!alive()) return;
      setMode("compact");
      setEnc(e => ({ ...reopen(e), sr: 0, ...trimRange(pcm, sr) }));
      setSource({ pcm, sr, name: "fade-demo" });
    } catch (e) {
      if (!alive() || e instanceof Aborted) return;
      console.error(e);
      setError(e instanceof Error ? e.message : "示例加载失败");
    }
  }, [generation, setEnc]);

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
    hint: [pick.note, hint].filter(Boolean).join("；") || null,
    open,
    listen,
    refine,
    demo,
    clear,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import DEMO_URL from "../assets/fade-demo.ogg";
import { decodeAudioFile } from "../lib/audio";
import type { Samples } from "../lib/arrays";
import { imageToSpectrum, sniff, spectrumToPng, type Container, type ReadMode } from "../lib/image";
import { FINENESS, SR_OPTIONS, VOICE, reopen, type Encode } from "../lib/params";
import { resample, silenceBounds, slice } from "../lib/resample";
import { Aborted, encode, fitEncode, synthesise, type Meta, type Spectrum } from "../lib/spectrum";

export interface Source {
  pcm: Samples;
  sr: number;
  name: string;
}

export interface Job {
  spec: Spectrum;
  pcm: Samples;
  png: Blob;
}

export type Stage = { label: string; value: number } | null;

const IMAGE_EXT = /\.(png|jpe?g|jpe|webp|gif|bmp|avif)$/i;

const nextFrame = () => new Promise<void>(done => setTimeout(done, 0));

function adoptMeta(meta: Meta, e: Encode): Encode {
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
  const [enc, setEnc] = useState<Encode>(VOICE);
  const [job, setJob] = useState<Job | null>(null);
  const [mode, setMode] = useState<ReadMode>("compact");
  const [stage, setStage] = useState<Stage>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    if (!source) {
      setJob(null);
      setHint(null);
      return;
    }
    let cancelled = false;
    const alive = () => !cancelled;

    void (async () => {
      setStage({ label: "转换", value: 0.05 });
      try {
        const clipped = slice(source.pcm, source.sr, enc.start, enc.end);
        const fit = fitEncode(enc, source.sr, clipped.length);
        if (fit.enc !== enc) {
          setHint(fit.note);
          setEnc(fit.enc);
          return;
        }
        setHint(null);
        const sr = enc.sr > 0 ? enc.sr : source.sr;
        const tuned = resample(clipped, source.sr, sr, enc.mode === "compact" ? enc.fmax : 0);
        if (cancelled) return;
        await nextFrame();

        const spec = await encode(tuned, sr, enc, alive, v => {
          if (!cancelled) setStage({ label: "生成图片", value: v });
        });
        if (cancelled) return;

        setStage({ label: "打包", value: 1 });
        await nextFrame();
        const png = await spectrumToPng(spec);
        if (cancelled) return;

        setJob({ spec, pcm: tuned, png });
        setError(null);
      } catch (e) {
        if (cancelled || e instanceof Aborted) return;
        console.error(e);
        setError(e instanceof Error ? e.message : "转换失败");
      } finally {
        if (!cancelled) setStage(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, enc]);

  const open = useCallback(async (file: File) => {
    const my = ++genRef.current;
    const alive = () => genRef.current === my;
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
        const pcm = await synthesise(spec, alive, v => {
          if (alive()) setStage({ label, value: v });
        });
        if (!alive()) return;

        setMode(readMode);
        setEnc(e => adoptMeta(spec.meta, reopen(e)));
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
      setEnc(e => reopen(e));
      setSource({ pcm: mono, sr, name: file.name });
    } catch (e) {
      if (!alive() || e instanceof Aborted) return;
      console.error(e);
      setError(e instanceof Error ? e.message : "这个文件处理不了");
    } finally {
      if (alive()) setStage(null);
    }
  }, []);

  const refine = useCallback(async () => {
    if (!job) return;
    const my = ++genRef.current;
    const alive = () => genRef.current === my;
    setError(null);
    setStage({ label: "精修", value: 0 });
    try {
      const pcm = await synthesise(
        job.spec,
        alive,
        v => {
          if (alive()) setStage({ label: "精修", value: v });
        },
        "fine",
      );
      if (!alive()) return;
      setJob(j => (j ? { ...j, pcm } : j));
      setHint("相位已重建");
    } catch (e) {
      if (!alive() || e instanceof Aborted) return;
      console.error(e);
      setError(e instanceof Error ? e.message : "精修失败");
    } finally {
      if (alive()) setStage(null);
    }
  }, [job]);

  const demo = useCallback(async () => {
    try {
      const buf = await (await fetch(DEMO_URL)).arrayBuffer();
      const { pcm, sr } = await decodeAudioFile(buf);
      setMode("compact");
      setEnc(e => ({ ...reopen(e), sr: 0 }));
      setSource({ pcm, sr, name: "fade-demo" });
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "示例加载失败");
    }
  }, []);

  const trim = useCallback(() => {
    if (!source) return;
    const b = silenceBounds(source.pcm, source.sr);
    if (b.end <= b.start) return;
    setEnc(e => ({
      ...e,
      start: Math.round(b.start * 100) / 100,
      end: Math.round(b.end * 100) / 100,
    }));
  }, [source]);

  const clear = useCallback(() => {
    genRef.current++;
    setSource(null);
    setJob(null);
    setError(null);
    setHint(null);
  }, []);

  return { source, enc, setEnc, job, mode, stage, error, hint, open, refine, demo, trim, clear };
}

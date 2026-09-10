import { useCallback, useEffect, useRef, useState } from "react";
import DEMO_URL from "../assets/fade-demo.ogg";
import { decodeAudioFile } from "../lib/audio";
import type { Samples } from "../lib/arrays";
import { imageToSpectrum, sniff, spectrumToPng, type Container, type ReadMode } from "../lib/image";
import { FINENESS, SR_OPTIONS, VOICE, reopen, type Encode } from "../lib/params";
import { resample, slice, trimRange } from "../lib/resample";
import { Aborted, encode, fitEncode, synthesise, type Meta, type Spectrum } from "../lib/spectrum";

interface Source {
  pcm: Samples;
  sr: number;
  name: string;
}

interface Job {
  spec: Spectrum;
  pcm: Samples;
  png: Blob;
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
  // 自动降级的提示必须与那次降级**同一个 state**：分开存会让 effect 的第二轮（enc 已是降级后的值、
  // fitEncode 原样放行）把它清掉 —— 提示只闪一帧，用户看到的就是「采样率自己跳回 8k，毫无说明」。
  const [pick, setPick] = useState<{ enc: Encode; note: string | null }>({ enc: VOICE, note: null });
  const [job, setJob] = useState<Job | null>(null);
  const [mode, setMode] = useState<ReadMode>("compact");
  const [stage, setStage] = useState<Stage>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const genRef = useRef(0);
  const enc = pick.enc;

  // 用户动参数 = 新的一段叙事：旧提示（含自动降级那条）一并作废。
  const setEnc = useCallback((next: Encode | ((e: Encode) => Encode)) => {
    setPick(p => ({ enc: typeof next === "function" ? next(p.enc) : next, note: null }));
    setHint(null);
  }, []);

  useEffect(() => {
    if (!source) {
      setJob(null);
      setPick(p => (p.note === null ? p : { ...p, note: null }));
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
          setPick({ enc: fit.enc, note: fit.note });
          return;
        }
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
    // 与 open / refine 同款代次守卫：演示在解码，用户中途点了「清空」或拖进新文件，
    // 这个 Promise 回来时不能再往界面上盖。
    const my = ++genRef.current;
    const alive = () => genRef.current === my;
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
  }, []);

  const clear = useCallback(() => {
    genRef.current++;
    setSource(null);
    setJob(null);
    setError(null);
    setHint(null);
  }, []);

  // 自动降级那条是「当前设置的既定事实」，得一直挂着；hint 是「刚发生的事」。两者都留着。
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
    refine,
    demo,
    clear,
  };
}

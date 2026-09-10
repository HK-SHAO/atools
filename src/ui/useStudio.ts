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
  png: Blob;
  /** 编码前的音频（重采样后）：质检的参照 —— 「还原度」是拿它比的。 */
  ref: Samples;
  /**
   * 图里装的声音 = `synthesise(spec)`。播放与「存音频」用的是它，**不是** `ref`。
   *
   * 位深 / 窗长 / 频宽只改图，原声对它们完全不敏感：放原声的话 2bit 与 8bit 听起来
   * 一模一样（实测包络相关 0.64 vs 0.99），用户会以为参数没生效。按需算（`listen`）：
   * 参数一动这份就作废，真按播放时才补算，免得调参数时空跑。
   */
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

  const jobRef = useRef<Job | null>(null);
  const pendingRef = useRef<{ spec: Spectrum; p: Promise<Samples | null> } | null>(null);

  const putJob = useCallback((next: Job | null) => {
    jobRef.current = next;
    setJob(next);
  }, []);

  // 用户动参数 = 新的一段叙事：旧提示（含自动降级那条）一并作废。
  const setEnc = useCallback((next: Encode | ((e: Encode) => Encode)) => {
    setPick(p => ({ enc: typeof next === "function" ? next(p.enc) : next, note: null }));
    setHint(null);
  }, []);

  useEffect(() => {
    if (!source) {
      putJob(null);
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

        putJob({ spec, png, ref: tuned, audio: null });
        setError(null);
      } catch (e) {
        if (cancelled || e instanceof Aborted) return;
        console.error(e);
        setError(e instanceof Error ? e.message : "转换失败");
      } finally {
        if (!alive()) return;
        setStage(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, enc, putJob]);

  /** 还原一张图的声音。`fine` 走精修档（更多迭代 + GL 打磨），「重建相位」用。 */
  const render = useCallback(
    async (spec: Spectrum, fine: boolean): Promise<Samples | null> => {
      const my = ++genRef.current;
      const alive = () => genRef.current === my;
      const label = fine ? "精修" : "还原";
      setStage({ label, value: 0 });
      try {
        const audio = await synthesise(
          spec,
          alive,
          v => {
            if (alive()) setStage({ label, value: v });
          },
          fine ? "fine" : "fast",
        );
        if (!alive()) return null;
        const cur = jobRef.current;
        // 等的时候参数被改过：这一份已经不是当前这张图。
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
    [putJob],
  );

  /** 播放与「存音频」的取音入口：同一张图的还原只算一次。 */
  const listen = useCallback((): Promise<Samples | null> => {
    const j = jobRef.current;
    if (!j) return Promise.resolve(null);
    if (j.audio) return Promise.resolve(j.audio);
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
    },
    [setEnc],
  );

  const refine = useCallback(async () => {
    const j = jobRef.current;
    if (!j) return;
    setError(null);
    if (await render(j.spec, true)) setHint("相位已重建");
  }, [render]);

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
  }, [setEnc]);

  const clear = useCallback(() => {
    genRef.current++;
    pendingRef.current = null;
    setSource(null);
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
    listen,
    refine,
    demo,
    clear,
  };
}

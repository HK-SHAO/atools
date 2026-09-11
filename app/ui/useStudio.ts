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
  const io = scope("studio");
  const enc = pick.enc;

  /**
   * 开新一段叙事：旧的还原 / 编码当场作废，并返回本代的守卫（「还是本代吗」）。
   *
   * 原先靠 `alive()` 闭包把「不是本代」这件事传到计算里，现在计算在别的线程上，
   * 只能靠消息 —— 两边合起来是同一个代次守卫：主线程换代号 + 让 Worker 作废在算的活。
   */
  const generation = useCallback((): (() => boolean) => {
    io.cancel();
    const my = ++genRef.current;
    return () => genRef.current === my;
  }, [io]);

  const jobRef = useRef<Job | null>(null);
  const pendingRef = useRef<{ spec: Spectrum; p: Promise<Samples | null> } | null>(null);
  /** 本轮编码什么时候结束。`listen` 要等它 —— 见 `listen` 里的循环。 */
  const readyRef = useRef<Promise<void>>(Promise.resolve());

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
    // 动参数 / 换素材 = 上一份还原（按播放、重建相位）**当场作废**。不作废的话它会一路算到底：
    // 结果被丢掉之外，它结束时的 setStage(null) 还会盖住这一轮的「转换中」，进度条闪一下没了。
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
      putJob(null);
      setPick(p => (p.note === null ? p : { ...p, note: null }));
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
        // 紧凑档出图是纯函数，交给 Worker；可逆档要走 canvas 的 toBlob，只能留在主线程。
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
        if (!alive()) return;
        setStage(null);
      }
    })();

    // 被换掉的那一轮也要放行，否则正在等它的 listen 会永远挂着。
    return () => {
      cancelled = true;
      io.cancel();
      release();
    };
  }, [source, enc, putJob, generation, io]);

  /** 还原一张图的声音。`fine` 走精修档（更多迭代 + GL 打磨），「重建相位」用。 */
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
    [io, putJob, generation],
  );

  /**
   * 播放与「存音频」的取音入口：同一张图的还原只算一次。
   *
   * 先等编码停下来 —— 换了参数而新一轮还没落地时，`jobRef` 还指着**上一张图**，
   * 这时候开算就是白算（结果会被 `render` 里的 spec 比对丢掉），长素材上白等好几秒。
   * 循环等是因为等的过程中可能又换了一次参数：一直等到没有新一轮在跑为止。
   */
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
    // 演示在解码时用户可能点了「清空」或拖进新文件，回来时不能再往界面上盖。
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
    setSource(null);
    setError(null);
    setHint(null);
  }, [generation]);

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

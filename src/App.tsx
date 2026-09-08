import { useCallback, useEffect, useRef, useState } from "react";
import { decodeAudioFile, demoTrack } from "./lib/audio";
import type { Samples } from "./lib/arrays";
import { imageToSpectrum, sniff, spectrumToPng, type Container, type ReadMode } from "./lib/image";
import { FINENESS, SR_OPTIONS, VOICE, reopen, type Encode } from "./lib/params";
import { resample, silenceBounds, slice } from "./lib/resample";
import { Aborted, encode, fitEncode, synthesise, type Meta, type Spectrum } from "./lib/spectrum";
import { useContainerScale } from "./ui/useContainerScale";
import { useMic, type CapturedSamples } from "./ui/useMic";
import { clock } from "./ui/usePlayback";
import { Workbench } from "./ui/Workbench";

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

const DEMO_RATE = 44100;
const IMAGE_EXT = /\.(png|jpe?g|jpe|webp|gif|bmp|avif)$/i;

// 让出主线程、允许 React 刷新进度；用 setTimeout 而非 rAF，避免后台标签页里 rAF 不触发而卡住流水线。
const nextFrame = () => new Promise<void>(done => setTimeout(done, 0));

type Stage = { label: string; value: number } | null;

/** 读进来的图按它自己的参数展示，之后想压再调 —— 所见即所得。 */
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

export function App() {
  const rootRef = useRef<HTMLDivElement>(null);
  useContainerScale(rootRef);

  const [source, setSource] = useState<Source | null>(null);
  const [enc, setEnc] = useState<Encode>(VOICE);
  const [job, setJob] = useState<Job | null>(null);
  const [mode, setMode] = useState<ReadMode>("compact");
  const [stage, setStage] = useState<Stage>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const genRef = useRef(0);

  // 素材或参数一变就重跑一遍：裁剪 → 重采样 → 成图 → 打包。
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
        // 载入优先：素材超上限就自动降采样率让它放得下，而不是报错拒载。
        // 改了参数就交给 effect 用新 enc 重跑，本次不再往下走。
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
          if (!cancelled) setStage({ label: "成图", value: v });
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
        setError(e instanceof Error ? e.message : "转换失败");
      } finally {
        if (!cancelled) setStage(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, enc]);

  const run = useCallback(async (file: File) => {
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

        const label = spec.meta.exact && spec.phaseCos ? "还原" : "重建相位";
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
            "这张图没带元数据（可能被压缩软件剥掉或改过名），已靠图的签名认出 —— 采样率按默认 8k 解读，时长或音高若不对可在参数里调整",
          );
        else if (phaseReliability !== null && phaseReliability < 0.8)
          setHint("相位信息已被缩放/压缩破坏，已自动改用幅度重建相位");
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
      if (alive() && !(e instanceof Aborted))
        setError(e instanceof Error ? e.message : "这个文件处理不了");
    } finally {
      if (alive()) setStage(null);
    }
  }, []);

  // 麦克风直接给到 PCM，跳过文件解码链路。
  const loadSamples = useCallback((s: CapturedSamples) => {
    setError(null);
    setMode("compact");
    setEnc(e => reopen(e));
    setSource({ pcm: s.pcm, sr: s.sr, name: s.name });
  }, []);

  const mic = useMic(loadSamples);

  // 精修：愿意多花时间，就把相位用足算力重新对齐（有损图 / 紧凑图都受益）。
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
      setHint("相位已用更多算力精修 —— 满意的话直接「存音频」");
    } catch (e) {
      if (alive() && !(e instanceof Aborted))
        setError(e instanceof Error ? e.message : "精修失败");
    } finally {
      if (alive()) setStage(null);
    }
  }, [job]);

  const demo = useCallback(() => {
    setMode("compact");
    setEnc(e => reopen(e));
    setSource({ pcm: demoTrack(DEMO_RATE), sr: DEMO_RATE, name: "示例" });
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

  return (
    <div
      ref={rootRef}
      className={dragging ? "app is-dragging" : "app"}
      onDragOver={e => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={e => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) void run(file);
      }}
    >
      <div className="shell">
        <header className="head">
          <h1>频谱</h1>
          <p>声音 ↔ 图像</p>
        </header>

        {job && source ? (
          <Workbench
            spec={job.spec}
            pcm={job.pcm}
            png={job.png}
            name={source.name}
            srcSr={source.sr}
            mode={mode}
            enc={enc}
            onEnc={setEnc}
            onTrim={trim}
            onRefine={refine}
            onReset={() => {
              setSource(null);
              setJob(null);
            }}
            busy={stage !== null}
          />
        ) : (
          <section className="card">
            <div className="drop">
              <span className="drop-lead">拖进一段音频，或者一张图</span>
              <span className="drop-sub">mp3 · wav · flac · m4a · ogg ↔ png · jpg · webp</span>
              <div className="drop-acts">
                <label className="drop-act">
                  选文件
                  <input
                    type="file"
                    accept="audio/*,image/*"
                    hidden
                    onChange={e => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void run(file);
                    }}
                  />
                </label>
                {mic.recording ? (
                  <button type="button" className="drop-act is-rec" onClick={mic.stop}>
                    <span className="rec-dot" aria-hidden="true" />
                    停止 {clock(mic.seconds)}
                  </button>
                ) : (
                  <button type="button" className="drop-act" onClick={mic.start}>
                    录制
                  </button>
                )}
              </div>
              {mic.error && <p className="drop-err">{mic.error}</p>}
            </div>
          </section>
        )}

        {stage && (
          <p className="note">
            {stage.label}
            <span className="note-bar">
              <span style={{ width: `${Math.round(stage.value * 100)}%` }} />
            </span>
          </p>
        )}
        {hint && <p className="note">{hint}</p>}
        {error && <p className="note is-error">{error}</p>}

        <footer className="foot">
          <button type="button" className="act" onClick={demo}>
            {source ? "换个示例" : "听个示例"}
          </button>
          <span className="dim">
            单声道 · 紧凑模式下图就是频谱图本身，只有幅度；可逆模式额外在下三段存精度与相位
          </span>
        </footer>
      </div>
    </div>
  );
}

export default App;

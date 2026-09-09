import { useCallback, useEffect, useRef, useState } from "react";
import { decodeAudioFile } from "./lib/audio";
import type { Samples } from "./lib/arrays";
import DEMO_URL from "./assets/fade-demo.ogg";
import { imageToSpectrum, sniff, spectrumToPng, type Container, type ReadMode } from "./lib/image";
import { FINENESS, SR_OPTIONS, VOICE, reopen, type Encode } from "./lib/params";
import { resample, silenceBounds, slice } from "./lib/resample";
import { Aborted, encode, fitEncode, synthesise, type Meta, type Spectrum } from "./lib/spectrum";
import { useContainerScale } from "./ui/useContainerScale";
import { Workbench } from "./ui/Workbench";
import { CREDIT_AUTHOR, CREDIT_NAME } from "./credit";

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

const IMAGE_EXT = /\.(png|jpe?g|jpe|webp|gif|bmp|avif)$/i;

const nextFrame = () => new Promise<void>(done => setTimeout(done, 0));

type Stage = { label: string; value: number } | null;

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
          setHint("图片被缩放过，相位信息已被抹平，只能按幅度重建，会有些失真");
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
      setHint("相位已精修");
    } catch (e) {
      if (!alive() || e instanceof Aborted) return;
      console.error(e);
      setError(e instanceof Error ? e.message : "精修失败");
    } finally {
      if (alive()) setStage(null);
    }
  }, [job]);

  const demo = useCallback(() => {
    void (async () => {
      try {
        const buf = await (await fetch(DEMO_URL)).arrayBuffer();
        const { pcm, sr } = await decodeAudioFile(buf);
        setMode("compact");
        setEnc(e => ({ ...reopen(e), sr: 0 }));
        setSource({ pcm, sr, name: "fade（示例，前 12 秒）" });
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : "示例加载失败");
      }
    })();
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
          <h1>频谱 SPECTRUM</h1>
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
            stage={stage}
            hint={hint}
            error={error}
          />
        ) : (
          <section className="card">
            <div className="drop">
              <span className="drop-lead">拖进一段音频，或者一张图</span>
              <span className="drop-sub">mp3, wav, flac, m4a, ogg, amr ↔ png, jpg, webp</span>
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
              </div>
            </div>
          </section>
        )}

        {!(job && source) && (
          <>
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
          </>
        )}

        <footer className="foot">
          {source && (
            <button
              type="button"
              className="act"
              style={{ display: 'none' }}
              onClick={() => {
                setSource(null);
                setJob(null);
              }}
            >
              清空
            </button>
          )}
          <button type="button" className="act" onClick={demo}>
            演示音频
          </button>
          <span className="credit">
            {CREDIT_NAME} · created by{" "}
            <a href={CREDIT_AUTHOR.url} target="_blank" rel="noreferrer">
              {CREDIT_AUTHOR.name}
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}

export default App;

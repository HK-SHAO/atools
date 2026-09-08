import { useCallback, useEffect, useRef, useState } from "react";
import { decodeAudioFile, demoTrack } from "./lib/audio";
import type { Samples } from "./lib/arrays";
import { imageToSpectrum, sniff, spectrumToPng, type Container, type ReadMode } from "./lib/image";
import { FINENESS, SR_OPTIONS, VOICE, reopen, type Encode } from "./lib/params";
import { resample, silenceBounds, slice } from "./lib/resample";
import { Aborted, encode, synthesise, type Meta, type Spectrum } from "./lib/spectrum";
import { useContainerScale } from "./ui/useContainerScale";
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

const nextFrame = () => new Promise<void>(done => requestAnimationFrame(() => setTimeout(done, 0)));

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
  const [dragging, setDragging] = useState(false);
  const genRef = useRef(0);

  // 素材或参数一变就重跑一遍：裁剪 → 重采样 → 成图 → 打包。
  useEffect(() => {
    if (!source) {
      setJob(null);
      return;
    }
    let cancelled = false;
    const alive = () => !cancelled;

    void (async () => {
      setStage({ label: "转换", value: 0.05 });
      try {
        const sr = enc.sr > 0 ? enc.sr : source.sr;
        const clipped = slice(source.pcm, source.sr, enc.start, enc.end);
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
        const { spec, mode: readMode } = await imageToSpectrum(new Blob([bytes]), file.name);
        if (!alive()) return;

        const label = spec.meta.exact ? "还原" : "重建相位";
        setStage({ label, value: 0 });
        await nextFrame();
        const pcm = await synthesise(spec, alive, v => {
          if (alive()) setStage({ label, value: v });
        });
        if (!alive()) return;

        setMode(readMode);
        setEnc(e => adoptMeta(spec.meta, reopen(e)));
        setSource({ pcm, sr: spec.meta.sr, name: file.name });
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
            onReset={() => {
              setSource(null);
              setJob(null);
            }}
            busy={stage !== null}
          />
        ) : (
          <section className="card">
            <label className="drop">
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
              <span className="drop-lead">拖进一段音频，或者一张图</span>
              <span className="drop-sub">mp3 · wav · flac · m4a · ogg ↔ png · jpg · webp</span>
              <span className="drop-act">选文件</span>
            </label>
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

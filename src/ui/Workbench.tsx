import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Samples } from "../lib/arrays";
import { audit, type LossRow } from "../lib/audit";
import { downloadName, spectrumToPng, type ReadMode } from "../lib/image";
import {
  BITS_OPTIONS,
  FMAX_OPTIONS,
  FINENESS,
  SR_OPTIONS,
  hzLabel,
  srLabel,
  type Encode,
  type Mode,
} from "../lib/params";
import { wavFile } from "../lib/wav";
import type { Spectrum } from "../lib/spectrum";
import { Row, type Option } from "./Row";
import { buildSheet } from "./raster";
import { Spectrogram } from "./Spectrogram";
import { clock, usePlayback } from "./usePlayback";

const SHEET_ROWS = 360;

interface Props {
  spec: Spectrum;
  pcm: Samples;
  png: Blob;
  name: string;
  srcSr: number;
  mode: ReadMode;
  enc: Encode;
  onEnc: (e: Encode) => void;
  onTrim: () => void;
  onRefine: () => void;
  onReset: () => void;
  stage: { label: string; value: number } | null;
  hint: string | null;
  error: string | null;
}

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

const MODE_NOTE: Record<ReadMode, string | null> = {
  exact: "可逆模式：音质几乎无损。要长期保存请用 PNG，转成 JPEG 音质会略降",
  compact: null,
  degraded: "这张图被压缩或缩放过，音质会打折扣",
  foreign: "这不是本工具生成的图，试着把画面明暗当声音来读",
};

const kb = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function lossLine(rows: LossRow[], exact: boolean): string {
  const own = rows[0]!;
  if (exact && own.level === 0 && own.corr > 0.999) return "自检：存出再读回，完全一致";
  const cell = (r: LossRow): string => `${r.label} 还原度 ${Math.round(r.corr * 100)}%`;
  return `自检：${rows.map(cell).join("，")}`;
}

export function Workbench({
  spec,
  pcm,
  png,
  name,
  srcSr,
  mode,
  enc,
  onEnc,
  onTrim,
  onRefine,
  onReset,
  stage,
  hint,
  error,
}: Props) {
  const busy = stage !== null;
  const { meta } = spec;
  const sheet = useMemo(() => buildSheet(spec, SHEET_ROWS), [spec]);
  const { playing, duration, toggle, seek, scrub, commit, nudge, headRef, timeRef } = usePlayback(
    pcm,
    meta.sr,
  );
  const [loss, setLoss] = useState<LossRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    genRef.current++;
    setLoss(null);
  }, [spec]);
  useEffect(() => setRange(null), [enc.start, enc.end]);

  const commitRange = () => {
    if (!range) return;
    const start = Math.max(0, Number(range.start) || 0);
    const end = Math.max(0, Number(range.end) || 0);
    setRange(null);
    if (start !== enc.start || end !== enc.end) onEnc({ ...enc, start, end });
  };

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setLoss(await audit(pcm, spec, png, name));
    } catch (e) {
      setLoss(null);
      void e;
    } finally {
      setChecking(false);
    }
  }, [name, pcm, png, spec]);

  const savePng = useCallback(() => save(png, downloadName(name, meta)), [meta, name, png]);

  const saveWav = useCallback(() => {
    save(
      new Blob([wavFile(pcm, meta.sr)], { type: "audio/wav" }),
      `${name.replace(/\.[^.]+$/, "")}.wav`,
    );
  }, [meta.sr, name, pcm]);

  const nyquist = (enc.sr > 0 ? enc.sr : srcSr) / 2;
  const compact = enc.mode === "compact";
  const note = MODE_NOTE[mode];
  const canRefine = !(spec.meta.exact && spec.phaseCos && spec.phaseSin);

  const set = <K extends keyof Encode>(key: K, value: Encode[K]) => onEnc({ ...enc, [key]: value });

  const endShown = (end: number): string => (end === 0 ? "" : String(end));

  const fmaxOptions: Option<number>[] = FMAX_OPTIONS.filter(hz => hz === 0 || hz < nyquist).map(
    hz => ({ value: hz, label: hzLabel(hz) }),
  );

  return (
    <section className="card">
      <Spectrogram
        sheet={sheet}
        headRef={headRef}
        onSeek={seek}
        onScrub={scrub}
        onCommit={commit}
        onNudge={nudge}
      />

      <div className="bar">
        <button
          type="button"
          className="icon-btn"
          onClick={toggle}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? (
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 6v12M15 6v12" />
            </svg>
          ) : (
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5.5 18.5 12 8 18.5Z" fill="currentColor" stroke="none" />
            </svg>
          )}
        </button>
        <p className="time">
          <span ref={timeRef}>0:00</span>
          <span className="dim"> / {clock(duration)}</span>
        </p>
        {busy && <span className="dim tick">转换中</span>}
      </div>

      <p className="facts">
        采样率 {srLabel(meta.sr)}、{clock(duration)}、{kb(png.size)}
        {compact ? "" : "、可逆"}
      </p>
      {note && <p className="facts dim">{note}</p>}
      {hint && <p className="facts dim">{hint}</p>}
      {error && <p className="note is-error">{error}</p>}
      {stage && (
        <p className="note">
          {stage.label}
          <span className="note-bar">
            <span style={{ width: `${Math.round(stage.value * 100)}%` }} />
          </span>
        </p>
      )}

      <div className="acts">
        <button type="button" className="act" onClick={savePng}>
          存频谱图
        </button>
        <button type="button" className="act" onClick={saveWav}>
          存音频
        </button>
        <button type="button" className="act" onClick={onReset}>
          换一个
        </button>
        <button type="button" className="act" onClick={check} disabled={checking || busy}>
          {checking ? "质检中" : "质检"}
        </button>
        {canRefine && (
          <button type="button" className="act" onClick={onRefine} disabled={busy}>
            精修相位
          </button>
        )}
      </div>

      {loss && <p className="facts">{lossLine(loss, meta.exact)}</p>}

      <div className="params">
        <Row<Mode>
          label="模式"
          value={enc.mode}
          options={[
            { value: "compact", label: "紧凑" },
            { value: "exact", label: "可逆" },
          ]}
          onPick={v => set("mode", v)}
        />
        <Row<number>
          label="采样率"
          value={enc.sr}
          options={SR_OPTIONS.map(sr => ({ value: sr, label: srLabel(sr) }))}
          onPick={v => onEnc({ ...enc, sr: v, fmax: v > 0 && enc.fmax >= v / 2 ? 0 : enc.fmax })}
        />
        {compact && (
          <Row<number>
            label="位深"
            value={enc.bits}
            options={BITS_OPTIONS.map(b => ({ value: b, label: String(b) }))}
            onPick={v => set("bits", v)}
          />
        )}
        <Row<Encode["fineness"]>
          label="窗长"
          value={enc.fineness}
          options={FINENESS.map((f, i) => ({
            value: i as Encode["fineness"],
            label: f.label,
          }))}
          onPick={v => set("fineness", v)}
        />
        {compact && (
          <Row<number>
            label="频宽"
            value={enc.fmax}
            options={fmaxOptions}
            onPick={v => set("fmax", v)}
          />
        )}
        <div className="prow">
          <span className="plabel">区间</span>
          <div className="chips">
            <label className="num">
              <span aria-hidden="true">起</span>
              <input
                type="number"
                min={0}
                max={duration}
                step={0.1}
                value={range ? range.start : String(enc.start)}
                onChange={e =>
                  setRange({ start: e.target.value, end: range ? range.end : endShown(enc.end) })
                }
                onBlur={commitRange}
                onKeyDown={e => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
            <label className="num">
              <span aria-hidden="true">止</span>
              <input
                type="number"
                min={0}
                max={duration}
                step={0.1}
                value={range ? range.end : endShown(enc.end)}
                placeholder="结尾"
                onChange={e =>
                  setRange({ start: range ? range.start : String(enc.start), end: e.target.value })
                }
                onBlur={commitRange}
                onKeyDown={e => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
            <button type="button" className="chip" onClick={onTrim}>
              裁静音
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

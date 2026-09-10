import { useCallback, useMemo } from "react";
import type { Samples } from "../lib/arrays";
import type { LossRow } from "../lib/audit";
import { downloadName, type ReadMode } from "../lib/image";
import { srLabel, type Encode } from "../lib/params";
import type { Spectrum } from "../lib/spectrum";
import { wavFile } from "../lib/wav";
import { ParamPanel } from "./ParamPanel";
import { buildSheet } from "./raster";
import { Spectrogram } from "./Spectrogram";
import { StatusNote } from "./StatusNote";
import { useAudit } from "./useAudit";
import { clock, usePlayback } from "./usePlayback";
import type { Stage } from "./useStudio";

const SHEET_ROWS = 360;

const MODE_NOTE: Record<ReadMode, string | null> = {
  exact: "相位已载入。无损图片的音质更好",
  compact: null,
  degraded: "此图被压缩或缩放过，音质会失真",
  foreign: "这不是本工具生成的，建议采用专用图片",
};

const kb = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

function lossLine(rows: LossRow[], exact: boolean): string {
  const own = rows[0]!;
  if (exact && own.level === 0 && own.corr > 0.999) return "自检：存出再读回，完全一致";
  const cell = (r: LossRow): string => `${r.label} ${Math.round(r.corr * 100)}%`;
  return `还原度：${rows.map(cell).join("；")}`;
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
  stage: Stage;
  hint: string | null;
  error: string | null;
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
  const { loss, checking, check } = useAudit(pcm, spec, png, name);

  const savePng = useCallback(() => save(png, downloadName(name, meta)), [meta, name, png]);

  const saveWav = useCallback(() => {
    save(
      new Blob([wavFile(pcm, meta.sr)], { type: "audio/wav" }),
      `${name.replace(/\.[^.]+$/, "")}.wav`,
    );
  }, [meta.sr, name, pcm]);

  const compact = enc.mode === "compact";
  const note = MODE_NOTE[mode];
  const canRefine = !(spec.meta.exact && spec.phaseCos && spec.phaseSin && !spec.phaseWeak);

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
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            {playing ? (
              <path d="M9 6v12M15 6v12" />
            ) : (
              <path d="M8 5.5 18.5 12 8 18.5Z" fill="currentColor" stroke="none" />
            )}
          </svg>
        </button>
        <p className="time">
          <span ref={timeRef}>0:00</span>
          <span className="dim"> / {clock(duration)}</span>
        </p>
        {busy && <span className="dim tick">转换中</span>}
      </div>

      <p className="facts">
        采样率 {srLabel(meta.sr)}；PNG {kb(png.size)}；
        {compact ? "紧凑：不保存相位信息；" : "可逆模式：保存相位信息；"}
        {loss ? `${lossLine(loss, meta.exact)}；` : ""}
        {note ? `${note}；` : ""}
        {hint ? `${hint}；` : ""}
      </p>

      <StatusNote stage={stage} error={error} />

      <div className="acts">
        <button type="button" className="act" onClick={savePng}>
          存频谱图
        </button>
        <button type="button" className="act" onClick={saveWav}>
          存音频
        </button>
        <button type="button" className="act" onClick={check} disabled={checking || busy}>
          {checking ? "质检中" : "质检"}
        </button>
        {canRefine && (
          <button type="button" className="act" onClick={onRefine} disabled={busy}>
            重建相位
          </button>
        )}
      </div>

      <ParamPanel enc={enc} srcSr={srcSr} duration={duration} onEnc={onEnc} onTrim={onTrim} />
    </section>
  );
}

import { useCallback, useMemo } from "react";
import type { Samples } from "../lib/arrays";
import type { LossRow } from "../lib/audit";
import { downloadName, type ReadMode } from "../lib/container";
import { t, type Key } from "../lib/i18n";
import { srLabel, type Encode } from "../lib/params";
import { hasStrongPhase, type Spectrum } from "../lib/spectrum";
import { wavFile } from "../lib/wav";
import { ParamPanel } from "./ParamPanel";
import { buildSheet } from "./raster";
import { Spectrogram } from "./Spectrogram";
import { StatusNote } from "./StatusNote";
import { useAudit } from "./useAudit";
import { clock, usePlayback } from "./usePlayback";
import type { Stage } from "./useStudio";

const SHEET_ROWS = 360;

const MODE_NOTE: Record<ReadMode, Key | null> = {
  exact: "readExact",
  compact: null,
  degraded: "readDegraded",
  foreign: "readForeign",
};

const CASE_LABEL: Record<LossRow["kind"], Key> = {
  original: "case",
  lossy: "caseLossy",
  half: "caseHalf",
};

const kb = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

function lossLine(rows: LossRow[], compact: boolean): string {
  const own = rows[0]!;
  if (!compact && own.level === 0 && own.corr > 0.999) return t("selfCheck");
  // Compact mode stores no phase, so waveform metrics (correlation, SNR) measure
  // what it cannot have and do not track listening; spectral distance does, so
  // compact mode shows only that.
  const cell = (r: LossRow): string =>
    compact
      ? `${t(CASE_LABEL[r.kind])} ${r.lsd.toFixed(1)}`
      : `${t(CASE_LABEL[r.kind])} ${Math.round(r.corr * 100)}%, ${r.snr.toFixed(1)}dB, ${r.lsd.toFixed(1)}`;
  return (compact ? t("lossLsd") : t("lossAll")) + rows.map(cell).join(t("sep"));
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
  ref: Samples;
  audio: Samples | null;
  audioFine: boolean;
  png: Blob;
  name: string;
  srcSr: number;
  srcDuration: number;
  mode: ReadMode;
  enc: Encode;
  onEnc: (e: Encode) => void;
  onRefine: () => void;
  onListen: () => Promise<Samples | null>;
  stage: Stage;
  hint: string | null;
  error: string | null;
}

export function Workbench({
  spec,
  ref,
  audio,
  audioFine,
  png,
  name,
  srcSr,
  srcDuration,
  mode,
  enc,
  onEnc,
  onRefine,
  onListen,
  stage,
  hint,
  error,
}: Props) {
  const busy = stage !== null;
  const { meta } = spec;
  const duration = meta.samples / meta.sr;
  const sheet = useMemo(() => buildSheet(spec, SHEET_ROWS), [spec]);
  const { playing, toggle, seek, scrub, commit, nudge, headRef, timeRef } = usePlayback(
    audio,
    meta.sr,
    duration,
    onListen,
  );
  const { loss, checking, check, progress } = useAudit(ref, spec, png, name, busy, audioFine ? audio : null);

  const savePng = useCallback(() => save(png, downloadName(name, meta)), [meta, name, png]);

  const saveWav = useCallback(async () => {
    const y = audio ?? (await onListen());
    if (!y) return;
    save(
      new Blob([wavFile(y, meta.sr)], { type: "audio/wav" }),
      `${name.replace(/\.[^.]+$/, "")}.wav`,
    );
  }, [audio, meta.sr, name, onListen]);

  const compact = enc.mode === "compact";
  const note = MODE_NOTE[mode];
  const canRefine = !hasStrongPhase(spec);
  const sep = t("sep");

  return (
    <>
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
            disabled={audio === null && busy}
            aria-label={playing ? t("pause") : t("play")}
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
          {busy && (
            <span className="dim tick">
              {stage.label}
              {t("busy")}
            </span>
          )}
        </div>

        <p className="facts">
          {t("sampleRate")} {srLabel(meta.sr)}
          {sep}PNG {kb(png.size)}
          {sep}
          {compact ? t("storeCompact") : t("storeExact")}
          {sep}
          {loss ? `${lossLine(loss, compact)}${sep}` : ""}
          {note ? `${t(note)}${sep}` : ""}
          {hint ? `${hint}${sep}` : ""}
        </p>

        <StatusNote stage={stage} error={error} />

        <div className="acts">
          <button type="button" className="act" onClick={savePng}>
            {t("saveImage")}
          </button>
          <button type="button" className="act" onClick={() => void saveWav()} disabled={busy}>
            {t("saveAudio")}
          </button>
          <button type="button" className="act" onClick={check} disabled={checking || busy}>
            {checking ? t("verifying", { pct: String(Math.round(progress * 100)) }) : t("verify")}
          </button>
          {canRefine && (
            <button type="button" className="act" onClick={onRefine} disabled={busy}>
              {t("rebuildPhase")}
            </button>
          )}
        </div>
      </section>

      <ParamPanel enc={enc} srcSr={srcSr} srcDuration={srcDuration} onEnc={onEnc} />
    </>
  );
}

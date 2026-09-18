import { useState } from "react";
import { t } from "../lib/i18n";
import {
  BITS_OPTIONS,
  FINENESS,
  SR_MIN,
  clampEncode,
  hzLabel,
  sourceSr,
  srLabel,
  winOf,
  type Encode,
  type Mode,
} from "../lib/params";
import { Fold } from "./Fold";
import { OptionRow, Row, type Option } from "./OptionRow";
import { Slide } from "./Slide";

const MODE_OPTIONS: readonly Option<Mode>[] = [
  { value: "compact", label: t("compact") },
  { value: "exact", label: t("exact") },
];

const BIT_OPTS: readonly Option<number>[] = BITS_OPTIONS.map(b => ({
  value: b,
  label: String(b),
}));

const FINENESS_OPTS: readonly Option<Encode["fineness"]>[] = FINENESS.map((f, i) => ({
  value: i as Encode["fineness"],
  label: f.label,
}));

interface Props {
  enc: Encode;
  srcSr: number;
  srcDuration: number;
  onEnc: (e: Encode) => void;
}

interface Draft {
  at: { start: number; end: number };
  text: { start: string; end: string };
}

export function ParamPanel({ enc, srcSr, srcDuration, onEnc }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const open = draft && draft.at.start === enc.start && draft.at.end === enc.end ? draft.text : null;

  const set = <K extends keyof Encode>(key: K, value: Encode[K]) => onEnc({ ...enc, [key]: value });
  const endShown = (end: number): string => (end === 0 ? "" : String(end));
  const compact = enc.mode === "compact";
  const src = sourceSr(srcSr);
  const rate = enc.sr > 0 ? enc.sr : src;
  const nyq = Math.floor(rate / 2);
  const bandMin = Math.min(nyq, Math.ceil((7 * rate) / winOf(enc)));
  const band = enc.fmax > 0 && enc.fmax < nyq ? Math.min(nyq, Math.max(bandMin, Math.round(enc.fmax))) : nyq;
  const maxLabel = srcDuration > 0 ? String(Math.round(srcDuration * 10) / 10) : undefined;

  const commitRange = () => {
    if (!open) return;
    const start = Math.max(0, Number(open.start) || 0);
    const end = Math.max(0, Number(open.end) || 0);
    setDraft(null);
    if (start !== enc.start || end !== enc.end) onEnc({ ...enc, start, end });
  };

  const field = (side: "start" | "end", aria: string) => (
    <label className="num">
      <span aria-hidden="true">{side === "start" ? t("rangeFrom") : t("rangeTo")}</span>
      <input
        id={`range-${side}`}
        name={`range-${side}`}
        type="number"
        autoComplete="off"
        aria-label={aria}
        min={0}
        max={srcDuration}
        step={0.1}
        placeholder={side === "end" ? maxLabel : undefined}
        value={open ? open[side] : side === "start" ? String(enc.start) : endShown(enc.end)}
        onChange={e =>
          setDraft({
            at: { start: enc.start, end: enc.end },
            text: {
              start: side === "start" ? e.target.value : (open?.start ?? String(enc.start)),
              end: side === "end" ? e.target.value : (open?.end ?? endShown(enc.end)),
            },
          })
        }
        onBlur={commitRange}
        onKeyDown={e => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );

  return (
    <Fold label={t("advanced")} className="card more">
      <div className="params">
        <OptionRow<Mode>
          label={t("mode")}
          value={enc.mode}
          options={MODE_OPTIONS}
          onPick={v => set("mode", v)}
        />
        <Slide
          label={t("rate")}
          aria={t("sampleRate")}
          min={SR_MIN}
          max={src}
          value={rate}
          format={v => (v >= src ? t("rateSource") : srLabel(v))}
          onCommit={v => onEnc(clampEncode({ ...enc, sr: v }, srcSr))}
        />
        {compact && (
          <OptionRow<number>
            label={t("depth")}
            value={enc.bits}
            options={BIT_OPTS}
            onPick={v => set("bits", v)}
          />
        )}
        <OptionRow<Encode["fineness"]>
          label={t("window")}
          value={enc.fineness}
          options={FINENESS_OPTS}
          onPick={v => set("fineness", v)}
        />
        {compact && (
          <Slide
            label={t("band")}
            aria={t("band")}
            min={bandMin}
            max={nyq}
            value={band}
            format={v => (v >= nyq ? t("bandFull") : hzLabel(v))}
            onCommit={v => onEnc({ ...enc, fmax: v >= nyq ? 0 : v })}
          />
        )}
        <Row label={t("range")}>
          {field("start", t("rangeFromAria"))}
          {field("end", t("rangeToAria"))}
        </Row>
      </div>
    </Fold>
  );
}

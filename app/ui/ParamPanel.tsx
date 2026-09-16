import { useState } from "react";
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
import { Fold } from "./Fold";
import { OptionRow, Row, type Option } from "./OptionRow";

const MODE_OPTIONS: readonly Option<Mode>[] = [
  { value: "compact", label: "紧凑" },
  { value: "exact", label: "可逆" },
];

const SR_OPTS: readonly Option<number>[] = SR_OPTIONS.map(sr => ({
  value: sr,
  label: srLabel(sr),
}));

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
  const nyquist = (enc.sr > 0 ? enc.sr : srcSr) / 2;
  const maxLabel = srcDuration > 0 ? String(Math.round(srcDuration * 10) / 10) : undefined;

  const commitRange = () => {
    if (!open) return;
    const start = Math.max(0, Number(open.start) || 0);
    const end = Math.max(0, Number(open.end) || 0);
    setDraft(null);
    if (start !== enc.start || end !== enc.end) onEnc({ ...enc, start, end });
  };

  const fmaxOptions: Option<number>[] = FMAX_OPTIONS.filter(hz => hz === 0 || hz < nyquist).map(
    hz => ({ value: hz, label: hzLabel(hz) }),
  );

  const field = (side: "start" | "end", aria: string) => (
    <label className="num">
      <span aria-hidden="true">{side === "start" ? "起" : "止"}</span>
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
    <Fold label="进阶参数" className="card more">
      <div className="params">
        <OptionRow<Mode> label="模式" value={enc.mode} options={MODE_OPTIONS} onPick={v => set("mode", v)} />
        <OptionRow<number>
          label="采样"
          value={enc.sr}
          options={SR_OPTS}
          onPick={v => onEnc({ ...enc, sr: v, fmax: v > 0 && enc.fmax >= v / 2 ? 0 : enc.fmax })}
        />
        {compact && (
          <OptionRow<number> label="位深" value={enc.bits} options={BIT_OPTS} onPick={v => set("bits", v)} />
        )}
        <OptionRow<Encode["fineness"]>
          label="窗长"
          value={enc.fineness}
          options={FINENESS_OPTS}
          onPick={v => set("fineness", v)}
        />
        {compact && (
          <OptionRow<number> label="频宽" value={enc.fmax} options={fmaxOptions} onPick={v => set("fmax", v)} />
        )}
        <Row label="区间">
          {field("start", "起点秒数")}
          {field("end", "终点秒数")}
        </Row>
      </div>
    </Fold>
  );
}

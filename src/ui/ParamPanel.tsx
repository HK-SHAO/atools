import { useEffect, useState } from "react";
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
import { OptionRow, type Option } from "./OptionRow";

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
  duration: number;
  onEnc: (e: Encode) => void;
  onTrim: () => void;
}

export function ParamPanel({ enc, srcSr, duration, onEnc, onTrim }: Props) {
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);

  useEffect(() => setRange(null), [enc.start, enc.end]);

  const set = <K extends keyof Encode>(key: K, value: Encode[K]) => onEnc({ ...enc, [key]: value });
  const endShown = (end: number): string => (end === 0 ? "" : String(end));
  const compact = enc.mode === "compact";
  const nyquist = (enc.sr > 0 ? enc.sr : srcSr) / 2;

  const commitRange = () => {
    if (!range) return;
    const start = Math.max(0, Number(range.start) || 0);
    const end = Math.max(0, Number(range.end) || 0);
    setRange(null);
    if (start !== enc.start || end !== enc.end) onEnc({ ...enc, start, end });
  };

  const fmaxOptions: Option<number>[] = FMAX_OPTIONS.filter(hz => hz === 0 || hz < nyquist).map(
    hz => ({ value: hz, label: hzLabel(hz) }),
  );

  return (
    <div className="params">
      <OptionRow<Mode>
        label="模式"
        value={enc.mode}
        options={MODE_OPTIONS}
        onPick={v => set("mode", v)}
      />
      <OptionRow<number>
        label="采样"
        value={enc.sr}
        options={SR_OPTS}
        onPick={v => onEnc({ ...enc, sr: v, fmax: v > 0 && enc.fmax >= v / 2 ? 0 : enc.fmax })}
      />
      {compact && (
        <OptionRow<number>
          label="位深"
          value={enc.bits}
          options={BIT_OPTS}
          onPick={v => set("bits", v)}
        />
      )}
      <OptionRow<Encode["fineness"]>
        label="窗长"
        value={enc.fineness}
        options={FINENESS_OPTS}
        onPick={v => set("fineness", v)}
      />
      {compact && (
        <OptionRow<number>
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
  );
}

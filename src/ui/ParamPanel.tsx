import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
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
import { kit } from "./kit";
import { OptionRow, Row, type Option } from "./OptionRow";

const params = stylex.create({
  panel: {
    display: { default: "flex", "@container (min-width: 800px)": "grid" },
    flexDirection: "column",
    gridTemplateColumns: { "@container (min-width: 800px)": "repeat(auto-fit, minmax(11em, 1fr))" },
    rowGap: "0.125em",
    columnGap: { "@container (min-width: 800px)": "1.25em" },
    alignItems: { "@container (min-width: 800px)": "center" },
    paddingTop: "0.5em",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: "var(--line)",
  },
});

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

  const field = (side: "start" | "end", aria: string, placeholder?: string) => (
    <label data-el="num" {...stylex.props(kit.num)}>
      <span aria-hidden="true">{side === "start" ? "起" : "止"}</span>
      <input
        {...stylex.props(kit.numInput)}
        type="number"
        aria-label={aria}
        min={0}
        max={duration}
        step={0.1}
        placeholder={placeholder}
        value={range ? range[side] : side === "start" ? String(enc.start) : endShown(enc.end)}
        onChange={e =>
          setRange({
            start: side === "start" ? e.target.value : (range?.start ?? String(enc.start)),
            end: side === "end" ? e.target.value : (range?.end ?? endShown(enc.end)),
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
    <div data-el="params" {...stylex.props(params.panel)}>
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
        {field("end", "终点秒数", "结尾")}
        <button type="button" data-el="chip" {...stylex.props(kit.chip, kit.chipHover)} onClick={onTrim}>
          裁静音
        </button>
      </Row>
    </div>
  );
}

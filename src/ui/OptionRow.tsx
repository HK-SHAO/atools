import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { kit } from "./kit";

export const row = stylex.create({
  line: {
    display: "flex",
    alignItems: "center",
    gap: "0.5em",
    minWidth: 0,
  },
  label: {
    flex: "none",
    width: "3.625em",
    fontSize: "var(--fs-lo)",
    letterSpacing: "0.1em",
    color: "var(--soft)",
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25em",
    minWidth: 0,
  },
});

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div {...stylex.props(row.line)}>
      <span {...stylex.props(row.label)}>{label}</span>
      <div {...stylex.props(row.chips)}>{children}</div>
    </div>
  );
}

export interface Option<T> {
  value: T;
  label: string;
}

interface Props<T> {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onPick: (v: T) => void;
}

export function OptionRow<T>({ label, value, options, onPick }: Props<T>) {
  return (
    <Row label={label}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            data-el="chip"
            {...stylex.props(kit.chip, on ? kit.chipOn : kit.chipHover)}
            aria-pressed={on}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </Row>
  );
}

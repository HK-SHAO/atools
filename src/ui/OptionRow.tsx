import type { ReactNode } from "react";

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prow">
      <span className="plabel">{label}</span>
      <div className="chips">{children}</div>
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
            className={on ? "chip is-on" : "chip"}
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

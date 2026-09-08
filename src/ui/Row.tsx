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

/** 一行参数：左边标签，右边一排极简小按钮。 */
export function Row<T>({ label, value, options, onPick }: Props<T>) {
  return (
    <div className="prow">
      <span className="plabel">{label}</span>
      <div className="chips">
        {options.map(o => (
          <button
            key={String(o.value)}
            type="button"
            className={o.value === value ? "chip is-on" : "chip"}
            aria-pressed={o.value === value}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

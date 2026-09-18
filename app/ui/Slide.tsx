import { useEffect, useRef, useState } from "react";
import { Row } from "./OptionRow";

interface Props {
  label: string;
  aria: string;
  min: number;
  max: number;
  value: number;
  format: (v: number) => string;
  onCommit: (v: number) => void;
}

export function Slide({ label, aria, min, max, value, format, onCommit }: Props) {
  const lo = Math.round(Number.isFinite(min) ? min : 0);
  const hi = Math.round(Number.isFinite(max) && max > lo ? max : lo);
  const clamped = Math.min(hi, Math.max(lo, Math.round(Number.isFinite(value) ? value : hi)));
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? clamped;
  const active = drag !== null;
  const elRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<number | null>(null);
  const sentRef = useRef(clamped);
  const boundsRef = useRef({ lo, hi });
  const onCommitRef = useRef(onCommit);
  boundsRef.current = { lo, hi };
  onCommitRef.current = onCommit;

  const flush = (e: { currentTarget: HTMLInputElement }) => {
    const { lo: a, hi: b } = boundsRef.current;
    const next = Math.min(b, Math.max(a, Math.round(Number(e.currentTarget.value))));
    dragRef.current = null;
    setDrag(null);
    if (next === sentRef.current) return;
    sentRef.current = next;
    onCommitRef.current(next);
  };

  useEffect(() => {
    if (dragRef.current === null) sentRef.current = clamped;
  }, [clamped]);

  useEffect(() => {
    if (!active) return;
    const el = elRef.current;
    const finish = (paint: boolean) => {
      const raw = dragRef.current;
      if (raw === null) return;
      const { lo: a, hi: b } = boundsRef.current;
      const next = Math.min(b, Math.max(a, Math.round(Number(el?.value ?? raw))));
      dragRef.current = null;
      if (paint) setDrag(null);
      if (next === sentRef.current) return;
      sentRef.current = next;
      onCommitRef.current(next);
    };
    const onUp = (e: Event) => {
      if (e instanceof PointerEvent) {
        try {
          el?.releasePointerCapture(e.pointerId);
        } catch {}
      }
      finish(true);
    };
    const opts = { capture: true } as const;
    document.addEventListener("pointerup", onUp, opts);
    document.addEventListener("pointercancel", onUp, opts);
    el?.addEventListener("change", onUp);
    return () => {
      document.removeEventListener("pointerup", onUp, opts);
      document.removeEventListener("pointercancel", onUp, opts);
      el?.removeEventListener("change", onUp);
      finish(false);
    };
  }, [active]);

  return (
    <Row label={label}>
      <div className="slide">
        <input
          ref={elRef}
          type="range"
          aria-label={aria}
          aria-valuetext={format(shown)}
          min={lo}
          max={hi}
          step={1}
          disabled={hi <= lo}
          value={shown}
          onPointerDown={e => {
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {}
          }}
          onChange={e => {
            const v = Number(e.currentTarget.value);
            dragRef.current = v;
            setDrag(v);
          }}
          onKeyUp={flush}
          onBlur={flush}
        />
        <span className="tick">{format(shown)}</span>
      </div>
    </Row>
  );
}

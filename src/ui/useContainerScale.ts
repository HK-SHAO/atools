import { useEffect, type RefObject } from "react";

const U_REF = 340;
const U_BASE = 14;
const U_SLOPE = 1 / 280;
const U_CEIL = 16.5;

function unitFor(width: number, height: number): number {
  const eff = Math.min(width, height * 1.6);
  const raw = eff < U_REF ? (U_BASE * eff) / U_REF : U_BASE + (eff - U_REF) * U_SLOPE;
  return Math.min(U_CEIL, raw);
}

export function useContainerScale(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let last = "";
    const apply = (width: number, height: number) => {
      const w = Math.max(1, width);
      const h = Math.max(1, height);
      const key = `${w}x${h}`;
      if (key === last) return;
      last = key;
      el.style.setProperty("--u", `${unitFor(w, h).toFixed(3)}px`);
      el.style.setProperty("--c-vh", `${(h / 100).toFixed(3)}px`);
    };

    const measure = () => apply(el.clientWidth, el.clientHeight);
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}

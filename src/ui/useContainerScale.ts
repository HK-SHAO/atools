import { useEffect, type RefObject } from "react";

const U_MIN = 14;
const U_MAX = 20;

const WIDE_AT = 860;

const CONTENT_MAX = 1180;

function unitFor(width: number, height: number): number {
  const eff = Math.min(width, height * 1.6);
  const raw = 14 + (eff - 340) * 0.0055;
  return Math.max(U_MIN, Math.min(U_MAX, raw));
}

export function useContainerScale(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let last = "";
    const apply = (width: number, height: number) => {
      const wReal = Math.max(1, width);
      const h = Math.max(1, height);
      const w = Math.min(wReal, CONTENT_MAX);
      const key = `${wReal}x${h}`;
      if (key === last) return;
      last = key;
      el.style.setProperty("--u", `${unitFor(w, h).toFixed(3)}px`);
      el.style.setProperty("--c-vw", `${(w / 100).toFixed(3)}px`);
      el.style.setProperty("--c-vh", `${(h / 100).toFixed(3)}px`);
      el.style.setProperty("--c-vmin", `${(Math.min(w, h) / 100).toFixed(3)}px`);
      el.style.setProperty("--c-max", `${CONTENT_MAX}px`);
      if (wReal >= WIDE_AT) el.dataset.wide = "1";
      else delete el.dataset.wide;
    };

    const measure = () => apply(el.clientWidth, el.clientHeight);
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width, box.height);
      else measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}

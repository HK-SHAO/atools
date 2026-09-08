import { useEffect, type RefObject } from "react";

/* Sizes come from the element the app is mounted into, never from the viewport:
   —— mounted inside a host div: the viewport is far larger, everything would blow up
   —— inside an iframe: the container box is the only space actually available
   Everything downstream is a multiple of --u. */

const U_MIN = 14;
const U_MAX = 20;
/** 容器宽到这个份上，参数区就从"一行一组"改成"横向铺开"。 */
const WIDE_AT = 860;

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
      const w = Math.max(1, width);
      const h = Math.max(1, height);
      const key = `${w}x${h}`;
      if (key === last) return;
      last = key;
      el.style.setProperty("--u", `${unitFor(w, h).toFixed(3)}px`);
      el.style.setProperty("--c-vw", `${(w / 100).toFixed(3)}px`);
      el.style.setProperty("--c-vh", `${(h / 100).toFixed(3)}px`);
      el.style.setProperty("--c-vmin", `${(Math.min(w, h) / 100).toFixed(3)}px`);
      // 用 data 属性而不是 class：React 只管自己写的 className，不会把它抹掉。
      if (w >= WIDE_AT) el.dataset.wide = "1";
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

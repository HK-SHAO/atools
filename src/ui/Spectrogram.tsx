import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as stylex from "@stylexjs/stylex";
import { kit } from "./kit";
import type { Raster } from "./raster";

const spec = stylex.create({
  box: {
    position: "relative",
    width: "100%",
    height: "clamp(6.5em, calc(24 * var(--c-vh)), 12em)",
    overflow: "hidden",
    borderRadius: "var(--r-md)",
    backgroundColor: "#1d1710",
    boxShadow: "inset 0 0 0 1px rgba(61, 52, 39, 0.16)",
    cursor: "pointer",
    touchAction: "none",
  },
  canvas: { display: "block", width: "100%", height: "100%" },
  head: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: "0.15em",
    backgroundColor: "#fff",
    mixBlendMode: "difference",
    opacity: 0,
    pointerEvents: "none",
    willChange: "left",
  },
});

interface Props {
  sheet: Raster;
  headRef: RefObject<HTMLDivElement | null>;
  onSeek: (ratio: number) => void;
  onScrub: (ratio: number) => void;
  onCommit: () => void;
  onNudge: (delta: number) => void;
}

export function Spectrogram({ sheet, headRef, onSeek, onScrub, onCommit, onNudge }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const source = useMemo(() => {
    const off = document.createElement("canvas");
    off.width = sheet.width;
    off.height = sheet.height;
    off.getContext("2d")?.putImageData(new ImageData(sheet.data, sheet.width, sheet.height), 0, 0);
    return off;
  }, [sheet]);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!box || !canvas || !ctx) return;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(box.clientWidth * dpr));
      const h = Math.max(1, Math.round(box.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, sheet.width, sheet.height, 0, 0, w, h);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(box);
    return () => observer.disconnect();
  }, [source, sheet]);

  const ratioAt = (clientX: number): number => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  return (
    <div
      ref={boxRef}
      data-el="spec"
      tabIndex={0}
      aria-label="播放进度：点按即播，拖动可擦洗，左右方向键微调"
      {...stylex.props(kit.squircle, kit.focusSm, spec.box)}
      onPointerDown={e => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}
        onSeek(ratioAt(e.clientX));
      }}
      onPointerMove={e => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onScrub(ratioAt(e.clientX));
      }}
      onPointerUp={e => {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {}
        onCommit();
      }}
      onPointerCancel={onCommit}
      onKeyDown={e => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onNudge((e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 0.1 : 0.02));
      }}
    >
      <canvas ref={canvasRef} {...stylex.props(spec.canvas)} />
      <div ref={headRef} data-el="spec-head" {...stylex.props(spec.head)} />
    </div>
  );
}

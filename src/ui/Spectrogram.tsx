import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { Raster } from "./raster";

interface Props {
  sheet: Raster;
  headRef: RefObject<HTMLDivElement | null>;
  /** 按下：跳过去并起播 */
  onSeek: (ratio: number) => void;
  /** 拖动中：只挪竖线 */
  onScrub: (ratio: number) => void;
  /** 松手：跳到竖线所在处 */
  onCommit: () => void;
  onNudge: (delta: number) => void;
}

export function Spectrogram({ sheet, headRef, onSeek, onScrub, onCommit, onNudge }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 离屏画布只由这个 memo 持有，换素材时整块交给 GC。
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
      className="spec"
      tabIndex={0}
      aria-label="播放进度：点按即播，拖动可擦洗，左右方向键微调"
      onPointerDown={e => {
        // 合成事件下可能没有活跃指针，失败也不影响单击跳转。
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* 忽略 */
        }
        onSeek(ratioAt(e.clientX));
      }}
      onPointerMove={e => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onScrub(ratioAt(e.clientX));
      }}
      onPointerUp={e => {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* 忽略 */
        }
        onCommit();
      }}
      onPointerCancel={onCommit}
      onKeyDown={e => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onNudge((e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 0.1 : 0.02));
      }}
    >
      <canvas ref={canvasRef} className="spec-canvas" />
      <div ref={headRef} className="spec-head" />
    </div>
  );
}

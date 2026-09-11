import { useCallback, useEffect, useRef, useState } from "react";
import type { Samples } from "../lib/arrays";
import { audit, type LossRow } from "../lib/audit";
import type { Spectrum } from "../lib/spectrum";
import { scope } from "./pipeline";

export function useAudit(pcm: Samples, spec: Spectrum, png: Blob, name: string) {
  const [loss, setLoss] = useState<LossRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const genRef = useRef(0);
  // 质检一次要还原三遍（原图 / 有损 / 半尺寸），是整页最重的一串计算，同样交给 Worker。
  // 自己的 scope：取消自己这一份，不牵连 `useStudio` 正在跑的编码。
  const io = scope("audit");

  useEffect(() => {
    io.cancel();
    genRef.current++;
    setLoss(null);
  }, [io, spec]);

  const check = useCallback(async () => {
    io.cancel();
    const my = ++genRef.current;
    const alive = () => genRef.current === my;
    setChecking(true);
    try {
      const rows = await audit(pcm, spec, png, name, s => io.synthesise(s, false));
      if (alive()) setLoss(rows);
    } catch (e) {
      console.error(e);
      if (alive()) setLoss(null);
    } finally {
      if (alive()) setChecking(false);
    }
  }, [io, name, pcm, png, spec]);

  return { loss, checking, check };
}

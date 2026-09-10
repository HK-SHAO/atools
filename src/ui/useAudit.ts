import { useCallback, useEffect, useRef, useState } from "react";
import type { Samples } from "../lib/arrays";
import { audit, type LossRow } from "../lib/audit";
import type { Spectrum } from "../lib/spectrum";

export function useAudit(pcm: Samples, spec: Spectrum, png: Blob, name: string) {
  const [loss, setLoss] = useState<LossRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const genRef = useRef(0);

  useEffect(() => {
    genRef.current++;
    setLoss(null);
  }, [spec]);

  const check = useCallback(async () => {
    const my = ++genRef.current;
    const alive = () => genRef.current === my;
    setChecking(true);
    try {
      const rows = await audit(pcm, spec, png, name);
      if (alive()) setLoss(rows);
    } catch (e) {
      console.error(e);
      if (alive()) setLoss(null);
    } finally {
      if (alive()) setChecking(false);
    }
  }, [name, pcm, png, spec]);

  return { loss, checking, check };
}

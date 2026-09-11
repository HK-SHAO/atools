import { useCallback, useRef, useState } from "react";
import type { Samples } from "../lib/arrays";
import type { LossRow } from "../lib/audit";
import type { Spectrum } from "../lib/spectrum";
import { scope } from "./pipeline";

interface Finding {
  spec: Spectrum;
  rows: LossRow[] | null;
}

export function useAudit(pcm: Samples, spec: Spectrum, png: Blob, name: string) {
  const [found, setFound] = useState<Finding | null>(null);
  const [running, setRunning] = useState<Spectrum | null>(null);
  const genRef = useRef(0);
  const io = scope("audit");

  const check = useCallback(async () => {
    io.cancel();
    const my = ++genRef.current;
    const alive = () => genRef.current === my;
    setRunning(spec);
    try {
      const rows = await io.audit(pcm, spec, png, name);
      if (alive()) setFound({ spec, rows });
    } catch (e) {
      console.error(e);
      if (alive()) setFound(null);
    } finally {
      if (alive()) setRunning(null);
    }
  }, [io, name, pcm, png, spec]);

  const loss = found && found.spec === spec ? found.rows : null;

  return {
    loss,
    checking: running === spec,
    check,
  };
}

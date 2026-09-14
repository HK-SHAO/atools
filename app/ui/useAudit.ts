import { useCallback, useEffect, useRef, useState } from "react";
import type { Samples } from "../lib/arrays";
import type { LossRow } from "../lib/audit";
import type { Spectrum } from "../lib/spectrum";
import { Aborted } from "../lib/spectrum";
import { scope } from "./pipeline";

interface Finding {
  spec: Spectrum;
  rows: LossRow[] | null;
}

export function useAudit(
  pcm: Samples,
  spec: Spectrum,
  png: Blob,
  name: string,
  busy: boolean,
  cached?: Samples | null,
) {
  const [found, setFound] = useState<Finding | null>(null);
  const [run, setRun] = useState(0);
  const [progress, setProgress] = useState(0);
  const genRef = useRef(0);
  const io = scope("audit");

  const stop = useCallback(() => {
    genRef.current += 1;
    io.cancel();
  }, [io]);

  const check = useCallback(async () => {
    stop();
    const my = ++genRef.current;
    const alive = () => genRef.current === my;
    setProgress(0);
    setRun(my);
    try {
      const rows = await io.audit(
        pcm,
        spec,
        png,
        name,
        p => {
          if (alive()) setProgress(p);
        },
        cached,
      );
      if (alive()) setFound({ spec, rows });
    } catch (e) {
      if (!(e instanceof Aborted)) {
        console.error(e);
        if (alive()) setFound(null);
      }
    } finally {
      setRun(prev => (prev === my ? 0 : prev));
    }
  }, [cached, io, name, pcm, png, spec, stop]);

  useEffect(() => {
    if (busy) stop();
  }, [busy, stop]);

  useEffect(() => stop, [stop]);

  const loss = found && found.spec === spec ? found.rows : null;

  return {
    loss,
    checking: run !== 0,
    progress,
    check,
  };
}

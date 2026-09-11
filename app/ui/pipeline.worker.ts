import { startKernel } from "../lib/dsp";
import { spectrumToPng } from "../lib/image";
import { compare } from "../lib/metric";
import { resample } from "../lib/resample";
import { Aborted, encode, synthesise } from "../lib/spectrum";
import type { FromWorker, JobRequest, ToWorker } from "./pipeline";

interface Scope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as Scope;

const ready = startKernel({ fft: true });

const cancelled = new Set<number>();

const strip = (buffers: (ArrayBufferLike | undefined)[]): Transferable[] =>
  buffers.filter((buffer): buffer is ArrayBufferLike => buffer !== undefined) as Transferable[];

async function run(request: JobRequest): Promise<void> {
  const { id } = request;
  const alive = (): boolean => !cancelled.has(id);
  const report = (value: number): void => scope.postMessage({ id, kind: "progress", value });

  try {
    await ready;
    if (request.kind === "resample") {
      const pcm = resample(request.pcm, request.from, request.to, request.fmax);
      scope.postMessage({ id, kind: "done", value: pcm }, strip([pcm.buffer]));
      return;
    }
    if (request.kind === "encode") {
      const spec = await encode(request.pcm, request.sr, request.enc, alive, report);
      scope.postMessage(
        { id, kind: "done", value: spec },
        strip([spec.levels.buffer, spec.phaseCos?.buffer, spec.phaseSin?.buffer]),
      );
      return;
    }
    if (request.kind === "synthesise") {
      const pcm = await synthesise(request.spec, alive, report, request.fine ? "fine" : "fast");
      scope.postMessage({ id, kind: "done", value: pcm }, strip([pcm.buffer]));
      return;
    }
    if (request.kind === "compare") {
      scope.postMessage({ id, kind: "done", value: compare(request.ref, request.got) });
      return;
    }
    scope.postMessage({ id, kind: "done", value: await spectrumToPng(request.spec) });
  } catch (error) {
    if (error instanceof Aborted) scope.postMessage({ id, kind: "aborted" });
    else
      scope.postMessage({
        id,
        kind: "error",
        message: error instanceof Error ? error.message : "数值流水线出错",
      });
  } finally {
    cancelled.delete(id);
  }
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const request = event.data;
  if ("ids" in request) {
    for (const id of request.ids) cancelled.add(id);
    return;
  }
  void run(request);
};

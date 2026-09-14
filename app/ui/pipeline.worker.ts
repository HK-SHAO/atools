import { audit } from "../lib/audit";
import { startKernel } from "../lib/dsp";
import { imageToSpectrum, spectrumToPng } from "../lib/image";
import { compare } from "../lib/metric";
import { resample } from "../lib/resample";
import { Aborted, encode, synthesise, type Spectrum } from "../lib/spectrum";
import type { FromWorker, JobRequest, ToWorker } from "./pipeline";

interface WorkerGlobal {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const worker = self as unknown as WorkerGlobal;

const ready = startKernel({ fft: true });

const cancelled = new Set<number>();

const strip = (buffers: (ArrayBufferLike | undefined)[]): Transferable[] =>
  buffers.filter((buffer): buffer is ArrayBufferLike => buffer !== undefined) as Transferable[];

const specBuffers = (spec: Spectrum): Transferable[] =>
  strip([spec.levels.buffer, spec.phaseCos?.buffer, spec.phaseSin?.buffer, spec.phaseW?.buffer]);

async function run(request: JobRequest): Promise<void> {
  const { id } = request;
  const alive = (): boolean => !cancelled.has(id);
  const report = (value: number): void => worker.postMessage({ id, kind: "progress", value });

  try {
    await ready;
    if (request.kind === "resample") {
      const pcm = resample(request.pcm, request.from, request.to, request.fmax);
      worker.postMessage({ id, kind: "done", value: pcm }, strip([pcm.buffer]));
      return;
    }
    if (request.kind === "encode") {
      const spec = await encode(request.pcm, request.sr, request.enc, alive, report);
      worker.postMessage(
        { id, kind: "done", value: spec },
        strip([spec.levels.buffer, spec.phaseCos?.buffer, spec.phaseSin?.buffer]),
      );
      return;
    }
    if (request.kind === "synthesise") {
      const pcm = await synthesise(request.spec, alive, report, request.fine ? "fine" : "fast");
      worker.postMessage({ id, kind: "done", value: pcm }, strip([pcm.buffer]));
      return;
    }
    if (request.kind === "compare") {
      worker.postMessage({ id, kind: "done", value: compare(request.ref, request.got) });
      return;
    }
    if (request.kind === "readImage") {
      const decoded = await imageToSpectrum(request.file, request.name);
      worker.postMessage({ id, kind: "done", value: decoded }, specBuffers(decoded.spec));
      return;
    }
    if (request.kind === "audit") {
      const rows = await audit(
        request.ref,
        request.spec,
        request.png,
        request.name,
        alive,
        report,
        request.cached,
      );
      worker.postMessage({ id, kind: "done", value: rows });
      return;
    }
    worker.postMessage({ id, kind: "done", value: await spectrumToPng(request.spec) });
  } catch (error) {
    if (error instanceof Aborted) worker.postMessage({ id, kind: "aborted" });
    else
      worker.postMessage({
        id,
        kind: "error",
        message: error instanceof Error ? error.message : "数值流水线出错",
      });
  } finally {
    cancelled.delete(id);
  }
}

worker.onmessage = (event: MessageEvent<ToWorker>) => {
  const request = event.data;
  if ("ids" in request) {
    for (const id of request.ids) cancelled.add(id);
    return;
  }
  void run(request);
};

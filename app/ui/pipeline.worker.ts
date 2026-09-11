import { spectrumToPng } from "../lib/image";
import { resample } from "../lib/resample";
import { Aborted, encode, synthesise } from "../lib/spectrum";
import type { FromWorker, JobRequest, ToWorker } from "./pipeline";

/**
 * 数值流水线的工作线程。只做纯计算，不碰 DOM —— 所以它能在任何支持 Worker 的浏览器里跑，
 * 也**不依赖 OffscreenCanvas**（读图与可逆档出图要 canvas，解码要 `AudioContext`，那三件事
 * 留在主线程）。
 *
 * 取消是消息式的：`alive` 每 12 ms 被流水线问一次，而流水线每 12 ms 也让出一次事件循环，
 * 于是主线程发的取消消息一定来得及在某一轮让出时被读到。已经算完的活不受影响。
 */

interface Scope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as Scope;

const cancelled = new Set<number>();

const strip = (buffers: (ArrayBufferLike | undefined)[]): Transferable[] =>
  buffers.filter((buffer): buffer is ArrayBufferLike => buffer !== undefined) as Transferable[];

async function run(request: JobRequest): Promise<void> {
  const { id } = request;
  const alive = (): boolean => !cancelled.has(id);
  const report = (value: number): void => scope.postMessage({ id, kind: "progress", value });

  try {
    if (request.kind === "resample") {
      // 相位表缓存（最坏 4 MB）跟着住到这里：主线程一次都不再为它停。
      const pcm = resample(request.pcm, request.from, request.to, request.fmax);
      scope.postMessage({ id, kind: "done", value: pcm }, strip([pcm.buffer]));
      return;
    }
    if (request.kind === "encode") {
      const spec = await encode(request.pcm, request.sr, request.enc, alive, report);
      // 结果是新建的，直接交出去，不必复制。
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
    // 尺寸可能很大，但 PNG 的字节都在这个 Blob 里，复制它比重算便宜。
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

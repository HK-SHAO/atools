import { startKernel, wasmUrl } from "../lib/dsp";
import { spectrumToPng } from "../lib/image";
import { compare } from "../lib/metric";
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
 *
 * **内核是这个 worker 的启动前置条件，不是可选项**：核心数值逻辑只有 `moon/` 那一份，
 * 没有参照实现可退。所以 `ready` 只做「加载 + 挂上 + 预热」，**失败就让它失败** ——
 * 每件活会带着那条错误回到主线程，而不是悄悄换一条谁都没在维护的路去算。
 *
 * 加载与预热都放在这里、放在收到第一条消息之前：编译 wasm、建表组、`memory.grow`
 * 这三件事都只发生一次，且都不占用户等待出图的那段时间。
 *
 * `fft: true`：这个 worker 的每一件活（编码、还原、重采样、指标）都要跑 FFT，
 * 所以产品那三档窗长的表组在这里一次建好。主线程那一份不建，见 `app/frontend.tsx`。
 */

interface Scope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as Scope;

// 内核落在应用根的 `wasm/dsp.wasm`；产物里 worker 在 `assets/`、源码里在 `app/ui/`，
// 都是向上**一级**。dev 与 build 因此各自解析成不同路径，由 `scripts/moon.ts` 的中间件兜住。
const ready = startKernel(wasmUrl(new URL("..", import.meta.url).href), { fft: true });

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
    if (request.kind === "compare") {
      // 指标也是跨线程纯计算，而且 `align` 是这里最重的一段（±span 个时延各扫一遍全长信号）。
      scope.postMessage({ id, kind: "done", value: compare(request.ref, request.got) });
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

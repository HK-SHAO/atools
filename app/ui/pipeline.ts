import type { Samples } from "../lib/arrays";
import type { Metrics } from "../lib/metric";
import type { Encode } from "../lib/params";
import { Aborted, type Spectrum } from "../lib/spectrum";

/** 质检要的三个数。口径在 `app/lib/metric.ts`，与 `bun run quality` 是同一份。 */
export type { Metrics };

/**
 * 数值流水线的主线程代理。
 *
 * 重采样、编码、还原、出图、**质检指标**原先都在主线程上跑：编码与还原各自**已经**每 12 ms
 * 让一次出（`yieldToUi`），所以界面不是死的，但每次让出前都实打实占了 12 ms —— 60 fps 的
 * 预算是 16.7 ms，等于把渲染整段挤掉；重采样更是几十毫秒一口气算完，中间一次都不让。
 * 质检的 `align` 更狠：它在 `±span` 个时延上各扫一遍全长信号（`span` 到 2048，也就是
 * 四千多倍素材长度），一次调用就把主线程按在地上。搬进 Worker 之后主线程一帧都不再让。
 *
 * 走这条路的都是**纯函数**（`app/lib/` 无 DOM 依赖），搬过去不用改一行算法。有 DOM 的部分
 * （读图要 canvas、可逆档出 PNG 要 `toBlob`、解码要 `AudioContext`）留在主线程，见 `useStudio`。
 *
 * 分工用 `scope`：每个用得着流水线的地方各拿一个。取消只作废自己这一份 —— 「谁新谁赢」是对的，
 * 但那是**同一个 scope 内**的规矩；拿一个全局取消去管两个互不相干的调用方，
 * 迟早会出现「质检把正在跑的编码掐掉」这种没人写过的耦合。
 */

/** 一件活。都是纯计算，跨线程只需要数据，不需要能力。 */
export type Job =
  | { kind: "resample"; pcm: Samples; from: number; to: number; fmax: number }
  | { kind: "encode"; pcm: Samples; sr: number; enc: Encode }
  | { kind: "synthesise"; spec: Spectrum; fine: boolean }
  | { kind: "png"; spec: Spectrum }
  | { kind: "compare"; ref: Samples; got: Samples };

export type JobRequest = { id: number } & Job;

export type ToWorker = JobRequest | { kind: "cancel"; ids: number[] };

export type FromWorker =
  | { id: number; kind: "progress"; value: number }
  | { id: number; kind: "done"; value: Spectrum | Samples | Blob | Metrics }
  | { id: number; kind: "error"; message: string }
  | { id: number; kind: "aborted" };

export interface Scope {
  resample(pcm: Samples, from: number, to: number, fmax: number): Promise<Samples>;
  encode(
    pcm: Samples,
    sr: number,
    enc: Encode,
    onProgress?: (value: number) => void,
  ): Promise<Spectrum>;
  synthesise(spec: Spectrum, fine: boolean, onProgress?: (value: number) => void): Promise<Samples>;
  png(spec: Spectrum): Promise<Blob>;
  /** 一段还原音与它的参照相比掉了多少。`align` 是主线程最不该碰的那种循环。 */
  compare(ref: Samples, got: Samples): Promise<Metrics>;
  /** 作废这个 scope 里所有在算的活：新一代开始，旧的当场作废。 */
  cancel(): void;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: unknown) => void;
  progress?: (value: number) => void;
  scope: string;
}

interface Wire {
  worker: Worker;
  nextId: number;
  pending: Map<number, Pending>;
}

let wire: Wire | null = null;
const scopes = new Map<string, Scope>();

function connect(): Wire {
  if (wire) return wire;
  const worker = new Worker(new URL("./pipeline.worker.ts", import.meta.url), { type: "module" });
  const live: Wire = { worker, nextId: 1, pending: new Map() };

  const fail = (reason: string): void => {
    for (const job of live.pending.values()) job.reject(new Error(reason));
    live.pending.clear();
  };

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    const job = live.pending.get(message.id);
    if (!job) return;
    if (message.kind === "progress") {
      job.progress?.(message.value);
      return;
    }
    live.pending.delete(message.id);
    if (message.kind === "aborted") job.reject(new Aborted());
    else if (message.kind === "error") job.reject(new Error(message.message));
    else job.resolve(message.value as never);
  };
  // Worker 整个挂掉（脚本没加载上 / 被 CSP 挡住 / 未捕获异常）时不能让 await 永远挂着。
  worker.onerror = () => fail("数值内核没能启动");
  worker.onmessageerror = () => fail("数值内核的消息解析失败");

  // 改这个文件会让 Vite 换掉模块，旧 Worker 得跟着收掉，不然 dev 里每改一次就多留一个。
  import.meta.hot?.dispose(() => {
    worker.terminate();
    wire = null;
    scopes.clear();
  });

  wire = live;
  return live;
}

/**
 * 取一个分工。同名复用，所以调用方不必操心生命周期 —— 直接 `scope("studio")` 即可。
 *
 * 取消走消息，**必须等 Worker 让出**才生效；流水线本来每 12 ms 让一次，这正是它来得及
 * 看消息的原因。已经算完的活不受影响（`pending` 里已经没有它了）。
 */
export function scope(name: string): Scope {
  const cached = scopes.get(name);
  if (cached) return cached;

  const send = <T>(job: Job, progress?: (value: number) => void): Promise<T> => {
    const live = connect();
    const id = live.nextId++;
    return new Promise<T>((resolve, reject) => {
      live.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        progress,
        scope: name,
      });
      // 一律结构化克隆，不转移所有权：这些数组主线程随后还要用（`source.pcm`、`job.spec`、
      // `ref`），转移会把它们就地废掉。多一次拷贝换不动的语义，`resample` 那次实测约 3 ms。
      live.worker.postMessage({ id, ...job });
    });
  };

  const made: Scope = {
    resample: (pcm, from, to, fmax) => send<Samples>({ kind: "resample", pcm, from, to, fmax }),
    encode: (pcm, sr, enc, onProgress) =>
      send<Spectrum>({ kind: "encode", pcm, sr, enc }, onProgress),
    synthesise: (spec, fine, onProgress) =>
      send<Samples>({ kind: "synthesise", spec, fine }, onProgress),
    png: spec => send<Blob>({ kind: "png", spec }),
    compare: (ref, got) => send<Metrics>({ kind: "compare", ref, got }),
    cancel: () => {
      const live = wire;
      if (!live) return;
      const ids: number[] = [];
      for (const [id, job] of live.pending) if (job.scope === name) ids.push(id);
      if (ids.length) live.worker.postMessage({ kind: "cancel", ids });
    },
  };
  scopes.set(name, made);
  return made;
}

// 模块一被引入就把 Worker 建起来，而不是等第一次 `send`。
//
// 它启动时要编 wasm（39 KB）、建三档窗长的表组、做掉必然的那一次内存增长 —— 三件事都只
// 发生一次，而它们没有一件该落在用户第一次点「生成」的那一刻。这样做还有一层：**主线程那一份
// 内核与这一份是并行加载的**（`app/frontend.tsx`），谁先要谁不等谁。
//
// 只有应用壳会引这个模块（评测台走 `bench/entry.ts`，自己挂内核），所以不会白起线程。
void connect();

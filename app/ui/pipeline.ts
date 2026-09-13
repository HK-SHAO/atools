import type { Samples } from "../lib/arrays";
import type { LossRow } from "../lib/audit";
import type { Decoded } from "../lib/image";
import type { Metrics } from "../lib/metric";
import type { Encode } from "../lib/params";
import { Aborted, type Spectrum } from "../lib/spectrum";

export type { Metrics };

export type Job =
  | { kind: "resample"; pcm: Samples; from: number; to: number; fmax: number }
  | { kind: "encode"; pcm: Samples; sr: number; enc: Encode }
  | { kind: "synthesise"; spec: Spectrum; fine: boolean }
  | { kind: "png"; spec: Spectrum }
  | { kind: "compare"; ref: Samples; got: Samples }
  | { kind: "readImage"; file: Blob; name: string }
  | { kind: "audit"; ref: Samples; spec: Spectrum; png: Blob; name: string };

export type JobRequest = { id: number } & Job;

export type ToWorker = JobRequest | { kind: "cancel"; ids: number[] };

export type FromWorker =
  | { id: number; kind: "progress"; value: number }
  | { id: number; kind: "done"; value: Spectrum | Samples | Blob | Metrics | Decoded | LossRow[] }
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
  compare(ref: Samples, got: Samples): Promise<Metrics>;
  readImage(file: Blob, name: string): Promise<Decoded>;
  audit(ref: Samples, spec: Spectrum, png: Blob, name: string): Promise<LossRow[]>;
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
  const worker = new Worker("./pipeline.worker.js", { type: "module" });
  const live: Wire = { worker, nextId: 1, pending: new Map() };

  const fail = (reason: string): void => {
    for (const job of live.pending.values()) job.reject(new Error(reason));
    live.pending.clear();
    worker.terminate();
    if (wire === live) wire = null;
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
  worker.onerror = () => fail("数值内核没能启动");
  worker.onmessageerror = () => fail("数值内核的消息解析失败");

  import.meta.hot.dispose(() => {
    worker.terminate();
    wire = null;
    scopes.clear();
  });

  wire = live;
  return live;
}

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
      try {
        live.worker.postMessage({ id, ...job });
      } catch (error) {
        live.pending.delete(id);
        reject(error);
      }
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
    readImage: (file, fileName) => send<Decoded>({ kind: "readImage", file, name: fileName }),
    audit: (ref, spec, png, fileName) =>
      send<LossRow[]>({ kind: "audit", ref, spec, png, name: fileName }),
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

void connect();

import kernelWasm from "../../moon/_build/wasm/release/build/dsp.wasm";
import { FINENESS } from "./params.ts";

const kernelUrl = (): string => new URL(kernelWasm, import.meta.url).href;

interface Kernel {
  memory: WebAssembly.Memory;
  dsp_abi(): number;

  dsp_probe_stamp(handle: number): number;
  dsp_probe_check(handle: number, wantD: number, wantB: number): number;
  dsp_probe_want(which: number): number;

  dsp_plan(win: number): number;
  dsp_plan_rev(plan: number): number;
  dsp_plan_cos(plan: number): number;
  dsp_plan_sin(plan: number): number;
  dsp_plan_hann(plan: number): number;

  dsp_slot_open(win: number): number;
  dsp_slot_close(slot: number): void;
  dsp_slot_mem(slot: number): number;
  dsp_slot_words(slot: number): number;
  dsp_fft(slot: number): void;
  dsp_real_ifft(slot: number, bins: number): number;

  dsp_pair_off(slot: number, which: number): number;
  dsp_pair_half(slot: number): number;
  dsp_pair_size(slot: number): number;

  dsp_job_open(words: number, bytes: number): number;
  dsp_job_close(handle: number): void;
  dsp_job_d(handle: number): number;
  dsp_job_b(handle: number): number;
  dsp_job_words(handle: number): number;
  dsp_job_bytes(handle: number): number;
  dsp_job_live(): number;

  dsp_rtisi_open(
    frames: number,
    bins: number,
    win: number,
    hop: number,
    samples: number,
    iters: number,
    hasWarm: number,
    hasBand: number,
    budget: number,
  ): number;
  dsp_rtisi_off(handle: number, which: number): number;
  dsp_rtisi_levels(handle: number, which: number): number;
  dsp_rtisi_run(handle: number, from: number, to: number): number;
  dsp_rtisi_finish(handle: number): void;
  dsp_rtisi_close(handle: number): void;

  dsp_pghi_open(
    frames: number,
    bins: number,
    win: number,
    hop: number,
    gamma: number,
    tolHi: number,
    tolLo: number,
  ): number;
  dsp_pghi_off(handle: number, which: number): number;
  dsp_pghi_close(handle: number): void;
  dsp_pghi_run(handle: number): number;

  dsp_stub_rows(): number;
  dsp_stub_sr(index: number): number;
  dsp_stub_win(index: number): number;
  dsp_stub_paint_bytes(w: number): number;
  dsp_stub_luma_bytes(w: number): number;
  dsp_stub_decode_words(n: number): number;
  dsp_stub_fits(w: number): number;
  dsp_stub_paint(handle: number, w: number, sr: number, win: number, exact: number): number;
  dsp_stub_luma(handle: number, w: number, sr: number, win: number, exact: number): number;
  dsp_stub_decode(handle: number, n: number): number;
}

export const ABI = 7;

const PROBE = 8;

const HOST_D = 7000;
const HOST_B = 40;

export interface Dsp {
  readonly kernel: Kernel;
  f64(ptr: number, len: number): Float64Array;
  i32(ptr: number, len: number): Int32Array;
  u8(ptr: number, len: number): Uint8Array;
}

export interface KernelHost {
  attach(dsp: Dsp | null): void;
  must(): Dsp;
  start(
    use: { fft: boolean },
    source?: string | ArrayBuffer | Uint8Array,
  ): Promise<Dsp>;
  ready(): Promise<void>;
}

interface KernelState {
  attached: Dsp | null;
  started: Promise<Dsp> | null;
}

const newKernelState = (): KernelState => ({ attached: null, started: null });

const attach = (state: KernelState, dsp: Dsp | null): void => {
  state.attached = dsp;
};

const must = (state: KernelState): Dsp => {
  if (!state.attached)
    throw new Error(
      "数值内核还没挂上：这一侧的入口要先 startKernel（线上只有 worker 那一侧挂，见 app/lib/dsp.ts）",
    );
  return state.attached;
};

const start = (
  state: KernelState,
  use: { fft: boolean },
  source: string | ArrayBuffer | Uint8Array = kernelUrl(),
): Promise<Dsp> => {
  if (state.started) return state.started;
  const pending = loadDsp(source).then(dsp => {
    const warmed = prewarm(dsp, use.fft);
    attach(state, warmed);
    return warmed;
  });
  state.started = pending;
  void pending.catch(() => {
    if (state.started === pending) state.started = null;
  });
  return pending;
};

const ready = async (state: KernelState): Promise<void> => {
  if (state.started) await state.started;
};

export const createKernelHost = (): KernelHost => {
  const state = newKernelState();
  return {
    attach: dsp => attach(state, dsp),
    must: () => must(state),
    start: (use, source) => start(state, use, source),
    ready: () => ready(state),
  };
};

const kernel = newKernelState();

export const attachKernel = (dsp: Dsp | null): void => {
  attach(kernel, dsp);
};

export const mustKernel = (): Dsp => must(kernel);

export const startKernel = (
  use: { fft: boolean },
  source: string | ArrayBuffer | Uint8Array = kernelUrl(),
): Promise<Dsp> => start(kernel, use, source);

export const kernelReady = (): Promise<void> => ready(kernel);

const toBuffer = async (source: string | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> => {
  if (typeof source === "string")
    return (await fetch(source, { credentials: "same-origin" })).arrayBuffer();
  if (source instanceof ArrayBuffer) return source;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
};

export async function loadDsp(source: string | ArrayBuffer | Uint8Array): Promise<Dsp> {
  const bytes = await toBuffer(source);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const k = instance.exports as unknown as Kernel;

  if (k.dsp_abi() !== ABI) throw new Error(`内核 ABI 不匹配：产物 ${k.dsp_abi()}，加载器 ${ABI}`);

  const h = k.dsp_job_open(PROBE, PROBE);
  if (h === 0) throw new Error("内核引导失败：开不出一段探测作业");
  try {
    const wantD = k.dsp_probe_want(0);
    const wantB = k.dsp_probe_want(1);
    if (k.dsp_probe_stamp(h) !== 1) throw new Error("内核引导失败：写不出探测花纹");
    const d = new Float64Array(k.memory.buffer, k.dsp_job_d(h), PROBE);
    const b = new Uint8Array(k.memory.buffer, k.dsp_job_b(h), PROBE);
    for (let i = 0; i < PROBE; i++) {
      if (d[i] !== wantD + i || b[i] !== wantB + i)
        throw new Error(
          `内核地址约定对不上：d[${i}] = ${d[i]} / b[${i}] = ${b[i]}，期望 ${wantD + i} / ${wantB + i}`,
        );
    }
    for (let i = 0; i < PROBE; i++) {
      d[i] = HOST_D + i;
      b[i] = HOST_B + i;
    }
    if (k.dsp_probe_check(h, HOST_D, HOST_B) !== 1)
      throw new Error("内核地址约定对不上：宿主写下去的值内核读不回来");
  } finally {
    k.dsp_job_close(h);
  }

  const buffer = (): ArrayBuffer => k.memory.buffer;
  return {
    kernel: k,
    f64: (ptr, len) => new Float64Array(buffer(), ptr, len),
    i32: (ptr, len) => new Int32Array(buffer(), ptr, len),
    u8: (ptr, len) => new Uint8Array(buffer(), ptr, len),
  };
}

export interface Plan {
  readonly win: number;
  rev(): Int32Array;
  cos(): Float64Array;
  sin(): Float64Array;
  hann(): Float64Array;
}

export const planOf = (dsp: Dsp, win: number): Plan => {
  const { kernel: k } = dsp;
  const index = k.dsp_plan(win);
  if (index < 0) throw new Error(`内核不接受窗长 ${win}`);
  return {
    win,
    rev: () => dsp.i32(k.dsp_plan_rev(index), win),
    cos: () => dsp.f64(k.dsp_plan_cos(index), win / 2),
    sin: () => dsp.f64(k.dsp_plan_sin(index), win / 2),
    hann: () => dsp.f64(k.dsp_plan_hann(index), win),
  };
};

export interface Slot {
  readonly id: number;
  readonly win: number;
  mem(): Float64Array;
  table(which: number): Float64Array;
  close(): void;
}

export const openSlot = (dsp: Dsp, win: number): Slot => {
  const k = dsp.kernel;
  const id = k.dsp_slot_open(win);
  if (id === -1) throw new Error(`内核不接受窗长 ${win}`);
  if (id < 0) throw new Error("内核会话槽已满：拿到槽就必须还（见 moon/session.mbt）");
  let open = true;
  return {
    id,
    win,
    mem: () => dsp.f64(k.dsp_slot_mem(id), k.dsp_slot_words(id)),
    table: (which) => {
      const off = k.dsp_pair_off(id, which);
      if (off < 0) throw new Error(`槽 ${id} 没有第 ${which} 张配对表`);
      const len = which >= 4 ? k.dsp_pair_size(id) : k.dsp_pair_half(id);
      return dsp.f64(k.dsp_slot_mem(id) + off * 8, len);
    },
    close: () => {
      if (open) {
        open = false;
        k.dsp_slot_close(id);
      }
    },
  };
};

export const fftBuffers = (slot: Slot): { re: Float64Array; im: Float64Array } => {
  const m = slot.mem();
  return { re: m.subarray(0, slot.win), im: m.subarray(slot.win, 2 * slot.win) };
};

export const realIfft = (dsp: Dsp, slot: Slot, bins: number): void => {
  if (dsp.kernel.dsp_real_ifft(slot.id, bins) !== 1)
    throw new Error(`内核拒绝了实反变换：槽 ${slot.id}、${bins} 行`);
};

export interface Job {
  readonly handle: number;
  d(): Float64Array;
  b(): Uint8Array;
  close(): void;
}

export const jobSlice = (dsp: Dsp, handle: number, off: number, len: number): Float64Array =>
  dsp.f64(dsp.kernel.dsp_job_d(handle) + off * 8, len);

export const jobBytes = (dsp: Dsp, handle: number, off: number, len: number): Uint8Array =>
  dsp.u8(dsp.kernel.dsp_job_b(handle) + off, len);

export const openJob = (dsp: Dsp, words: number, bytes: number): Job => {
  const k = dsp.kernel;
  const handle = k.dsp_job_open(words, bytes);
  if (handle === 0) throw new Error(`开不出作业区：${words} 个元素 + ${bytes} 字节`);
  return {
    handle,
    d: () => dsp.f64(k.dsp_job_d(handle), k.dsp_job_words(handle)),
    b: () => dsp.u8(k.dsp_job_b(handle), k.dsp_job_bytes(handle)),
    close: () => k.dsp_job_close(handle),
  };
};

const FFT_WINS: readonly number[] = FINENESS.map(f => f.win);

const prewarm = (dsp: Dsp, fft: boolean): Dsp => {
  if (fft) for (const win of FFT_WINS) planOf(dsp, win);
  openJob(dsp, 0, 0).close();
  return dsp;
};

export const warmKernel = (dsp: Dsp): Dsp => {
  const warmed = prewarm(dsp, true);
  attachKernel(warmed);
  return warmed;
};

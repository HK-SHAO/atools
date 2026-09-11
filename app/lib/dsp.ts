/**
 * MoonBit 数值内核（`moon/`）的加载与访存层。
 *
 * 契约一句话：**工作区按会话槽静态定型，地址在会话期内不变**。导出地址是
 * 「FixedArray 数据区首地址」这条非文档化 ABI（见 `moon/ffi.mbt`），而槽的容量是编译期常量
 * （见 `moon/session.mbt`），所以宿主切出的 typed view 不会因 `memory.grow` 而 detach ——
 * 并发跑几件活也不会互相把视图顶掉。这条约定由 `moon/engine.mbt` 的白盒测试与
 * `app/lib/dsp.test.ts` 的往返验证共守。
 *
 * 用法：`attachKernel(await loadDsp(url))` 一次，之后 `kernel()` 就能拿到。
 * 没挂上内核（或槽位池满）时调用方退回 TS 参照实现 —— 降级，不是崩。
 */

/** 内核导出面。与 `moon/*.mbt` 里的 `#export_name` 一一对应，改一处必须改两处。 */
interface Kernel {
  memory: WebAssembly.Memory;
  dsp_abi(): number;
  dsp_canary_ptr(): number;
  dsp_canary_len(): number;
  dsp_canary_set(index: number, value: number): void;
  dsp_canary_get(index: number): number;
  dsp_plan(win: number): number;
  dsp_plan_rev_ptr(plan: number): number;
  dsp_plan_cos_ptr(plan: number): number;
  dsp_plan_sin_ptr(plan: number): number;
  dsp_plan_hann_ptr(plan: number): number;
  dsp_slot_open(win: number): number;
  dsp_slot_close(slot: number): void;
  dsp_slot_ptr(slot: number): number;
  dsp_fft(slot: number): void;
  dsp_ifft(slot: number): void;
  dsp_pair_r1_ptr(slot: number): number;
  dsp_pair_i1_ptr(slot: number): number;
  dsp_pair_r2_ptr(slot: number): number;
  dsp_pair_i2_ptr(slot: number): number;
  dsp_pair_x1_ptr(slot: number): number;
  dsp_pair_x2_ptr(slot: number): number;
  dsp_pair_forward(slot: number): void;
  dsp_pair_inverse(slot: number): void;
}

/** 加载器与内核约定的 ABI 版本。错配时症状是「算出来的数不对」，所以这里直接拒绝。 */
export const ABI = 2;

/** 内核在产物里的落点。与 `scripts/moon.ts` 的 `WASM_FILE` 同名，由 `dsp.test.ts` 盯住。 */
const FILE = "wasm/dsp.wasm";

export interface Dsp {
  readonly kernel: Kernel;
  /** 在 wasm 线性内存上切一段视图。 */
  i32(ptr: number, len: number): Int32Array;
  f32(ptr: number, len: number): Float32Array;
  f64(ptr: number, len: number): Float64Array;
  u8(ptr: number, len: number): Uint8Array;
}

/** 相对应用根解析 —— 页面在子路径下（B站 Toy 的 `/toy/<slug>/`）也成立。 */
export const wasmUrl = (base: string): string => new URL(FILE, base).href;

let attached: Dsp | null = null;

/** 挂上（或摘掉）数值内核。`null` 只给测试用：对照 TS 参照实现跑同一批用例。 */
export const attachKernel = (dsp: Dsp | null): void => {
  attached = dsp;
};

/** 当前挂着的内核，没有就是 `null`。 */
export const kernel = (): Dsp | null => attached;

const toBuffer = async (source: string | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> => {
  if (typeof source === "string")
    return (await fetch(source, { credentials: "same-origin" })).arrayBuffer();
  if (source instanceof ArrayBuffer) return source;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
};

export async function loadDsp(source: string | ArrayBuffer | Uint8Array): Promise<Dsp> {
  // 统一收成一个**纯 ArrayBuffer**：加载器同时被浏览器（fetch 出来的 ArrayBuffer）
  // 与测试（Node 的 Buffer，其 buffer 是 ArrayBufferLike）使用，让 Node 的类型漏进浏览器模块
  // 不划算。多一次 KB 级拷贝，只在启动时发生一次。
  const bytes = await toBuffer(source);
  // 零 import：内核不向宿主索取任何东西（见 moon/moon.pkg）
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const kernel = instance.exports as unknown as Kernel;

  if (kernel.dsp_abi() !== ABI) throw new Error(`内核 ABI 不匹配：产物 ${kernel.dsp_abi()}，加载器 ${ABI}`);

  // 引导期握手：宿主写的值内核读得到、内核写的值宿主读得到。地址约定错位在这里就会响，
  // 而不是等到某个数值调用给出「看起来合理但不对」的结果。
  for (let i = 0; i < kernel.dsp_canary_len(); i++) kernel.dsp_canary_set(i, 0x5a5a + i);
  const canary = new Int32Array(kernel.memory.buffer, kernel.dsp_canary_ptr(), kernel.dsp_canary_len());
  for (let i = 0; i < canary.length; i++)
    if (canary[i] !== 0x5a5a + i) throw new Error(`内核地址约定对不上：canary[${i}] = ${canary[i]}`);

  const buffer = (): ArrayBuffer => kernel.memory.buffer;
  return {
    kernel,
    i32: (ptr, len) => new Int32Array(buffer(), ptr, len),
    f32: (ptr, len) => new Float32Array(buffer(), ptr, len),
    f64: (ptr, len) => new Float64Array(buffer(), ptr, len),
    u8: (ptr, len) => new Uint8Array(buffer(), ptr, len),
  };
}

/**
 * 一次 FFT 计划。三张表只依赖窗长、建成即只读，所以**按窗长缓存**在核心里
 * （见 `moon/plan.mbt`），可以同时持有多个 —— 宿主并发跑两件活不会互相顶掉。
 */
export interface Plan {
  readonly win: number;
  readonly rev: Int32Array;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  readonly hann: Float64Array;
}

export const planOf = (dsp: Dsp, win: number): Plan => {
  const { kernel: k } = dsp;
  const index = k.dsp_plan(win);
  if (index < 0) throw new Error(`内核不接受窗长 ${win}`);
  return {
    win,
    rev: dsp.i32(k.dsp_plan_rev_ptr(index), win),
    cos: dsp.f64(k.dsp_plan_cos_ptr(index), win / 2),
    sin: dsp.f64(k.dsp_plan_sin_ptr(index), win / 2),
    hann: dsp.f64(k.dsp_plan_hann_ptr(index), win),
  };
};

/** 内核里的一次会话：一份工作区 + 它绑定的表组。 */
export interface Slot {
  readonly id: number;
  readonly win: number;
  close(): void;
}

/**
 * 占一个会话槽。窗长不合法直接抛（那是编程错误）；**池满返回 `null`** —— 由调用方退回
 * 参照实现。内核里只有 6 个槽（`moon/session.mbt` 的 `max_slots`），拿到就必须还。
 */
export const openSlot = (dsp: Dsp, win: number): Slot | null => {
  const id = dsp.kernel.dsp_slot_open(win);
  if (id === -1) throw new Error(`内核不接受窗长 ${win}`);
  if (id < 0) return null;
  let open = true;
  return {
    id,
    win,
    close: () => {
      if (open) {
        open = false;
        dsp.kernel.dsp_slot_close(id);
      }
    },
  };
};

/** 单条复变换的工作区：`re` 在槽首、`im` 紧随其后（与 `moon/fft.mbt` 同一份布局）。 */
export const fftBuffers = (dsp: Dsp, slot: Slot): { re: Float64Array; im: Float64Array } => {
  const base = dsp.kernel.dsp_slot_ptr(slot.id);
  return {
    re: dsp.f64(base, slot.win),
    im: dsp.f64(base + slot.win * 8, slot.win),
  };
};

/** 配对双实变换的六张表。**偏移一律问内核要**，宿主不自己算布局。 */
export interface PairTables {
  r1: Float64Array;
  i1: Float64Array;
  r2: Float64Array;
  i2: Float64Array;
  x1: Float64Array;
  x2: Float64Array;
}

export const pairTables = (dsp: Dsp, slot: Slot): PairTables => {
  const { kernel: k } = dsp;
  const { id, win } = slot;
  const half = win / 2 + 1;
  return {
    r1: dsp.f64(k.dsp_pair_r1_ptr(id), half),
    i1: dsp.f64(k.dsp_pair_i1_ptr(id), half),
    r2: dsp.f64(k.dsp_pair_r2_ptr(id), half),
    i2: dsp.f64(k.dsp_pair_i2_ptr(id), half),
    x1: dsp.f64(k.dsp_pair_x1_ptr(id), win),
    x2: dsp.f64(k.dsp_pair_x2_ptr(id), win),
  };
};

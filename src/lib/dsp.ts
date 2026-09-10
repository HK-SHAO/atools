/**
 * MoonBit 数值内核（`moon/`）的加载与访存层。
 *
 * 契约一句话：**先让内核把所有缓冲配齐，再取指针，再计算**。
 * 导出地址是「FixedArray 数据区首地址」这条非文档化 ABI（见 `moon/ffi.mbt`），
 * 而 `memory.grow` 会让先前切出来的视图全部 detach，所以视图一律**每个 job 重切**，
 * 不跨 job 缓存。这条约定由 `moon/engine.mbt` 的白盒测试与 `src/lib/dsp.test.ts` 的往返验证共守。
 */

/** 内核导出面。与 `moon/*.mbt` 里的 `#export_name` 一一对应，改一处必须改两处。 */
interface Kernel {
  memory: WebAssembly.Memory;
  dsp_abi(): number;
  dsp_canary_ptr(): number;
  dsp_canary_len(): number;
  dsp_canary_set(index: number, value: number): void;
  dsp_canary_get(index: number): number;
}

/** 加载器与内核约定的 ABI 版本。错配时症状是「算出来的数不对」，所以这里直接拒绝。 */
export const ABI = 1;

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

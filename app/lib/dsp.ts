/**
 * MoonBit 数值内核（`moon/`）的加载与访存层。
 *
 * **边界只有一条约定**：导出函数返回 `FixedArray` 时，宿主收到的那个整数就是它的
 * 数据区首址，据此切 typed view。这条不是标准库的文档化行为（内核不向宿主交裸指针时
 * 也没有别的零拷贝路子 —— 把 `Float64Array` 传进导出函数会被当成裸 i32 直接越界），
 * 所以 `loadDsp` 引导期用 `dsp_probe_*` 走一次**双向**握手：内核写、宿主两把视图读回；
 * 宿主写、内核读回。工具链哪天改了布局，这里先响，而不是等某个数值调用给出
 * 「看起来合理但不对」的结果。依据与推演见 `moon/engine.mbt`。
 *
 * **视图只现切，不持有。** `memory.grow` 会把先前切出的**全部**视图 detach（实测
 * 20 页 → 2260 页之后旧视图 `byteLength` 变 0），而 `dsp_job_open` / `dsp_plan` /
 * `dsp_slot_open` 都可能触发它；grow 之后数据**没有搬**，用同一个地址从新 buffer 现切
 * 就还是那一格。于是下面 `Job` / `Slot` / `Plan` 都把「取数组」做成方法，
 * 每次调用重新切 —— 「持有一份内核内存上的视图」在结构上就写不出来。
 *
 * 用法：入口在启动时 `startKernel(url, { fft })` **一次**，之后 `kernel()` 就能拿到；
 * 要用内核的异步入口先 `await kernelReady()`（用户的动作可能比 wasm 的加载早到）。
 * **没有参照实现可退**：核心数值逻辑只有内核这一份，拿不到就抛（见 `mustKernel`）。
 *
 * **两个线程各挂一份**（worker 与主线程，见 `startKernel`）。这不是双重实现 ——
 * 源码只有 `moon/` 那一份，是同一份实现被实例化了两次：wasm 实例不能跨线程共享。
 */

import { FINENESS } from "./params";

/** 内核导出面。与 `moon/*.mbt` 的 `#export_name` 一一对应，改一处必须改两处。 */
interface Kernel {
  memory: WebAssembly.Memory;
  dsp_abi(): number;

  // 引导期自证：内核写花纹 / 内核回读宿主写的 / 内核侧花纹的基准值。
  dsp_probe_stamp(handle: number): number;
  dsp_probe_check(handle: number, wantD: number, wantB: number): number;
  dsp_probe_want(which: number): number;

  // 表组：按窗长缓存、建成即只读、永不搬家。
  dsp_plan(win: number): number;
  dsp_plan_rev(plan: number): number;
  dsp_plan_cos(plan: number): number;
  dsp_plan_sin(plan: number): number;
  dsp_plan_hann(plan: number): number;

  // 会话槽：定长工作区 + 绑定的表组。池满给负值。
  dsp_slot_open(win: number): number;
  dsp_slot_close(slot: number): void;
  dsp_slot_mem(slot: number): number;
  dsp_slot_words(slot: number): number;
  dsp_fft(slot: number): void;
  dsp_ifft(slot: number): void;
  /** 实序列反变换：内核先按 `bins` 把单边谱翻成共轭对称整谱，再复反变换。1 = 做了。 */
  dsp_real_ifft(slot: number, bins: number): number;

  // 配对双实变换：六张表的偏移由内核给（`dsp_pair_off`），宿主不自己算布局。
  dsp_pair_off(slot: number, which: number): number;
  dsp_pair_half(slot: number): number;
  dsp_pair_size(slot: number): number;
  dsp_pair_forward(slot: number): void;
  dsp_pair_inverse(slot: number): void;

  // 作业区：**一作业一段自己的数组**（主缓冲 Double + 字节段 Byte）。
  dsp_job_open(words: number, bytes: number): number;
  dsp_job_close(handle: number): void;
  dsp_job_d(handle: number): number;
  dsp_job_b(handle: number): number;
  dsp_job_words(handle: number): number;
  dsp_job_bytes(handle: number): number;
  /** 白盒计数：在用的作业段数。给「取消/抛错之后作业有没有还回去」那条门禁用。 */
  dsp_job_live(): number;

  // RTISI：偏移 / 长度一律问内核要。
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
  dsp_rtisi_len(handle: number, which: number): number;
  dsp_rtisi_run(handle: number, from: number, to: number): number;
  dsp_rtisi_finish(handle: number): void;
  dsp_rtisi_close(handle: number): void;

  // 票根：纯整数逻辑，整段在内核里。`*_bytes` / `*_words` 是尺寸表的一部分，
  // 三张梯子（行数、采样率、窗长）也是 —— 存两份就等着漂移。
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

/** 加载器与内核约定的 ABI 版本。错配时症状是「算出来的数不对」，所以这里直接拒绝。 */
export const ABI = 6;

/** 内核在产物里的落点。与 `scripts/moon.ts` 的 `WASM_FILE` 同名，由 `dsp.test.ts` 盯住。 */
const FILE = "wasm/dsp.wasm";

/** 引导期探测作业的格数。两边都取 8，内核侧的基准值问 `dsp_probe_want`。 */
const PROBE = 8;

/** 宿主写下去、内核回读的基准值。随便取，只要两次用的是同一个。 */
const HOST_D = 7000;
const HOST_B = 40;

export interface Dsp {
  readonly kernel: Kernel;
  /**
   * 现切一段视图。**只在同一次同步块内用完** —— 别跨 `openJob` / `planOf` / `openSlot`
   * 持有，那些调用可能 `memory.grow`（见文件头）。
   */
  f64(ptr: number, len: number): Float64Array;
  i32(ptr: number, len: number): Int32Array;
  u8(ptr: number, len: number): Uint8Array;
}

/** 相对应用根解析 —— 页面在子路径下（B站 Toy 的 `/toy/<slug>/`）也成立。 */
export const wasmUrl = (base: string): string => new URL(FILE, base).href;

let attached: Dsp | null = null;

/** 挂上（或摘掉）数值内核。摘掉只给测试用（`dsp.test.ts` 那条「没挂上就抛」）。 */
export const attachKernel = (dsp: Dsp | null): void => {
  attached = dsp;
};

/** 当前挂着的内核；还没挂上就是 `null`。 */
export const kernel = (): Dsp | null => attached;

/**
 * 要用内核时的取法。**没有参照实现可退** —— 核心数值逻辑只有 `moon/` 那一份，
 * 这里拿不到就是启动流程出了问题（这一侧的入口要先 `startKernel`），
 * 宁可当场地报出来，也不要悄悄换一条谁都没在维护的路。
 */
export const mustKernel = (): Dsp => {
  if (!attached)
    throw new Error(
      "数值内核还没挂上：这一侧的入口要先 startKernel（worker 与主线程各挂一份，见 app/lib/dsp.ts）",
    );
  return attached;
};

let started: Promise<Dsp> | null = null;

/**
 * 这一线程的内核，**入口在启动时调一次**。同一线程上重复调用共享同一次加载 ——
 * 一次实例化要一份私有内存（实测 1.25 MB）与一次编译（39 KB 的模块，0.8 ms），
 * 没有理由付两遍。
 *
 * `use.fft` 是「这一侧会不会跑 FFT」，也就是**要不要在启动时把三档窗长的表组建好**
 * （见 `warmKernel`）。worker 每条消息都要跑，主线程只用票根编解码（纯整数，
 * 见 `app/lib/stub.ts`）—— 后者建那三组表是白花，实测 1.2 ms。
 *
 * 返回的 Promise 是给 `kernelReady` 等的，不是给调用方 await 的：
 * 加载与页面 / worker 的启动并行，别让它挡住首屏。
 *
 * `source` 与 `loadDsp` 同一套入参：浏览器传 URL，测试直接给字节。
 */
export const startKernel = (
  source: string | ArrayBuffer | Uint8Array,
  use: { fft: boolean },
): Promise<Dsp> => {
  started ??= loadDsp(source).then(dsp => prewarm(dsp, use.fft));
  // 这一句只为「内核加载失败时别先在控制台以未处理拒绝的形式响一次」：真正的报错点在使用它的
  // 那次调用上 —— `kernelReady()` 会把同一条错误抛回给调用方，界面据此显示。
  started.catch(() => {});
  return started;
};

/**
 * 等这一线程的内核热好。用到内核的**异步**入口都在开头 await 一次 ——
 * 用户的动作可能比 wasm 的加载早到（拖进一个文件是毫秒级的事），不等它就是一句
 * 「内核还没挂上」。
 *
 * 没调过 `startKernel` 就原样放行：测试与评测台是手工 `loadDsp` + `attachKernel` 挂的，
 * 该由 `mustKernel` 判有没有，这里不替它做决定。
 */
export const kernelReady = async (): Promise<void> => {
  if (started) await started;
};


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
  const k = instance.exports as unknown as Kernel;

  if (k.dsp_abi() !== ABI) throw new Error(`内核 ABI 不匹配：产物 ${k.dsp_abi()}，加载器 ${ABI}`);

  // 引导期握手。**必须在消费那条约定的这一侧做** —— 内核白盒证不了跨语言取址，
  // 两侧本来就是同一份内存，怎么试都对得上（见 `moon/engine.mbt`）。
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

/**
 * 一次 FFT 计划。三张表只依赖窗长、建成即只读，所以**按窗长缓存**在核心里
 * （见 `moon/plan.mbt`），可以同时持有多个 —— 宿主并发跑两件活不会互相顶掉。
 *
 * 访问器做成方法而不是属性：表本身不搬家，但 `memory.grow` 会把视图 detach，
 * 所以每次用之前现切（见文件头）。
 */
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

/** 内核里的一次会话：一份定长工作区 + 它绑定的表组。 */
export interface Slot {
  readonly id: number;
  readonly win: number;
  /** 槽工作区全文（元素）。 */
  mem(): Float64Array;
  /** 配对布局的第 `which` 张表：0=r1 1=i1 2=r2 3=i2 4=x1 5=x2。 */
  table(which: number): Float64Array;
  close(): void;
}

/**
 * 占一个会话槽。窗长不合法直接抛（那是编程错误）；**池满也抛** —— 内核里只有 6 个槽
 * （`moon/session.mbt` 的 `max_slots`），拿到就必须还，「忘了还」要在现场报出来，
 * 而不是变成一条慢慢变慢的路。
 */
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

/** 单条复变换的两个半区：实部在槽首、虚部紧随其后（与 `moon/fft.mbt` 同一份布局）。 */
export const fftBuffers = (slot: Slot): { re: Float64Array; im: Float64Array } => {
  const m = slot.mem();
  return { re: m.subarray(0, slot.win), im: m.subarray(slot.win, 2 * slot.win) };
};

/**
 * 实序列的反变换：内核把「单边谱翻成共轭对称整谱」与复反变换一次做完（见 `moon/fft.mbt`
 * 的 `real_ifft`）。**宿主这一侧没有第二处翻转** —— 漏翻的后果是上半谱带着上一帧的时域
 * 样本被当成本帧的谱再变一次，帧 0 之后整条输出都是错的，而症状离出错点很远。
 *
 * 拒绝（槽或行数不合法）时当场抛：那是调用方的编程错误。
 */
export const realIfft = (dsp: Dsp, slot: Slot, bins: number): void => {
  if (dsp.kernel.dsp_real_ifft(slot.id, bins) !== 1)
    throw new Error(`内核拒绝了实反变换：槽 ${slot.id}、${bins} 行`);
};

/** 一段作业区。两段的长度由内核给，宿主不自己算布局。 */
export interface Job {
  readonly handle: number;
  /** 主缓冲（Double），长度 `dsp_job_words`。 */
  d(): Float64Array;
  /** 字节段（Byte），长度 `dsp_job_bytes`。 */
  b(): Uint8Array;
  close(): void;
}

/**
 * 作业主缓冲上的一个元素区间（**现切视图**）。
 *
 * `off` 是内核报的**元素**偏移（例：`dsp_rtisi_off`）—— 地址这一步只在这里做一次。
 * 别在调用点上自己拼 `+ off * 8`：漏掉乘 8 或漏掉基址都会把视图切到别的内存上，
 * 而症状出现在很远的地方（实测漏掉基址 = 切在地址 0，写进去砸的是运行时的低内存，
 * 表现为随后某次内核调用莫名的 `memory access out of bounds`）。
 */
export const jobSlice = (dsp: Dsp, handle: number, off: number, len: number): Float64Array =>
  dsp.f64(dsp.kernel.dsp_job_d(handle) + off * 8, len);

/** 作业字节段上的一个字节区间（**现切视图**）。`off` 是段内字节偏移，不乘 8。 */
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

/** 产品那三档窗长。**问 `params.ts` 要**，不在这里再抄一份 —— 抄一份就等着漂移。 */
const FFT_WINS: readonly number[] = FINENESS.map(f => f.win);

/**
 * 挂上内核并把它**热起来**。
 *
 * 三件事都只该发生一次、且都不该落在「用户等出图」那段时间里：wasm 编译与实例化
 * （`loadDsp` 里）、建表组（旋转因子与汉宁窗，最贵的是 1024 那一档）、以及头一次
 * 作业区分配（它必然带着一次 `memory.grow`）。入口启动时一次做完，之后每条消息都不再付。
 *
 * 顺序也是要紧的：`planOf` 自己会分配，所以放在前面 —— 它之后的视图才是在
 * 「内存已经长到该有的样子」之后切的。
 *
 * `fft` 为假时不建表组（主线程只用票根编解码，见 `startKernel`），
 * 「热起来」对它只剩「做掉头一次分配」这一件事。
 */
const prewarm = (dsp: Dsp, fft: boolean): Dsp => {
  attachKernel(dsp);
  if (fft) for (const win of FFT_WINS) planOf(dsp, win);
  openJob(dsp, 0, 0).close();
  return dsp;
};

/**
 * 挂上内核并把它热起来 —— 给**已经从字节拿到内核**的调用方（评测台与测试）；
 * 浏览器里的两个线程走 `startKernel`。
 */
export const warmKernel = (dsp: Dsp): Dsp => prewarm(dsp, true);


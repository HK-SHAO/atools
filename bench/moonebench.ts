/**
 * 把 `moon bench` 的**同一份产物**拿到 V8 里量 —— 用来回答「moon bench 的读数是这个引擎的吗」。
 *
 * 为什么需要它：`moon bench --target wasm` 的产物由 `moonrun` 执行（link 时带 `-wasi`、
 * 导出 test-driver 入口），而应用跑在浏览器 / Node 的 V8 上。两个运行时对同一份 wasm 的
 * 读数不同，且差多少取决于这段代码走不走 `v128`（实测：v128 那档 1.4×、纯访存整数 1.1×）。
 * 所以 `moon bench` 只能当**同运行时的前后回归锚点**，「内核比 TS 快多少」必须看
 * `bench/kernel.ts` 的宿主侧 A/B。判据与实测表在 `docs/algorithms.md`
 * 的「`moon bench` 的读数归 `moonrun`」。
 *
 * 用法（两步，因为 bench 产物与 `bun run kernel` 用的应用产物不是同一份文件）：
 *
 *   bun run bench:kernel:build    # 只编出 bench 产物，不在这里跑（`moon bench --build-only`）
 *   bun run bench:moonebench      # 本脚本读数
 *
 * 名字与 `moon/*_bench_wbtest.mbt` 里的 `it.bench(name=...)` 一一对应，方便并排看。
 * 注意比的是**变换本身**（`forward-alone-*`），不是含一次填数的 `forward-*`。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifact = path.join(root, "moon/_build/wasm/release/bench/dsp.whitebox_test.wasm");

if (!existsSync(artifact)) {
  console.error(
    `找不到 bench 产物：${path.relative(root, artifact)}\n` +
      `先生成它：bun run bench:kernel:build`,
  );
  process.exit(1);
}

/**
 * bench 产物带四个宿主 import。这里只给够实例化的桩 —— 要量的那几个内核函数不碰它们
 * （`fd_write` 只在断言失败时用，`exception.throw` 只在 wasm 异常抛出时用，时间原语由
 * `@bench.T` 自己调，本脚本量的是裸函数）。签名取自 `moon-wasm-opt --print` 的 import 段。
 */
const imports = {
  exception: {
    tag: new WebAssembly.Tag({ parameters: [] }),
    throw: () => {},
  },
  wasi_snapshot_preview1: { fd_write: () => 0 },
  __moonbit_time_unstable: {
    instant_now: () => performance.now(),
    instant_elapsed_as_secs_f64: (t: number) => (performance.now() - t) / 1000,
  },
  __moonbit_fs_unstable: {
    begin_read_string: () => null,
    string_read_char: () => -1,
    finish_read_string: () => {},
  },
};

const { instance } = await WebAssembly.instantiate(readFileSync(artifact), imports as never);
const k = instance.exports as unknown as Record<string, CallableFunction> & {
  memory: WebAssembly.Memory;
};

/** 取最快的若干轮：调度与 GC 只会让某轮变慢，最小值是无偏的估计量。 */
function best(rounds: number, iters: number, fn: () => void): number {
  let lo = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    for (let n = 0; n < iters; n++) fn();
    const dt = (performance.now() - t0) / iters;
    if (dt < lo) lo = dt;
  }
  return lo;
}

const us = (ms: number): string => (ms * 1000).toFixed(2).padStart(9) + " µs";

console.log(`产物 ${path.relative(root, artifact)}  ·  引擎 V8 (${process.versions.bun ? "Bun" : "Node"})`);
console.log("name                       V8 读数      moon bench 里的同名读数");

for (const win of [512, 4096]) {
  const s = k.dsp_slot_open!(win) as number;
  const re = new Float64Array(k.memory.buffer, k.dsp_slot_ptr!(s) as number, win);
  for (let i = 0; i < win; i++) re[i] = Math.sin(i * 0.017);
  console.log(`forward-alone-${win}`.padEnd(24) + us(best(20, 400, () => k.dsp_fft!(s))));
  k.dsp_slot_close!(s);
}

for (const w of [2048, 65535]) {
  const jh = k.dsp_job_open!(k.dsp_stub_paint_words!(w) as number) as number;
  console.log(
    `paint-${w}`.padEnd(24) + us(best(20, 200, () => k.dsp_stub_paint!(jh, w, 44100, 512, 1))),
  );
  k.dsp_job_close!(jh);
}

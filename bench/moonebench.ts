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
console.log("同一份产物换引擎跑：这一列是 V8，moonrun 那一列读 `moon bench`，两者只比比值");
console.log("name                       V8");

for (const win of [512, 4096]) {
  const s = k.dsp_slot_open!(win) as number;
  const re = new Float64Array(k.memory.buffer, k.dsp_slot_mem!(s) as number, win);
  for (let i = 0; i < win; i++) re[i] = Math.sin(i * 0.017);
  console.log(`forward-alone-${win}`.padEnd(24) + us(best(20, 400, () => k.dsp_fft!(s))));
  k.dsp_slot_close!(s);
}

for (const w of [2048, 65535]) {
  const jh = k.dsp_job_open!(0, k.dsp_stub_paint_bytes!(w) as number) as number;
  console.log(
    `paint-${w}`.padEnd(24) + us(best(20, 200, () => k.dsp_stub_paint!(jh, w, 44100, 512, 1))),
  );
  k.dsp_job_close!(jh);
}

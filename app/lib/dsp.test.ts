import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import {
  ABI,
  attachKernel,
  kernelReady,
  loadDsp,
  mustKernel,
  openJob,
  startKernel,
  type Dsp,
} from "./dsp";
import { stubRows } from "./stub";

describe("内核握手与访存", () => {
  let dsp: Dsp;
  beforeAll(async () => {
    dsp = await loadDsp(compileWasm());
    attachKernel(dsp);
  });

  test("ABI 版本与加载器一致", () => {
    expect(dsp.kernel.dsp_abi()).toBe(ABI);
  });

  test("加载期已经把地址约定自证过一遭", async () => {
    const { kernel } = dsp;
    const job = openJob(dsp, 8, 8);
    try {
      expect(kernel.dsp_probe_stamp(job.handle)).toBe(1);
      const d = job.d();
      const b = job.b();
      const wantD = kernel.dsp_probe_want(0);
      const wantB = kernel.dsp_probe_want(1);
      for (let i = 0; i < 8; i++) {
        expect(d[i]).toBe(wantD + i);
        expect(b[i]).toBe(wantB + i);
      }
      for (let i = 0; i < 8; i++) {
        d[i] = 500 + i;
        b[i] = 90 + i;
      }
      expect(kernel.dsp_probe_check(job.handle, 500, 90)).toBe(1);
      expect(kernel.dsp_probe_check(job.handle, 501, 90)).toBe(0);
    } finally {
      job.close();
    }
  });

  test("memory.grow 顶掉旧视图，而从当前 buffer 现切就还是那一格", () => {
    const { kernel } = dsp;
    const job = openJob(dsp, 64, 32);
    try {
      const before = job.d();
      for (let i = 0; i < 8; i++) before[i] = 111 + i;
      const pages0 = kernel.memory.buffer.byteLength;

      const hog = [0, 1, 2].map(() => openJob(dsp, 1 << 22, 1 << 20));
      expect(kernel.memory.buffer.byteLength).toBeGreaterThan(pages0);
      expect(before.byteLength).toBe(0);

      const after = job.d();
      expect(Array.from(after.subarray(0, 8))).toEqual([111, 112, 113, 114, 115, 116, 117, 118]);
      for (const h of hog) h.close();
    } finally {
      job.close();
    }
  });

  test("没挂上内核就当场抛，不悄悄换路", () => {
    const held = mustKernel();
    attachKernel(null);
    try {
      expect(() => mustKernel()).toThrow(/内核还没挂上/);
    } finally {
      attachKernel(held);
    }
    expect(mustKernel()).toBe(held);
  });

  test("零 import：内核不向宿主索取任何东西", () => {
    const module = new WebAssembly.Module(compileWasm());
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module).some(e => e.name === "memory")).toBe(true);
  });
});

describe("内核启动路径", () => {
  test("没启动过就原样放行 —— 手工挂载的路照旧（评测台与其余测试都走它）", async () => {
    const held = mustKernel();
    await expect(kernelReady()).resolves.toBeUndefined();
    expect(mustKernel()).toBe(held);
  });

  test("重复调用共享同一次加载，且 kernelReady 真的等到挂上为止", async () => {
    const first = startKernel({ fft: false }, compileWasm());
    await kernelReady();
    expect(mustKernel()).toBe(await first);
    expect(startKernel({ fft: false }, compileWasm())).toBe(first);
  });

  test("不建 FFT 表组也能用：主线程要的票根问得动", async () => {
    await kernelReady();
    expect(stubRows()).toBeGreaterThan(0);
  });
});

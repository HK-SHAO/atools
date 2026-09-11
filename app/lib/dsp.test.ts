import { beforeAll, describe, expect, test } from "vitest";
import { compileWasm, WASM_FILE } from "../../scripts/moon";
import {
  ABI,
  attachKernel,
  kernelReady,
  loadDsp,
  mustKernel,
  openJob,
  startKernel,
  wasmUrl,
  type Dsp,
} from "./dsp";
import { stubRows } from "./stub";

/**
 * 内核与宿主之间唯一的硬约定是「导出函数返回数组时，宿主收到的整数就是数据区首址」。
 * 它没有文档背书（MoonBit 的 wasm 后端对导出函数不做任何 marshalling），工具链升级
 * 可能悄悄改掉，所以这里把**两个方向**都做成断言：内核写、宿主两把视图读回；
 * 宿主写、内核读回。交接条款见 `moon/engine.mbt`。
 *
 * 另一半是**视图的寿命**：`memory.grow` 会 detach 掉先前切出的全部视图，而数据没有搬。
 * 这一条决定了整层的写法（「现切，不持有」），所以它也要有门禁 —— 否则哪天有人把
 * 一次现切的结果缓起来，只有在真的 grow 过之后才会现形。
 */
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
    // `loadDsp` 里的握手跑不过就直接抛。这里再独立走一遍那条路，确认它确实是活的判据：
    // 故意把内核写下去的花纹读错一格，就该对不上。
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
      // 反向：宿主写、内核回读
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

      // 逼一次 grow：四段 4M 元素的主缓冲（32 MB）足够把后备缓冲换掉。
      const hog = [0, 1, 2].map(() => openJob(dsp, 1 << 22, 1 << 20));
      expect(kernel.memory.buffer.byteLength).toBeGreaterThan(pages0);
      expect(before.byteLength).toBe(0); // detach 了

      // 数据**没有搬**：同一个地址从新 buffer 现切，还是那几个数
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

  test("加载器解析出的 URL 与构建落点同一条路径", () => {
    expect(wasmUrl("http://localhost/toy/slug/")).toBe(`http://localhost/toy/slug/${WASM_FILE}`);
  });
});

/**
 * 启动路径：入口起一次内核，之后要用内核的异步入口各 `await kernelReady()` 一次。
 *
 * 这条链曾经只在 worker 里有，主线程的读图链没人挂 —— 于是真页面里「拖进一张频谱图、
 * 点质检」必然报「数值内核还没挂上」。下面的用例盯的就是**入口起过就够了**这件事本身。
 *
 * 放在文件最后：`startKernel` 占掉本模块「这一线程的内核」这个槽位（同一线程只加载一次），
 * 前面那些手工挂载的用例不该被它换掉。
 */
describe("内核启动路径", () => {
  test("没启动过就原样放行 —— 手工挂载的路照旧（评测台与其余测试都走它）", async () => {
    const held = mustKernel();
    await expect(kernelReady()).resolves.toBeUndefined();
    // 没启动过就一步都不做：手工挂上的那一份原样留着，也不替 `mustKernel` 判有没有。
    expect(mustKernel()).toBe(held);
  });

  test("重复调用共享同一次加载，且 kernelReady 真的等到挂上为止", async () => {
    const first = startKernel(compileWasm(), { fft: false });
    // **不**先 await：此刻正是「wasm 还在路上、用户已经把文件拖进来了」那一瞬间。
    // `kernelReady()` 要是空操作，下一句拿到的是压根还没挂上的内核。
    await kernelReady();
    expect(mustKernel()).toBe(await first);
    // 同一线程只加载一次 —— 第二次调用给的是**同一个** promise，不是又编一份 wasm。
    expect(startKernel(compileWasm(), { fft: false })).toBe(first);
  });

  test("不建 FFT 表组也能用：主线程要的票根问得动", async () => {
    await kernelReady();
    // 主线程那一份刻意不预热表组（`fft: false`，它不碰 FFT），但必须真的可用 ——
    // 「省掉了预热」与「根本没挂上」是两回事，这条断言把它们分开。FFT 的表组是
    // 懒建的（`planOf` 按窗长缓存），所以这里不去碰它。
    expect(stubRows()).toBeGreaterThan(0);
  });
});

import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import {
  ABI,
  attachKernel,
  createKernelHost,
  loadDsp,
  mustKernel,
  openJob,
  type Dsp,
} from "./dsp";

describe("kernel handshake and memory access", () => {
  let dsp: Dsp;
  beforeAll(async () => {
    dsp = await loadDsp(compileWasm());
    attachKernel(dsp);
  });

  test("the ABI version matches the loader", () => {
    expect(dsp.kernel.dsp_abi()).toBe(ABI);
  });

  test("the load stage has already proved the address convention once", async () => {
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

  test("memory.grow drops the old view, but slicing from the current buffer still lands on the same cell", () => {
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

  test("a missing kernel throws on the spot instead of quietly switching paths", () => {
    const held = mustKernel();
    attachKernel(null);
    try {
      expect(() => mustKernel()).toThrow(/not attached/);
    } finally {
      attachKernel(held);
    }
    expect(mustKernel()).toBe(held);
  });

  test("zero imports: the kernel asks its host for nothing", () => {
    const module = new WebAssembly.Module(compileWasm());
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module).some(e => e.name === "memory")).toBe(true);
  });
});

describe("kernel startup paths", () => {
  test("without a start call the manual attach path passes straight through (the audit bench and the other tests all take it)", async () => {
    const held = mustKernel();
    const host = createKernelHost();
    host.attach(held);
    await expect(host.ready()).resolves.toBeUndefined();
    expect(host.must()).toBe(held);
  });

  test("repeated calls share one load, and kernelReady really waits until it is attached", async () => {
    const host = createKernelHost();
    const first = host.start({ fft: false }, compileWasm());
    expect(host.start({ fft: false }, compileWasm())).toBe(first);
    await host.ready();
    expect(host.must()).toBe(await first);
  });

  test("usable without the FFT tables: the stub rows the main thread wants answer", async () => {
    const host = createKernelHost();
    await host.start({ fft: false }, compileWasm());
    expect(host.must().kernel.dsp_stub_rows()).toBeGreaterThan(0);
  });

  test("a failed load does not poison the next start", async () => {
    const host = createKernelHost();
    await expect(host.start({ fft: false }, new Uint8Array())).rejects.toThrow();
    const recovered = await host.start({ fft: false }, compileWasm());
    expect(host.must()).toBe(recovered);
  });
});

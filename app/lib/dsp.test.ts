import { beforeAll, describe, expect, test } from "vitest";
import { compileWasm, WASM_FILE } from "../../scripts/moon";
import { ABI, loadDsp, wasmUrl, type Dsp } from "./dsp";

/**
 * 内核与宿主之间唯一的硬约定就是「导出地址 = FixedArray 数据区首地址」。
 * 它没有文档背书，工具链升级可能悄悄改掉，所以这里把它做成断言：
 * 内核写、宿主读，宿主写、内核读，两个方向都要通。
 */
describe("内核握手", () => {
  let dsp: Dsp;
  beforeAll(async () => {
    dsp = await loadDsp(compileWasm());
  });

  test("ABI 版本与加载器一致", () => {
    expect(dsp.kernel.dsp_abi()).toBe(ABI);
  });

  test("导出地址确实指向数据区，两个方向都通", () => {
    const { kernel } = dsp;
    const len = kernel.dsp_canary_len();
    const canary = dsp.i32(kernel.dsp_canary_ptr(), len);

    for (let i = 0; i < len; i++) kernel.dsp_canary_set(i, 1000 + i);
    for (let i = 0; i < len; i++) expect(canary[i]).toBe(1000 + i);

    canary[len - 1] = -1;
    expect(kernel.dsp_canary_get(len - 1)).toBe(-1);
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

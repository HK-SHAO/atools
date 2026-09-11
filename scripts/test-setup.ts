import { ensureWasm } from "./moon.ts";

/**
 * vitest 的 globalSetup：开工前把 MoonBit 内核编一次。
 *
 * 为什么必须放在这里而不是各测试文件的 `beforeAll`：`compileWasm` 判到 stale 会先
 * `rm -rf moon/_build` 再全量重编，而 vitest 默认并行起多个测试文件 —— 两个文件同时判到 stale
 * 就会互相删掉对方的中间产物。在这里编完，各文件拿到的都是最新产物，一次都不会重编。
 */
export function setup(): void {
  ensureWasm();
}

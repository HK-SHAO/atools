import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { WASM_FILE } from "./moon.ts";

/**
 * 预缓存清单里必须有两样东西，缺哪一样都是「断网那一刻才发现」的缺陷：
 *
 *  - `index.html` —— 壳的入口，它不在清单里，离线就是白屏；
 *  - 数值内核 —— 编码与还原的唯一实现，掉出壳则断网后什么也编不了。
 *
 * 判据取**产物**里的清单（workbox 注入 dist/sw.js 的那些 `url:"..."` 条目），而不是复述一遍
 * vite.config.ts 的 glob 配置 —— 复述配置只能证明配置写对了，证明不了产物里真有。
 */
export function pwaGate(): Plugin {
  return {
    name: "pwa-gate",
    apply: "build",
    // 必须排在 vite-plugin-pwa 之后：它是在自己的 closeBundle 里才写出 sw.js 的
    enforce: "post",
    async closeBundle() {
      const sw = await readFile(path.join(process.cwd(), "dist/sw.js"), "utf8").catch(() => null);
      // 渲染阶段失败时 Vite 也会走这里当清理，那时 dist 还没写出来。缺 sw.js 不是本插件的事，
      // 在这里抛只会把真正的失败原因盖掉。
      if (!sw) return;

      // 清单条目是数据（`{"revision":…,"url":"…"}`），压缩器不动它的键名，只会换引号
      const precached = [...sw.matchAll(/["'`]url["'`]\s*:\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1]!);
      if (!precached.length)
        throw new Error("dist/sw.js 里没有预缓存清单：injectManifest 没跑起来（清单是空的，离线必然失效）");
      if (!precached.includes("index.html"))
        throw new Error(`预缓存清单里没有 index.html（现有 ${precached.length} 项）：离线会白屏`);
      if (!precached.includes(WASM_FILE))
        throw new Error(`预缓存清单里没有 ${WASM_FILE}：数值内核掉出了应用壳，断网后编不了`);

      this.info(`预缓存清单 ${precached.length} 项 · 含数值内核`);
    },
  };
}

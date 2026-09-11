import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { WASM_FILE } from "./moon.ts";

/**
 * 产物里三样东西缺哪一样都是「等到那一刻才发现」的缺陷：
 *
 *  - `index.html` —— 壳的入口，它不在预缓存清单里，离线就是白屏；
 *  - 数值内核 —— 编码与还原的唯一实现，掉出壳则断网后什么也编不了；
 *  - 内核 preload 的路径与 `crossorigin` —— 路径错了那份资源只是静默掉出壳，取错了浏览器
 *    不认这份预热、白下一遍；两者都只表现为「慢一点」，没人查得出来。
 *
 * 判据一律取**产物**：清单从 workbox 写进 dist/sw.js 的那些 `url:"..."` 条目里读，preload 从
 * dist/index.html 里读 —— 复述一遍源码里的写法只能证明写法是对的，证明不了产物里真有。
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

      const html = await readFile(path.join(process.cwd(), "dist/index.html"), "utf8");
      const preload = [...html.matchAll(/<link\b[^>]*>/gi)]
        .map(m => m[0])
        .find(tag => /\brel\s*=\s*["']?preload\b/i.test(tag) && /\bas\s*=\s*["']?fetch\b/i.test(tag));
      if (!preload) throw new Error("dist/index.html 里没有 as=fetch 的 preload：数值内核失去了抢跑机会");

      const href = preload.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
      const at = href ? new URL(href, "https://x/").pathname.replace(/^\//, "") : "";
      if (at !== WASM_FILE)
        throw new Error(
          `内核 preload 指向 ${href || "（没有 href）"}，解析成 ${at || "空路径"}，不是 ${WASM_FILE}：` +
            "路径对不上时那份资源只是静默掉出应用壳，断网后编不了",
        );

      // crossorigin 按**枚举语义**判、不按字面：HTML 规范把空值与非法值都落回 anonymous，
      // 唯一另一种模式是 use-credentials（凭据 include）。app/lib/dsp.ts 用的是 same-origin，
      // 对应 anonymous —— 取成 use-credentials 或干脆不写都会被浏览器当成另一笔请求。
      const cors = preload.match(/\bcrossorigin(?:\s*=\s*["']([^"']*)["'])?/i);
      if (!cors)
        throw new Error("内核 preload 没有 crossorigin：as=fetch 的预热按规范就得带它（同源也一样）");
      if ((cors[1] ?? "").toLowerCase() === "use-credentials")
        throw new Error(
          "内核 preload 的 crossorigin=use-credentials 与 app/lib/dsp.ts 的凭据模式对不上：" +
            "那边是 same-origin，对应 anonymous",
        );

      this.info(`预缓存清单 ${precached.length} 项 · 含数值内核 · preload 已对齐`);
    },
  };
}

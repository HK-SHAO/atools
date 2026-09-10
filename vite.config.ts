import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { serviceWorker } from "./scripts/sw.ts";

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * 纯静态产物，无后端。`dist/` 是唯一产物，另由 `scripts/toy.ts` 压成 `toy.zip`。
 *
 * `base: "./"`：引用全为相对路径，`dist/` 因此可以落在任意子路径（B站 Toy 的 `/toy/<slug>/`）。
 *
 * `modulePreload: false`：Vite 默认给入口插 `<link rel="modulepreload">`，Safari 不消费这份缓存
 * 却会报 "preloaded but not used"；关掉它同时也让共享 chunk 不再进应用壳（壳只认 HTML 里真写的引用）。
 *
 * 不引 @vitejs/plugin-react：按官方文档接上它（连 `babel-plugin-react-compiler`）产出的
 * 生产包与不接**逐字节相同**（实测同一内容哈希），却要多背 3 个包 / 7 MB。
 * JSX 由打包器原生转换；代价是改组件时走整页刷新而不是 Fast Refresh，本项目规模下可接受。
 */
export default defineConfig({
  base: "./",
  plugins: [serviceWorker()],
  // 端口与地址钉死：`bun dev` / `bun start` 原本都在 127.0.0.1:3000，评测台按它写。
  // 必须显式写 host —— Vite 默认只听 `[::1]`，而评测台与 PWA 只认 `127.0.0.1`
  // （回环上的 `http://` 才算安全上下文，Service Worker 才装得上）。
  server: { host: "127.0.0.1", port: 3000 },
  preview: { host: "127.0.0.1", port: 3000 },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    // 源码映射不进产物：`upload_source_maps: false` 之外，多一份 .map 也多一份要上传的字节
    sourcemap: false,
    modulePreload: false,
    rollupOptions: {
      // sw.ts 与应用同一趟构建：它不 import 应用代码，产物天然自包含
      input: { index: at("./index.html"), sw: at("./src/sw.ts") },
      output: {
        // 用户可见的产物名只有一份：`sw.js` 必须落在 dist 根（注册与作用域都写着 `./sw.js`），
        // 其余按内容哈希进 assets/，改内容即改名字，缓存自然换代。
        entryFileNames: chunk => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

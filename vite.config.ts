import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";
import { moonKernel } from "./scripts/moon.ts";
import { pwaGate } from "./scripts/pwa.ts";

/**
 * 纯静态产物，无后端。`dist/` 是唯一产物，另由 `scripts/toy.ts` 压成 `toy.zip`。
 *
 * `base: "./"`：引用全为相对路径，`dist/` 因此可以落在任意子路径（B站 Toy 的 `/toy/<slug>/`）。
 *
 * `modulePreload: false`：Vite 默认给入口插 `<link rel="modulepreload">`，Safari 不消费这份缓存
 * 却会报 "preloaded but not used"；关掉它同时也让共享 chunk 不再进应用壳（壳只认 HTML 里真写的引用）。
 *
 * React 走官方插件（`@vitejs/plugin-react`）+ `babel-plugin-react-compiler`：编译器把组件里
 * 那些「稳定引用」自动加上记忆化，手写的 `useMemo`/`useCallback` 因此可以省着点用；dev 侧
 * 顺带拿回 Fast Refresh（原先靠整页刷新）。
 */
export default defineConfig({
  base: "./",
  plugins: [
    moonKernel(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    /**
     * 应用壳的预缓存清单由 workbox 在构建期 glob `dist/` 生成，注入 `app/sw.ts` 的 `__WB_MANIFEST`。
     * 壳因此是**产物自己**说了算，不再需要「按 HTML 引用推导壳 + 内容指纹定缓存名 + 槽位替换」那一套
     * （也一并去掉了产物名与构建脚本之间的耦合）。
     *
     * `manifest: false`：清单与图标是 `public/` 里的手写件。交给插件生成会把 `<link rel="manifest">`
     * 写成以 base 为前缀的路径，而本仓 base 是 `"./"` —— 子路径部署下的正确性由 `bench/offline.ts`
     * 按 DOM 里的实际 href 判，不靠这一处。
     *
     * `injectRegister: null`：注册仍写在 `frontend.tsx`（生产构建才注册，静默失败）。
     *
     * `globIgnores` 排掉解码器分包：它们是懒加载的动态 import（合计约 1.2 MB），
     * 进清单就等于首次访问强制下载全部格式；改由运行期缓存按需兜住。
     */
    VitePWA({
      strategies: "injectManifest",
      srcDir: "app",
      filename: "sw.ts",
      manifest: false,
      injectRegister: null,
      registerType: "prompt",
      injectManifest: {
        // iife：sw.js 由 `navigator.serviceWorker.register("./sw.js")` 按**经典脚本**加载
        rollupFormat: "iife",
        globPatterns: ["**/*.{html,css,js,wasm,svg,png,webmanifest}"],
        globIgnores: ["**/assets/decode-*.js", "**/assets/meta-*.js"],
      },
    }),
    pwaGate(),
  ],
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
      output: {
        // 除 sw.js 外全部按内容哈希进 assets/：改内容即改名字，缓存自然换代。
        // 数值流水线的 Worker 同样是这里的普通产物，它的名字不再需要谁去认。
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  /**
   * 单元测试跑在 vitest（Node）上，不是 `bun test` —— 测试链因此不绑运行时，
   * `npx vitest run` 与 `bun run test` 是同一条路。
   *
   * `globalSetup` 先把 MoonBit 内核编一次：判到 stale 的 `compileWasm` 会先 `rm -rf moon/_build`
   * 再全量重编，而 vitest 默认并行起多个测试文件 —— 各编各的就会互相删掉对方的中间产物。
   *
   * 真实浏览器的三道门禁（`bench/`）刻意不在这里：它们要关掉 HTTP 服务再冷加载页面、
   * 要按 device metrics 出图、要注入自建 bundle，vitest 的 browser mode 表达不了这些控制，
   * 于是自成一个用真实 Chromium 的评测台。
   */
  test: {
    include: ["app/**/*.test.ts"],
    globalSetup: ["./scripts/test-setup.ts"],
  },
});

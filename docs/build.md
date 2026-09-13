# 构建与运行

## 工具链

Bun 安装依赖、运行 TypeScript、测试、开发服务和生产构建；MoonBit 只编译数值内核。

```sh
bun install --frozen-lockfile
bun dev
bun run typecheck
bun run lint
bun run test
bun run test:kernel
bun run build:web
bun start
```

服务默认监听 `http://127.0.0.1:3000`，`PORT` 可改端口。MoonBit 从 `MOON`、`PATH` 或 `~/.moon/bin` 定位。`bun start` 只读取 `dist/`。

## 生产构建

`scripts/build.ts` 按依赖顺序执行三次 Bun 构建：

1. `pipeline.worker.ts` → 带内容哈希的 Worker 和 Wasm。
2. `index.html` → 应用、CSS 与按需音频解码器。
3. `sw.ts` → 注入应用壳清单和内容指纹的 `sw.js`。

Bun 不会从 `new Worker()` 或 `serviceWorker.register()` 的运行期字符串发现入口，因此 Worker 和 Service Worker 必须单独构建。构建把 Worker 的哈希 URL 注入应用入口，避免更新期间的新应用误取旧 Worker。Service Worker 依赖前两步的完整产物计算缓存版本，所以最后构建。

产物保持在 `dist/` 根目录：Worker 相对页面解析，Wasm 相对 Worker 模块解析，manifest 也以自身位置解析图标。构建会拒绝缺失的壳文件、嵌套产物、未注入的 Service Worker 清单，以及意外进入主线程入口的 Wasm 内核。

音频解码器和演示音频按需下载并进入运行时缓存，不计入首次离线应用壳。完整职责与门禁见 [architecture.md](architecture.md)。

## 开发服务

`scripts/serve.ts` 使用 Bun HTML 路由和 HMR。Worker 独立构建；请求 Worker 入口时刷新其产物，修改 `moon/` 时重编内核。开发环境不注册 Service Worker。

静态模式提供 `dist/`，未知路径回落到 `index.html`，用于验证生产产物、子路径和离线行为。Cloudflare 配置位于 `cloudflare/wrangler.jsonc`。

## 离线与更新

首次安装缓存应用壳。新版本等待旧页面关闭后激活，避免中断正在进行的转换；激活时只删除当前部署路径的旧版本缓存。

导航优先网络，断网时返回当前版本首页；其他同源 GET 请求优先读当前版本缓存。成功的非 HTML 响应可写入运行时缓存，Range 请求不缓存。不同部署路径的缓存互不读取和清理。

`bun run offline` 验证安装、更新等待、缓存隔离、运行时缓存和真正断服后的重载。`bun run ui` 验证主要交互；`UI_BASELINE=/path/to/old/dist bun run ui` 可对比两个构建。

## 浏览器基线

**Chrome / Edge 108+ · Firefox 128+ · Safari 16.4+**。

硬要求是 WebAssembly SIMD、模块 Worker、OffscreenCanvas、CompressionStream / DecompressionStream、容器查询、容器相对单位和 `@property`。其中 Firefox 128 才完整支持 `@property`，Safari 16.4 才支持所用的 Wasm SIMD 指令；Chrome 108 保证动态视口单位，其余硬要求更早可用。

自动化门禁使用本机 Chrome。Chromium 152 与 WebKit 26.6 已跑通真实 `dist/`；Firefox 基线来自特性支持范围，尚未完成实机端到端验证。

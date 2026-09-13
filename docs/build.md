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
```

服务默认监听 `http://127.0.0.1:3000`，`PORT` 可改端口。MoonBit 从 `MOON`、`PATH` 或 `~/.moon/bin` 定位。`dist/` 产物由各门禁脚本（`bun run offline`、`bun run ui`）自起服务验证，部署直接走 `bun run deploy`。

## 生产构建

`scripts/build.ts` 按依赖顺序执行两次 Bun 构建：

1. `index.html` → 应用、CSS 与按需音频解码器；`scripts/worker-plugin.ts` 在构建内响应 `./pipeline.worker.ts?worker&url` 导入，把 Worker 连同 Wasm 以内容哈希产出到 `dist/` 根目录。
2. `sw.ts` → 注入应用壳清单和内容指纹的 `sw.js`。

应用代码用 `import workerUrl from "./pipeline.worker.ts?worker&url"` 声明 Worker，URL 由插件注入，dev 与 build 同一写法。构建会拒绝缺失的壳文件、未被入口按相对 URL 引用的 Worker、未注入的 Service Worker 清单，以及任何进入应用产物的 Wasm 内核握手（主线程不含数值，见 docs/architecture.md）。

音频解码器和演示音频按需下载并进入运行时缓存，不计入首次离线应用壳。完整职责与门禁见 [architecture.md](architecture.md)。

## 开发服务

`app/index.ts` 是开发服务器入口，`bun dev` 直接运行它（Bun HTML 路由 + HMR）；Worker 的构建与路由由 `scripts/worker-plugin.ts` 提供（bunfig `[serve.static]` 注册），请求 Worker 入口时按源码重新构建，修改 `moon/` 时重编内核（`scripts/moon.ts` 的 `watchKernel`）。开发环境不注册 Service Worker。

## 离线与更新

首次安装缓存应用壳。新版本等待旧页面关闭后激活，避免中断正在进行的转换；激活时只删除当前部署路径的旧版本缓存。

导航优先网络，断网时返回当前版本首页；其他同源 GET 请求优先读当前版本缓存。成功的非 HTML 响应可写入运行时缓存，Range 请求不缓存。不同部署路径的缓存互不读取和清理。

`bun run offline` 验证安装、更新等待、缓存隔离、运行时缓存和真正断服后的重载。`bun run ui` 验证主要交互；`UI_BASELINE=/path/to/old/dist bun run ui` 可对比两个构建。

## 浏览器基线

**Chrome / Edge 108+ · Firefox 128+ · Safari 16.4+**。

硬要求是 WebAssembly SIMD、模块 Worker、OffscreenCanvas、CompressionStream / DecompressionStream、容器查询、容器相对单位和 `@property`。其中 Firefox 128 才完整支持 `@property`，Safari 16.4 才支持所用的 Wasm SIMD 指令；Chrome 108 保证动态视口单位，其余硬要求更早可用。

自动化门禁使用本机 Chrome。Chromium 152 与 WebKit 26.6 已跑通真实 `dist/`；Firefox 基线来自特性支持范围，尚未完成实机端到端验证。

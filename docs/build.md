# 构建与运行

## 工具链

使用 Bun 安装依赖、运行 TypeScript、测试、开发服务和生产打包。TypeScript 做类型检查，Oxlint 做静态检查；MoonBit 仅编译数值内核。

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

开发与静态服务默认使用 `http://127.0.0.1:3000`，可通过 `PORT` 修改端口。MoonBit 通过 PATH、`~/.moon/bin` 或 `MOON` 环境变量定位。`bun start` 只读取已有的 `dist/`，不需要编译器。

## 生产构建

`scripts/build.ts` 先确保 Wasm 产物存在，再依次打包：

1. `app/ui/pipeline.worker.ts` → `pipeline.worker.js` 与带哈希的 Wasm。
2. `app/index.html` → 应用、CSS 和按需加载的音频解码器，启用 React Compiler。
3. `app/sw.ts` → `sw.js`，注入应用壳清单和内容指纹。

产物为纯静态文件。应用与 Worker 位于 `dist/` 根目录，Worker 地址相对文档解析，Wasm 地址相对引用它的模块解析。部署到子路径时必须保留这个结构。Worker 使用固定文件名，其他打包资源使用内容哈希；无需 Worker 插件。

构建验证入口不包含内核加载器、产物位置和预缓存文件完整性。数值计算与图片处理只在 Worker 内运行，主线程负责交互、音频解码和播放。

应用壳包括 HTML、入口脚本、CSS、Worker、Wasm、manifest 和图标。音频解码器与演示音频按需下载。manifest 中的图标路径不经过打包器，构建脚本按原路径复制。

## 开发服务

`scripts/serve.ts` 的开发模式使用 Bun HTML 路由与 HMR，单独构建并提供 Worker 及其 Wasm。修改 Worker 后刷新页面；修改 `moon/` 源码会触发内核重编。

静态模式提供 `dist/`，缺失文件回落到 `index.html`，用于验证部署产物、PWA 和离线行为。Cloudflare 配置位于 `cloudflare/wrangler.jsonc`。

## 离线与更新

Service Worker 在生产环境注册。首次安装缓存应用壳；新版本等待旧页面关闭后激活，避免切断正在进行的转换。激活时只删除当前部署路径的旧缓存。

导航优先访问网络，断网时返回本版本首页；其他同源 GET 请求优先使用本版本缓存。成功的非 HTML 响应可以写入运行期缓存，Range 请求不缓存。缓存不会跨部署读取或清理；旧版未标明路径的缓存保留。

`bun run offline` 使用真实浏览器验证安装、更新等待、其他应用缓存保留、运行期缓存和断网重载。`bun run ui` 验证主要交互；`UI_BASELINE=/path/to/old/dist bun run ui` 对照两版图片大小与还原指标。

## 样式与浏览器

`app/styles/index.css` 按顺序导入 reset、tokens、primitives、layout、spectrogram 和 workbench。公共控件几何放在 primitives，组件布局放在对应样式文件。

`.app` 提供尺寸查询容器，`.shell` 定义尺寸令牌。`--u` 和 `--c-vh` 用 `@property` 注册为长度，使容器单位在令牌根解析后继承。修改 tokens 后应同时检查窄屏、矮屏和嵌入容器。

应用需要 WebAssembly、模块 Worker、OffscreenCanvas、CompressionStream / DecompressionStream、容器查询和 `@property`。当前自动化验证使用本机 Chrome；不能用特性支持表代替 Safari、Firefox 的实际端到端验证。

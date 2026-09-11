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

产物为纯静态文件。应用与 Worker 位于 `dist/` 根目录，Worker 地址相对文档解析，Wasm 地址相对引用它的模块解析。部署到子路径时必须保留这个结构。Worker 使用固定文件名，其他打包资源使用内容哈希。

构建自带四道校验，任一不过即退 1：

1. 应用壳里的每一项真在 `dist/`。壳是推出来的（入口产物 ∪ HTML 里的 `./` 引用 ∪ manifest 图标 ∪ Worker 产物 ∪ `.wasm`），缺项就是引用或图标路径写错了。
2. `sw.js` 里不许残留 `PRECACHE`。`define` 是文本替换，键名写错构建照过、只在浏览器炸。
3. 所有产物必须在 `dist/` 根。这是**规则而不是清单**：Worker 按文档基准、Wasm 按模块基准解析，都只在「同级文件」下成立。
4. 入口产物里不许出现 `dsp_abi`。数值计算与图片处理只跑在 Worker 内，主线程负责交互、音频解码和播放；主线程挂内核是构建期错误。

应用壳包括 HTML、入口脚本、CSS、Worker、Wasm、manifest 和图标。音频解码器与演示音频按需下载：12 个解码分包合计约 1.6 MB，刻意不进壳，改由运行期缓存按需兜住。manifest 中的图标路径不经过打包器，构建脚本按原路径复制。

契约与门禁的对应关系见 [architecture.md](architecture.md)。

## Bun 打包器的几条事实

下面这些是实测结论，不是文档承诺；换工具链或升级 Bun 时先重测：

- **没有 `?url` / `?worker` 这类后缀。** `.wasm` 直接 import 拿到的是**路径字符串**：dev 下是 `/_bun/asset/<hash>.wasm`，产物里是与引用它的 chunk 同目录的相对路径。
- **Worker 只能单独构建，没有「顺手产出」的写法。** 看着该管用的五种写法都试过，Bun 1.4.3 一种都不接：

  | 写法 | 实测结果 |
  | --- | --- |
  | `new Worker(new URL("./x.js", document.baseURI))` | 调用点原样透传，Worker 文件不产出 |
  | `new Worker(new URL("./x.ts", import.meta.url))` | 同上（`import.meta.url` 是源码的 `file://` 路径） |
  | `import u from "./x.ts?url"` | `Could not resolve` |
  | `import u from "./x.ts" with { type: "file" }` | 产出的是**逐字节拷贝的 `.ts`**：不转译、也不打包 |
  | `Bun.serve({ routes: { "/x.js": "./x.ts" } })` | 路由值不接受字符串；`Bun.file("./x.ts")` 供出去的是**未打包的原文**，`import` 原样留在里面 |

  所以 `scripts/build.ts` 与 `scripts/serve.ts` 各自有一个**独立**的 Worker 入口构建，固定文件名 `pipeline.worker.js`，应用侧手写 `new URL("pipeline.worker.js", document.baseURI)`。这不是冗余，是打包器边界 —— 想省掉它，先重跑这张表。
- **dev 下 `import.meta.url` 被静态替换成源码的 `file://` 路径**，`new URL(x, import.meta.url)` 在产物里也不改写。Worker 地址一律以 `document.baseURI` 为基准——`new URL(绝对路径, 任意基准)` 直接返回那个绝对路径，于是 dev（根绝对路径）与产物（相对路径）用同一个表达式。
- **扁平布局是 manifest 的硬约束**，不是审美：`manifest.webmanifest` 是手写件、不经打包器改写，`"scope": "./"` 与 `./icons/…` 都按它自己所在的位置解析，一挪就装不起来。
- **`import.meta.hot` 就是「开发 / 生产」判据**：dev 是真对象，生产构建折叠成 `undefined`（`app/ui/pipeline.ts` 的 HMR 清理挂在它上面）。
- **`@types/node` 删不得**：`bun-types/index.d.ts` 第一行就 `/// <reference types="node" />`，移走它连 `process` 与 `node:fs/promises` 都解析不出来。「移除 node」只落在运行时与脚本这一层。
- **React Compiler 判「有没有生效」看产物里有没有 `react.memo_cache_sentinel`**，不能看见体积没变就下结论。`oxlint` 的 `react/*` 那组就是编译器自己的退让理由（认不出的写法会静默不优化），两边必须一起开。
- **入口 chunk 的字节不只由入口自己的代码决定。** 给一个只从 worker 走的模块加一条 `import`（`app/lib/rtisi.ts` 引入 `TUNE`），入口里**它一行都没有**（独有的错误字符串在入口里 0 次、worker 里 1 次）、体积**逐字节同长**（244 632 B），却有 251 处标识符各差 1 字节、文件名跟着从 `index-6ayybrnh.js` 变成 `index-w3zhy93z.js` —— 压缩器的短名分配随模块图整体挪了位。**同一棵树连打两次是逐字节相同的**（单独验过），所以这不是不确定性；但**「入口哈希变了」不能当回归的证据**，这类改动要用行为门禁（`quality --gate` 五项 + `kernel` 倍率）判。

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

应用需要 WebAssembly、模块 Worker、OffscreenCanvas、CompressionStream / DecompressionStream、容器查询与容器相对单位、`@property`。

## 浏览器基线

**Chrome / Edge 108+ · Firefox 128+ · Safari 16.4+。**

这三列由下面四条定下。**硬门**是缺了就进不来的，**软**是缺了只是不好看：

| 特性 | 最晚满足的引擎 | 性质 |
| --- | --- | --- |
| `@property` | Firefox 128 · Safari 16.4 | **硬门**——令牌不注册，容器单位漏进继承的令牌并静默错缩放：界面能开、尺寸全错，比打不开更难查 |
| Wasm v128（SIMD） | Safari 16.4 | **硬门**——模块直接编译不过 |
| `container-type` + `cqi` / `cqb`、`:has()` | Chrome 105 | **硬门**——尺寸令牌的来源 |
| `dvh`（`100vh` 兜底就写在它上一行） | Chrome 108 · Firefox 101 · Safari 15.4 | 软——缺了只是移动端拿不到动态视口高度 |

Chrome 那一列因此取最晚的 108；取 105 也不算错，只是不承诺移动端视口高度正确。
其余所需特性（Wasm bulk memory 与非陷阱转整、`OffscreenCanvas`、`CompressionStream`、
`backdrop-filter`、`:focus-visible`、`color-scheme`）都远早于这四条；
`@supports (corner-shape: squircle)` 只是渐进增强，不构成门槛。

Wasm 侧的门槛取自内核的**指令集读数**（`moon build --output-wat` 的 wat）：`f64x2.splat` + `v128.store`
是 v128，bulk memory 是 `memory.copy` / `memory.fill`，非陷阱转整是 `i32.trunc_sat_f64_s`；
**导入面为空**，所以不需要 WASI。

当前验证状态：Chromium（152）与 WebKit（26.6）上真实 `dist/` 都跑通，两边零控制台错误。
**Firefox 没有实机测过**（Nightly 要往 `~/Library/Application Support/Firefox` 写 profile，
本环境对该目录 `EPERM`，与代码无关），所以 Firefox 一列是门槛推导而非实测。
自动化验证走本机 Chrome，不能用特性支持表代替真机端到端验证。

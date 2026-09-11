# 构建与样式管线

纯静态产物，无后端。源码一份，出两个包：`dist/` 目录给静态服务器（`bun run build:web`），
`toy.zip` 给 B站 Toy（`bun run build:toy` = 构建 + `scripts/toy.ts` 打包）。

## 构建：Bun.build，四步

`bun run build:web` → `scripts/build.ts`，纯 `Bun.build`、零第三方插件：

| 步 | 干什么 |
| --- | --- |
| 0 | `ensureWasm()`：内核按 mtime 判 stale 后重编（`moon build --release --deny-warn --target wasm`） |
| 1 | 打包 worker（**独立入口**，先编 —— 应用那一步要拿它的名字做内联） |
| 2 | 打包应用（HTML 入口：样式、图标与 manifest 一并按内容哈希落盘） |
| 3 | 推应用壳 → 取壳的内容指纹当缓存名 → 二次构建 `app/sw.ts`，把壳以 `__SHELL__` 注入 |

**布局是扁平的**：带哈希的产物与 `index.html` 同级。默认命名本就如此，这里只把动态分包的
`chunk-<hash>.js` 换成 `decode-mp3-<hash>.js` 这类读得懂的名字。这不是审美 ——
`manifest.webmanifest` 是手写件、每个相对地址都按它自己解析，`"scope": "./"` 与
`"./icons/icon-192.png"` 只有与入口同级才分别解析成应用根与 `/icons/…`；一旦挪进子目录，
`scope` 就变成那个子目录，装出来的 PWA 直接打不开。**这条由 `bench/offline.ts` 抓着**：
实测把命名改成 `assets/…` 之后，门禁当场报「scope/start_url 解析成 /assets/，应用根是 /」。

源码侧与产物侧解耦：入口在 `app/index.html`，字面资源在 `app/public/`（`logo.svg`、
`manifest.webmanifest`、`icons/*.png`），HTML 按 `./public/…` 引它们。打包器把引到的资源
**摊平**进 `dist/` 根并加内容哈希 —— 源里多深都一样 —— 而 manifest 自己引的图标不经打包器，
由 `build.ts` 从 `app/public/` 按字面路径抄进 `dist/`。所以「manifest 必须落在应用根」说的是
**产物位置**，源文件放哪层都不影响它。

### 内核在产物里怎么被找到

唯一一条规则，写在 `app/lib/dsp.ts` 一处：`import kernelWasm from "…/dsp.wasm"`。

- `.wasm` 是 Bun 的**内置 loader**：导入拿到的是**路径字符串**，不是模块对象、也不是 DataURL。
  dev 下是根绝对路径 `/_bun/asset/<hash>.wasm`；产物里是 `dsp-<hash>.wasm`，与引用它的 chunk 同目录。
- 拿到之后要**补成绝对地址再用**（`kernelUrl()`）：产物里给的是相对模块自身的路径，直接 `fetch`
  会按**文档**地址解析，深链（`/toy/<slug>/a/b`）下就取错文件。dev 那条本来就是绝对路径，原样放行。
- **谁进壳**：按 `.wasm` 后缀显式挑进壳。读图链在主线程上，每一步都要问内核，断网后编不了图
  就等于应用废了。
- 首屏并不需要它**下载完成**：它在入口 chunk 执行时开始取，与 React 首次渲染并行，而真正用到它的
  动作（拖进文件）远在其后 —— 实测 `bench/perf.ts` 的六个时间点与长任务数都不受影响。

早先那套「固定名 + HTML preload + 按模块上一级解析 + 构建期对账两层路径」整段删掉（见
`docs/migration.md` 的「内核改走打包器」）。`?url` 这个后缀也一并删掉 —— Bun 不支持它，直接写
`.wasm` 导入即可。

### worker 是独立入口

Bun **不打包** `new Worker(new URL(…, import.meta.url))`（列成 entrypoint 也不改写，实测产物里
原样留着 `"./w.ts"`、文件也不出），`?url` / `?worker` 两个后缀都不认。所以 worker 自己编，
而它的地址由**入口自己算出来**，不经过任何注入：

```ts
const WORKER = new URL("./pipeline.worker.js", entry.src);   // entry = <script type=module src>
new Worker(WORKER, { type: "module" });
```

- **名字钉死、不带哈希**：dev 与产物两边必须算出同一个地址，所以 worker 只能有一个固定名字。
  它的内容变化由 Service Worker 的壳指纹覆盖（那个指纹把每个字节都喂进了 `Bun.hash`）。
- **不能写 `import.meta.url`**：dev 下 Bun 把它内联成**源码的 `file://` 路径**（实测产物里是
  `new URL("./pipeline.worker.js", "file:///…/app/ui/pipeline.ts")`），浏览器拉不动；而入口脚本的
  `src` 在 dev（`/_bun/client/index-*.js`）与产物里都指得对，深路径与子路径部署也成立 ——
  按 `entry.src` 解析是这一族写法里唯一两边都对的那个。
- **dev 侧**：`scripts/serve.ts` 把 worker 现编现供在 `/_bun/client/pipeline.worker.js`（Bun 的
  dev 服务器把入口 bundle 供在那个前缀下，所以按入口脚本相对解析正好落到这里）。这是 Bun 的
  **内部挂载点**，不是文档承诺，所以 dev 起来后当场 fetch 一次，供出来的不是 JS 就直接报错。
  兄弟资产（内核 `.wasm`，dev 下钉成 `dsp.wasm`）同前缀、同路由表 —— 路由表由**真实产物名**推出来。
- **产物侧**：`naming: "pipeline.worker.js"`，与入口 chunk 同在 `dist/` 根（一道构建期校验兜住
  入口不在根的情况：不同目录即构建失败）。
- 拉起方式是 `new Worker(url, { type: "module" })`，产物自包含（零顶层 `import`）。

### 应用壳：推出来，不是挑出来的

四路来源取并集后**排序**（排序是为了让指纹与输出稳定 —— 打包器给产物的顺序不是契约）：

| 来源 | 收什么 |
| --- | --- |
| 入口产物（`kind === "entry-point"`） | `index.html` 与入口脚本 |
| 产物 `index.html` 上的 `./` 引用 | 样式、logo、apple-touch-icon |
| manifest 自己引的图标 | 内容不经打包器改写，按字面路径由构建脚本手写补进 `dist/` |
| 后缀与产物名挑出 | 内核 `.wasm`、worker |

那 12 个解码器分包是 `kind === "chunk"` 且 HTML 不引，两头都不沾，天然落在壳外按需 `import()`。

**缓存名 = 壳的内容指纹**：壳里每个名字与每个字节一起喂 `Bun.hash`，取 base36 后 6 位
（当前 `atools-399jrc`）。带哈希的资源改内容会连名字一起改，`index.html` 与图标不会，所以指纹
取的是**字节**而不是清单。壳里少一样就是断网白屏，构建期对每一项在不在 `dist/` 里做一次核对 ——
这类错只有断网才看得出来。

`sw.js` 是**第三次构建**的产物：它是应用的看门人，不在应用的依赖图里，壳以 `define` 注入
`__SHELL__`。`define` 是文本替换，**键名写错不会让构建失败**，所以补一道残留检查：产物里还有
`__SHELL__` 就退出。`sw.ts` 顶部一次性解构那个对象 —— `define` 会把对象字面量在**每一处**整份
内联（实测 6 处 → 2.0 KB），解构后只剩那一处。

### React Compiler

走 `Bun.build` 的 `reactCompiler: true`，不需要 `@vitejs/plugin-react` + `@rolldown/plugin-babel`
那一串。代价实测 **+6.4 KB**（入口 chunk 264 421 → 270 801 B，产物里 9 处
`react.memo_cache_sentinel`），全部都是编译器的自动记忆化。`.oxlintrc.json` 里那一组 `react/*`
规则就是**编译器自己的退让理由** —— 它认不出的写法会静默不优化，于是把同一套校验放进 lint
让「没被优化」可见。

Bun 默认 `modulePreload: true`，会给入口**静态**依赖的 chunk 插 `<link rel="modulepreload">`；
本仓入口的 12 个分包全是动态 `import()`，所以 `dist/index.html` 里只有一条样式与一条入口脚本
（实测）—— 当年 Vite 那条「Safari 报 preloaded but not used」没有回来的路。

## 本地两个服务器

`scripts/serve.ts` 一个文件两种模式，职责不重叠，合成一条不行：

- `bun dev`：Bun 的 HTML 路由（源码直出 + HMR），另按 `/_bun/client/*` 现编现供 worker 与它的
  兄弟资产 —— 见「worker 是独立入口」。几毫秒一次，改完 worker 刷新即生效。
  它还盯着 `moon/`：`.mbt` 一改就重编内核；产物被重写后 Bun 自己的 dev 服务器看到那个 import
  变了，照常整页刷新。
- `bun start`（`--dist`）：静态服务 `dist/`，**找不到实体文件就回落到 `index.html`**，与 Cloudflare 的
  `not_found_handling: single-page-application` 同语义；顺带把 `/../../etc/passwd` 这类穿越挡在
  `dist/` 里。

不能合并的理由是**回落**：dev 也把 `/*` 一律回落到 `index.html`，于是 `/sw.js` 与
`/manifest.webmanifest` 都会拿回 HTML（实测 `Content-Type: text/html`），PWA 在本地永远复现不出来。
`bun start` 存在的理由就是：在 localhost 这个安全上下文里，能用真浏览器验证安装与离线。

端口与地址钉死在 `127.0.0.1:3000`：PWA 只认回环上的 `http://`（那才算安全上下文，Service Worker
才装得上）。dev 那条 worker 路由的路径不是配出来的，而是入口脚本相对解析的**结果**（见上）。

`dist/` 是默认产物，多文件，交给任意静态服务器。`scripts/toy.ts` 在原地产出 `dist/` 之后把它压成
`toy.zip`，`index.html` 落在包根。zip 是「更新」语义（已存在的包不会自动剔除消失的文件），
所以每次先删掉旧包再压，且压的是目录里的**内容**（`cd dist && zip ... .`）而不是目录本身。

## 样式：分层 CSS

样式就是 CSS，按职责分层放在 `app/styles/`，由 `index.css` 一个 `@import` 入口按序串起来，
`app/frontend.tsx` 是唯一导入点。Bun 的 CSS loader 会把整条 `@import` 链内联进同一个 css chunk，
所以 `dist/` 里始终**只有一个** css 产物。dev 与生产走同一条链。

| 文件 | 职责 |
| --- | --- |
| `reset.css` | 宿主归零：`box-sizing`、`h1/p` 去边距、表单控件继承字体、`html/body/#root` 铺满且不滚动 |
| `tokens.css` | `@property` 注册与设计令牌：调色板在 `:root`，尺度令牌在 `.shell` |
| `primitives.css` | 卡片与五种控件共用的几何（`act` / `chip` / `num` / `icon-btn` / `drop-act`）、图标、焦点环、状态注记 |
| `layout.css` | 外壳（`app` / `shell`）、页头、拖放区、页脚 |
| `spectrogram.css` | 频谱图与播放头 |
| `workbench.css` | 时间条、事实行、动作行、参数面板（一个参数一行，标签与控件两列） |

不套 `@layer`：未分层的普通声明**无条件胜出**于任何层，分层与未分层混写会让层序静默失效。
一个声明只写一遍；**控件高度只有一套**的落点是 `primitives.css` 里那组共用选择器，
五种控件各自只调 `padding-inline`，新增控件并入这一组，不得自带高度或字号。

需要手写 `-webkit-` 前缀的地方（`backdrop-filter`）就手写：打包器的 CSS 压缩器不会替你补，
本项目也不引自动前缀插件（多一个包、且要跟浏览器列表同步）。漏掉它只会在 Safari 上静默失效，
而本机 Chromium 评测台看不见 —— 改这里之后要人工 `grep` 一遍产物 css。

## 尺度系统：`.app` 容器 + `.shell` 令牌根 + `@property` 冻结

一套纯 CSS 的尺度：界面在任意容器宽度下自适应，无 JS、无 `ResizeObserver`。

- `.app` 是 `container-type: size` 的查询容器，`.shell` 是它下一层的令牌根。**容器查询单位只认祖先
  容器**，所以令牌根必须紧挨在容器下面。`.app` 是**唯一**的查询容器（`.card` 上曾经也有，已撤）。
- `--u = min(14×eff/340, 14+(eff−340)/280, 16.5px)`，其中 `eff = min(100cqi, 160cqb)`。两段曲线在
  340px 处相接，并在 16.5px 封顶。
- `--u` 与 `--c-vh` 必须用 `@property { syntax: "<length>" }` 注册：**注册后**才在 `.shell` 上解析成
  绝对 px，再随继承下发到全树；不注册则 `cqi` 留在令牌里，到使用点才解析，会被使用点**最近的**
  `container-type` 容器抢走（当时是 `.card`，症状是卡片内控件高 24.5 → 20.3、字号 → 7.98）。
  **这条链没有自动门禁**（原先守它的 `bench/scale.ts` 已删，见 `bench/README.md`）：
  改 `tokens.css` 之后要人工把 `.app` 缩到窄容器看一眼。
- 尺度分两级：全局量（`--fs-*` / `--h-ctl` / `--r-*` / `--shadow-*` / `--blur`）用 `calc(n * var(--u))`，
  与 `--u` 写在同一个元素上；局部比例（控件内边距、缝隙、图标尺寸）用字面 `em`，在使用点随局部字号。
  两个反面例子（都是实测）：在 `:root` 里写 `calc(n * var(--u))` 会被兜底值算死；用 `em` 表示的字号
  令牌若在同一元素上又设一次会叠乘（出现过 `0.6875²`）。
- 容器选 `.app` 而不选 `#root`：组件自带容器、不向宿主提要求；且 `.app` 的 content box 恰好等于原先
  用 JS 量的 `clientWidth/clientHeight`，改回去不用重算基准。

## 控件几何与参数面板

- 五种控件（`act` / `chip` / `num` / `icon-btn` / `drop-act`）在 `primitives.css` 里共用同一组选择器
  —— 同高、同一种玻璃表面，各自只调 `padding-inline`。新增控件必须并入这一组，不得自带高度或字号。
  注意 `button` 的 UA 样式带 `padding: 1px 6px`，只写 `padding-inline` 会漏掉上下。
- `.params` 是两列网格（`max-content minmax(0, 1fr)`）：**一个参数一行**，标签在第 1 列、控件在第 2 列。
  标签因此共享一条竖线。控件列必须写 `minmax(0, 1fr)` 而不是 `1fr` —— 后者的 `auto` 下限会被
  区块内容顶住，网格装不下就往外溢。
  这里换过两茬：最早是 `repeat(auto-fit, minmax(11em, 1fr))` 等宽栅格（把宽区块挤到内部换行，已废），
  后来是 `flex-wrap` + `space-between`（**按内容取宽**，余量分到块之间）。后者只是把右缘凑齐，
  标签仍旧随整块在换行流里漂移 —— 同一列的标签对不齐，而行尾那笔死区（可逆档四块、1145 宽下余
  409px）也是同一套绕法的产物。改成网格后两者一起消失。
- 代价写在明处：桌面下参数面板从两行变六行（≈224px），换来标签对齐与不再有行尾死区。
- 间距是 0.25 / 0.5em 两级：行内 chip 之间 0.25em，标签到控件、行与行之间 0.5em（网格的 `gap`）。
- 标签数量随模式变：`位深` / `频宽` 在 `ParamPanel` 里是 `compact &&`，可逆档只有四个标签
  （`levelToDb` 在 exact 分支走固定电平标度，`bits` 不参与）。

## 评测台按语义类名取样

`bench/` 直接用类选择器取元素：`perf.ts` 用 `.app` / `.note` / `.params`，`offline.ts` 用
`.spec` / `.drop` / `.params`（外加 `link[rel=…]` / `script[type=module]` 这类按语义取头标签的写法）。不给组件加 `data-*` 中转：类名本身就是稳定的语义钩子，
多一层只会让同一件事有两个出处。反过来说，这些类名是**契约**，改名要同步改 `bench/`。

## PWA 与离线

产物另有三样：`sw.js`、`manifest.webmanifest` 与 `icons/`。后两样是**手写件**：manifest 自己引的
图标由构建脚本按字面路径补进 `dist/`，`logo.svg` 与 apple-touch-icon 由 HTML 引到、经打包器按内容
哈希落盘 —— 它们不经过打包器改写的那几处，路径写错不会报错，只会让条目静默消失。

- **manifest 必须落在应用根**（`start_url` 与 `scope` 都写 `"./"`）：它的**产物**一旦挪进子目录，
  这两个值就会被解析成那个子目录，装出来的应用直接打不开。门禁里有一条专门盯它。
- **图标**：iOS 不认 SVG，`apple-touch-icon` 必须是 PNG。三个 PNG 由 `app/public/icons/icon.svg`
  光栅化而来（这份稿子只留着作图源，不进产物；产物里的是 `icons/*.png`）。那份图稿是
  `app/public/logo.svg`（favicon）去掉 `rx=8` 的圆角、
  四条竖杠**以中心为原点等比缩到 0.82** 得到的（`x' = 16 + (x − 16) · 0.82`，`w' = 0.82w`，`y'`
  按底边对齐），满幅底色加内容缩进安全区，一份就能同时声明 `any` 与 `maskable`。
  **两份 SVG 是同一枚标识的手写源，改一份必须改另一份**；交叉说明写在 `icon.svg` 的注释里，
  favicon 那份刻意不留注释 —— 它进产物，多一行注释就多 46% 的字节。
  本机没有 rsvg/inkscape，光栅化用的是仓库自带的 Chromium 快照：照 `bench/cdp.ts` 的 `open()`
  开该 SVG，`Emulation.setDeviceMetricsOverride` 定尺寸后 `Page.captureScreenshot`（180 / 192 / 512
  各一张）。一次性产物，改图稿要重出，别把这套塞进构建。
- **Service Worker 是自建的一百行**（`app/sw.ts`，产物 1.2 KB）：壳（`__SHELL__` 里那份清单）由
  构建期推出来，运行期没有任何第三方运行时。当前壳 **10 项 / 339.8 KB** ——
  入口脚本 257.2 KB、内核 44.1 KB、worker 20.3 KB 占了绝大部分。
- **进壳的只有壳**。那 12 个懒加载的解码器分包（`decode-*` / `meta-*`，合计约 1.7 MB）刻意不进壳：
  进壳等于首次访问强制下载全部音频格式，改由运行期缓存按需兜住 —— 用过一次的格式此后离线可用，
  没用过的离线时优雅失败。
- **运行期缓存与壳同住一个缓存名**：运行期只往里写应用自己的资源（哈希分包 + 演示音频），集合有限；
  换代时 `activate` 把其余缓存整代删掉，所以旧代不会堆积。workbox 那版的 `ExpirationPlugin`
  （64 项 / 30 天）是给「同代内可能无限堆积」准备的，这里同代内没有那个来源，所以不引。
  带 `Range` 的请求照样不碰，免得把半截响应写进缓存。
- **导航回退**：只对**导航**这么做 —— 网络优先、离线回退预缓存里的 `index.html`，深链因此离线也能
  直达应用；其余同源 GET 走缓存优先。
- **SPA 回落出来的 HTML 不许进运行期缓存**。部署端配的是 `not_found_handling: single-page-application`：
  任何不匹配实体文件的路径（**包括 `.js`**）都会拿回 200 的 `index.html`。这种响应一旦被缓存优先的
  那一支写进缓存，一次偶发的缺文件就固化成永久坏死 —— 此后每次取到的都是这份 HTML，直到缓存换代。
  判据在 `cacheable()`：`response.ok` 且 `Content-Type` 不以 `text/html` 开头才收。
  （`index.html` 归预缓存清单管，本来也不走这条路。）
- **预缓存缺一项就不接管**：`install` 用 `Promise.all` 而**不是** `allSettled` —— 任一壳资源失败即
  安装失败，旧 Worker 继续服役，浏览器下次导航重试。`allSettled` 会让缺一项的半壳照样激活，
  要等到断网白屏才暴露，而那时用户和日志之间已经隔了很远。
- **更新语义 = 下次启动接管**。`app/sw.ts` 刻意**不调 `skipWaiting`**：新版装好就停在 `waiting`，
  旧 Worker 与旧缓存继续服务，等标签页全关掉、下次启动才 `activate` 并清掉上一代。发了 `skipWaiting`
  的话，新版一 `activate` 就整代删掉旧的预缓存，而正在用的页面还揣着旧的 HTML —— 它剩下没加载过的
  动态分包会连同旧缓存一起消失。
  但 `clients.claim` **要发**：它只在 `activate` 时接管现有页面，而 `skipWaiting` 缺席时新版根本
  到不了 `activate`，两者叠不出撕裂状态；首次安装本来就直接 `activate`，于是 claim 让**当前这次访问
  之后**加载的东西（演示音频、按需的解码器分包）也走 SW 缓存。门禁断言「首次加载后就受控」钉的正是
  这条（判据是等 `controllerchange`，不是读 `ready` —— `ready` 只说明有活着的 worker）。
- **只在生产注册**：`frontend.tsx` 以 `import.meta.hot` 的**有无**为界。Bun 没有
  `import.meta.env.PROD`，而 `Bun.build` 实测把 `import.meta.hot` 折叠成 `undefined`
  （`if (!import.meta.hot)` → `if (true)`），dev 服务器注入的则是一个真对象 —— 于是它同时是
  「有没有热更新运行时」和「是不是生产」。注册一行 `register("./sw.js")`，静默失败（不支持的环境与
  隐私模式都会拒，不该让首屏报错）。
- **门禁**：`bun bench/offline.ts`。**只加载一次页面**，后面所有断言都建立在这一次之上 ——
  若先加载第二遍再断网，安装期什么都没预热也照样能过（第一遍顺手就把壳填满了）。
  其中的「断网」是直接关掉 HTTP 服务，不是 CDP 模拟 —— 实测 `Network.emulateNetworkConditions`
  对回环不起作用，探针的对照地址照样拿到 404，整段断言会是空的。
  离线的 200 用 `fetch(url, { cache: 'reload' })` 判定：该模式强制绕过 HTTP 缓存，源又真的不可达，
  此时还能拿到 200 就只可能是 Service Worker 给的。预缓存是**逐项**对照的：期望清单从**运行中的 DOM**
  现取（入口脚本、样式、manifest、favicon、apple-touch-icon，加上 manifest 自己引的两份图标）与
  **清单里的那份 `.wasm`**，凑齐再判（免得把「装到一半」误报成「漏装」）。另钉住 `sw.js` 不在其中。
  （这条对照是 `⊇` 而不是相等：壳里多出来的项由构建期那道核对管，门禁管的是「DOM 要的一样都不少」。）
  另外两条：服务端以 `spa: true` 打开 SPA 回落、与部署端同语义，然后主动请求一个不存在的 `.js`，
  断言它确实拿回 200 的 `text/html`（否则这条断言是空的）**且没有进缓存**；更新语义则是就地给
  `dist/sw.js` 追加一行注释制造「新版」，调 `registration.update()` 后断言 `registration.waiting`
  非空、当前页面仍受控、壳仍完整。

### 从 `shaofeng` 的 service worker 史里学到的

那个仓库的 SW 前后有 **5 个提交**，最后随 Cloudflare 部署整体下线（不是 SW 本身出问题）：

| 提交 | 做了什么 |
| --- | --- |
| `7bc2811` | 手写 78 行 `public/sw.js`：导航网络优先、`/assets/*` 缓存优先、其余 stale-while-revalidate；顺带写了 `/sw.js` 的 `Cache-Control: no-cache` |
| `08497fa` | **主动降级成两策略**，删掉安装期预热、HTML 解析、清理与 SWR 分支 |
| `5568702` | 换 vite-plugin-pwa（injectManifest + workbox 预缓存），导航统一回退应用壳 |
| `6c5e949` | `autoUpdate` → `prompt`，**删掉 `skipWaiting` 与 `clientsClaim`** |
| `3138ea7` | 整体移除 |

`5568702` 那版一次装了六个包（`vite-plugin-pwa` + `workbox-core` / `precaching` / `routing` /
`strategies` / `window`），最终态只 `import` 了两个 —— `workbox-precaching` 与 `workbox-routing`。
本仓库照着同一份清单接过一次：`precaching`（预缓存与 `__WB_MANIFEST`）、`routing`（导航回退）、
`core`（`clientsClaim`）、`strategies`（运行期那一支的 `CacheFirst`）、`expiration`（缓存过期）。
那次是为构建期那 210 行自建链（壳推导 114 行 + SW 96 行）买的单：要按 HTML 引用推壳、给壳算内容
指纹当缓存名、再往产物里替换 `__SHELL__` 槽位，每一环都是「写错只断网时才暴露」的那一类。
workbox 的代价：`bun add` 装 319 个包、`node_modules` 94 MB → 162 MB，`dist/sw.js`
0.86 → 23.20 KB（gzip 0.47 → 7.68），另加 `vite.config.ts` 十余行配置。

**后来撤了，因为当初买的那件东西已经不值钱了。** 壳推导不再是「按 Vite 的 manifest 猜」——
`Bun.build` 的产物直接报 `kind === "entry-point"`，壳就是产物 ∪ HTML 的 `./` 引用，
96 行 SW 也原样搬回来（`docs/migration.md` 里程碑 9 记着它当时的形状）。而 workbox 换来的三件里：

| workbox 给的 | 现在由什么覆盖 |
| --- | --- |
| 按 URL / 内容摘要版本化 | 缓存名 = 壳的内容指纹（名字 + 字节一起喂 `Bun.hash`），换版即换代 |
| `createHandlerBoundToURL` 的导航回退 | 手写的三行 `HOME` 匹配（`caches.match(HOME)`） |
| `ExpirationPlugin` 的缓存过期 | **不做了** —— 同代内只有应用自己的资源会进运行期缓存，没有无限增长源；跨代由 `activate` 整代清 |

撤回后的实测：`dist/sw.js` **1.2 KB**（workbox 版 23.20 KB），开发依赖少 13 个包，
壳清单 10 项 / 339.8 KB —— **清单与 workbox 那版逐项相同**，字节比它少 5.8 KiB（345.6 → 339.8，
−1.7%）。这点差在两个压缩器的取舍上，不是少了什么：逐项对照过，名字与条数一个不差。

同一条线上的三个位置，本仓库与它不同：

- **`clientsClaim` 留着**。`6c5e949` 把它与 `skipWaiting` 一起删了，注释写的是「无 skipWaiting/clientsClaim」，
  像是把两者当成同一件事。但撕裂状态只由 `skipWaiting` 造成；`clientsClaim` 只在 `activate` 时接管
  现有页面，而 `skipWaiting` 缺席时新版根本到不了 `activate`。留着它，首次访问之后加载的演示音频与
  解码器分包才进得了 SW 缓存（门禁的「演示资源入缓存」与「首次加载后就受控」两条都钉在这上面）。
- **清单只收壳**。它用默认的 `globPatterns: ['**/*']`；本仓库必须排掉约 1.7 MB 的动态分包 ——
  这不是洁癖，是「首次访问不该下载七种音频解码器」。它的第 2 版是另一条反面教材：删掉安装期预热
  就等于丢掉了首次访问的离线能力，所以本仓库的门禁改成**只加载一次**就必须全绿，不接受「第二遍才离线」。
- **manifest 与图标不进打包器的改写范围**，理由也一样：它们交出去生成会把 `<link rel="manifest">`
  与 `scope` / `start_url` 写成以 base 为前缀的路径，`/toy/<slug>/` 这类子路径部署就断了。
- **`_headers` 不需要**。它当年给 `/sw.js` 写 `Cache-Control: no-cache`；而 Cloudflare Workers 的静态
  资源**默认**就是 `Cache-Control: public, max-age=0, must-revalidate` + `ETag`，每次回源校验，
  `sw.js` 不会卡在旧版本。哈希资源同理不配 `immutable` —— 受控页面根本不走 HTTP，走的是 SW 缓存。
  少一个文件，也少一条要与部署端对齐的规则。
- **深链回退回到手写版**：导航网络优先、离线回落 `HOME`。`NavigationRoute` 随 workbox 一起走了。

## 平台基线：哪些浏览器跑得起来（2026-09 定案）

门槛由两条决定，其余都更宽。三条来源都在产物里可核对：指令集读内核产物（临时反汇编成 wat 看的，
不入库），CSS 读 `index-*.css`，API 看宿主代码里用到的构造。

**WebAssembly**（`dsp-<hash>.wasm`，44.1 KB，**零 `import`，不需要 WASI**）：

| 用到的特性 | 产物里的证据 | Chrome | Firefox | Safari |
| --- | --- | --- | --- | --- |
| v128 SIMD | `f64x2.splat` + `v128.store`（一个 `memory.fill` 的向量化循环） | 91 | 89 | **16.4** |
| bulk memory | `memory.copy` / `memory.fill` | 75 | 78 | 15 |
| 非陷阱浮点转整 | `i32.trunc_sat_f64_s` ×21 | 75 | 78 | 15 |
| reference types | `ref.func` / `funcref` | 96 | 79 | 15 |

没有用到符号扩展、多值返回、`memory64`、尾调用、异常处理；`memory.grow` 是通用能力。

**CSS**（`index-*.css`，7.2 KB）：

| 用到的特性 | 用处 | Chrome | Firefox | Safari |
| --- | --- | --- | --- | --- |
| `@property` ×2 | 冻结 `--u` 与 `--c-vh` 两个长度令牌（见上文尺度系统） | 85 | **128** | **16.4** |
| `container-type` + `cqi` / `cqb` | 容器相对单位 | 105 | 110 | 16 |
| `:has()` | 一处状态选择 | 105 | 121 | 15.4 |
| `dvh` | 首屏高度 | 108 | 101 | 15.4 |
| `backdrop-filter` | 毛玻璃卡片 | 76 | 103 | 9 |
| `@supports (corner-shape:squircle)` | 渐进增强的守护，不构成门槛 | — | — | — |

**JS**：

| 用到的 API | 用处 | Chrome | Firefox | Safari |
| --- | --- | --- | --- | --- |
| `CompressionStream` / `DecompressionStream` | PNG 的 zlib | 80 | 113 | **16.4** |
| `OfflineAudioContext` | 按容器速率建解码上下文（带 `webkit` 前缀兜底） | 14 | 25 | 6 |
| `Worker`（**module**） | 数值流水线；`pipeline.worker.js` 零顶层 `import`，但按 `{ type: "module" }` 拉起 | 80 | **114** | 15 |

合起来是 **Chrome / Edge 108+ · Firefox 128+ · Safari 16.4+**。Safari 被 `@property` 与 `v128`
同时钉在 16.4；Firefox 被 `@property` 钉在 128，是整条线里最新的一条（module Worker 的 114 更宽，
不构成门槛）。

实测（2026-09-11，真实 `dist/` 产物，本机）：

| 引擎 | 页面可载入 | 演示就绪（含 wasm + Worker） | 控制台 |
| --- | --- | --- | --- |
| Chromium 152（Chrome / Edge 内核） | 75 ms | 216 ms | 零错误 |
| WebKit 26.6（Safari 内核） | 242 ms | 189 ms | 零错误 |

两台引擎都报 `WebAssembly.validate` 的 SIMD 与 `trunc_sat` 为 `true`；`OfflineAudioContext` /
`Worker` / `CompressionStream` / `container-type` / `@property` / `backdrop-filter` 全为 `true`；
出图是 `DIV.spec`，facts 为「采样率 48k；PNG 800~802 KB；紧凑：不保存相位信息」。

**Firefox 未实测**：本机那个 Nightly 二进制起不来，报 `Could not find profile folder`，根因是它必须
往 `~/Library/Application Support/Firefox` 写 profile 而这个环境对该目录 `EPERM`（`mkdir` 就被拒）。
所以上面 Firefox 那一列是**从特性支持表推的，不是跑出来的**。换一台能写那个目录的机器，同一个探针
（起本地服务 + headless 截图 + 页面 beacon 回传读写数）就能补齐。

**读图侧没有第二条路**：`app/lib/png.ts` 的 `zlib()` 在 `CompressionStream` 缺席时退到未压缩 zlib，
`inflate()` 却是裸的 `new DecompressionStream("deflate")`。两个 API 同版本上线，所以不存在「能存不能读」
的真实浏览器；而「两个都没有」的老环境本来就被 `@property` 与 `v128` 两道门槛挡在门外。自写 inflate
约 200 行，与「不要冗余代码」冲突，所以维持现状 —— 代价只是那种环境下报错是原生 `TypeError`，
不是一句人话。

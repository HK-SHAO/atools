# 构建与样式管线

纯静态产物，无后端。源码一份，出两个包：`dist/` 目录给静态服务器（`bun run build:web`），
`toy.zip` 给 B站 Toy（`bun run build:toy` = 构建 + `scripts/toy.ts` 打包）。

## 构建：Vite，两个自家插件

`vite build`。`vite.config.ts` 里挂两个自家插件，各自只管一件事：

| 插件 | 干什么 | 为什么不是别的东西 |
| --- | --- | --- |
| `scripts/moon.ts` | 编译 MoonBit 内核（`moon build --release --target wasm`），以**固定名** `wasm/dsp.wasm` 交给 Vite：构建期 `emitFile`，dev 期中间件直出并盯 `moon/` 里的源码变更重编 | 内核的源头不是 TS。固定名而非内容哈希 —— 它被 HTML 的 preload 与 `app/lib/dsp.ts` 按字面路径写死，哈希名没法写进这两处 |
| `scripts/pwa.ts` | 出完产物后从 `dist/sw.js` 里读出预缓存清单，核对 `index.html` 与数值内核都在；再从 `dist/index.html` 里核对内核那条 preload 的路径与 `crossorigin` 取对了；任一条不成立就**让构建失败** | 这几点缺了都只在断网那一刻、或「首屏悄悄慢一点」上暴露，判据必须在构建期 |

**应用壳的清单不在这两个插件里**：它由 `vite-plugin-pwa` 在构建期 glob `dist/` 生成（见 PWA 一节）。

两个入口：`index.html`，以及由 `app/ui/pipeline.ts` 的 `new Worker(new URL(...))` 引出的
`pipeline.worker`。应用产物一律按内容哈希进 `assets/`；`sw.js` 由 PWA 插件另出一份、落在 `dist/` 根
（注册与作用域都写着 `./sw.js`），所以它进不了 `assets/` 的 glob，也不会被谁认错。

Worker 不设 `format`：默认 iife —— 模块 Worker 要 Firefox 114+，而这份产物自包含，用不上 `import`。
它的产物名也不需要谁去认：预缓存清单是 glob 出来的，谁被 `new Worker(new URL(...))` 引到都算数。

`base: "./"`：引用全为相对路径，`dist/` 因此可以落在任意子路径（B站 Toy 的 `/toy/<slug>/`）。

`modulePreload: false`：Vite 默认给入口插 `<link rel="modulepreload">`，Safari 不消费这份缓存
却会报 "preloaded but not used"；关掉它同时也让共享 chunk 不再进应用壳（壳只认 HTML 里真写的引用）。

React 走 `@vitejs/plugin-react` + `babel-plugin-react-compiler`（后者经 `@rolldown/plugin-babel` 的
`reactCompilerPreset()`）。同一轮三档构建的**分层实测**：

| 接法 | 入口 chunk | 预缓存壳 |
|---|---|---|
| 都不接 | 264 421 B | 339.88 KiB |
| 只接 `react()` | 264 421 B（**逐字节相同**） | 339.88 KiB |
| 再加 React Compiler | 270 801 B（+6 380 B / +2.4%） | 346.11 KiB |

即：**插件本身零字节代价**（JSX 仍由打包器原生转换，它做的是 Fast Refresh 与 jsx-runtime 接线），
多出来的 6.4 KB 全是编译器的自动记忆化（产物里 9 处 `react.memo_cache_sentinel`）。

早先「接上却逐字节不变，故不引」那条结论**已作废**：当时走的是 `react({ babel: ... })` 通道，
而那条通道根本没挂载，量到的是一个空操作（重测记在 `docs/migration.md` 的「被否掉的方案」）。

## 本地两个服务器

职责不重叠，合成一条不行：

- `bun dev` → `vite`：源码直出 + HMR。
- `bun start` → `vite preview`：静态服务 `dist/`，并且**找不到实体文件就回落到 `index.html`**
  （实测 `/assets/nope.js` 拿回 200 的 `text/html`），与 Cloudflare 的
  `not_found_handling: single-page-application` 同语义。

不能合并的理由是**回落**：dev 也把 `/*` 一律回落到 `index.html`，于是 `/sw.js` 与
`/manifest.webmanifest` 都会拿回 HTML（实测 `Content-Type: text/html`），PWA 在本地永远复现不出来。
`bun start` 存在的理由就是：在 localhost 这个安全上下文里，能用真浏览器验证安装与离线。

端口与地址都钉死在 `127.0.0.1:3000`。必须显式写 `host` —— Vite 默认只听 `[::1]`，
而评测台与 PWA 只认 `127.0.0.1`（回环上的 `http://` 才算安全上下文，Service Worker 才装得上）。

`dist/` 是默认产物，多文件，交给任意静态服务器。`scripts/toy.ts` 在原地产出 `dist/` 之后把它压成
`toy.zip`，`index.html` 落在包根。zip 是「更新」语义（已存在的包不会自动剔除消失的文件），
所以每次先删掉旧包再压，且压的是目录里的**内容**（`cd dist && zip ... .`）而不是目录本身。

## 样式：分层 CSS

样式就是 CSS，按职责分层放在 `app/styles/`，由 `index.css` 一个 `@import` 入口按序串起来，
`app/frontend.tsx` 是唯一导入点。Vite 会把整条 `@import` 链内联进同一个 css chunk，
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
`.spec` / `.drop` / `.params`（外加 `link[rel=…]` / `script[type=module]` / `link[rel=preload]` 这类
按语义取头标签的写法）。不给组件加 `data-*` 中转：类名本身就是稳定的语义钩子，
多一层只会让同一件事有两个出处。反过来说，这些类名是**契约**，改名要同步改 `bench/`。

## PWA 与离线

产物另有三样：`sw.js`、`manifest.webmanifest` 与 `icons/`。后两样连同 `logo.svg` 放在 `public/`，
由 Vite 按**字面路径**原样复制到 `dist/` 根 —— 它们不经过打包器改写，所以路径写错不会报错，
只会让条目静默消失。

- **manifest 必须落在应用根**（`start_url` 与 `scope` 都写 `"./"`）：它一旦挪进子目录，
  这两个值就会被解析成那个子目录，装出来的应用直接打不开。门禁里有一条专门盯它。
- **图标**：iOS 不认 SVG，`apple-touch-icon` 必须是 PNG。三个 PNG 由 `app/icons/icon.svg` 光栅化而来
  （这份稿子只留着作图源，不进产物；产物里的是 `public/icons/*.png`）。那份图稿是 `public/logo.svg`
  （favicon）去掉 `rx=8` 的圆角、
  四条竖杠**以中心为原点等比缩到 0.82** 得到的（`x' = 16 + (x − 16) · 0.82`，`w' = 0.82w`，`y'`
  按底边对齐），满幅底色加内容缩进安全区，一份就能同时声明 `any` 与 `maskable`。
  **两份 SVG 是同一枚标识的手写源，改一份必须改另一份**；交叉说明写在 `icon.svg` 的注释里，
  favicon 那份刻意不留注释 —— 它进产物，多一行注释就多 46% 的字节。
  本机没有 rsvg/inkscape，光栅化用的是仓库自带的 Chromium 快照：照 `bench/cdp.ts` 的 `open()`
  开该 SVG，`Emulation.setDeviceMetricsOverride` 定尺寸后 `Page.captureScreenshot`（180 / 192 / 512
  各一张）。一次性产物，改图稿要重出，别把这套塞进构建。
- **Service Worker 用 workbox**：`vite-plugin-pwa` 的 `injectManifest` 模式，源码就是 `app/sw.ts`。
  构建期 glob `dist/` 生成预缓存清单注入 `__WB_MANIFEST`：带哈希的资源按 URL 版本化，`index.html`
  与图标按内容摘要版本化。于是「壳是什么」由**产物**说了算 —— 不再需要按 HTML 引用推导壳、
  给壳算内容指纹当缓存名、再往 `sw.js` 里替换 `__SHELL__` 槽位那一整套。
- **进清单的只有壳**。`globPatterns` 收 `html/css/js/wasm/svg/png/webmanifest`，`globIgnores` 排掉
  `assets/decode-*.js` 与 `assets/meta-*.js`：它们是懒加载的动态分包（合计约 1.2 MB），进清单等于
  首次访问强制下载全部音频格式，改由运行期缓存按需兜住 —— 用过一次的格式此后离线可用。
  数值流水线的 Worker 同样是普通产物，被 glob 收进来，不必再有人去认它的名字。
  当前清单 **10 项 / 339.9 KiB**（入口脚本 264 KB、内核 44.1 KB、worker 20 KB 占了绝大部分），
  与手写版逐项相同。体积按 `dist/sw.js` 里的清单逐项求和得来。
- **运行期缓存**：同源 GET 命中即用（`CacheFirst`），`ExpirationPlugin` 限 64 项 / 30 天。
  过期是手写版没有的：哈希分包随每次部署换代，不收就无限堆积。带 `Range` 的请求不碰，
  免得把半截响应写进缓存。
- **导航回退**：`NavigationRoute(createHandlerBoundToURL("index.html"))`，网络优先、离线回退预缓存里的
  `index.html`，深链因此离线也能直达应用。`denylist` 排除带扩展名的路径与 `_` 前缀 —— 那些按 URL
  精确命中预缓存，不该被回落成一份 HTML。
- **构建期校验分两段**。一、从 `dist/sw.js` 读出预缓存清单，核对 `index.html` 与数值内核都在
  （「每一项都得真在 `dist/` 里」不用再查 —— 清单是 glob 出来的，匹配不到的文件根本进不去）。
  二、从 `dist/index.html` 里核对内核那条 preload 的 `href` 与 `crossorigin`。第二段非有不可：
  壳改成 glob 之后，preload 的路径不再由「按 HTML 引用推壳」顺带覆盖，写错的后果也不再是
  「那种资源静默不进壳」这种可观察的缺失，而只是这份资源掉出壳、断网后编不了。
  违例跑过：`globPatterns` 收窄到 `.txt`、只排掉 `wasm`、preload 路径改成 `./wasm/dsp2.wasm`，
  三次构建都红。
- **内核 preload 的 `crossorigin` 要与真实那次 fetch 对齐**。`as="fetch"` 的预热按规范必须带它
  （同源也一样），且取值须匹配请求的凭据模式：`app/lib/dsp.ts` 用 `credentials: "same-origin"`，
  对应 `anonymous`。判据按**枚举语义**取 —— 空值与非法值都落回 `anonymous`，只有 `use-credentials`
  是另一种模式（凭据 `include`），所以不写死字面值。取错时浏览器只当它是另一笔请求，症状是首屏
  白白多下一次 18 KB，没人查得出来。违例跑过：去掉 `crossorigin`、改成 `use-credentials`，两次都红。
- **预缓存缺一项就不接管**：workbox 的 `install` 也是 `Promise.all`，任一壳资源失败即安装失败，
  旧的 Worker 继续服役，浏览器下次导航重试。换成「缺了也照样激活」的话，要等到断网白屏才暴露，
  而那时用户和日志之间已经隔了很远。
- **更新语义 = 下次启动接管**。`app/sw.ts` 刻意**不调 `skipWaiting`**：新版装好就停在 `waiting`，
  旧 Worker 与旧缓存继续服务，等标签页全关掉、下次启动才 `activate` 并清旧条目。发了 `skipWaiting`
  的话，新版一 `activate` 就整代删掉旧的预缓存，而正在用的页面还揣着旧的 HTML —— 它剩下没加载过的
  动态分包会连同旧缓存一起消失。
  但 `clients.claim` **要发**：它只在 `activate` 时接管现有页面，而 `skipWaiting` 缺席时新版根本
  到不了 `activate`，两者叠不出撕裂状态；首次安装本来就直接 `activate`，于是 claim 让**当前这次访问
  之后**加载的东西（演示音频、按需的解码器分包）也走 SW 缓存。门禁断言「首次加载后就受控」钉的正是
  这条（判据是等 `controllerchange`，不是读 `ready` —— `ready` 只说明有活着的 worker）。
- **SPA 回落出来的 HTML 不许进运行期缓存**。部署端配的是 `not_found_handling: single-page-application`：
  任何不匹配实体文件的路径（**包括 `.js`**）都会拿回 200 的 `index.html`。这种响应一旦被缓存优先的
  那一支写进缓存，一次偶发的缺文件就固化成永久坏死 —— 此后每次取到的都是这份 HTML，直到缓存换代。
  判据在 `cacheWillUpdate`：`response.ok` 且 `Content-Type` 不以 `text/html` 开头才收。
  （`index.html` 归预缓存清单管，本来也不走这条路。）
- **只在生产注册**：`frontend.tsx` 以 `import.meta.env.PROD` 为界，dev 下不注册，免得旧缓存顶着源码。
  判据刻意**不**取 `import.meta.hot` 的有无 —— 本模块不导出组件，改它只能是整页重载，
  「有没有热更新运行时」与「生产 / 开发」是两件事。注册脚本不用插件注入（`injectRegister: null`）。
- **门禁**：`bun bench/offline.ts`。**只加载一次页面**，后面所有断言都建立在这一次之上 ——
  若先加载第二遍再断网，安装期什么都没预热也照样能过（第一遍顺手就把壳填满了）。
  其中的「断网」是直接关掉 HTTP 服务，不是 CDP 模拟 —— 实测 `Network.emulateNetworkConditions`
  对回环不起作用，探针的对照地址照样拿到 404，整段断言会是空的。
  离线的 200 用 `fetch(url, { cache: 'reload' })` 判定：该模式强制绕过 HTTP 缓存，源又真的不可达，
  此时还能拿到 200 就只可能是 Service Worker 给的。预缓存是**逐项**对照的：期望清单从**运行中的 DOM**
  现取（入口脚本、样式、manifest、favicon、apple-touch-icon、preload 的内核，加上 manifest 自己引的
  两份图标），凑齐再判（免得把「装到一半」误报成「漏装」）；DOM 取不到那份内核就直接判不合格，
  而不是把这条断言悄悄跳过。另钉住 `sw.js` 不在其中。
  （这条对照是 `⊇` 而不是相等：壳里多出来的项由构建期那道核对管，门禁管的是「DOM 要的一样都不少」。）
  另外两条：服务端以 `serveDir(..., true)` 打开 SPA 回落、与部署端同语义，然后主动请求一个不存在的
  `.js`，断言它确实拿回 200 的 `text/html`（否则这条断言是空的）**且没有进缓存**；更新语义则是就地给
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
本仓库按同一份清单接：`precaching`（预缓存与 `__WB_MANIFEST`）、`routing`（导航回退）、`core`
（`clientsClaim`）、`strategies`（运行期那一支的 `CacheFirst`）、`expiration`（缓存过期）。
`workbox-window` 不引 —— 它是给页面侧注册器用的，而本仓库的注册就一行 `register("./sw.js")`。

**本仓库为什么还是引了它**（此处 2026-09 的实测数字，与上一版「不引」的结论同源，只是权衡变了）：
上一版的理由是「手写 SW 才 1.2 KB，而这一套要 338 个包 / 101 MB」。本仓这次要为的不是运行时，
是**构建期那 210 行自建链**（壳推导 114 行 + SW 96 行）—— 它要按 HTML 引用推壳、给壳算内容指纹当
缓存名、再往产物里替换 `__SHELL__` 槽位，每一环都是「写错只断网时才暴露」的那一类。
交给 workbox 之后，这些全成了十几行配置，另外白得三件手写版没有的东西：按 URL / 内容摘要的
版本化、`ExpirationPlugin` 的缓存过期、`createHandlerBoundToURL` 的导航回退。

代价如实记（本仓实测）：

| | 手写 | workbox |
| --- | --- | --- |
| 构建期 + SW 源码 | 114 + 96 行 | 39 + 56 行（另 `vite.config.ts` 十余行配置） |
| `dist/sw.js` | 0.86 KB（gzip 0.47） | 23.20 KB（gzip 7.68） |
| 预缓存清单 | 10 项 | 10 项（与手写版同一组） |
| 开发依赖 | — | `bun add` 装 319 个包，`node_modules` 94 MB → 162 MB |

`sw.js` 大出来的 22 KB 是 workbox 的预缓存与路由运行时：它在后台下载、不挡首屏，换来的是上面那三件。
**首次访问要下的字节没有变**（预缓存清单逐项相同）。

同一条线上的三个位置，本仓库与它不同：

- **`clientsClaim` 留着**。`6c5e949` 把它与 `skipWaiting` 一起删了，注释写的是「无 skipWaiting/clientsClaim」，
  像是把两者当成同一件事。但撕裂状态只由 `skipWaiting` 造成；`clientsClaim` 只在 `activate` 时接管
  现有页面，而 `skipWaiting` 缺席时新版根本到不了 `activate`。留着它，首次访问之后加载的演示音频与
  解码器分包才进得了 SW 缓存（门禁的「演示资源入缓存」与「首次加载后就受控」两条都钉在这上面）。
- **清单只收壳**。它用默认的 `globPatterns: ['**/*']`；本仓库必须排掉约 1.2 MB 的动态分包 ——
  这不是洁癖，是「首次访问不该下载七种音频解码器」。它的第 2 版是另一条反面教材：删掉安装期预热
  就等于丢掉了首次访问的离线能力，所以本仓库的门禁改成**只加载一次**就必须全绿，不接受「第二遍才离线」。
- **`manifest: false` 与它一致**，理由也一样：manifest 与图标是 `public/` 里的手写件，交插件生成会把
  `<link rel="manifest">` 写成以 base 为前缀的路径，`/toy/<slug>/` 这类子路径部署就断了。
  `injectRegister: null` 则保持注册写在 `frontend.tsx`。
  另：`injectManifest` 默认输出保留裸 `import`（module SW），得配 `rollupFormat: 'iife'` 才回到 classic。
- **`_headers` 不需要**。它当年给 `/sw.js` 写 `Cache-Control: no-cache`；而 Cloudflare Workers 的静态
  资源**默认**就是 `Cache-Control: public, max-age=0, must-revalidate` + `ETag`，每次回源校验，
  `sw.js` 不会卡在旧版本。哈希资源同理不配 `immutable` —— 受控页面根本不走 HTTP，走的是 SW 缓存。
  少一个文件，也少一条要与部署端对齐的规则。
- **深链回退交给 workbox 的 `NavigationRoute`**（它当年也是这么做的）。手写版的 `HOME` 匹配已经是过去式。

## 平台基线：哪些浏览器跑得起来（2026-09 定案）

门槛由两条决定，其余都更宽。三条来源都在产物里可核对：指令集读 `wasm/dsp.wat`，CSS 读
`assets/index-*.css`，API 看宿主代码里用到的构造。

**WebAssembly**（`wasm/dsp.wasm`，44.1 KB，**零 `import`，不需要 WASI**）：

| 用到的特性 | 产物里的证据 | Chrome | Firefox | Safari |
| --- | --- | --- | --- | --- |
| v128 SIMD | `f64x2.splat` + `v128.store`（一个 `memory.fill` 的向量化循环） | 91 | 89 | **16.4** |
| bulk memory | `memory.copy` / `memory.fill` | 75 | 78 | 15 |
| 非陷阱浮点转整 | `i32.trunc_sat_f64_s` ×21 | 75 | 78 | 15 |
| reference types | `ref.func` / `funcref` | 96 | 79 | 15 |

没有用到符号扩展、多值返回、`memory64`、尾调用、异常处理；`memory.grow` 是通用能力。

**CSS**（`assets/index-*.css`，6.8 KB）：

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
| `Worker`（classic） | 数值流水线；`assets/pipeline.worker-*.js` 是 `(function(){` 开头的 IIFE，零顶层 `import` | 4 | 3.5 | 5 |

合起来是 **Chrome / Edge 108+ · Firefox 128+ · Safari 16.4+**。Safari 被 `@property` 与 `v128`
同时钉在 16.4；Firefox 被 `@property` 钉在 128，是整条线里最新的一条。

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

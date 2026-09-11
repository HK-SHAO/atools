# 构建与样式管线

纯静态产物，无后端。源码一份，出两个包：`dist/` 目录给静态服务器（`bun run build:web`），
`toy.zip` 给 B站 Toy（`bun run build:toy` = 构建 + `scripts/toy.ts` 打包）。

## 构建：Vite，两个插件，三个入口

`vite build`。`vite.config.ts` 里挂两个自家插件，各自只管一件事：

| 插件 | 干什么 | 为什么不是别的东西 |
| --- | --- | --- |
| `scripts/moon.ts` | 编译 MoonBit 内核（`moon build --release --target wasm`），以**固定名** `wasm/dsp.wasm` 交给 Vite：构建期 `emitFile`，dev 期中间件直出并盯 `moon/` 里的源码变更重编 | 内核的源头不是 TS。固定名而非内容哈希 —— 它由 HTML 的 preload 引用，必须能进应用壳 |
| `scripts/sw.ts` | 出完产物后推应用壳、算内容指纹，把 `{cache, home, files}` 注入 `dist/sw.js` 的 `__SHELL__`；不满足就**让构建失败** | 壳是「首屏必需的一切」，写错只会在断网时暴露，所以判据必须在构建期 |

三个入口：`index.html`、`src/sw.ts`（应用同一趟构建，它不 import 应用代码，产物天然自包含）、
以及由 `src/ui/pipeline.ts` 的 `new Worker(new URL(...))` 引出的 `pipeline.worker`。
产物名只有一条规矩：`sw.js` 必须落在 `dist/` 根（注册与作用域都写着 `./sw.js`），
其余按内容哈希进 `assets/`，改内容即改名字，缓存自然换代。

`base: "./"`：引用全为相对路径，`dist/` 因此可以落在任意子路径（B站 Toy 的 `/toy/<slug>/`）。

`modulePreload: false`：Vite 默认给入口插 `<link rel="modulepreload">`，Safari 不消费这份缓存
却会报 "preloaded but not used"；关掉它同时也让共享 chunk 不再进应用壳（壳只认 HTML 里真写的引用）。

不引 `@vitejs/plugin-react`：按官方文档接上它（连 `babel-plugin-react-compiler`）产出的
生产包与不接**逐字节相同**（实测同一内容哈希），却要多背 3 个包 / 7 MB。
JSX 由打包器原生转换；代价是改组件时走整页刷新而不是 Fast Refresh，本项目规模下可接受。

`build.worker.rollupOptions.output.entryFileNames` 把 Worker 产物名钉成一份**共用声明**
（`scripts/sw.ts` 的 `WORKER_FILE`）。不钉不行：Vite 的 worker 子构建把产物当 **asset** 交上来
（没有 `facadeModuleId`），入口信息在交上来之前就丢了，壳的推导只能按名字认。默认的 `format`
是 iife —— 模块 Worker 要 Firefox 114+，而这份产物是自包含的，用不上 `import`。

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

样式就是 CSS，按职责分层放在 `src/styles/`，由 `index.css` 一个 `@import` 入口按序串起来，
`src/frontend.tsx` 是唯一导入点。Vite 会把整条 `@import` 链内联进同一个 css chunk，
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
- **图标**：iOS 不认 SVG，`apple-touch-icon` 必须是 PNG。三个 PNG 由 `src/icons/icon.svg` 光栅化而来
  （这份稿子只留着作图源，不进产物；产物里的是 `public/icons/*.png`）。那份图稿是 `public/logo.svg`
  （favicon）去掉 `rx=8` 的圆角、
  四条竖杠**以中心为原点等比缩到 0.82** 得到的（`x' = 16 + (x − 16) · 0.82`，`w' = 0.82w`，`y'`
  按底边对齐），满幅底色加内容缩进安全区，一份就能同时声明 `any` 与 `maskable`。
  **两份 SVG 是同一枚标识的手写源，改一份必须改另一份**；交叉说明写在 `icon.svg` 的注释里，
  favicon 那份刻意不留注释 —— 它进产物，多一行注释就多 46% 的字节。
  本机没有 rsvg/inkscape，光栅化用的是仓库自带的 Chromium 快照：照 `bench/cdp.ts` 的 `open()`
  开该 SVG，`Emulation.setDeviceMetricsOverride` 定尺寸后 `Page.captureScreenshot`（180 / 192 / 512
  各一张）。一次性产物，改图稿要重出，别把这套塞进构建。
- **Service Worker**：应用壳由 `scripts/sw.ts` 在构建期推出来（见下一条），连同缓存名一起注入
  `dist/sw.js` 的 `__SHELL__`（`{ cache, home, files }` 一个对象）。音频解码器是动态 import 的分包，
  不进壳，改由运行期缓存兜住 —— 用过一次的格式此后离线可用。导航走网络优先，其余同源 GET 走缓存
  优先但**只收非 HTML 响应**（理由见下面的 SPA 回落那条）；带 `Range` 的请求不碰，免得把半截响应
  写进缓存。
  注入的**对象字面量**会在每个使用处整份内联 —— 实测用 6 次就把 `sw.js` 从 1.1 KB 撑到 2.0 KB，
  所以 `sw.ts` 顶部一次性解构成 `CACHE` / `home` / `files`，产物回到 1.2 KB。
  壳清单是**相对路径全链路**（manifest 的 `"./"`、`new URL(entry, sw.js 的位置)`、注册的 `"./sw.js"`），
  所以子路径部署天然成立，不需要任何一处写死应用根。
- **应用壳是推出来的，不是挑出来的**。三处来源各自独立，取并集后排序（排序是为了让指纹与输出稳定，
  打包器给产物的顺序不是契约）：
  ① **HTML 引用** —— 产物 `index.html` 上所有 `src|href="./…"`：入口脚本、样式、favicon、
  manifest、apple-touch-icon、preload 的数值内核，以及 `index.html` 自己。
  ② **manifest 图标** —— 它的内容不经过打包器改写，按字面路径复制后自己补进清单。
  ③ **Worker 产物** —— 它只由 `new Worker(new URL(...))` 引到，HTML 里没有；而 Vite 交上来的是
  asset（认不出入口），所以按我们自己钉的产物名认。
  解码器分包是动态 import、HTML 不引，三头都不沾，天然落在壳外；`fade-demo.ogg` 同理
  —— 它是静态 import，但 HTML 没引用它。**代码型资源看静态还是动态可达，URL 型资源只看 HTML
  引没引**，两条规则清清楚楚，于是「壳 = 首屏所需」不需要任何排除名单。
  当前壳 = **10 项 / 316 KB**（其中入口脚本 266 KB）。
- **缓存名 = 壳的内容指纹**（名字加字节一起喂 sha256）。带哈希的资源改内容会连名字一起改，
  `index.html` 与图标不会，所以指纹取字节而不是清单 —— 壳里任何一个字节变了就换一代，`activate`
  再删掉其余缓存。取清单哈希的旧写法漏得掉「只改 HTML 标记」这一类：实测那样改完清单不变、缓存名
  不变、`sw.js` 字节也不变，浏览器连更新都不装。
- **构建期有四道校验**，都只对着「写错不会当场报错、只在运行时炸」的那几类：
  ① 每一项都得真在 `dist/` 里 —— 图标与 manifest 是手写路径，是唯一真会写错的来源；
  ② `dist/sw.js` 里不许残留 `__SHELL__` —— 注入是文本替换，键名写错**不会让构建失败**
  （实测三态：注入了标识符就没了，漏一个就整段留在产物里），而它炸在最没人看的那个控制台里；
  ③ 数值内核必须在壳里 —— 这条同时核对「`index.html` 的 preload 路径 == `scripts/moon.ts` 的
  `WASM_FILE`」，路径对不上的表现只是那种资源静默不进壳；
  ④ 我们自己钉的 Worker 产物名必须**恰好命中一个** —— 认不出来就红，漏进壳的代价是断网之后按钮点不动。
  「`sw.js` 不许进壳」不在这里重复：它归属 worker 构建，本来就到不了这份清单，门禁盯真实缓存即可。
- **预缓存缺一项就不接管**：`install` 用 `Promise.all`，任一壳资源失败即安装失败，旧的 Worker 继续
  服役，浏览器下次导航重试。改用 `allSettled` 的话，缺一项的半壳照样激活，要等到断网白屏才暴露，
  而那时用户和日志之间已经隔了很远。
- **更新语义 = 下次启动接管**。`install` 里刻意**不调 `skipWaiting`**：新版装好就停在 `waiting`，
  旧 Worker 与旧缓存继续服务，等标签页全关掉、下次启动才 `activate` 并清旧缓存。发了 `skipWaiting`
  的话，新版一 `activate` 就整代删掉旧缓存，而正在用的页面还揣着旧的 HTML —— 它剩下没加载过的动态
  分包会连同旧缓存一起消失。**首次安装没有旧 Worker，本来就直接 `activate`**，所以「首次访问即离线
  可用」不靠 `skipWaiting`，靠 `clients.claim`；门禁断言「首次加载后就受控」钉的正是这条
  （判据是等 `controllerchange`，不是读 `ready` —— `ready` 只说明有活着的 worker）。
- **SPA 回落出来的 HTML 不许进运行期缓存**。部署端配的是 `not_found_handling: single-page-application`：
  任何不匹配实体文件的路径（**包括 `.js`**）都会拿回 200 的 `index.html`。这种响应一旦被缓存优先的
  那一支写进缓存，一次偶发的缺文件就固化成永久坏死 —— 此后每次取到的都是这份 HTML，直到缓存换代。
  所以运行期这一支只收 `response.ok` 且 `Content-Type` 不以 `text/html` 开头的响应；`index.html` 归
  预缓存清单管，不从这条路走。
- **只在生产注册**：`frontend.tsx` 以 `import.meta.hot` 为界，dev 下不注册，免得 HMR 被旧缓存顶着。
- **门禁**：`bun bench/offline.ts`。**只加载一次页面**，后面所有断言都建立在这一次之上 ——
  若先加载第二遍再断网，安装期什么都没预热也照样能过（第一遍顺手就把壳填满了）。
  其中的「断网」是直接关掉 HTTP 服务，不是 CDP 模拟 —— 实测 `Network.emulateNetworkConditions`
  对回环不起作用，探针的对照地址照样拿到 404，整段断言会是空的。
  离线的 200 用 `fetch(url, { cache: 'reload' })` 判定：该模式强制绕过 HTTP 缓存，源又真的不可达，
  此时还能拿到 200 就只可能是 Service Worker 给的。预缓存是**逐项**对照的：期望清单从**运行中的 DOM**
  现取（入口脚本、样式、manifest、favicon、apple-touch-icon、preload 的内核，加上 manifest 自己引的
  两份图标），凑齐再判（免得把「装到一半」误报成「漏装」）；DOM 取不到那份内核就直接判不合格，
  而不是把这条断言悄悄跳过。另钉住 `sw.js` 不在其中。
  （这条对照是 `⊇` 而不是相等：壳里多出来的项由构建期的 ④ 管，门禁管的是「DOM 要的一样都不少」。）
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
`strategies` / `window`），但最终态只 `import` 了两个 —— `workbox-precaching` 与 `workbox-routing`。
`workbox-strategies` 一次没用；`workbox-window` 本就是 `vite-plugin-pwa` 的依赖，属重复声明。

**本仓库不引这一套**（2026-09 在临时目录实测过，别再重新论证）：本项目现在也用 Vite 了，
`vite-plugin-pwa` 装得上，但代价是 338 个包 / 101 MB，同功能的 `dist/sw.js` 31.0 KB（gzip 9.9），
对手写的 1.2 KB（gzip 0.5）；且默认 `globPatterns: ['**/*']` 会把全量产物扫进壳 ——
本仓库的壳是 316 KB / 10 项，正好把约 1.2 MB 的动态分包挡在外面，这是设计不是巧合。
另：`injectManifest` 默认输出保留裸 `import`（module SW），得配 `rollupFormat: 'iife'` 才回到 classic；
本仓库的 `sw.js` 是 Vite 的第二个入口产物，**没有 `import`/`export`，天然就是 classic 脚本**。

同一条线上的三个位置，本仓库与它不同：

- **更新语义抄它第 4 版**（不发 `skipWaiting`），因为「旧页面 + 新版」的撕裂状态在这里是真实可达的
  （解码器走动态分包）。它的第 2 版则是反面教材：删掉安装期预热就等于丢掉了首次访问的离线能力，
  所以本仓库的门禁改成**只加载一次**就必须全绿，不接受「第二遍才离线」。
- **`_headers` 不需要**。它当年给 `/sw.js` 写 `Cache-Control: no-cache`；而 Cloudflare Workers 的静态
  资源**默认**就是 `Cache-Control: public, max-age=0, must-revalidate` + `ETag`，每次回源校验，
  `sw.js` 不会卡在旧版本。哈希资源同理不配 `immutable` —— 受控页面根本不走 HTTP，走的是 SW 缓存。
  少一个文件，也少一条要与部署端对齐的规则。
- **深链回退比它更直接**。它靠 `cache.match(req, { ignoreSearch: true })` 让 `/?lv=3` 命中缓存里的
  `/`；本仓库是拿确定的 `HOME` 去匹配，不依赖「缓存键长什么样」。

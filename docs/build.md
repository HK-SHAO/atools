# 构建与样式管线

纯静态产物，无后端。源码一份，出两个包（见 `build.ts`）：`dist/` 目录给静态服务器，
`toy.zip` 给 B站 Toy。构建不带任何插件，Bun 原生处理 `import "./x.css"` 与 `import x from "./x.ogg"`。

本地两个服务器职责不重叠，`src/index.ts` 里是两条分支：`bun dev` 直出源码并开 HMR；`bun start`
只静态服务 `dist/`，找不到实体文件就回落到 `index.html`（与 Cloudflare 的
`not_found_handling: single-page-application` 同语义）。合成一条是不行的 —— 开发服务器把 `/*`
一律回落到 `index.html`，于是 `/sw.js` 与 `/manifest.webmanifest` 都会拿回 HTML，PWA 在本地
永远复现不出来（实测 `Content-Type: text/html`）。这也是 `bun start` 存在的理由：
在 localhost 这个安全上下文里，能直接用真浏览器验证安装与离线。

`dist/` 是默认产物，多文件，交给任意静态服务器；引用全为相对路径，兼容 B站 Toy 的
`/toy/<slug>/` 子路径部署。`bun run build:toy` 在原地产出 `dist/` 之后把它压成 `toy.zip`，
`index.html` 落在包根。zip 是「更新」语义（已存在的包不会自动剔除消失的文件），
所以每次先删掉旧包再压，且压的是目录里的**内容**（`cd dist && zip ... .`）而不是目录本身。

## 样式：分层 CSS

样式就是 CSS，按职责分层放在 `src/styles/`，由 `index.css` 一个 `@import` 入口按序串起来，
`src/frontend.tsx` 是唯一导入点。Bun 会把整条 `@import` 链内联进同一个 css chunk，
所以 `dist/` 里始终**只有一个** css 产物（`bench/scale.ts` 断言这一点）。dev 与生产走同一条链，
Bun 在 dev 下自动注入，不需要另配插件或路由。

| 文件 | 职责 |
| --- | --- |
| `reset.css` | 宿主归零：`box-sizing`、`h1/p` 去边距、表单控件继承字体、`html/body/#root` 铺满且不滚动 |
| `tokens.css` | `@property` 注册与设计令牌：调色板在 `:root`，尺度令牌在 `.shell` |
| `primitives.css` | 卡片与五种控件共用的几何（`act` / `chip` / `num` / `icon-btn` / `drop-act`）、图标、焦点环、状态注记 |
| `layout.css` | 外壳（`app` / `shell`）、页头、拖放区、页脚 |
| `spectrogram.css` | 频谱图与播放头 |
| `workbench.css` | 时间条、事实行、动作行、参数面板（区块按内容取宽、整行装不下才换行） |

不套 `@layer`：未分层的普通声明**无条件胜出**于任何层，分层与未分层混写会让层序静默失效。
一个声明只写一遍；**控件高度只有一套**的落点是 `primitives.css` 里那组共用选择器，
五种控件各自只调 `padding-inline`，新增控件并入这一组，不得自带高度或字号。

需要手写 `-webkit-` 前缀的地方（`backdrop-filter`）就手写：Bun 的 CSS 压缩器不会替你补，
漏掉它只会在 Safari 上静默失效，而本机 Chromium 评测台看不见。`bench/scale.ts` 有一条产物断言盯着它。

## 评测台按语义类名取样

`bench/scale.ts` 与 `bench/smoke.ts` 直接用类选择器取元素（`.act` / `.params .chip` /
`.params .num` / `.icon-btn` / `.drop-act` / `.spec` / `.spec-head` / `.facts` / `.app` /
`.shell` / `.head h1`）。不给组件加 `data-*` 中转：类名本身就是稳定的语义钩子，
多一层只会让同一件事有两个出处。反过来说，这些类名是**契约**，改名要同步改 `bench/`。

## PWA 与离线

产物另有三样：`sw.js`、`manifest.webmanifest` 与 `icons/`，都由 `bun run build:web` 定夺。

- **manifest 立在 `src/` 根**（与 `index.html` 同级），因为 `scope` 与 `start_url` 都写 `"./"`：
  它一旦挪进子目录，这两个值就会被解析成那个子目录，装出来的应用直接打不开。
- **manifest 的内容不经过打包器改写**，所以它引的 `icons/icon-192.png`、`icons/icon-512.png`
  由 `build.ts` 按字面路径原样落进 `dist/`；只有 HTML 直接引的 `apple-touch-icon` 照常走哈希输出。
- **图标**：iOS 不认 SVG，`apple-touch-icon` 必须是 PNG。三个 PNG 由 `src/icons/icon.svg` 光栅化而来。
  那份图稿是 `src/logo.svg`（favicon）去掉 `rx=8` 的圆角、四条竖杠**以中心为原点等比缩到 0.82**
  得到的（`x' = 16 + (x − 16) · 0.82`，`w' = 0.82w`，`y'` 按底边对齐），满幅底色加内容缩进安全区，
  一份就能同时声明 `any` 与 `maskable`。**两份 SVG 是同一枚标识的手写源，改一份必须改另一份**；
  交叉说明写在 `src/icons/icon.svg` 的注释里，favicon 那份刻意不留注释 —— 它进产物，多一行注释
  就多 46% 的字节。
  本机没有 rsvg/inkscape，光栅化用的是仓库自带的 Chromium 快照：照 `bench/cdp.ts` 的 `open()`
  开该 SVG，`Emulation.setDeviceMetricsOverride` 定尺寸后 `Page.captureScreenshot`（180 / 192 / 512
  各一张）。一次性产物，改图稿要重出，别把这套塞进构建。
- **Service Worker**：应用壳由 `build.ts` 定出来（见下一条），连同缓存名一起注入 `sw.js` 的
  `__SHELL__`（`{ cache, home, files }` 一个对象）。音频解码器是动态 import 的分包，不进壳，
  改由运行期缓存兜住 —— 用过一次的格式此后离线可用。导航走网络优先，其余同源 GET 走缓存
  优先但**只收非 HTML 响应**（理由见下面的 SPA 回落那条）；带 `Range` 的请求不碰，免得把半截响应
  写进缓存。
  `define` 注入**对象字面量**时会在每个使用处整份内联 —— 实测用 6 次就把 `sw.js` 从 1.1 KB 撑到
  2.0 KB，所以 `sw.ts` 顶部一次性解构成 `CACHE` / `home` / `files`，Bun 会把它折叠掉，产物回到
  1.1 KB。
  壳清单是**相对路径全链路**（manifest 的 `"./"`、`new URL(entry, sw.js 的位置)`、注册的 `"./sw.js"`），
  所以子路径部署天然成立，不需要任何一处写死应用根。
- **应用壳是推出来的，不是挑出来的**。三处来源各自独立，取并集后排序（排序是为了让指纹与输出稳定，
  打包器给产物的顺序不是契约）：
  ① **入口产物** —— `result.outputs` 里 `kind === "entry-point"` 的那些：每个 HTML 与它的入口脚本。
  ② **HTML 引用** —— 产物 `index.html` 上的 `./` 引用：样式、图标、manifest，以及 Bun 自插的
  `<link rel="modulepreload">` 共享 chunk。
  ③ **manifest 图标** —— 它的内容不经过打包器改写，按字面路径落盘后自己补进清单。
  解码器分包是 `kind === "chunk"` 且 HTML 不引，两头都不沾，天然落在壳外；`fade-demo.ogg` 同理
  —— 它是静态 import，但 HTML 没引用它。**代码型资源看静态还是动态可达，URL 型资源只看 HTML
  引没引**，两条规则清清楚楚，于是「壳 = 首屏所需」不需要任何排除名单。
- **缓存名 = 壳的内容指纹**（名字加字节一起喂给 `Bun.hash`）。带哈希的资源改内容会连名字一起改，
  `index.html` 与图标不会，所以指纹取字节而不是清单 —— 壳里任何一个字节变了就换一代，`activate`
  再删掉其余缓存。取清单哈希的旧写法漏得掉「只改 HTML 标记」这一类：实测那样改完清单不变、缓存名
  不变、`sw.js` 字节也不变，浏览器连更新都不装。
- **构建期只剩两道校验**。① 每一项都得真在 `dist/` 里 —— manifest 的图标是手写路径，是唯一真会
  写错的来源，而写错只会让条目静默消失，这条把它变成硬失败。② `dist/sw.js` 里不许残留 `__SHELL__`
  —— `define` 是文本替换，键名写错**不会让构建失败**（实测三态：注入了标识符就没了，漏一个就整段
  留在产物里），而它炸在最没人看的那个控制台里。
  原先另外两道（「每个 CSS 与入口产物必须在壳里」「只被动态 import 的产物不许进壳」）已经变成上面
  的推导方式本身：入口产物由 ① 保证，动态分包因为不是 `entry-point` 也进不来 —— **不必再拿断言
  去盯自己刚推出来的结论**。「`sw.js` 不许进壳」由门禁盯真实缓存，构建期不重复（它归属 worker 构建，
  本来就到不了这份清单）。
- **正则在产物上成立不是巧合**。实测 `Bun.build` 会把 `href='./x'`、`href=./x`、`href="icons/x.png"`
  一律改写成 `href="./<name>-<hash>.<ext>"`；而绝对路径 `/icons/x.png` 与 `srcset="a 1x, b 2x"`
  直接构建失败（`Could not resolve`）。所以「漏匹配」只剩「正则自己失灵」一种可能，而 CSS 与入口
  脚本另有来源 ① 兜底 —— 壳就算缩水也不会缩成一条 `index.html`。Bun 还会替静态 chunk 自己插
  `<link rel="modulepreload" href="./chunk-….js">`，形态相同，自动落进壳。
- **预缓存缺一项就不接管**：`install` 用 `Promise.all`，任一壳资源失败即安装失败，旧的 Worker 继续
  服役，浏览器下次导航重试。改用 `allSettled` 的话，缺一项的半壳照样激活，要等到断网白屏才暴露，
  而那时用户和日志之间已经隔了很远。
- **更新语义 = 下次启动接管**。`install` 里刻意**不调 `skipWaiting`**：新版装好就停在 `waiting`，
  旧 Worker 与旧缓存继续服务，等标签页全关掉、下次启动才 `activate` 并清旧缓存。发了 `skipWaiting`
  的话，新版一 `activate` 就整代删掉旧缓存，而正在用的页面还揣着旧的 HTML —— 它剩下没加载过的动态
  分包会连同旧缓存一起消失。**首次安装没有旧 Worker，本来就直接 `activate`**，所以「首次访问即离线
  可用」不靠 `skipWaiting`，靠 `clients.claim`；门禁断言「首次加载后就受控」钉的正是这条。
- **SPA 回落出来的 HTML 不许进运行期缓存**。部署端配的是 `not_found_handling: single-page-application`：
  任何不匹配实体文件的路径（**包括 `.js`**）都会拿回 200 的 `index.html`。这种响应一旦被缓存优先的
  那一支写进缓存，一次偶发的缺文件就固化成永久坏死 —— 此后每次取到的都是这份 HTML，直到缓存换代。
  所以运行期这一支只收 `response.ok` 且 `Content-Type` 不以 `text/html` 开头的响应；`index.html` 归
  预缓存清单管，不从这条路走。
- **只在生产注册**：`frontend.tsx` 以 `import.meta.hot` 为界，dev 下不注册，免得 HMR 被旧缓存顶着。
  dev 下 Bun 把 `manifest` 改写成 `/_bun/asset/<hash>.<ext>`，manifest 内部的相对图标路径因此解析不到；
  这是 dev 才有的现象，图标只在产物里成立，不必去修。
- **门禁**：`bun bench/offline.ts`。**只加载一次页面**，后面所有断言都建立在这一次之上 ——
  若先加载第二遍再断网，安装期什么都没预热也照样能过（第一遍顺手就把壳填满了）。
  其中的「断网」是直接关掉 HTTP 服务，不是 CDP 模拟 —— 实测 `Network.emulateNetworkConditions`
  对回环不起作用，探针的对照地址照样拿到 404，整段断言会是空的。
  离线的 200 用 `fetch(url, { cache: 'reload' })` 判定：该模式强制绕过 HTTP 缓存，源又真的不可达，
  此时还能拿到 200 就只可能是 Service Worker 给的。预缓存是**逐项**对照的：从页面里现取 manifest 与
  两份图标，凑齐 8 项才算数（等凑齐再判，免得把「装到一半」误报成「漏装」），并钉住 `sw.js` 不在其中。
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
**本仓库不引这一套**（2026-09 在临时目录实测过，别再重新论证）：它是 Vite 插件，本项目没有 Vite；
裸 `workbox-build` 的 `injectManifest` 能在 Bun 下跑通，但代价是 338 个包 / 101 MB，同功能的
`dist/sw.js` 31.0 KB（gzip 9.9）对手写的 1.1 KB（gzip 0.6），且默认 `globPatterns: ['**/*']` 会把
全量 2.0 MB 扫进壳 —— 本仓库的壳是 286 KB / 8 项，正好把 1.58 MB 动态分包挡在外面，
这是设计不是巧合。另：`injectManifest` 默认输出保留裸 `import`（module SW），得配 `rollupFormat: 'iife'`
才回到 classic；Bun 直接出 classic，0 配置。

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

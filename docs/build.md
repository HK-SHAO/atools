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
- **Service Worker**：`dist/index.html` 直接引用到的资源就是应用壳，`build.ts` 把这份清单注入
  `sw.js` 的 `__PRECACHE__`，缓存名取清单的哈希，改了哪块只换哪块。音频解码器是动态 import 的分包，
  不进壳，改由运行期缓存兜住 —— 用过一次的格式此后离线可用。导航走网络优先（`sw.js` 每次导航都会被
  重新校验，发新版即接管），其余同源 GET 走缓存优先；带 `Range` 的请求不碰，免得把半截响应写进缓存。
  壳清单是**相对路径全链路**（manifest 的 `"./"`、`new URL(entry, sw.js 的位置)`、注册的 `"./sw.js"`），
  所以子路径部署天然成立，不需要任何一处写死应用根。
- **构建期两道校验**。壳清单是从 `index.html` 里正则推出来的，引用写错只会让条目静默消失、不会让
  构建失败，所以 `build.ts` 逐项核实它们确实落进了 `dist/`（含 manifest 自己引的两份图标）。另一条
  是反向不变量：`sw.js` 一旦被 `index.html` 直接引到就立刻终止构建 —— 它进了壳，浏览器此后只会拿到
  旧的 Service Worker，再也发不出新版。
- **预缓存缺一项就不接管**：`install` 用 `Promise.all`，任一壳资源失败即安装失败，旧的 Worker 继续
  服役，浏览器下次导航重试。改用 `allSettled` 的话，缺一项的半壳照样激活，要等到断网白屏才暴露，
  而那时用户和日志之间已经隔了很远。
- **取舍：接管是即时的，缓存是整代删的**。`skipWaiting` + `clients.claim` 让首次访问当场受控、当场
  离线可用（门禁正是靠这条断言「注册完就受控」）；代价是发新版时，旧标签页里还没加载过的动态分包
  会因为旧哈希随旧缓存一起删掉而取不到。本工具的用法是「拖进来、拿到图、关掉」，跨版本长期挂着的
  标签页不是它的场景，所以选了即时接管。
- **只在生产注册**：`frontend.tsx` 以 `import.meta.hot` 为界，dev 下不注册，免得 HMR 被旧缓存顶着。
  dev 下 Bun 把 `manifest` 改写成 `/_bun/asset/<hash>.<ext>`，manifest 内部的相对图标路径因此解析不到；
  这是 dev 才有的现象，图标只在产物里成立，不必去修。
- **门禁**：`bun bench/offline.ts`。其中的「断网」是直接关掉 HTTP 服务，不是 CDP 模拟 ——
  实测 `Network.emulateNetworkConditions` 对回环不起作用，探针的对照地址照样拿到 404，整段断言会是空的。
  离线的 200 用 `fetch(url, { cache: 'reload' })` 判定：该模式强制绕过 HTTP 缓存，源又真的不可达，
  此时还能拿到 200 就只可能是 Service Worker 给的。预缓存是**逐项**对照的：从页面里现取 manifest 与
  两份图标，凑齐 8 项才算数（等凑齐再判，免得把「装到一半」误报成「漏装」），并钉住 `sw.js` 不在其中。

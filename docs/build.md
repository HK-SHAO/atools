# 构建与样式管线

纯静态产物，无后端。源码一份，出两个包（见 `build.ts`）：`dist/` 目录给静态服务器，
`toy.zip` 给 B站 Toy。构建不带任何插件，Bun 原生处理 `import "./x.css"` 与 `import x from "./x.ogg"`。

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

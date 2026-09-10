# 构建与样式管线

纯静态产物，无后端。源码一份，出两个包（见 `build.ts` 顶部）：`dist/` 目录给静态服务器，
`toy.zip` 给 B站 Toy。

## 样式：StyleX 编译期抽取

组件样式写在 `stylex.create` 里，编译期抽成原子类，**运行时不带引擎**。项目里已无 CSS-in-JS 运行时。

| 阶段 | 入口 | 插件 | 产物 |
| --- | --- | --- | --- |
| 开发 | `bun dev` → `src/index.ts` | `stylex.dev.ts`（经 `bunfig.toml` 的 `[serve.static]`） | `.cache/stylex.dev.css`，由 `/stylex.dev.css` 路由供出 |
| 生产 | `bun run build:web` | `@stylexjs/unplugin` 的 esbuild 适配器 | 追加进 Bun 抽出的那个 css chunk |

两处都显式 `useCSSLayers: false`。StyleX 默认开 `@layer`，而未分层规则**无条件**胜过分层规则，
一旦两边不一致，同一份样式在 dev 和 prod 的胜负关系会反过来。关掉后 StyleX 改走 `:not(#\#)`
特异性加权，稳定压过 `src/styles/` 里的基础样式。

留在 `src/styles/` 的只有 CSS 自定义属性、`@property` 注册、reset 与容器查询尺度系统——
这些是「令牌」而非组件样式，本就不该由 StyleX 表达。

## Bun 的三处硬约束

均已在 `build.ts` / `stylex.dev.ts` 里落地，改动前先读这里。

**一、`outdir` 必须是绝对路径，且不能传 `metafile`。**
StyleX 的 esbuild 适配器有两套定位 css 产物的分支：给了 `metafile` 就按 esbuild 语义
`path.join(cwd, 产物键)` 找，而 Bun 给的键是**相对 outdir** 的（`./chunk-xxxx.css`），
路径对不上 → `readFileSync` 抛错 → 被 `try{}catch{}` 吞掉 → **样式静默全部丢失**。
不传 `metafile` 才落到 `readdirSync(outdir)` 那条正确分支。
（官方文档 `installation/bun` 写的是 `metafile: true`，那是 esbuild 语义，在 Bun 上不成立。）

**二、二进制资源必须先被一个 onLoad 截胡。**
`@stylexjs/unplugin` 没给自己的 esbuild 插件设 `onLoadFilter`，unplugin 于是默认 `filter: /.*/`。
它的 transform 钩子遇到非 JS 文件会**裸 `return`**（返回 `undefined`），而 Bun 1.4.3 在
「onLoad 匹配上了却返回 undefined」时直接 panic（`index out of bounds: the len is 0 but the index is 0`）。
`build.ts` 里的 `asset` 插件排在最前，用 `loader: "file"` 显式接管这些扩展名，
既避开 panic，产物命名与 Bun 默认行为一致。

**三、dev 期 CSS 落在 `.cache/`，不落 `dist/`。**
`bench/scale.ts` 断言 `dist/` 里只有一个 css 产物。dev 产物混进去会污染这个前提，
也让 `dist/` 不再是纯粹的生产产物。

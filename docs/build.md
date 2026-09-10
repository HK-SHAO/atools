# 构建与样式管线

纯静态产物，无后端。源码一份，出两个包（见 `build.ts` 顶部）：`dist/` 目录给静态服务器，
`toy.zip` 给 B站 Toy。

`dist/` 是默认产物，多文件，交给任意静态服务器；引用全为相对路径，兼容 B站 Toy 的
`/toy/<slug>/` 子路径部署。`bun run build:toy` 在原地产出 `dist/` 之后把它压成 `toy.zip`，
`index.html` 落在包根。zip 是「更新」语义（已存在的包不会自动剔除消失的文件），
所以每次先删掉旧包再压，且压的是目录里的**内容**（`cd dist && zip ... .`）而不是目录本身。

## 样式：StyleX 编译期抽取

组件样式一律写在 `stylex.create` 里，编译期抽成原子类，**运行时不带引擎**。项目里已无 CSS-in-JS 运行时。

| 阶段 | 入口 | 插件 | 产物 |
| --- | --- | --- | --- |
| 开发 | `bun dev` → `src/index.ts` | `stylex.dev.ts`（经 `bunfig.toml` 的 `[serve.static]`） | `.cache/stylex.dev.css`，由 `/stylex.dev.css` 路由供出 |
| 生产 | `bun run build:web` | `@stylexjs/unplugin` 的 esbuild 适配器 | 追加进 Bun 抽出的那个 css chunk |

两处都显式 `useCSSLayers: false`。StyleX 默认开 `@layer`，而未分层规则**无条件**胜过分层规则，
一旦两边不一致，同一份样式在 dev 和 prod 的胜负关系会反过来。关掉后 StyleX 改走 `:not(#\#)`
特异性加权，稳定压过 `base.css` 里的归零规则。

`src/styles/base.css` 是仓库里**唯一**的 CSS 文件，只装 StyleX 表达不了的两件事：

- `@property --u` / `--c-vh` 的注册。StyleX 的 API 面没有 `@property`，而尺度系统必须靠它把
  `cqi/cqb` 在 `.shell` 上就折成绝对 px（见下文与 AGENTS.md 的「尺度系统」）。
- 宿主文档的归零：`*` 的 `box-sizing`、`html/body/#root` 的铺满与不滚动、表单控件的继承字体、
  `prefers-reduced-motion` 的全局降速。StyleX 只产出类选择器，够不到元素选择器。

**设计令牌与控件几何都在 StyleX 里**，在 `src/ui/kit.ts`：调色板与尺度令牌是 `tokens` 上的
自定义属性（`stylex.create` 会把 `--*` 原样透传，不做哈希），五种控件（`act` / `chip` / `num` /
`icon-btn` / `drop-act`）共用一个 `SIZED` 基座，只各自调 `padding-inline` —— 「控件高度只有一套」
这条约定的单一落点。留成 CSS 只会让同一件事有两个出处。

**共享的样式片段必须以 `kit` 的样式条目落点**，不能导出裸常量给别的模块用。跨模块 import 到
`stylex.create` 里的值只有两种被认：`stylex.create` 的产物（如 `kit.chip`）与 `defineVars` 的变量。
裸对象或函数会被当成主题导入，报 `Could not resolve the path to the imported file`（要求
`.stylex.js` / `.stylex.ts` 扩展名）；即便把文件改名成 `.stylex.ts` 绕过它，求值期仍会报
`A style value can only contain an array, string or number`。所以焦点环与 squircle 圆角写成
`kit.focusSm` / `kit.squircle`，在调用点用 `stylex.props` 组合 —— 实测这样产出的 CSS 与把声明
内联在各模块里逐字节一致（StyleX 会把相同的声明去重成同一个原子类）。

## 评测台按 `data-el` 取样

StyleX 把类名换成原子哈希，所以组件上一律不再有语义类名。`bench/scale.ts` 与 `bench/smoke.ts`
改按 `data-el="<名字>"` 这个稳定钩子取元素（`app` / `shell` / `title` / `params` / `chip` /
`num` / `act` / `icon-btn` / `spec` / `spec-head` / `facts` / `drop-act`）。列表只收评测台真的会
取的元素，新增可测元素时才补这个属性，别指望类名。

## Bun 的三处硬约束

均已在 `build.ts` / `stylex.dev.ts` 里落地，改动前先读这里。

**一、`outdir` 必须是绝对路径，且不能传 `metafile`。**
StyleX 的 esbuild 适配器有两套定位 css 产物的分支：给了 `metafile` 就按 esbuild 语义
`path.join(cwd, 产物键)` 找，而 Bun 给的键是**相对 outdir** 的（`./chunk-xxxx.css`），
路径对不上 → `readFileSync` 抛错 → 被 `try{}catch{}` 吞掉 → **样式静默全部丢失**。
不传 `metafile` 才落到 `readdirSync(outdir)` 那条正确分支。
（官方文档 `installation/bun` 写的是 `metafile: true`，那是 esbuild 语义，在 Bun 上不成立。）

**二、非代码资源必须先被一个 onLoad 截胡。**
`@stylexjs/unplugin` 没给自己的 esbuild 插件设 `onLoadFilter`，unplugin 于是默认 `filter: /.*/`。
它的 transform 钩子遇到非 JS 文件会**裸 `return`**（返回 `undefined`），而 Bun 1.4.3 在
「onLoad 匹配上了却返回 undefined、且没有别的插件接手」时直接 panic
（`index out of bounds: the len is 0 but the index is 0`）。`build.ts` 的 `asset` 插件用
「不是代码就当资源」的过滤器把这类文件交给 `loader: "file"`，既避开 panic，产物命名与 Bun 默认一致，
也不必维护扩展名清单。实测 `loader: { ".ogg": "file" }` 这类构建选项**不能**替代它：
插件的 onLoad 依旧命中并返回 undefined。

**三、dev 期 CSS 落在 `.cache/`，不落 `dist/`。**
`bench/scale.ts` 断言 `dist/` 里只有一个 css 产物。dev 产物混进去会污染这个前提，
也让 `dist/` 不再是纯粹的生产产物。

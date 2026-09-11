# AGENTS.md

音频 ↔ 频谱图双向转换工具。Bun + React（打包、本地服务、单元测试、包管理全在 Bun 内），无后端、无数据库。运行时依赖仅 react/react-dom 与 `@audio/*` 解码器（动态 import 单独分包，按需加载）。

## 命令

```bash
bun install
bun dev                  # 开发服务器 http://localhost:3000（Bun 的 HTML 路由 + HMR）
bun start                # 静态服务构建产物 dist/，本地验 PWA 与离线
bun run typecheck        # `tsc -b`：两个工程一起检查（app / bun，见下）
bun run lint             # oxlint（含 React Compiler 那一组规则）
bun run test             # 全量单元测试（bun test；`bun test --watch` 进监听模式）
bun run test:kernel      # 内核白盒门禁：`moon test --release --target wasm`
bun run moon:ports       # 内核同一份源码在 js / native 上也要能编（「只用标准库」的可证伪形式）
bun run bench:kernel     # 内核自带基准：`moon bench --release --target wasm`
bun run bench:moonebench # `moon bench` 读数的归属：同一份产物拿到 V8 里量（先 bench:kernel:build）
bun run build:web        # 生产构建 → dist/
bun run build:wasm       # 单独重编数值内核（--force 全量重编，否则按 mtime 判 stale）
bun run deploy           # build:web → Cloudflare 纯静态部署（配置在 cloudflare/wrangler.jsonc）
bun run quality          # 算法消融：15 用例 × 6 指标，改数值层前后逐项比（--gate 出门禁退出码）
bun run kernel           # 整链计时，判据是**实时倍率**（实测 0.004~0.007×，门禁 0.05×）
bun bench/run.ts         # 浏览器端到端评测（`CASES` / `FILES` 可选过滤）
bun bench/offline.ts     # PWA 门禁：可装、预缓存逐项入缓存、断网可用（先 build:web）
bun run perf             # 性能体检：重采样倍数与相位组合门禁，外加页面主线程长任务
bun bench/ui.ts          # 界面链门禁：真页面走 演示 → 质检 → 重建相位，零异常（先 build:web）
```

每个评测台的判据、参数与环境变量见 `bench/README.md`。

包管理、打包、本地服务、单元测试全在 Bun 内（`bun install` / `Bun.build` / `Bun.serve` / `bun test`），仓库里没有第二个打包器、也没有第二个测试运行时。`bench/` 那几个驱动也是 Bun 脚本，但它们要的浏览器控制（关掉 HTTP 服务再冷加载、按 device metrics 出图、注入自建 bundle）没有现成的壳，所以静态服务与进程拉起直接用 `node:http` / `node:child_process` —— 在 Bun 上照跑。

**tsconfig 拆两个工程**（`tsconfig.json` 只是 solution）：`tsconfig.app.json`（`app/`，`types` **留空**，只认 `app/assets.d.ts` 的资源声明与 `app/browser.d.ts` 的构建期常量）、`tsconfig.node.json`（`scripts/` / `bench/` / 测试 / `app` 的其余部分，`types: ["bun"]`。名字沿用生态惯用的「非浏览器那一侧」，**不是**说它跑在 Node 上 —— 它只认 Bun 的类型）。拆开是为了**让边界可证伪**：`Bun.*`、`import.meta.dirname`、`process` 在 `app/` 里必须编译不过 —— 它们在本机会跑通，进了浏览器才炸。加一条断言时先故意写一次违例，确认真报错。测试不再单列一个工程：它们与构建脚本跑在同一个运行时上、要同一套类型。

**React Compiler 走 `Bun.build` 的 `reactCompiler: true`**（`scripts/build.ts`），不需要 `@vitejs/plugin-react` + `@rolldown/plugin-babel` 那一串。`.oxlintrc.json` 里那一组 `react/*` 规则是**编译器自己的退让理由** —— 它认不出的写法会静默不优化，于是把同一套校验放进 lint 让「没被优化」可见。当前有 0 条：那四条（`set-state-in-effect` / 依赖数组那三条）一度是有意降级的，对应几处 effect「取消在飞的作业 + 重置派生状态」；现已全部改成**派生** —— 质检结果与它所属的 `spec` 一起存、区间草稿与 `enc.start`/`enc.end` 一起存、播放状态与时间轴长度一起存、清空作业挪进 `clear()` —— 于是 effect 里再没有 setState，四条都按 `error` 钉住（违例验过：注入一个 effect 里同步 setState 的组件，lint 退 1 并报「React Compiler skipped optimizing」）。将来真要偏离，用 `// oxlint-disable-next-line <rule>` 就地说明，不要把整条规则降级。

## 架构

```
app/lib/     算法层（纯函数，无 DOM 依赖）。
             **核心数值只有一份，在 `moon/` 里**：宿主拿不到内核就**当场抛**（`dsp.ts` 的
             `mustKernel`），没有「退回 TS 参照实现」这条路 —— 那条路谁都不维护，留着只会让
             一整遍用例悄悄退化成「参照 == 参照」。
             宿主侧剩下的三块都不是数值实现：`spectrum.ts` 的量化与重建**调度**（fast / fine）、
             `resample.ts` 的相位表重采样、`stft.ts` 的骨架（窗与变换都取自内核表组）。
             数值行为断言一律在 `moon/*_wbtest.mbt`；`bun test` 只管**跨边界与浏览器侧**：
             内核装载与握手（含两个线程各起一份）、视图的寿命、DOM / canvas、端到端契约。
app/ui/      组件与 hooks，只是结构与行为；样式一律在 app/styles/，组件上只有语义类名。
             数值流水线走 Worker（`pipeline.ts` 代理 + `pipeline.worker.ts`）：模块被引入就建
             Worker，内核在 worker 里启动即加载 + 预热；**worker 与主线程各挂一份**（wasm 实例
             不跨线程），主线程那一份由 `frontend.tsx` 顶层同时起。主线程那份只用票根编解码。
             Worker 的地址由入口自己算：`new URL("./pipeline.worker.js", 入口脚本.src)`。名字不带
             哈希是**必须的**（两边得算出同一个地址），拉动态路由见 `docs/build.md` 的「worker 是独立入口」。
             别改成 `import.meta.url`：dev 下 Bun 把它内联成源码的 `file://` 路径，浏览器拉不动。
moon/        数值内核（MoonBit → `moon/_build/…/dsp.wasm`，由 `app/lib/dsp.ts` 导入成产物里的
             一个普通资产）。零 import、只用标准库（`moon.pkg`），所以 js / native 也编得过
             （`bun run moon:ports` 盯着）。三层内存、边界约定、导出面与搬迁流程见 `moon/README.md`。
scripts/     build.ts（编内核 → 打包 worker → 打包应用 → 推应用壳 → 取壳指纹 → 把壳装进 SW）、
             serve.ts（dev 与 --dist 两种模式）、moon.ts（编内核；**被 import 就编一次** ——
             构建、dev、`bun test` 的 preload 都靠这一条，所以没有单独的垫片文件）
app/styles/  样式，`index.css` 一个 `@import` 入口，按 reset → tokens → primitives → layout →
             spectrogram → workbench 分层
app/index.html  唯一入口（Bun 的 HTML loader 的入口约定），与 `frontend.tsx` 同级；它引到的
             一切都在 `app/` 或 `app/public/` 之下，仓库根只留工程配置与文档。
app/public/  按字面路径被引的静态件：`logo.svg`（favicon）、`manifest.webmanifest`、`icons/*.png`。
             **目录名只是位置，Bun 不认 public 语义** —— HTML 里写 `/x` 会被当成文件系统里的
             绝对路径去找，所以引用一律相对。`icons/icon.svg` 是三个 PNG 的 maskable 作图源，
             全仓唯一一件「在 app/ 下却不进产物」的东西。
app/sw.ts    Service Worker（自建预缓存：壳由构建期推出来、以 `PRECACHE` 注入 + 运行期缓存）
fixtures/    单测的音频夹具（10 个真容器样本）
bench/       评测台（`cdp.ts` 会话壳）。quality.ts 与 kernel.ts 不经浏览器；run.ts 跑
             `bench/index.html` 这份自建页；offline.ts / perf.ts / ui.ts 驱动真实 dist 页面
docs/        format-spec.md（图片格式契约）、algorithms.md（算法原理与实测）、build.md（构建、
             样式与 PWA 管线）、migration.md（迁移里程碑与消融记录）
```

数据流：`pcm → encode() → Spectrum{levels, phaseCos/Sin, Meta} → PNG/容器 → 读图 → Spectrum → synthesise() → pcm`。`Meta` 是唯一权威参数（sr/win/hop/frames/bins/samples/bits/ref/exact），随 tEXt、文件名、条码票根三路冗余传递。

关键模块职责：

- `dsp.ts` 内核装载、握手、访存（`Job` / `Slot` / `Plan` 三件套，**视图只现切、不持有**）；`startKernel({ fft }, source = kernelUrl())` 是每一侧的启动入口（同一线程只加载一次），`source` 只留给测试传字节。
- `stft.ts` STFT 宿主骨架：一个 `Frames` 占一个内核会话槽，窗与变换都来自内核表组。
- `rtisi.ts` / `stub.ts` / `phase.ts` 三个薄壳（上传与分块推进），实现分别在 `moon/rtisi.mbt` / `moon/stub.mbt` / `moon/pghi.mbt`。
- `spectrum.ts` 量化与重建调度（fast / fine，已裁定**不搬**：实测 30 s 细档合计 1.7 ms，是 `synthesise` 135 ms 的 1.2%，且搬它要把作业句柄穿进三个消费者 —— 见 `docs/algorithms.md`）；`image.ts` 容器嗅探、认图分级（可逆 / 紧凑 / 降级 / 通用）、缩放适配。
- `audio.ts` 解码链与 `containerRate`；`pipeline.ts` + `pipeline.worker.ts` 跨线程代理（按 `scope` 分工、消息式取消）。

**播放与「存音频」走 `synthesise(spec)` 的结果，不是编码前的原声。** 位深 / 窗长这类参数只改图，放原声等于让它们静默失效（2bit 与 8bit 听起来会一模一样）；这份还原结果按需算、随参数作废（`useStudio` 的 `listen`），时间轴长度一律取自 `meta.samples / meta.sr`。**这条没有自动门禁**（原先守它的界面冒烟台已删）：动播放链要人工核对 2bit 与 8bit 两次播出的 PCM 必须不同。

解码链（原生优先 / 失败按嗅探落 WASM 兜底、Ogg 按首包魔数定引擎序、`OfflineAudioContext`、按容器速率建上下文、M4A 刻意不读）的原理与实测见 `docs/algorithms.md` 的「解码链路与覆盖面」，`audio.ts` 是那一节的实现。

## 样式

样式就是 CSS，分层放在 `app/styles/`，`index.css` 是唯一入口，`frontend.tsx` 是唯一导入点。组件只产出结构与语义类名，不写行内样式 —— 只有运行期才知道的值例外（如进度条宽度）。不套 `@layer`（未分层的普通声明无条件胜出于任何层），不引 CSS-in-JS，不引自动前缀插件；需要 `-webkit-` 就手写。

「控件高度只有一套」的落点是 `primitives.css` 那组共用选择器（`act` / `chip` / `num` / `icon-btn` / `drop-act` 同高同玻璃表面，各自只调 `padding-inline`）；新增控件并入这组，不得自带高度或字号。

**这些类名同时是评测台的取样点，改名要同步改 `bench/`。** 细节与产物断言见 `docs/build.md`。

## 尺度系统

`.app` 是 `container-type: size` 的容器，`.shell` 是它上面的令牌根 —— 容器查询单位只认**祖先**容器，令牌根必须在容器下一层。`--u` 由 `cqi/cqb` 折线算出，并以 `@property --u { syntax: "<length>" }` 注册：注册后它才在 `.shell` 上解析成绝对 px 再随继承下发；不注册则 `cqi` 留在令牌里、到使用点才解析，会被使用点最近的 `container-type` 容器抢走，卡片内所有尺寸静默错位。**这条没有自动门禁**（原先守它的尺度台已删）：改 `tokens.css` 后要人工把 `.app` 缩到窄容器看一眼。仓库里没有别的容器查询，`.app` 是唯一的查询容器。

## Rules

- 克制、克制、克制
- 权衡取舍、取舍、取舍
- 设计、工程、架构、模块、代码要优先遵循 apple、google 规范
- 代码、交互、UI、文案：精悍、简约、易懂、零冗余
- 少即是多，不留任何债务，不约束现在与未来
- 有特别多报酬、精力和时间，“沉没成本”始终不影响判断、规划、执行
- 高内聚低耦合、解耦、模块化、易理解、易维护、非必要不注释、零注释（要让工程、架构、代码本身易理解，而不是依靠注释）
- 第一性原理是用户体验、玩家体验、遵守规则
- 积极采用或参考可靠的经验、轮子，引入依赖项之前要研究是否值得
- 能用标准库就用标准库，不造轮子；判「有没有现成的」要全仓扫一遍，不为历史妥协

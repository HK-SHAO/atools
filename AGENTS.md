# AGENTS.md

音频 ↔ 频谱图双向转换工具。Vite + React，无后端、无数据库。运行时依赖仅 react/react-dom 与 @audio/* 解码器（AMR、AAC/ALAC、MP3、WAV、Vorbis、Opus、FLAC，动态 import 单独分包，按需加载；解码链 = 浏览器原生 decodeAudioData 优先，失败按嗅探落 WASM 兜底，Ogg 按首包魔数定引擎序；原生解码一律按容器里的采样率建上下文，见 `audio.ts` 的 `containerRate`，M4A 刻意不读）。

## 命令

```bash
bun install
bun dev                  # 开发服务器 http://localhost:3000（源码直出 + HMR）
bun start                # 静态服务构建产物 dist/，本地验 PWA 与离线
bun run test             # 全量单元测试（vitest，Node 上跑；`npx vitest` 可进监听模式）
bun run test:kernel      # 内核白盒门禁：`moon test --release --target wasm`
bun run bench:kernel     # 内核自带基准：`moon bench --release --target wasm`
bun run build:web        # 生产构建 → dist/（build:toy 另出 toy.zip）
bun run build:wasm       # 单独重编 MoonBit 数值内核（--force 全量重编，否则按 mtime 判 stale）
bun run deploy           # build:web → Cloudflare 纯静态部署（配置在 cloudflare/wrangler.jsonc）
bun run quality          # 算法消融：15 用例 × 6 指标，改数值层前后逐项比
bun run kernel           # 内核 A/B：同一批用例在「内核挂上」与「摘掉（TS 参照）」两条路各跑一遍，比时间也比结果
bun bench/run.ts         # 浏览器端到端评测（CASES='[...]' FILES='voice/greeting.mp3' 可选过滤）
bun bench/offline.ts     # PWA 门禁：manifest 可装、iOS 头标签齐备、预缓存逐项入缓存、断网可用；只加载一次页面，另验 SPA 回落不投毒、新版 SW 停在 waiting（先 build:web）
bun run perf             # 性能体检：重采样相位表倍数 + 相位数最多组合「不得慢于逐样点」的门禁 + 页面主线程长任务
```

包管理一律 Bun（`bun install` / `bunx`）。单元测试与构建不绑运行时 —— `vitest` / `vite` 在 Node 上同样跑得通；
`bench/` 那三个**真实 Chromium** 的驱动是 Bun 脚本（要用 `Bun.serve` 起本地服务、`Bun.spawn` 拉浏览器），
它们的浏览器控制（关掉 HTTP 服务再冷加载、按 device metrics 出图、注入自建 bundle）vitest 的 browser mode 表达不了。

## 架构

```
app/lib/     算法层（纯函数，无 DOM 依赖；单测跑在 vitest 上，不绑运行时）
             密集计算的**两份实现**：内核（moon/，默认走它）与同文件的 TS 参照实现（内核没挂上、
             或会话槽占满时退回）。逐位/ulp 等价由单测守，谁快由 `bun run kernel` 守。
moon/        数值内核的 MoonBit 源，由 scripts/moon.ts 编成 wasm/dsp.wasm。
             两根轴：**表组**（按窗长缓存、只读，plan.mbt）与**会话槽**（工作区，有限池，session.mbt）。
             热循环一律 unsafe_get/unsafe_set —— `arr[i]` 编出来是两次不内联的调用（见 docs/algorithms.md）
scripts/     moon.ts（编内核）· pwa.ts（核对产物里的 PWA 契约：预缓存清单 + 内核 preload 的路径与 crossorigin）
             · test-setup.ts（vitest 的 globalSetup：先编一次内核，免得并行起的测试文件互相删中间产物）
             · toy.ts（压 toy.zip）；都是 Vite 插件或构建脚本
app/styles/  样式：index.css 一个 @import 入口，按职责分层放 reset/tokens/primitives/layout/spectrogram/workbench
app/App.tsx  外壳与布局，组合 Dropzone 与 Workbench
app/ui/      组件与 hooks，只是结构与行为；样式一律在 app/styles/ 里，组件上只有语义类名
app/sw.ts    Service Worker（workbox：预缓存清单由 vite-plugin-pwa 构建期注入 + 运行期缓存）
public/      原样复制进 dist/ 根的字面资源：manifest.webmanifest、logo.svg、icons/*.png
fixtures/    单测的音频夹具（10 个真容器样本，三百多 KB）；`app/` 只放会进产物的东西，
             唯一的例外是 `app/icons/icon.svg` —— 三个 PNG 图标的 maskable 作图源，不留注释、不进产物
bench/       评测台（cdp.ts 会话壳）。quality.ts 纯数值消融、kernel.ts 内核 A/B 都不经浏览器，直接 import `app/lib`；
             run.ts 跑的是 `bench/index.html` 这份自建页 —— 它把 entry.ts 打成 bundle、按真实管线调 `app/lib`，
             启动时重打一次以免测到旧代码；只有 offline.ts 与 perf.ts 驱动真实 dist 页面
docs/        format-spec.md（图片格式契约）· algorithms.md（算法原理与实测）· build.md（构建、样式与 PWA 管线）· migration.md（迁移里程碑与消融记录）
```

数据流：`pcm → encode() → Spectrum{levels, phaseCos/Sin, Meta} → PNG/容器 → 读图 → Spectrum → synthesise() → pcm`。`Meta` 是唯一权威参数（sr/win/hop/frames/bins/samples/bits/ref/exact），随 tEXt、文件名、条码票根三路冗余传递。

**播放与「存音频」走的是 `synthesise(spec)` 的结果，不是编码前的原声。** 位深 / 窗长这类参数只改图，放原声等于让它们静默失效（2bit 与 8bit 听起来会一模一样）；这份还原结果按需算、随参数作废（`useStudio` 的 `listen`），时间轴长度一律取自 `meta.samples / meta.sr`，与是否已还原无关。界面上的「听到什么」只有 `synthesise` 这一条路。**这条没有自动门禁**（原先守它的界面冒烟台已删）：动播放链要人工核对 2bit 与 8bit 两次播出的 PCM 必须不同。

关键模块职责：
- `spectrum.ts` STFT 编解码与重建调度（fast/fine 两档）
- `phase.ts` + `rtisi.ts` 相位重建（PGHI 暖启 → RTISI-LA → GL 打磨）
- `image.ts` 容器嗅探、认图分级（可逆/紧凑/降级/通用）、缩放适配
- `stub.ts` 底部条码票根（meta 丢失后的参数权威通道）
- `audio.ts` 解码链（嗅探 → 原生 `decodeAudioData` → WASM 兜底）与 `containerRate`（按容器里的采样率建解码上下文；M4A 刻意不读，理由在该函数的注释里）
- `pipeline.ts` + `pipeline.worker.ts` 数值流水线的跨线程代理与工作线程（重采样 / 编码 / 还原 / 出图；按 `scope` 分工、消息式取消）
- `useStudio.ts` 流水线编排（含按需还原 `listen`），`usePlayback` 播放，`useAudit` 质检，`useDragDrop` 拖放

## 样式

样式就是 CSS，分层放在 `app/styles/`，`index.css` 是唯一入口（reset → tokens → primitives → layout → spectrogram → workbench），`frontend.tsx` 是唯一导入点。组件只产出结构与语义类名，不写行内样式 —— 只有运行期才知道的值例外（如进度条宽度）。不套 `@layer`：未分层的普通声明无条件胜出于任何层。不引 CSS-in-JS，不引自动前缀插件；Vite 把 `@import` 链内联成**唯一**一个 css 产物，需要 `-webkit-` 就手写。

「控件高度只有一套」的落点在 `primitives.css` 那组共用选择器里：`act` / `chip` / `num` / `icon-btn` / `drop-act` 同高同玻璃表面，各自只调 `padding-inline`；新增控件并入这组，不得自带高度或字号。需要 `-webkit-` 前缀就手写，压缩器不会替你补。

这些类名同时是评测台的取样点，改名要同步改 `bench/`。细节与产物断言见 `docs/build.md`。

## 尺度系统

`.app` 是 `container-type: size` 的容器，`.shell` 是它上面的令牌根 —— 容器查询单位只认**祖先**容器，令牌根必须在容器下一层。`--u` 由 `cqi/cqb` 折线算出，并以 `@property --u { syntax: "<length>" }` 注册：注册后它才在 `.shell` 上解析成绝对 px 再随继承下发；不注册则 `cqi` 留在令牌里、到使用点才解析，会被使用点最近的 `container-type` 容器抢走，卡片内所有尺寸静默错位。**这条没有自动门禁**（原先守它的尺度台已删）：改 `tokens.css` 后要人工把 `.app` 缩到窄容器看一眼。仓库里没有容器查询，`.app` 是唯一的查询容器。

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

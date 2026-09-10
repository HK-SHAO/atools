# AGENTS.md

音频 ↔ 频谱图双向转换工具。Bun + React，无后端、无数据库。运行时依赖仅 react/react-dom 与 @audio/* 解码器（AMR、AAC/ALAC、MP3、WAV、Vorbis、Opus、FLAC，动态 import 单独分包，按需加载；解码链 = 浏览器原生 decodeAudioData 优先，失败按嗅探落 WASM 兜底，Ogg 按首包魔数定引擎序）。

## 命令

```bash
bun install
bun dev                  # 开发服务器 http://localhost:3000
bun test                 # 全量测试（bun:test，勿用 jest/vitest）
bun run build:web        # 生产构建 → dist/（build:toy 另出 toy.zip）
bun run deploy           # build:web → Cloudflare 纯静态部署（配置在 cloudflare/wrangler.jsonc）
bun bench/run.ts         # 浏览器端到端评测（CASES='[...]' FILES='voice/greeting.mp3' 可选过滤）
bun bench/scale.ts       # 尺度门禁：字号随容器等比、五种控件同高、令牌锚在当前容器上
```

包管理一律 Bun（`bun install` / `bunx`），不引入 npm/yarn 配置。

## 架构

```
src/lib/     算法层（纯函数，无 DOM 依赖，可被 Bun 直接测试）
src/styles/  样式：index.css 一个 @import 入口，按职责分层放 reset/tokens/primitives/layout/spectrogram/workbench
src/App.tsx  外壳与布局，组合 Dropzone 与 Workbench
src/ui/      组件与 hooks，只是结构与行为；样式一律在 src/styles/ 里，组件上只有语义类名
bench/       无头 Chromium + CDP 驱动真实页面的评测台（cdp.ts 会话壳，run.ts 端到端，scale.ts 守尺度，smoke.ts 冒烟）
docs/        format-spec.md（图片格式契约）· algorithms.md（算法原理与实测）· build.md（构建与样式管线）
```

数据流：`pcm → encode() → Spectrum{levels, phaseCos/Sin, Meta} → PNG/容器 → 读图 → Spectrum → synthesise() → pcm`。`Meta` 是唯一权威参数（sr/win/hop/frames/bins/samples/bits/ref/exact），随 tEXt、文件名、条码票根三路冗余传递。

关键模块职责：
- `spectrum.ts` STFT 编解码与重建调度（fast/fine 两档）
- `phase.ts` + `rtisi.ts` 相位重建（PGHI 暖启 → RTISI-LA → GL 打磨）
- `image.ts` 容器嗅探、认图分级（可逆/紧凑/降级/通用）、缩放适配
- `stub.ts` 底部条码票根（meta 丢失后的参数权威通道）
- `useStudio.ts` 流水线编排，`usePlayback` 播放，`useAudit` 质检，`useDragDrop` 拖放

## 样式

样式就是 CSS，分层放在 `src/styles/`，`index.css` 是唯一入口（reset → tokens → primitives → layout → spectrogram → workbench），`frontend.tsx` 是唯一导入点。组件只产出结构与语义类名，不写行内样式 —— 只有运行期才知道的值例外（如进度条宽度）。不套 `@layer`：未分层的普通声明无条件胜出于任何层。不引 CSS-in-JS、不引构建插件，Bun 原生打包 CSS 与静态资源。

「控件高度只有一套」的落点在 `primitives.css` 那组共用选择器里：`act` / `chip` / `num` / `icon-btn` / `drop-act` 同高同玻璃表面，各自只调 `padding-inline`；新增控件并入这组，不得自带高度或字号。需要 `-webkit-` 前缀就手写，压缩器不会替你补。

这些类名同时是评测台的取样点，改名要同步改 `bench/`。细节与产物断言见 `docs/build.md`。

## 尺度系统

`.app` 是 `container-type: size` 的容器，`.shell` 是它上面的令牌根 —— 容器查询单位只认**祖先**容器，令牌根必须在容器下一层。`--u` 由 `cqi/cqb` 折线算出，并以 `@property --u { syntax: "<length>" }` 注册：注册后它才在 `.shell` 上解析成绝对 px 再随继承下发；不注册则 `cqi` 留在令牌里、到使用点才解析，会被最近的 `container-type: inline-size` 容器（`.card`）抢走，卡片内所有尺寸静默错位。`bun bench/scale.ts` 守这条链。

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

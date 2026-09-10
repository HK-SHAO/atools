# AGENTS.md

音频 ↔ 频谱图双向转换工具。Bun + React，无后端、无数据库。运行时依赖仅 react/react-dom 与 @audio/* 解码器（AMR、AAC/ALAC、MP3、WAV、Vorbis、Opus、FLAC，动态 import 单独分包，按需加载；解码链 = 浏览器原生 decodeAudioData 优先，失败按嗅探落 WASM 兜底，Ogg 按首包魔数定引擎序）。

## 命令

```bash
bun install
bun dev                  # 开发服务器 http://localhost:3000
bun test                 # 全量测试（bun:test，勿用 jest/vitest）
bun run build            # 生产构建 → dist/
bun run deploy           # build:web → Cloudflare 纯静态部署（配置在 cloudflare/wrangler.jsonc）
bun bench/run.ts         # 浏览器端到端评测（CASES='[...]' FILES='voice/greeting.mp3' 可选过滤）
```

包管理一律 Bun（`bun install` / `bunx`），不引入 npm/yarn 配置。

## 架构

```
src/lib/     算法层（纯函数，无 DOM 依赖，可被 Bun 直接测试）
src/styles/  地基样式，唯一入口 index.css 按序 @import：reset（归零）· tokens（色 + `.app` 上的单位与派生令牌）· primitives（卡片、控件组、进度）· layout（外壳与页级骨架）· spectrogram / workbench（组件私有）
src/App.tsx  外壳与布局，组合 Dropzone 与 Workbench
src/ui/      组件与 hooks
bench/       无头 Chromium + CDP 驱动真实页面的评测台（run.ts 每次重打 bundle.js）
docs/        format-spec.md（图片格式契约）· algorithms.md（算法原理与实测）
```

数据流：`pcm → encode() → Spectrum{levels, phaseCos/Sin, Meta} → PNG/容器 → 读图 → Spectrum → synthesise() → pcm`。`Meta` 是唯一权威参数（sr/win/hop/frames/bins/samples/bits/ref/exact），随 tEXt、文件名、条码票根三路冗余传递。

关键模块职责：
- `spectrum.ts` STFT 编解码与重建调度（fast/fine 两档）
- `phase.ts` + `rtisi.ts` 相位重建（PGHI 暖启 → RTISI-LA → GL 打磨）
- `image.ts` 容器嗅探、认图分级（可逆/紧凑/降级/通用）、缩放适配
- `stub.ts` 底部条码票根（meta 丢失后的参数权威通道）
- `useStudio.ts` 流水线编排，`usePlayback` 播放，`useAudit` 质检，`useDragDrop` 拖放，`useContainerScale` 容器尺度

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
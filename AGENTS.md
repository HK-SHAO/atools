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
src/lib/    算法层（纯函数，无 DOM 依赖，可被 Bun 直接测试）
src/ui/     React 组件与 hooks
src/App.tsx 流水线编排：载入 → 裁剪 → 重采样 → 编码/读图 → 合成
bench/      无头 Chromium + CDP 驱动真实页面的评测台（run.ts 每次重打 bundle.js）
docs/       format-spec.md（图片格式契约）· algorithms.md（算法原理与实测）
```

数据流：`pcm → encode() → Spectrum{levels, phaseCos/Sin, Meta} → PNG/容器 → 读图 → Spectrum → synthesise() → pcm`。`Meta` 是唯一权威参数（sr/win/hop/frames/bins/samples/bits/ref/exact），随 tEXt、文件名、条码票根三路冗余传递。

关键模块职责：
- `spectrum.ts` STFT 编解码与重建调度（fast/fine 两档）
- `phase.ts` + `rtisi.ts` 相位重建（PGHI 暖启 → RTISI-LA → GL 打磨）
- `image.ts` 容器嗅探、认图分级（可逆/紧凑/降级/通用）、缩放适配
- `stub.ts` 底部条码票根（meta 丢失后的参数权威通道）

## 约定

- **零注释**：代码自解释；设计依据写进 docs/，不写在代码里
- **格式契约在 docs/format-spec.md**：tEXt 数组、文件名文法、票根位流一经发布即冻结；改格式必须升 `FORMAT_VERSION`
- **CSS 走令牌**：尺寸 = `calc(n × var(--u))`，字号只用 `--fs-lead/--fs-hi/--fs-lo`，间距 1/4 步进；不引入 CSS 框架
- **不用 alert/confirm**，错误与提示走 App 的 error/hint 通道
- 长任务一律支持 `Aborted` 中止 + genRef 竞态守卫；ImageBitmap/AudioContext/canvas 用完即释放

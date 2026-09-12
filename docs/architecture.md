# 架构

浏览器里的音频 ↔ 频谱图双向转换。纯静态 PWA：没有后端、没有数据库、没有账号，全部计算在本机完成。
图片格式契约见 [format-spec.md](format-spec.md)，算法原理与实测见 [algorithms.md](algorithms.md)，构建与部署见 [build.md](build.md)。

## 分层

```
文件 ─┬─ 音频 ─→ 解码（主线程：Web Audio）
      └─ 图片 ─→ sniff（主线程：判断拖进来的是图还是音频）
                     │  递 Blob 与参数
                     ▼
                Worker —— 唯一挂内核的一侧
                ├ resample    重采样
                ├ encode      量化 → 像素 → PNG
                ├ synthesise  相位重建 → 波形
                ├ readImage   图片 → 频谱
                └ png / audit / compare
                     │  递 ArrayBuffer（转移所有权，不留副本）
                     ▼
                Wasm 内核（moon/，零 import，只用标准库）
                FFT · STFT 编解码 · PGHI + RTISI-LA · 票根
```

主线程只做三件 DOM 事：读文件、解码音频、播放。其余全部在 Worker；内核只被 Worker 装载。

## 目录

| 路径 | 职责 |
| --- | --- |
| `app/lib/` | 数值与格式：`spectrum`（量化 / 重建调度）、`phase`（调参表 + PGHI 入口）、`rtisi`、`image`（读图）、`png`、`stub`（票根）、`metric`、`resample`、`audio`（解码）、`wav`、`container`（`sniff` / `ReadMode` / `downloadName`，主线程仅有的三件读图件） |
| `app/lib/dsp.ts` | 宿主与内核之间的唯一接缝：装载、ABI 握手、Plan / Slot / Job 的取址 |
| `app/ui/` | React 交互：`useStudio`（编码流水线）、`usePlayback`、`useAudit`、`pipeline`（Worker 调用面）、`pipeline.worker`（Worker 侧） |
| `app/styles/` | `reset` → `tokens` → `primitives` → `layout` → `spectrogram` → `workbench`，按此顺序导入 |
| `app/sw.ts` | 自建 Service Worker（产物 1.2 KB），运行期没有第三方 |
| `moon/` | 内核源码与它的白盒测试；改法与加模块见 [../moon/README.md](../moon/README.md) |
| `bench/` | 评测基建与浏览器门禁，见 [../bench/README.md](../bench/README.md) |
| `scripts/` | 三个文件：`build.ts`（构建）、`serve.ts`（dev / `--dist` 两种静态服务）、`moon.ts`（内核编译与 `--test` / `--ports` / `--bench`） |

## 三条边界

**一、Worker 是唯一挂内核的一侧。** 主线程不 `startKernel`、不 import 任何要问内核的模块，
只递 `Blob` 与参数、接结果。构建期的第 ④ 道校验挡在入口（见下）。
`startKernel` 仍按侧缓存（同一线程只装载一次），线上只有 Worker 调它。

**二、数组视图只现切、不持有。** `memory.grow` 会把先前切出的视图全部 detach，而开 Plan / Slot / Job
都可能触发它。`Job` / `Slot` / `Plan` 都把「取数组」做成方法、每次调用重切，**`await` 之后必须重新取一次**。

**三、内核的内存回答一切。** 池子大小、窗长上限、容量上限都由内核给，宿主不自己算布局：
Plan 表按窗长缓存，Session slot 池 6 个（必须归还），Job arena 池 4 个（`1 << 26` 元素 / 字节）。
内核说「装不下」一律是返回 0 —— 那是正式语义，不是异常。

## 契约与守着它的门禁

| 契约 | 门禁 | 怎么证伪 |
| --- | --- | --- |
| 主线程不挂内核 | `build:web` 第 ④ 道 | 把 `startKernel` 写回主线程 → 构建退 1 并报出是哪个产物 |
| 产物落在 `dist/` 根 | `build:web` 第 ③ 道 | 给 `naming.chunk` 加 `dir` → 构建失败 |
| 壳清单完整、`PRECACHE` 真注入 | `build:web` ①② + `offline` | 键名写错 → `define` 是文本替换，构建照过、`offline` 红 |
| 量化与相位重建不回归 | `quality --gate` 五项 | 动浮点结合顺序 → 指标变、退 1 |
| 数值逻辑本身 | `test:kernel`（`moon/*_wbtest.mbt`） | 改一个常量 → 白盒红 |
| 跨边界取址与内核装载 | `bun test` | — |
| 整链吞吐 | `kernel`（实时倍率，门禁 `0.05×`） | — |
| 重采样相位表不许慢于逐样点现算 | `perf` | — |
| 真页面交互链与图片数值 | `ui`；`UI_BASELINE=<目录>` 并排比两版 | 把基线演示音频截断 → 两行 `p.facts` 都红 |
| 第一次播放不付音频上下文的一次性开销 | `ui` 数 `AudioContext` 构造次数 | 去掉 `usePlayback` 的预热 → 「演示就绪」时计数为 0，退 1 |
| 子路径部署 | `ui` 的 `SUBPATH=<路径>` | 换成根绝对引用 → 根路径照样绿、子路径红 |
| PWA 可装与断网可用 | `offline` | 断网后内核取不回 200 |

`bun run bench` 是端到端评测台（真 Chromium 跑完整链路，覆盖 PNG / JPEG / 缩放降级），
不是门禁但发布前该跑。**它的 `ms` 列含测量自身的对齐搜索**（O(n·span)，30 秒素材约 2 秒），
读它判性能前先减掉，见 [algorithms.md](algorithms.md)。`moon:ports` 与 `moon fmt --check` 管语言与格式。

跨分支判「有没有下降」用 `git worktree` 出两侧、跑同一批仪器，不要读 diff；比绝对值前先找一列阴性对照，
**低于 1.2 倍的差不要写成结论**。

## 基线（2026-09-12，本机 Bun 1.4.3）

| 检查 | 读数 |
| --- | --- |
| `tsc -b` / `oxlint` | 干净 / 0 warning 0 error（59 文件 163 规则） |
| `bun test` | 142 通过 / 0 失败，164016 次断言（9 文件） |
| `test:kernel` | 48 通过 |
| `quality --gate` | 五项通过 |
| `kernel` | 0.007 / 0.006 / 0.005 / 0.002× 实时 |
| `build:web` | 入口 238.9 KB · CSS 7.2 KB · 内核 43.8 KB · 预缓存 10 项 · `sw.js` 1.2 KB |
| `offline` / `perf` / `ui`（含 `SUBPATH`） | 通过 |

这张快照是本仓唯一的门禁与体积读数落点；时间是本机单次读数，不是跨机器性能承诺。

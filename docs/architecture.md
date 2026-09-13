# 架构

atools 是浏览器本地运行的音频 ↔ 频谱图工具。它是纯静态 PWA，没有后端、数据库或账号。格式契约见 [format-spec.md](format-spec.md)，算法取舍见 [algorithms.md](algorithms.md)，构建与部署见 [build.md](build.md)。

## 数据流

```text
文件 ─┬─ 音频 → 主线程解码 ──────────────┐
      └─ 图片 → 主线程识别容器 ─┐        │
                                ▼        ▼
                         Pipeline Worker
                         ├ 重采样与频谱编码
                         ├ 图片编解码与质检
                         ├ 相位重建与波形合成
                         └ MoonBit Wasm 内核
                                │
                                ▼
                         主线程播放与交互
```

主线程只保留文件输入、音频解码、播放和 DOM。可无头运行的重计算放在 Worker；Worker 是浏览器中唯一装载 Wasm 内核的一侧。

## 边界

**Worker 协议。** `app/ui/pipeline.ts` 定义请求、响应、取消和作用域。返回的数组缓冲转移所有权；主线程仍需播放的输入 PCM 保持可用。Worker 崩溃会拒绝全部待处理请求并释放实例，下一次请求重新连接。

**Wasm ABI。** `app/lib/dsp.ts` 是唯一宿主绑定。启动时核对 ABI 版本、导出集合和线性内存读写。Plan、Slot 或 Job 的创建可能触发 `memory.grow`，所以数组视图按需取得，不能跨 `await` 保存。

**容量。** 内核报告 Plan、Slot 和 Job 的地址与容量；宿主不复制内存布局。池耗尽或形状不合法用返回值拒绝。图片另受 1600 万输出像素、2400 万输入像素和 65535 单边尺寸限制。

**PWA 缓存。** Service Worker 的缓存名包含部署路径和应用壳内容指纹。更新只清理同一路径的旧版本；不同子路径和其他应用缓存互不影响。

## 目录

| 路径 | 职责 |
| --- | --- |
| `app/lib/` | 音频、频谱、图片、PNG、指标与内核绑定 |
| `app/ui/` | React 交互、Worker 客户端与 Worker 入口 |
| `app/styles/` | reset、令牌、基础控件和页面布局 |
| `app/sw.ts` | 无第三方运行期的 Service Worker |
| `moon/` | MoonBit 数值内核与白盒测试 |
| `bench/` | 质量、性能、浏览器和离线门禁 |
| `scripts/` | Bun 构建、开发服务和 MoonBit 驱动 |

## 门禁

| 命令 | 守住的边界 |
| --- | --- |
| `bun run typecheck` / `bun run lint` | TypeScript 与 React 静态规则 |
| `bun run test` | 格式、算法、解码与 Wasm 宿主边界 |
| `bun run test:kernel` | FFT、内存池、PGHI、RTISI 与票根 |
| `bun run quality -- --gate` | 确定性素材的重建质量 |
| `bun run kernel` | 完整数值链低于 `0.05×` 实时 |
| `bun run perf` | 重采样缓存必须快于逐样点计算 |
| `bun run build:web` | 扁平产物、完整壳、SW 注入、主线程无内核 |
| `bun run ui` | 演示、播放、质检、精修和可逆模式 |
| `bun run offline` | 安装、更新、缓存隔离和断网重载 |

`SUBPATH=/path bun run ui` 验证子路径部署；`UI_BASELINE=/old/dist bun run ui` 比较两个构建。真实素材经 PNG、JPEG 和缩放的评测方法见 [bench/README.md](../bench/README.md)。

# 验证

所有脚本由 Bun 运行。浏览器检查自动查找 Chrome / Chromium；找不到时用 `CHROME=/path/to/browser` 指定。

| 命令 | 作用 |
| --- | --- |
| `bun run test` | TypeScript、浏览器 API 适配与 Wasm 边界测试 |
| `bun run test:kernel` | MoonBit 数值内核测试 |
| `bun run quality -- --gate` | 确定性素材的编码与重建质量门禁 |
| `bun run kernel` | 四档完整数值链的实时倍率门禁 |
| `bun run perf` | 重采样缓存相对逐样点计算的性能门禁 |
| `bun run ui` | Chrome 中的演示、播放、质检、精修和可逆模式 |
| `bun run offline` | PWA 安装、更新、缓存隔离和断网重载 |
| `bun run bench` | 真实音频经 PNG、JPEG、缩放后读回的端到端评测 |

`quality` 和 `kernel` 无需浏览器。`ui` 与 `offline` 读取 `dist/`，先运行 `bun run build:web`。

`UI_BASELINE=/path/to/old/dist bun run ui` 比较两份产物。`SUBPATH=/sub/path bun run ui` 验证子路径部署。端到端评测默认读取 `docs/` 下本地音频，也可指定：

```sh
FILES='voice/greeting.mp3' \
CASES='[{"sr":8000,"bits":8,"fineness":1,"fmax":0,"mode":"exact","via":"jpeg"}]' \
bun run bench
```

数值改动先跑 MoonBit 测试、质量门禁和内核性能，再用相同素材与参数比较改动前后。短窗相位重建对浮点微扰敏感，单条素材的小幅升降不能证明改善；结论应来自多素材分布。具体指标与算法限制见 [算法说明](../docs/algorithms.md)，构建和离线规则见 [构建说明](../docs/build.md)。

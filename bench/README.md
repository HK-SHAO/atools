# 验证

所有脚本由 Bun 运行。浏览器检查自动查找 Chrome / Chromium；找不到时用 `CHROME=/path/to/browser` 指定。

| 命令 | 作用 |
| --- | --- |
| `bun run test` | TypeScript、浏览器 API 适配与 Wasm 边界测试 |
| `bun run test:kernel` | MoonBit 数值内核测试 |
| `bun run quality -- --gate` | 确定性素材的编码与重建质量门禁 |
| `bun run kernel` | 四档完整数值链的实时倍率门禁 |
| `bun run bench:kernel:native` | MoonBit release/native 原生微基准 |
| `bun run perf` | 重采样缓存相对逐样点计算的性能门禁 |
| `bun run compare:librosa` | 与 librosa 0.11.0 交叉核验 STFT 数值 |
| `bun run compare:librosa:stft` | 预热后的 `librosa.stft()` 性能基准 |
| `bun run compare:librosa:phase` | 真实素材上比较 PGHI+RTISI-LA 与 fast Griffin-Lim 的重建质量 |
| `bun run compare:librosa:phase-perf` | 预热后的 librosa fast Griffin-Lim 性能基准 |
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

数值验收以独立朴素 DFT 为参考：FFT 相对峰值误差不超过 `1e-12`，逆变换逐样点不超过 8 ULP，Hann 四分之一窗移的平方包络波动低于 `1e-9`。选择数学定义作为固定 oracle，可避免外部库升级改变门禁；需要与 librosa 交叉核验时，应使用相同的周期 Hann、中心填充和单边谱约定。

librosa 对标不进入默认门禁，避免引入 Python 运行时。复现时先在隔离环境安装 `librosa==0.11.0`，再用 `PYTHON=/path/to/venv/bin/python` 运行：数值核验 `compare:librosa`，相位质量 `compare:librosa:phase`，性能 `bench:kernel:native` 配 `compare:librosa:stft` 或 `compare:librosa:phase-perf`。两侧要交替测量各取最快值，不得用 Wasm 数据与 librosa 的 native 数据下结论。

相位质量对标读取 `app/assets/demo.ogg`、`fixtures/speech-nb.amr` 和 `docs/audio-examples/love-story.m4a`；第三段属于不入库的本地评测素材，缺失时脚本直接报错。

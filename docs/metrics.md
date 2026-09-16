# 量化数据

数据记录于 2026-09-16。质量用例使用固定信号或真实素材；性能数据来自当前开发机，取预热后的最快值，相位重建表的两侧交替测量。命令和门限保存在仓库中。

## 容量

| 项目 | 上限 |
| --- | ---: |
| 输入文件 | 64 MiB |
| 图片处理画布 | 2400 万像素，单边 65535 px；更大的图片先缩小 |
| 输出图片 | 1600 万像素，单边 65535 px |
| 音频 | 800 万样本 |
| FFT 窗长 | 256、512、1024、2048、4096 |
| PNG 幅度位深 | 2、4、8 bit；Exact 使用 8 bit 幅度和两路 8 bit 相位分量 |

## 数值误差

`bun run test:kernel` 使用独立朴素 DFT 和解析性质检查 MoonBit 内核。

| 检查 | 门限 |
| --- | ---: |
| 256 点 FFT 对朴素 DFT 的相对峰值误差 | `≤ 1e-12` |
| FFT 后 IFFT 的逐样点误差 | `≤ 8 ULP` |
| Hann 对称误差 | `< 1e-12` |
| `hop=win/4` 时 Hann² 重叠包络波动 | `< 1e-9` |

## librosa 交叉核验

`bun run compare:librosa` 固定使用 librosa 0.11.0，对 8192 个确定性样本逐档比较。两侧统一周期 Hann、`hop=win/4`、中心补零和单边复数谱。

| 指标 | 五档窗长最差值 |
| --- | ---: |
| 复数 STFT 相对峰值误差 | `6.14e-16` |
| 复数 STFT 相对 RMS 误差 | `5.92e-16` |

STFT 差异接近 Float64 舍入极限。

性能比较完整 STFT：131072 个样本、周期 Hann、`hop=win/4`、中心补零、单边复数谱和预分配输出。MoonBit 使用 release/native；另一侧直接调用 `librosa.stft()`。两边预热后取最小值。测试机为 Apple M4；数值越低越快。

| 窗长 | MoonBit native | librosa | MoonBit / librosa |
| ---: | ---: | ---: | ---: |
| 256 | 2.41 ms | 1.15 ms | 2.10× |
| 512 | 2.69 ms | 1.23 ms | 2.18× |
| 1024 | 2.98 ms | 1.26 ms | 2.37× |
| 2048 | 3.19 ms | 1.39 ms | 2.29× |
| 4096 | 3.54 ms | 1.48 ms | 2.39× |

这项共有数值链中，librosa 快 2.10–2.39×。该表衡量 MoonBit native 内核上限；浏览器产品实际运行 Wasm。它不包含本项目的量化、PNG、恢复和交互，也不代表产品端到端性能。

### 相位重建

`bun run compare:librosa:phase` 取三段真实素材各 2.5 秒：`app/assets/demo.ogg` 第 4 秒、`fixtures/speech-nb.amr` 第 6 秒、`docs/audio-examples/love-story.m4a` 第 30 秒。素材统一到 8 kHz，在 `win=512`、`hop=128`、8 次迭代下比较，两侧拿到同一份精确幅度谱，只重建相位。相关与包络越高越好，LSD 与谱收敛越低越好。

| 素材 | 方法 | 相关 | SNR dB | LSD dB | 谱收敛 dB | 包络 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 演示 | PGHI+RTISI-LA | 0.303 | -1.44 | 2.22 | -28.86 | 0.990 |
| 演示 | RTISI-LA 零相位初值 | 0.370 | -1.00 | 2.80 | -25.04 | 0.991 |
| 演示 | Griffin-Lim 随机初值 | 0.354 | -1.07 | 3.26 | -16.97 | 0.968 |
| 演示 | Griffin-Lim PGHI 初值 | 0.291 | -1.51 | 2.04 | -29.43 | 0.990 |
| 语音 | PGHI+RTISI-LA | 0.449 | -0.42 | 1.92 | -32.12 | 0.993 |
| 语音 | RTISI-LA 零相位初值 | 0.375 | -0.97 | 2.36 | -29.73 | 0.977 |
| 语音 | Griffin-Lim 随机初值 | 0.242 | -1.73 | 2.91 | -14.67 | 0.964 |
| 语音 | Griffin-Lim PGHI 初值 | 0.439 | -0.50 | 1.76 | -32.85 | 0.995 |
| 音乐 | PGHI+RTISI-LA | 0.422 | -0.61 | 2.21 | -25.04 | 0.994 |
| 音乐 | RTISI-LA 零相位初值 | 0.416 | -0.64 | 2.60 | -17.91 | 0.968 |
| 音乐 | Griffin-Lim 随机初值 | 0.259 | -1.64 | 3.41 | -14.34 | 0.948 |
| 音乐 | Griffin-Lim PGHI 初值 | 0.378 | -0.92 | 1.91 | -26.73 | 0.995 |

`Griffin-Lim 随机初值`是 `librosa.griffinlim()` 的默认（`random_state=0`）；`Griffin-Lim PGHI 初值`用同一更新式，只换初值，复现漂移不超过 `6.1e-15`。`RTISI-LA 零相位初值`不用 PGHI，只用内核自身的启动相位。

相对 librosa 的默认方案，本项目默认在三段素材的 LSD、谱收敛和包络上都更好；波形相关两胜一负，演示素材上 `0.354` 高于 `0.303`。把迭代预算拉到 4 倍（32 次迭代），librosa 默认的谱收敛为 `-26.25`、`-28.14`、`-17.23`，仍不及本项目 8 次的 `-28.86`、`-32.12`、`-25.04`。

把初值对齐后，LSD 差在 `0.3 dB` 以内、谱收敛差在 `1.7 dB` 以内，相关互有胜负；而随机初值与本项目默认的谱收敛差在 `10.7 dB` 以上。这项差距主要来自 PGHI 初值，不是迭代方式，RTISI-LA 相对同初值的 Griffin-Lim 没有稳定优势。波形相关对相位等价解敏感，不能单独代表听感。

三段素材的输出与参考的 RMS 差都不超过 `0.17 dB`，谱收敛列比较的是相位而不是电平。同一幅度谱配真实相位时三段的相关均为 `1.000`、LSD 为 `0.00`、增益为 `0.00 dB`；基准在运行时断言这一行，不成立即报错。

性能用 501 帧、512 点窗、8 次迭代。MoonBit release/native 的 PGHI 为 8.17 ms、RTISI-LA 为 37.10 ms，合计 45.27 ms；同一帧数和迭代下预热后的 librosa fast Griffin-Lim 为 23.49 ms，本项目慢 `1.93×`。两侧交替测量各取最快值。两者初始化不同，这项比较的是同一输入规模与预算下的完整默认管线，不是逐步骤微基准。

## 重建质量

`bun run quality -- --gate` 对人声、乐声和瞬态/噪声混合信号各生成 2.5 秒音频。表中为本次运行结果。

| 信号 | 模式 | 相关 | SNR dB | 谱收敛 dB | LSD dB | 包络相关 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 人声 | Exact 8 kHz | 1.000 | 42.5 | -44.0 | 0.2 | 1.000 |
| 乐声 | Exact 8 kHz | 1.000 | 41.8 | -43.4 | 0.4 | 1.000 |
| 严苛 | Exact 8 kHz | 1.000 | 41.9 | -43.1 | 0.4 | 1.000 |
| 人声 | Compact 8 kHz / 8 bit | 0.272 | -1.6 | -18.9 | 3.2 | 0.989 |
| 乐声 | Compact 8 kHz / 8 bit | 0.674 | 2.2 | -22.9 | 2.2 | 0.886 |
| 严苛 | Compact 8 kHz / 8 bit | 0.101 | -1.0 | -8.3 | 2.4 | 0.990 |
| 乐声 | Compact 8 kHz / 4 bit | 0.533 | 0.8 | -9.9 | 16.2 | 0.664 |

Compact 不保存相位。相关系数衡量波形一致性，LSD 和包络相关补充频谱与时域包络信息。

真实图片链路使用 6 段素材，每段取前 8 秒。`bun run bench` 覆盖 PNG、JPEG 和缩放读回。

| 模式 | 图片路径 | 相关中位数 | LSD 中位数 |
| --- | --- | ---: | ---: |
| Compact 8 kHz / 4 bit / win 256 | PNG | 0.466 | 10.2 |
| Compact 8 kHz / 8 bit / win 512 | PNG | 0.299 | 3.5 |
| Exact / 原采样率 / win 512 | PNG | 1.000 | 0.3 |
| Exact / 原采样率 / win 512 | JPEG | 0.745 | 4.2 |
| Exact / 原采样率 / win 512 | 0.75× 缩放 | 0.112 | 4.5 |

## 速度

`bun run kernel` 处理 30 秒、44.1 kHz 的固定素材，包含重采样、编码和还原。门限为 `0.05×` 实时。

| 档位 | 总耗时 | 实时倍率 |
| --- | ---: | ---: |
| win 256 | 234.4 ms | 0.008× |
| win 512 | 172.6 ms | 0.006× |
| win 1024 | 171.9 ms | 0.006× |
| win 2048 | 171.1 ms | 0.006× |
| win 4096 | 172.1 ms | 0.006× |
| Exact / win 1024 | 49.2 ms | 0.002× |

`bun run perf` 用 60 秒、44.1 kHz、264.6 万样本检查重采样缓存。8/16/48 kHz 输出分别比逐样点计算快 6.9×、5.6×、5.2×；相位种类最多的测试组合为 4.27× 至 5.66×。

## 复现

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run test:kernel
bun run compare:librosa # 对标 librosa 的四条命令需 Python 环境安装 librosa==0.11.0
bun run compare:librosa:stft
bun run compare:librosa:phase
bun run compare:librosa:phase-perf
bun run bench:kernel:native # 相位与 STFT 性能表的 MoonBit 一侧
bun run quality -- --gate
bun run kernel
bun run perf
bun run build:web
bun run ui
bun run offline
```

`bun run bench` 读取本地真实音频，相位重建对标也读取 `docs/audio-examples` 里的本地素材。素材选择和用例参数见 [`bench/README.md`](../bench/README.md)。

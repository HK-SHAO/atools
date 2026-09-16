# 量化数据

数据记录于 2026-09-16。质量用例使用固定合成信号；性能数据来自当前开发机，取同一进程两轮中的最快值。命令和门限保存在仓库中。

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

## 测试与产物

| 项目 | 当前值 |
| --- | ---: |
| TypeScript 测试 | 154 个 |
| MoonBit 白盒测试 | 48 个 |
| TS/TSX/MoonBit/bench/scripts 源码 | 16863 行 |
| 主界面 JS | 240.4 KiB |
| Pipeline Worker | 65.6 KiB |
| MoonBit Wasm | 43.8 KiB |
| CSS | 7.2 KiB |

解码器按格式拆分加载。AAC、AMR、Opus、Vorbis、MP3、FLAC 和 WAV 模块不进入主界面包。

## 复现

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run test:kernel
bun run quality -- --gate
bun run kernel
bun run perf
bun run build:web
bun run ui
bun run offline
```

`bun run bench` 读取本地真实音频。素材选择和用例参数见 [`bench/README.md`](../bench/README.md)。

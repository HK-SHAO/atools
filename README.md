# 留声 / 频谱 Spectrum

**[▶ 在线试用 / Try online](https://atools.shao.fun)**

![频谱 · 界面截图 / Screenshot](docs/screenshot.png)

把音频变成一张可分享的频谱图；把频谱图，或随便哪张图片，还原成可播放的音频。图即是声音。

Turn audio into a shareable spectrogram; turn a spectrogram, or any picture, back into playable audio. The picture *is* the sound.

## 怎么用 / How to use

拖入一段音频（mp3、wav、flac、m4a、ogg、amr）得到频谱图；把图拖回去就能出声。频谱图本身就是进度条：点、拖、方向键，落到哪听到哪。

Drop in an audio file (mp3, wav, flac, m4a, ogg, amr) to get a spectrogram; drop the image back to hear it. The spectrogram is the progress bar: click, drag, or use the arrow keys; playback starts wherever you land.

## 两种模式 / Two modes

| | 紧凑 Compact（默认 default） | 可逆 Exact |
| -- | -- | -- |
| 存什么 / Stored | 2 / 4 / 8 bit 幅度 / magnitude | 8 bit 幅度 + 相位 / magnitude + phase |
| 大小 / Size | 更小 / smaller | 更大 / larger |
| 还原 / Restored | 相位重建，近似音频 / approximate | 原始 PNG 近乎无损 / near-lossless from the original PNG |
| 编辑后 / After edits | 可继续读取，质量取决于保留的像素 | 相位受损时自动降级 |

紧凑模式不存相位。常见的转发、压缩和缩放后通常仍可读取，但编辑越重，声音损失越大。

Compact images omit phase. They usually remain readable after common sharing, compression, and resizing, with quality determined by the pixels that survive.

## 陌生图片也能出声 / Any image can play

按图里保留的信息自动选择还原路径：相位完好时直接逆变换；相位受损时重建；陌生图片则把整张图当作幅度谱尝试合成。

Decoding adapts to the available information: intact phase is inverted directly, damaged phase is reconstructed, and an unfamiliar image is treated as a magnitude spectrum for synthesis.

## 开发 / Development

```bash
bun install
bun dev              # 源码直出 + HMR → http://localhost:3000
bun run test         # 算法与格式测试 / tests（bun test）
bun run build:web    # 生产构建 → dist/ / build
bun start            # 静态服务 dist/，本地就能验证 PWA 与离线
```

## 深入 / Going deeper

- [docs/architecture.md](docs/architecture.md)：工程架构与门禁 / architecture and the gates
- [docs/algorithms.md](docs/algorithms.md)：算法原理与实测 / algorithm notes and benchmarks
- [docs/format-spec.md](docs/format-spec.md)：图片格式契约 / image format contract
- [docs/build.md](docs/build.md)：构建、部署与离线 / build, deploy, offline
- [AGENTS.md](AGENTS.md)：工程守则 / engineering rules

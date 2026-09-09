# atools · 频谱

把音频变成可下载的频谱图，把频谱图还原成可播放的音频 —— 双向转换，可调压缩比。

```bash
bun install
bun dev          # http://localhost:3000
bun start        # 生产
bun test         # 算法 / 格式测试
bun run build    # 产物到 dist/
```

把音频或本工具导出的图拖进页面即可（支持 mp3、wav、flac、m4a、ogg、opus、amr、3gp、webm）。频谱图本身就是进度条 —— 点或拖到任意位置跳转，左右方向键微调。

## 两种模式

| | 紧凑（默认） | 可逆 |
| -- | -- | -- |
| 图里藏的是什么 | 一张纯粹的频谱图：时间 × 频率，暖色深浅表示幅度 | 上半段是频谱图，下半段额外存相位（cos/sin） |
| 存多少信息 | 幅度，按位深（2 / 4 / 8 bit）量化 | 16 bit 幅度 + 相位 |
| 还原音频 | 相位重建（PGHI + RTISI-LA） | 直接逆 STFT |
| 文件大小 | 几 KB ~ 几十 KB | 几百 KB |
| 默认参数 | 8 kHz、8 bit、N=512 | 同源采样率、N=1024 |

紧凑模式的图就是频谱图本身 —— 相位没存，所以读图永远不靠"取巧"，随便转格式、随便找一张陌生图片丢进来，工具都能出声。

## 转换参数

| 参数 | 选项 | 说明 |
| -- | -- | -- |
| 模式 | 紧凑 / 可逆 | 见上表 |
| 采样率 | 8 k / 16 k / 32 k / 原 | 降采样同时把带宽也裁了 |
| 位深 | 2 / 4 / 8 bit | 紧凑模式才有效；动态范围自动 = 12·位深 dB |
| 窗长 | 省 / 中 / 细 | 调整窗口大小与跳距（256/2、512/2、1024/4） |
| 频宽 | 全 / 2k / 4k / 6k / 8k Hz | 紧凑模式才有效；超过奈奎斯特的选项自动隐藏 |
| 区间 | 起 / 止 | 时间裁剪，单位秒；"裁静音"自动找首尾静默边界 |

## 四档读图

任何一张图都能出声，工具按可用信息自动选档：

- **可逆**（相位段完好）：16 bit 幅度 + 相位直接逆变换，近乎无损
- **紧凑**（本工具出的图）：幅度按亮度反查，相位重建
- **降级**（图被改过：转 JPEG、缩放、改名）：重采样适配，缩放场景由条码票根恢复几何
- **通用**（完全陌生）：整张当幅度读

每张导出图带三重参数来源：PNG tEXt 元数据、文件名文法、底部条码票根 —— 任何一处在转发中幸存就能恢复参数。

## 设计与动效

颜色、字、间距、圆角、动效全部走容器相对单位 `var(--u)`：根字号随挂载容器宽高连续变化。暖纸底、毛玻璃卡片、贴纸按钮、squircle 圆角。

## 结构

```
src/
  index.html / index.ts        server + 入口
  frontend.tsx / App.tsx       React 外壳
  index.css                    设计令牌（暖纸 + 毛玻璃）
  lib/
    fft.ts                     radix-2 复数 FFT + 窗函数 + 谱镜像
    palette.ts                 调色板：保证 G==level，亮度严格单调
    params.ts                  转换参数模型 + 默认值
    resample.ts                加窗 sinc 重采样（兼作低通）+ 时间裁剪 + 找静音
    spectrum.ts                STFT 编解码 + 相位重建调度（核心）
    phase.ts                   PGHI 相位初始化 + GL 打磨
    rtisi.ts                   RTISI-LA 逐帧反演
    stub.ts                    条码票根编解码
    png.ts                     PNG 编解码（索引色）、tEXt 元数据
    wav.ts                     16-bit PCM 单声道 WAV
    audio.ts                   音频解码：原生 decodeAudioData 优先，失败按嗅探落 WASM 兜底（amr/aac/mp3/wav/vorbis/opus/flac/mp4/webm 九引擎）+ 示例
    image.ts                   频谱 ↔ 图片、认图、缩放适配
    audit.ts                   质检（往返质量矩阵）
    metric.ts                  对齐、相关、LSD
  ui/
    useContainerScale.ts       按容器宽度写 --u
    usePlayback.ts             Web Audio 播放 + 进度 ref，懒建 ctx
    raster.ts                  频谱最大池化 + 显示栅格
    Spectrogram.tsx            频谱图即进度条
    Workbench.tsx              加载后的工作台
    Row.tsx                    通用一行参数（标签 + 一排小按钮）

docs/format-spec.md             图片格式契约（发布后冻结）
docs/algorithms.md              算法原理与实测结论
bench/                          浏览器端到端评测台
```

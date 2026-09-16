# Spectrum Image Format v4

本规范定义 atools 生成和读取的频谱图。实现者只需 PNG 编解码、FFT 和 JSON 支持。票根用于图片经过平台转码后的参数恢复，标准 PNG 往返不依赖票根。

## 1. 数据模型

编码器把单声道 PCM 转成 `frames × bins` 个 STFT 单元。数组采用帧优先顺序：

```text
i = frame * bins + bin
frame = 0 .. frames - 1
bin   = 0 .. bins - 1       # 0 为 DC，频率为 bin * sr / win
```

| 模式 | 元数据 | 图像 | 音频还原 |
| --- | --- | --- | --- |
| Compact | `exact=0`，`bits=2/4/8` | 单幅量化幅度谱 | 相位不唯一，解码器负责估计 |
| Exact | `exact=1`，`bits=0` | 幅度谱和相位谱 | 原 PNG 可直接逆 STFT |

规范中的整数舍入使用 `round(x) = floor(x + 0.5)`。字节写入前限制到 `0..255`。

## 2. STFT 约定

设输入为 `pcm[0..samples-1]`，窗长为 `N=win`，帧移为 `H=hop`。

1. 在 PCM 两端各补 `N/2` 个零，得到 `xpad`。
2. 取周期 Hann 窗：

   ```text
   w[m] = 0.5 - 0.5*cos(2*pi*m/N), m = 0..N-1
   ```

3. 帧数为 `floor(max(1, samples)/H)+1`。
4. 第 `f` 帧的 DFT 为：

   ```text
   X[f,k] = sum(xpad[f*H+m] * w[m] * exp(-j*2*pi*k*m/N), m=0..N-1)
   ```

5. 图中保存 `k=0..bins-1`。完整单边谱使用 `bins=N/2+1`；裁掉高频时可取更小的 `bins`。

参考幅度为 `scale=N/4`。dB 值按 `20*log10(abs(X)/scale)` 计算。

## 3. PNG 与元数据

编码器写标准 PNG，并加入一个 `tEXt` chunk：

```text
keyword: spectrum
text:    [4,sr,win,hop,frames,bins,samples,bits,ref,exact]
```

keyword 和 JSON 只含 ASCII 字节。PNG chunk 使用标准 CRC-32。读端校验 PNG 签名、chunk 边界、CRC、IHDR 和 IEND。

| 位置 | 字段 | 约束 |
| ---: | --- | --- |
| 0 | version | 必须为 `4` |
| 1 | sr | 整数，`1..96000` Hz |
| 2 | win | `256/512/1024/2048/4096` |
| 3 | hop | 整数，`1..win`；本项目写 `win/4` |
| 4 | frames | 整数，`1..min(65535, floor(16000000/(bins*bands)))` |
| 5 | bins | 整数，`2..win/2+1` |
| 6 | samples | 整数，`0..min(8000000, (frames-1)*hop+win)` |
| 7 | bits | `0/2/4/8`；规范写端按模式选择 |
| 8 | ref | 有限 dB 值；写入 JSON 时舍入到 0.1 dB |
| 9 | exact | `0/1` |

`bands` 在 Compact 模式取 1，在 Exact 模式取 2。实现者可在数组末尾追加字段；v4 读端忽略第 10 项之后的值。修改现有字段、像素坐标或数值映射需要新版本号。

文件名可保存一份降级参数：

```text
{stem}_SR{sr}_N{win}_H{hop}_F{frames}_L{samples}_B{bits}.png
```

文件名不保存 `bins` 和 `ref`。atools 在缺少有效 `tEXt` 时使用 `bins=win/2+1`、`ref=0`、`exact=(bits==0)`。

## 4. 颜色表

幅度像素使用 256 级 RGB ramp。G 通道等于级别。编码器在相邻控制点间逐通道线性插值并舍入：

```text
(level, R, B)
(0,     0,   0)
(24,    34,  6)
(64,    110, 22)
(112,   190, 52)
(168,   232, 120)
(216,   250, 190)
(255,   255, 255)
```

对控制点 `(la,ra,ba)` 和 `(lb,rb,bb)`，`la <= level <= lb`：

```text
t = (level-la)/(lb-la)
R = round(ra + (rb-ra)*t)
G = level
B = round(ba + (bb-ba)*t)
```

读取经过 RGB 转码的幅度像素时，atools 先算：

```text
Y = round(0.299*R + 0.587*G + 0.114*B)
level = max(l in 0..255 where luma(ramp[l]) <= Y)
```

标准 ramp 像素可取回原级别。

## 5. Compact 图

### 5.1 幅度量化

设 `steps=2^bits-1`，动态范围 `span=12*bits` dB。参考编码器令 `stride=max(1,floor(frames/240))`，检查 `f=0,stride,2*stride...` 的帧，并取：

```text
ref = peak > 0 ? 20*log10(peak/scale)+1 : 0
floorDb = ref-span
q = clamp(round((db-floorDb)/span*steps), 0, steps)
level = round(q*255/steps)
```

第三方编码器可以从全部帧求峰值。`ref` 和像素采用同一基准即可互通。

### 5.2 PNG 布局

Compact 图使用索引色 PNG，宽度为 `frames`，有效高度为 `bins`。bit depth 等于 `bits`。调色板有 `2^bits` 项，第 `q` 项使用 `ramp[round(q*255/steps)]`。

```text
x = frame
y = bins - 1 - bin
palette_index = q
```

图顶对应最高频点，图底对应 DC。编码器可在有效图像下方追加 8 行票根；IHDR 高度随之增加。

### 5.3 解码

从像素得到 `level` 后：

```text
q = round(level*steps/255)
db = ref-span + q/steps*span
magnitude = exp(db*ln(10)/20) * (win/4)
```

Compact 图没有相位。零相位加逆 STFT 可以生成合法输出；PGHI、Griffin-Lim 或 RTISI 能改善听感。不同算法产生不同波形，不影响格式兼容性。

## 6. Exact 图

Exact 图使用 RGBA PNG。宽度为 `frames`，有效高度为 `2*bins`。前 `bins` 行存幅度，后 `bins` 行存相位。

### 6.1 幅度段

```text
db = 20*log10(abs(X)/(win/4))
level = clamp(round((db+120)/120*255), 0, 255)
x = frame
y = bins - 1 - bin
RGBA = (ramp[level].R, level, ramp[level].B, 255)
```

零幅度写 `level=0`。

### 6.2 相位段

对 `X = re+j*im`，`mag=abs(X)`：

```text
if mag > 0:
    C = round((re/mag*0.5+0.5)*255)
    S = round((im/mag*0.5+0.5)*255)
else:
    C = 255
    S = 128

x = frame
y = bins + (bins - 1 - bin)
RGBA = (C, S, 0, 255)
```

编码器可在相位段下方追加 8 行票根。

### 6.3 直接逆变换

读出 `level/C/S` 后：

```text
db = -120 + level/255*120
mag = exp(db*ln(10)/20) * (win/4)
cr = (C-127.5)/127.5
cs = (S-127.5)/127.5
h = sqrt(cr*cr+cs*cs)
phase_vector = h > 0.1 ? (cr/h, cs/h) : previous_vector_for_this_bin
X = mag * phase_vector
```

初始 previous vector 为 `(1,0)`。把未保存的高频 bins 设为零，执行标准实数 IFFT。每帧乘同一 Hann 窗后按 `f*hop` overlap-add。逐样点除以重叠处的 `sum(w²)`，从偏移 `win/2` 取 `samples` 个样本。该流程匹配 atools 的直接还原路径。

## 7. 参数票根

票根用于 tEXt 和文件名被平台移除后的恢复。编码器可以省略票根；带有效 tEXt 的原 PNG 不依赖它。

atools 票根支持宽度 `2..65535`、窗长 `256/512/1024/2048`，以及下表采样率：

```text
index: 0     1      2      3      4      5      6      7      8
sr:    8000  11025  12000  16000  22050  24000  32000  44100  48000

index: 9      10     11     12      13
sr:    64000  88200  96000  176400  192000
```

窗长索引为 `0:256, 1:512, 2:1024, 3:2048`。宽度字段按数值选择 8、12 或 16 bit；对应前缀为 `00`、`01`、`10`。

位流使用 MSB first：

```text
sync 4          1010
magic 4         1011
width prefix 2  00/01/10
width           8/12/16 bit
sr index 4
win index 2
exact 1
crc 8
```

CRC 覆盖 `magic` 起至 `exact` 止，不覆盖 `sync`。算法逐 bit 执行下列步骤；不要先把位流打包成字节：

```text
crc = 0xFF
for bit in covered_bits:
    crc = crc XOR (bit << 7)
    repeat 8 times:
        crc = ((crc << 1) XOR 0x07) & 0xFF  if crc & 0x80
              (crc << 1) & 0xFF             otherwise
```

票根占图底 8 行，每列写同一值。Exact 图用灰度 RGBA：暗值 20，亮值 230，alpha 255。Compact 图用调色板首项和末项。每 bit 的列宽取：

```text
image width >= 160: 4 px
image width >= 70:  2 px
otherwise:          1 px
```

`bit_count=25+width_bits`，单份跨度为 `span=2+bit_count*bit_width`。左侧副本的基点为 `base=2`；`base..base+1` 是暗锚，位 `j` 写入 `base+2+j*bit_width` 起的列。其余列保持暗色。图宽满足 `width >= 2*span+6` 时，编码器在 `base=width-span` 再写一份。图宽不足 `span+2` 或小于 46 时省略票根。

解码器把底部 2 至 8 行取列均值，用 `(min+max)/2` 二值化。它从 `1010` 的四个等宽交替游程估算缩放单位，展开后校验 magic、字段长度和 CRC。

## 8. atools 读取顺序

1. 读取并校验 PNG `spectrum` tEXt。
2. tEXt 无效时解析文件名。
3. 参数仍缺失时检查索引色调色板和票根。
4. 检查 Exact 像素特征；无法识别时把整张图作为幅度谱。

图片经过缩放时，atools 对每个目标单元覆盖的像素求平均。它用相位向量平均长度判断相位是否还能使用：原尺寸 JPEG 阈值为 0.3，缩放图阈值为 0.5；宽度保留至少 60% 且可靠度达到 0.15 时，相位只作为重建锚点。

Exact 像素识别分别抽样上下两段。上段至少 55% 的像素需在每个通道 32 的容差内匹配 ramp；下段至少 55% 的像素需满足 `B<=48`，且 `(R-127.5, G-127.5)` 的半径位于 `96..160`。读端还要求至少 12 个相位样本命中。

识别成功后，读端令 `raw=2*(rows-1)`，选择不大于 `min(raw,4096)` 的最大 2 的幂，最低取 256；`hop=win/4`，采样率取 8 kHz。普通图片使用相同的几何规则，采样率取 44.1 kHz，帧数最多 6000，频点数最多 1025。

## 9. 最小互操作实现

生成可由 atools 直接还原的图片时，优先实现 Exact：

1. 按第 2 节计算 STFT。
2. 按第 6 节写 `frames × 2*bins` RGBA 像素。
3. 写第 3 节的 tEXt。票根可省略。
4. 文件名使用第 3 节文法，作为 tEXt 的备份。

还原 atools Exact PNG 时，读取 tEXt、两段像素，并执行第 6.3 节。还原 Compact PNG 时，按第 5.3 节取得幅度，再选择一种相位估计算法。

# 评测基建（bench/）

常驻的质量评测与量化工具，**不是一次性脚本** —— 调参、回归、发布前体检都靠这里。
指标口径统一在 `src/lib/metric.ts`（lib 与评测台共用，不会两套数字对不上）。

## 工具一览

| 命令 | 依赖浏览器 | 用途 |
|---|---|---|
| `bun run quality` | 否 | **质量回归**：确定性合成素材 → 真实 encode/synthesise 链路 → SNR/相关/谱收敛/谱差。日常改动后先跑这个。 |
| `bun run quality -- --gate` | 否 | 同上 + 质量门禁：低于阈值退出码 1（可挂 CI / 提交前钩子）。 |
| `bun run bench` | 是 | **端到端评测台**：Chromium 无头跑完整链路（音频 → 图 → PNG/JPEG/缩放降级 → 读图 → 还原），覆盖图片容器层的损失。 |
| `bun run smoke` | 是 | **界面冒烟**：起页面 → 点演示 → 质检 → 点频谱图试播，只报控制台错误与截图（`/tmp/smoke-*.png`）。需要 dev server 在 `http://127.0.0.1:3000`。 |
| `bun bench/scale.ts` | 是 | **尺度门禁**：先 `bun run build:web`，再校验字号随容器等比、五种控件同高、令牌锚在当前容器上、参数区在 800px 容器处 flex↔grid。 |

另有单元测试 `bun test`，覆盖 FFT/相位/PNG/参数等纯逻辑。

## 结构

- `cdp.ts` —— Chromium 路径、CDP 会话（`send` / `ev` / `on` / `goto` / `shot`）、静态文件服务都在这里，
  三个浏览器侧入口共用，别在各自文件里再抄一份。页面里的求值一律走 `ev`。
- `entry.ts` —— 打进页面的评测内核（`window.Bench`），被 `run.ts` 重打成 `bundle-<PORT>.js`。
- 页面取样一律用 `data-el="<名字>"`（组件类名已被 StyleX 换成原子哈希），清单见 `docs/build.md`。

## 质量回归（quality.ts）

- 三种**确定性合成素材**（固定种子，每次数字可横比）：人声（谐波+音节包络）、乐声（和弦）、严苛（白噪+点击+扫频，专治相位重建）。
- 用例：可逆 8k、紧凑 8k 8bit / 4bit、紧凑 16k 8bit、紧凑 8k 8bit ×2 往返（量累积损失）。
- 覆盖**编解码内核**（量化 + 相位重建）；图片容器层的损失由浏览器评测台负责，两边互补。
- `--tune='{"rtisiGl":8}'` 可临时改相位重建调参口做对比实验，一行复现。
- `--json` 输出机器可读结果，便于归档对比。
- **门禁阈值不是拍脑袋**：来自基线实测加余量。算法真实提升后请把阈值提到新基线；变红先当退步查。

## 端到端评测台（run.ts + entry.ts）

- 启动时**自动重打 bundle**（杜绝改了 src 忘了重编、测的是旧代码）。
- 默认覆盖 **docs/ 下全部音频**（voice、ra2、audio-examples…，启动时自动发现，新加文件自动纳入）；`FILES='voice/greeting.mp3'` 可覆盖为子集，其余用例参数同样通过环境变量定制：

  ```sh
  FILES='voice/greeting.mp3' \
  CASES='[{"sr":8000,"bits":8,"fineness":1,"fmax":0,"mode":"exact","via":"jpeg"}]' \
  TUNE='{"phaseReliable":0.5}' \
  bun run bench
  ```

- `via` 降级方式：`png`（原样）、`jpeg`、`half`（0.5×）、`s75`、`s90`、`jpeg75`；加 `-anon` 后缀 = 连文件名一起丢（模拟微信转发，走像素签名认图）。
- 每行输出：认图结果（exact/compact/degraded/foreign）、相位可靠性、SNR/相关/收敛/LSD、幅度一致性与层级偏差。
- 内置探针（环境变量开关）：
  - `SIG='["jpeg-anon","half-anon"]'` —— 像素签名诊断（B 通道分布、矢量半径分布、命中率），调 `recognizeExact` 阈值用。
  - `SYNTH` / `RECON` / `PHASE` / `GRAD` —— 反演器横评、量化/相位分离、PGHI 梯度体检（详见 entry.ts 各 probe 注释）。
- `OUT=/tmp/x.json` 自定义结果落盘路径（默认 `/tmp/bench.json`）；并行跑多实例时给每个实例不同的 `BENCH_PORT`（CDP 端口与 bundle 文件名都从它派生，互不冲突）。
- **解码缓存**（cache.ts）：无头 Chromium 快照没有 AAC 等专有编解码，m4a 整曲走 WASM 解码要几分钟。启动时先用 bun 侧解码一次，按「路径 + mtime + size」落盘前 30 秒 PCM（`bench/.cache`，`PRECACHE_SEC` 可调），之后评测直接读缓存。
- `DATA='["jpeg","s75"]'` —— **训练对转储**：走真实管线（encode → 降损 → 读回），把损伤相位/幅度/置信度与真值相位成对落盘 `bench/.data/`，供 `bench/ml/train.py` 训练相位修正网络。二进制布局见 `entry.ts` 的 `dumpPair`：40 字节小端头（frames/bins/win/hop/sr/bits/exact/ref/hasW）→ uint16 层级 → 损伤 cos/sin/置信度三路 uint8 → 对齐后的真值 cos/sin。层级统一升到 **uint16**，免得 compact 的 uint8 与 exact 的 uint16 在训练侧分成两套读法（compact 升位无损）。
- `NEURAL=bench/ml/w_p7.json` —— 启用训练好的修正网络（读回后、合成前逐 bin 修正），用于 ML 实验对比。
- 消融与全语料基准数字（含 ML 负结果）见 `docs/algorithms.md`。

## 已标定的经验数字（2026-09，greeting.mp3 / 2.5s 合成）

- 可逆 1:1 PNG：相关 1.000，LSD 0.2 —— 直逆即最优，勿加迭代。
- 可逆 → JPEG（q0.72，色度 4:2:0）：相位可靠性降到 ~0.63，但**保留相位**相关 0.70，弃掉只剩 0.22 —— 阈值因此定在 0.5（`READ_TUNE.phaseReliable`）。
- 可逆 → 缩放 0.5~0.9×：相位矢量被平均掉（可靠 0.2-0.4），必须弃用退幅度重建。
- 紧凑模式（只有幅度）：波形相关上限 ~0.2-0.66、LSD 5-6dB，加算力无效（信息论上限）—— 要音质请用可逆。

## 约定

- `docs/` 在 `.gitignore` 中（评测素材本地留档），评测台从 `docs/` 读音频。
- Chromium 路径写死在 `cdp.ts` 顶部（本机快照），换机器只改这一处。
- 改动读端/写端行为后：先 `bun run quality -- --gate`，再 `bun run bench`（含缩放/JPEG 矩阵），最后 `bun run smoke`。
- 改样式后另跑 `bun run build:web && bun bench/scale.ts`。

# 评测基建（bench/）

常驻的质量评测与量化工具，**不是一次性脚本** —— 调参、回归、发布前体检都靠这里。
指标口径统一在 `src/lib/metric.ts`（lib 与评测台共用，不会两套数字对不上）。

## 工具一览

| 命令 | 依赖浏览器 | 用途 |
|---|---|---|
| `bun run quality` | 否 | **质量回归**：确定性合成素材 → 真实 encode/synthesise 链路 → SNR/相关/谱收敛/谱差。日常改动后先跑这个。 |
| `bun run quality -- --gate` | 否 | 同上 + 质量门禁：低于阈值退出码 1（可挂 CI / 提交前钩子）。 |
| `bun run bench` | 是 | **端到端评测台**：Chromium 无头跑完整链路（音频 → 图 → PNG/JPEG/缩放降级 → 读图 → 还原），覆盖图片容器层的损失。 |
| `bun run smoke` | 是 | **界面冒烟**：起页面 → 点示例 → 质检 → 点频谱图试播，只报控制台错误与截图（`/tmp/smoke-*.png`）。需要 dev server 在 `http://127.0.0.1:3000`。 |

另有单元测试 `bun test`（66 个），覆盖 FFT/相位/PNG/参数等纯逻辑。

## 质量回归（quality.ts）

- 三种**确定性合成素材**（固定种子，每次数字可横比）：人声（谐波+音节包络）、乐声（和弦）、严苛（白噪+点击+扫频，专治相位重建）。
- 用例：可逆 8k、紧凑 8k 8bit / 4bit、紧凑 16k 8bit、紧凑 8k 8bit ×2 往返（量累积损失）。
- 覆盖**编解码内核**（量化 + 相位重建）；图片容器层的损失由浏览器评测台负责，两边互补。
- `--tune='{"rtisiGl":8}'` 可临时改相位重建调参口做对比实验，一行复现。
- `--json` 输出机器可读结果，便于归档对比。
- **门禁阈值不是拍脑袋**：来自基线实测加余量。算法真实提升后请把阈值提到新基线；变红先当退步查。

## 端到端评测台（run.ts + entry.ts）

- 启动时**自动重打 bundle**（杜绝改了 src 忘了重编、测的是旧代码）。
- 用例通过环境变量定制：

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
- 结果同时落盘 `/tmp/bench.json`。

## 已标定的经验数字（2026-09，greeting.mp3 / 2.5s 合成）

- 可逆 1:1 PNG：相关 1.000，LSD 0.2 —— 直逆即最优，勿加迭代。
- 可逆 → JPEG（q0.72，色度 4:2:0）：相位可靠性降到 ~0.63，但**保留相位**相关 0.70，弃掉只剩 0.22 —— 阈值因此定在 0.5（`READ_TUNE.phaseReliable`）。
- 可逆 → 缩放 0.5~0.9×：相位矢量被平均掉（可靠 0.2-0.4），必须弃用退幅度重建。
- 紧凑模式（只有幅度）：波形相关上限 ~0.2-0.66、LSD 5-6dB，加算力无效（信息论上限）—— 要音质请用可逆。

## 约定

- `docs/` 在 `.gitignore` 中（评测素材本地留档），评测台从 `docs/` 读音频。
- Chromium 路径写死在 run.ts / smoke.ts 顶部（本机快照），换机器改这两处。
- 改动读端/写端行为后：先 `bun run quality -- --gate`，再 `bun run bench`（含缩放/JPEG 矩阵），最后 `bun run smoke`。

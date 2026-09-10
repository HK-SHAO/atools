# 迁移记录：Bun 构建 → Vite，数值内核 → MoonBit

每一次「换掉底层」都要留下可对照的数字与判据，否则「没有回归」只是一句话。
本文件按里程碑追加，只记**实测**与**决策依据**；原理与管线细节归 `build.md` / `algorithms.md`。

判据分三层，缺一层就不算验过：

1. **等价**：迁移前后同一输入的输出逐位或统计无差别（逐位优先，做不到才退统计并写明分布）。
2. **门禁**：原有的断言一条不少地仍然绿；新增断言必须**故意制造一次违例**确认真能抓到。
3. **消融**：性能与体积有前后数字；被否掉的方案连数字一起留档，避免重复论证。

---

## 里程碑 0：迁移前基线（2026-09-11，Bun 1.4.3 / `build.ts` + `src/index.ts`）

| 项 | 数字 |
| --- | --- |
| 单元测试 | 124 通过 / 0 失败 / 102345 次断言 |
| `dist/` 总体积 | 2044 KB |
| 产物文件数 | 17 |
| 主入口 chunk | `chunk-rkq23yvg.js` 269.1 KB · css 7.2 KB |
| `sw.js` | 1.1 KB（预缓存 8 项，缓存名 `atools-<6 位>`） |
| 质量回归 | 可逆 8k：相关 1.000 / LSD 0.4；严苛紧凑 8k 8bit：相关 0.101 / LSD 2.4 |
| 端到端（greeting.mp3） | 可逆 PNG：相关 1.000 / LSD 0.3；可逆→JPEG：相关 0.745 / 相位可靠 0.63；0.75×、0.9× 缩放落在 degraded |
| 重采样相位表倍数 | 6.6× / 7.2× / 5.5×（8k / 16k / 48k 目标）；相位最多组合 4.37× / 4.26× / 4.65× / 5.70× |
| 主线程长任务 | 60s WAV、默认档：合计阻塞 183 ms，2 个长任务 |

---

## 里程碑 1：Vite 替换自建构建与自建服务器

### 删掉了什么

| 文件 | 行数 | 原本做什么 | 现在由谁做 |
| --- | --- | --- | --- |
| `build.ts` | 106 | 两次 `Bun.build`、手推应用壳、算缓存指纹、注入 `__SHELL__` | `vite.config.ts` + `scripts/sw.ts`（构建插件） |
| `src/index.ts` | 29 | 自建 dev 服务器（HMR）与 dist 静态服务器（SPA 回落） | `vite dev` / `vite preview` |
| `bunfig.toml` | 2 | Bun dev 的静态服务配置 | 同上，已无对象 |
| `src/assets.d.ts` | 10 | 手写 `*.ogg` / `*.m4a` 模块声明 | `vite/client` 自带（连同 CSS、PNG、`import.meta`） |

`src/index.html` 上移到仓库根（Vite 的入口约定），静态资源移进 `public/`：`manifest.webmanifest`、
`logo.svg`、`icons/*.png`。这些文件**不经打包器改写**，按字面路径落进 `dist/`，
与 manifest 里 `scope`/`start_url` 的 `"./"` 一致，子路径部署天然成立。
`src/icons/icon.svg`（maskable 图稿源）刻意**留在 `src/`**：它不进产物，挪进 `public/` 就会白带一份。

### 保住了什么

- **应用壳仍是推出来的**：`index.html` 的 `./` 引用 ∪ manifest 自引的图标，取并集排序。
  解码器是动态 import 的独立 chunk，HTML 不引，天然留在壳外。
- **缓存名仍是壳的内容指纹**：名字加每个成员的字节一起喂 `sha256`。改 HTML 标记会换缓存名。
- **壳缺一项、`sw.js` 残留占位符**：两条构建期校验都还在，前者由 `scripts/sw.ts` 抛错，后者是文本替换后的复核。
- **更新语义**：`install` 仍不发 `skipWaiting`，新版停在 `waiting`。

### 产物对照

| 项 | Bun 构建 | Vite 构建 | 差 |
| --- | --- | --- | --- |
| `dist/` 总体积 | 2044 KB | 1544 KB | **−24%** |
| 主入口 chunk | 269.1 KB | 276.1 KB | +2.6% |
| CSS | 7.2 KB | 7.0 KB | −3% |
| `sw.js` | 1.1 KB | 0.86 KB | −22% |
| 预缓存项 | 8 | 8 | 一致 |
| 壳内容（逐项） | 8 项 | 同一组 8 项 | 一致 |

总体积降两成来自压缩器（rolldown/oxc）更狠：解码器分包合计从 1.62 MB 降到 1.14 MB。
入口 chunk 反而略大，是 Vite 的模块包装与预加载辅助代码，量级可忽略。

### 不回归证据

- `bun test`：124 通过 / 0 失败（与基线同数）。
- `bench/offline.ts`：**全部合格** —— 壳逐项 8 项、断网后 html/script/style/manifest 全 200、
  运行期缓存收下演示音频、新版停在 `waiting`、SPA 回落的 HTML 没进缓存、`sw.js` 不在预缓存里。
- `bench/scale.ts`：五档容器宽度全合格，`@property --u` 与 `-webkit-backdrop-filter` 都还在产物里。
- `bench/perf.ts`：通过，重采样倍数 6.6× / 7.2× / 5.5×、相位最多组合 4.37× 起，与基线一致。
- `bench/run.ts`（单素材）：可逆 PNG 相关 1.000 / LSD 0.3、JPEG 相位可靠 0.63、缩放档 degraded，
  与基线逐项一致。
- `tsc --noEmit`：干净。

### 迁移中真实踩到的三个缺陷（都是「绿灯可证伪」的样本）

1. **首屏白屏：`import.meta.hot.data.root`**。`src/frontend.tsx` 原本直接写
   `(import.meta.hot.data.root ??= createRoot(elem))`。Bun 的打包器会把整个表达式折掉，
   Vite 把 `import.meta.hot` 替换成 `undefined`，于是取 `.data` 直接抛错。
   **抓法**：CDP 里 `Runtime.exceptionThrown` 报 `Cannot read properties of undefined (reading 'data')`。
   改成显式守卫（`hot?.data.root ?? createRoot(elem)`）。构建成功、类型干净、单测全绿都没抓到它。
2. **Service Worker 没注册上**。构建期把壳清单塞进了 `JSON.parse(...)` 的槽位，但塞的是**对象字面量**，
   运行期 `JSON.parse` 收到 `"[object Object]"` 抛错，又被注册处的 `.catch(() => {})` 吞掉 ——
   表象是「SW 十秒内没就绪」，不是任何一条显式的错误。
   **抓法**：`bench/offline.ts` 29 项不合格。现在注入的是**双引号字符串字面量**：
   JSON 的转义是 JS 字符串转义的子集，直接可用，也不必理会压缩器原来用的是哪种引号
   （实测 oxc 会把 `"__SHELL__"` 改写成 `` `__SHELL__` ``，按某一种引号去匹配会漏）。
3. **门禁绑死了产物布局**。`bench/scale.ts` 用 `new Bun.Glob("*.css")` 数 CSS 产物，
   Vite 把 CSS 放进 `assets/` 之后它报「一个都没有」，看着像产物坏了，其实是断言写死了扁平布局。
   改成 `**/*.css`：契约是「整个 dist 只有一份 CSS」，产物放在哪一层不是。

### 被否掉的方案

**@vitejs/plugin-react（连 React Compiler）**。`bun add -d @vitejs/plugin-react babel-plugin-react-compiler`
后按官方文档配 `react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } })`，重新构建 ——
**产物逐字节不变**（主入口 chunk 内容哈希与不接时相同：`index-D4X96kXc.js`）。
代价实测：顶层包 18 → 21、安装体积 38 MB → 45 MB（+3 包 / +7 MB，且这还是 babel 通道未真正挂载时的下限）。
既无可测收益又要多背依赖链，不引。JSX 由打包器原生转换；代价是改组件走整页刷新而非 Fast Refresh，
本项目规模下可接受。真要有意义，理由得是「分析器量到 re-render 成本」，而不是「别家都装」。

---

## 里程碑 2：MoonBit 内核骨架接进 Vite

### 与 `sfengine` 的一处刻意分歧：内存不静态定型

sfengine 把 `memory-limits` 钉成 `min=max`，换「宿主缓存的 typed view 永不 detach」，因为它的
缓冲上限是固定网格（约 17 MB）。本项目的缓冲**随素材涨**：像素预算 16M 时，只「目标幅度」一张
`Float64` 表就是 128 MB。手机上开机就要 256 MB 是直接要不到。

所以这里换成另一套契约，写在 `moon/moon.pkg` 里：**按 job 分配 → 全部就绪后取指针 → 再开始计算**。
宿主每个 job 开始时重读一遍地址，`memory.grow` 造成的 detach 就落在契约之外，不靠「禁止增长」保证。
运行期零分配靠的是「中间缓冲在 begin 里一次配齐」，而不是靠禁止增长 —— 这是本设计唯一的软肋，
由「每个 job 只有一次取指针的时机」这条纪律兜住。

### 骨架与构建链

| 文件 | 职责 |
| --- | --- |
| `moon/moon.pkg` | `foreign_library` + `supported_targets = "wasm"`；导出 `memory`，**零 import** |
| `moon/ffi.mbt` | `#borrow` 取 `FixedArray` 数据区首地址、`memory.copy/fill`、v128 访存、裸地址读写（测试用） |
| `moon/engine.mbt` | `dsp_abi` 与 canary 握手；白盒测试证明「导出地址 = 数据区首地址」 |
| `scripts/moon.ts` | mtime 判 stale → `rm -rf moon/_build` → `moon build --release --target wasm`；Vite 插件 |
| `src/lib/dsp.ts` | 加载器：ABI 校验、canary 双向握手、按需切 typed view |

判 stale 后**一律连 `_build` 一起删干净再编**：moon 的增量链接对 `moon.pkg` 变更会失活
（实测导出面残留），全量重编 62~123 ms，换「产物与配置必然一致」很划算。

内核在产物里是**固定名** `wasm/dsp.wasm`，不是内容哈希：它由 `index.html` 的
`<link rel="preload" as="fetch">` 引用，只有被 HTML 引到才会进应用壳 —— 而它必须进壳，
否则「首次访问 → 断网」之后什么也编不了。缓存换代靠的是壳的内容指纹（改内核字节就换缓存名）。

### 实测数字

| 项 | 数字 |
| --- | --- |
| 内核 wasm | 2044 B（骨架期只有握手） |
| 初始内存 | 1 页 / 64 KB |
| import 数 | 0 |
| 编译耗时 | 全量 62~123 ms |
| 应用壳 | 8 项 → 9 项（新增 `wasm/dsp.wasm`） |
| `dist/` 总体积 | 1544 KB → 1548 KB |
| 测试 | 124 → 128 通过（新增 4 条握手/契约断言） |
| dev 重编 | 改 `moon/*.mbt` 后 80 ms 防抖内自动重编并整页刷新（实测 touch 一次 → 62 ms 编完） |

### 门禁与可证伪性

- `src/lib/dsp.test.ts` 4 条：ABI 一致、**导出地址双向握手**（内核写宿主读 / 宿主写内核读）、
  零 import 且导出 `memory`、加载器解析出的 URL 与构建落点同一条路径。
  第一条与第二条盯的是一条**没有文档背书**的 ABI —— 工具链升级若改了 `#borrow` 的传参表示，
  这里会先响，而不是等到某个数值调用给出「看起来合理但不对」的结果。
- `scripts/sw.ts` 新增：**应用壳里必须有 `WASM_FILE`**。
  故意制造违例：把 `index.html` 的 preload 写成绝对路径 `/wasm/dsp.wasm`
  （Vite **不**改写 `rel="preload"` 的 `href`，而壳只认 `./` 开头的引用）→ 构建硬失败
  `应用壳里没有 wasm/dsp.wasm`。这条断言确实抓得到，不是同义反复。
- `bench/offline.ts` 新增：**数值内核必须在预缓存里**。URL 从运行中的 DOM 的 `preload` 取，
  不从构建脚本抄；preload 整个消失时直接判不合格，而不是把这条断言静默跳过。现在预缓存 9 项全绿。
- `bun test` 128/128；`tsc --noEmit` 干净。

---

## 里程碑 3：FFT 移植 —— 以及一次否定「换语言就更快」的消融

### 移植了什么

`moon/plan.mbt` 一次性算好 `rev` / 旋转因子 / 汉宁窗（三张静态表，`*_ptr()` 导出给宿主），
`moon/fft.mbt` 是原地 radix-2 变换，末级（`step == 1`）单独走 v128 整对打包。
`src/lib/dsp.ts` 的 `planOf()` 把这些表切成熟宿共享的视图，`src/lib/fft.ts` 的 TS 实现原样留在仓库里
**作为参照实现**，逐位比对靠它。

### 等价判据：分成「必须逐位」与「只约束 ulp 上界」两类

一次 FFT 里有两类东西，混在一起谈「逐位等价」是含糊的：

| 量 | 判据 | 实测 |
| --- | --- | --- |
| 位反转置换 | **逐位相同** | 0 处不同 |
| 旋转因子 / 汉宁窗 | ≤ 1 ulp | 1 ulp（相对 2.19e-16） |
| 正/反变换结果 | ≤ 8 ulp | 最大 3.4 ulp |

旋转因子那一项**做不到逐位**：TS 写 `Math.cos(2πi/N)`，V8 的 `Math.cos` 与 MoonBit 的
`@math.cos` 在末位差 1 ulp，这是两个超越函数实现的差别，不是编码错误。
量级上它相对误差 2.19e-16，而数据最终落到 Float32（1.2e-7）与 8bit 幅度（1/255），
相差九个数量级 —— 所以「exact 档逐位不变」这条强断言挪到**产物**上去验，不在这里卡。

`src/lib/fft.test.ts` 9 条，`ULP_BOUND = 8`，窗长扫 256 / 512 / 1024 / 4096。
**故意制造一次违例**：把 `k = k + step` 改成 `k = k + 1` → 门禁报 `6293310820384024` ulp，
确认它抓得住，随后恢复。

### 消融：WASM 内核 vs TS 参照实现，同一台机器、11 轮取中位数

```
  win  256    2,930 次（含 im 清零）   wasm   2.40 µs   TS   2.36 µs   → 1.02×
  win  512    1,302 次（含 im 清零）   wasm   5.33 µs   TS   5.16 µs   → 1.03×
  win 1024      586 次（含 im 清零）   wasm  11.70 µs   TS  11.14 µs   → 1.05×
  win 4096      400 次（含 im 清零）   wasm  55.63 µs   TS  52.84 µs   → 1.05×
```

**结果是否定的：wasm 反而慢 2%~5%。** 四档窗长一致，不是噪声。

原因不神秘：这个内层循环是「定长数组 + 连续常量索引 + 无分配」，V8 的 TurboFan 已经把它
优化到接近标量硬件极限；wasm 那一侧多出来的是**边界内存访问的间接层**，而不是更少的指令。
SIMD 也不是解药：数据是 f64，v128 只有 2 条道，radix-2 蝶形的 cross-lane 代价吃掉全部收益，
实测末级上 v128 与标量持平。

### 顺带把整条链的耗时摸了一遍（8s @ 8kHz，win 512 = 501 帧）

| 环节 | 耗时 | 占比 |
| --- | --- | --- |
| `encode` 完整 | 6.9 ms | 5% |
| `synthesise` 完整 | 135.7 ms | 95% |
| ├ `phaseFromMagnitude`（PGHI） | 8.1 ms | 逆变换的 5.9% |
| └ `rtisiLa`（8 轮） | 106.0 ms | **逆变换的 78.1%** |

**编码侧根本不是瓶颈**（6.9 ms），瓶颈是逆变换里的 RTISI-LA，而它 2/3 的时间又在下述这个格局里：
每帧 `act = K+1` 个槽位、每轮 `act` 次正变换 + `act` 次反变换、共 `iters` 轮。
两处的旋钮是同一个预算：

```ts
const unit = frames * L * max(1, log2(L));
while (K > 1    && unit * (K + 1) * iters > budget) K--;
while (iters > 1 && unit * (K + 1) * iters > budget) iters--;
```

所以**每帧的 FFT 次数不是常数**：2.5s 素材（157 帧）拿到完整的 K=3、每帧 64 次变换；
8s 素材（501 帧）被预算压到 K=1、每帧 32 次。看「每帧多少毫秒」会得出相反结论，
必须换算到**每次变换**：两档实测都落在 5~7 µs/次（含窗乘、重叠相加、`load` 拷贝），与上表的裸 FFT 对得上。

### 这条负结果决定了后面怎么走

「把 TS 数值代码逐行翻成 MoonBit 就会更快」到这里被证伪了。剩下的价值只有三条，各自可证伪：

1. **算法本身的改动**（不是换语言）——RTISI 里那 64 次变换，每一次要么是「实输入 → 复输出」，
   要么是「Hermite 谱 → 实输出」，都够格用**实数 FFT 折半**或**两条实序列打成一个复变换**。
   这是 2× 量级的、与语言无关的收益，必须在 wasm 里做才能顺手拿到 SIMD。
2. **主线程不阻塞**——与语言无关，独立成立，见里程碑 4。
3. **一份实现多处编译**（离线批处理走 native）。

所以后续不把 STFT / 相位重建整段平移，**只把能真正吃到 SIMD 的密集内核搬过去**，
搬一个消融一个。


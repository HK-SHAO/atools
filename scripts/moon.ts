import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const moonDir = path.join(root, "moon");
const artifact = path.join(moonDir, "_build/wasm/release/build/dsp.wasm");

/**
 * moon 的安装位置跟 PATH 无关：官方安装器把它放进 `~/.moon/bin`，而 `bun run` 起的进程
 * 未必继承到那条 PATH。这里自己找一遍，别让「工具链没装在 PATH 里」伪装成「内核编译失败」。
 */
const moonBin = (): string => {
  if (process.env.MOON) return process.env.MOON;
  const exe = process.platform === "win32" ? "moon.exe" : "moon";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  const installed = path.join(homedir(), ".moon", "bin", exe);
  return existsSync(installed) ? installed : exe;
};

/** 内核在应用里的落点。固定名而非内容哈希：它由 HTML 的 preload 引用，必须能进应用壳。 */
export const WASM_FILE = "wasm/dsp.wasm";

// 读出普通 Uint8Array 而不是 Node 的 Buffer：加载器同时被浏览器与测试使用，
// 让 Buffer 的 ArrayBufferLike 漏进浏览器侧的类型不划算。多一次 KB 级拷贝，可以忽略。
const read = (): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(artifact));

/**
 * moon 的增量链接对 moon.pkg 变更会失活（实测导出面残留：改了 supported_targets 却不重链），
 * 所以判 stale 后一律连 `_build` 一起删干净再编。全量重编是秒级，换产物与配置必然一致。
 */
const latestSource = (): number => {
  let latest = 0;
  for (const name of readdirSync(moonDir, { recursive: true })) {
    const file = String(name);
    if (file.startsWith("_build")) continue;
    if (file.endsWith(".mbt") || file.endsWith("moon.pkg") || file.endsWith("moon.mod"))
      latest = Math.max(latest, statSync(path.join(moonDir, file)).mtimeMs);
  }
  return latest;
};

const wasmStale = (): boolean =>
  !existsSync(artifact) || latestSource() > statSync(artifact).mtimeMs;

/** 编译内核并返回字节。失败即抛 —— 这是构建的前置条件，不允许带着旧产物往下走。 */
export function compileWasm(opts: { force?: boolean } = {}): Uint8Array<ArrayBuffer> {
  if (!opts.force && !wasmStale()) return read();

  rmSync(path.join(moonDir, "_build"), { recursive: true, force: true });
  const started = Date.now();
  // `--deny-warn`：警告当错误。数值内核里一条警告就是一处没读懂的代码（曾攒到 17 条：
  // 4 个没人引用的 ffi 原语 + 13 条实验性 API），而构建不该替人攒着。真需要放行就在
  // moon.pkg 的 `warn_list` 里显式写出来 —— 那是一次有人做过的决定，不是沉默的欠账。
  const done = spawnSync(moonBin(), ["build", "--release", "--deny-warn", "--target", "wasm"], {
    cwd: moonDir,
    encoding: "utf8",
  });
  // 工具链缺失时 spawnSync 给的是 error（不是 status≠0），单独报，别让空白的 stdout 糊过去
  if (done.error)
    throw new Error(
      `找不到 moon 工具链：装好 MoonBit（本机在 ~/.moon/bin）或用 MOON 指路径。\n${done.error.message}`,
    );
  if (done.status !== 0) throw new Error(`moon 编译失败：\n${done.stdout ?? ""}\n${done.stderr ?? ""}`);

  console.log(`[moon] 内核编译 ✓ ${Date.now() - started}ms  ${(statSync(artifact).size / 1024).toFixed(1)} KB`);
  return read();
}

/** 独立命令与构建期的共同入口。 */
export const ensureWasm = (opts: { force?: boolean } = {}): Uint8Array<ArrayBuffer> => {
  mkdirSync(moonDir, { recursive: true });
  return compileWasm(opts);
};

export function moonKernel(): Plugin {
  const SOURCE = /moon[\\/].*\.(mbt|pkg|mod)$/;
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  let building = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    name: "moon-kernel",
    // 测试跑在 vitest 上，内核由 scripts/test-setup.ts 在 globalSetup 里编一次；
    // 插件只服务真的 dev server 与构建 —— 否则测试每次也多起一个 watcher 与中间件。
    apply: (_config, env) => env.mode !== "test",
    buildStart() {
      bytes = ensureWasm();
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: WASM_FILE, source: bytes ?? ensureWasm() });
    },
    configureServer(server) {
      bytes = ensureWasm();
      server.middlewares.use((req, res, next) => {
        // 按后缀收：worker 用 `new URL("..", import.meta.url)` 解析内核落点，源码里解析成
        // `/app/wasm/dsp.wasm`、产物里解析成 `/wasm/dsp.wasm`，两者都该由这里供上。
        if (!req.url?.split("?")[0]?.endsWith(`/${WASM_FILE}`)) return next();
        res.setHeader("content-type", "application/wasm");
        res.end(bytes);
      });

      // 80ms 防抖 + 串行合并：一次保存常连着好几条 watcher 事件
      const schedule = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, 80);
      };
      const run = (): void => {
        timer = null;
        if (building) {
          pending = true;
          return;
        }
        building = true;
        try {
          bytes = ensureWasm();
          server.ws.send({ type: "full-reload" });
        } catch (error) {
          server.config.logger.error(String(error));
        } finally {
          // 编译抛错也必须复位：否则 building 恒为 true，后续变更全被吞进 pending，重建链静默失效
          building = false;
        }
        if (pending) {
          pending = false;
          schedule();
        }
      };
      server.watcher.on("all", (event, file) => {
        // add/unlink 一并触发：新增/删除 .mbt 时不改既有文件，watcher 只发 add/unlink
        if (event !== "add" && event !== "change" && event !== "unlink") return;
        if (SOURCE.test(file) || path.basename(file) === "moon.ts") schedule();
      });
    },
  };
}

// 用 import.meta.main 而不是比 argv：本模块同时被 vite.config.ts 与测试导入，
// 只有直接跑它才该编译。
if (import.meta.main) {
  const flags = process.argv.slice(2);
  // 白盒门禁与内核基准也走这里：moon 的定位（`MOON` 环境变量、错误文案）只有这一处，
  // 与编译共用，免得在 package.json 里再写一遍裸 `moon`。
  const task = flags.includes("--bench") ? "bench" : flags.includes("--test") ? "test" : null;
  if (task) {
    const done = spawnSync(moonBin(), [task, "--release", "--deny-warn", "--target", "wasm"], {
      cwd: moonDir,
      stdio: "inherit",
    });
    if (done.error)
      throw new Error(`找不到 moon 工具链：装好 MoonBit（本机在 ~/.moon/bin）或用 MOON 指路径。`);
    process.exit(done.status ?? 1);
  }
  const bytes = ensureWasm({ force: flags.includes("--force") });
  console.log(`[moon] ${WASM_FILE} ${(bytes.length / 1024).toFixed(1)} KB`);
}

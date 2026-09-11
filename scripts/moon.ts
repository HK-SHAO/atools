import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const moonDir = path.join(root, "moon");
const artifact = path.join(moonDir, "_build/wasm/release/build/dsp.wasm");

const moonBin = (): string => {
  if (process.env.MOON) return process.env.MOON;
  const exe = process.platform === "win32" ? "moon.exe" : "moon";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  const installed = path.join(homedir(), ".moon", "bin", exe);
  return existsSync(installed) ? installed : exe;
};

const read = (): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(artifact));

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

export function compileWasm(opts: { force?: boolean } = {}): Uint8Array<ArrayBuffer> {
  if (!opts.force && !wasmStale()) return read();

  rmSync(path.join(moonDir, "_build"), { recursive: true, force: true });
  const started = Date.now();
  const done = spawnSync(moonBin(), ["build", "--release", "--deny-warn", "--target", "wasm"], {
    cwd: moonDir,
    encoding: "utf8",
  });
  if (done.error)
    throw new Error(
      `找不到 moon 工具链：装好 MoonBit（本机在 ~/.moon/bin）或用 MOON 指路径。\n${done.error.message}`,
    );
  if (done.status !== 0) throw new Error(`moon 编译失败：\n${done.stdout ?? ""}\n${done.stderr ?? ""}`);

  console.log(`[moon] 内核编译 ✓ ${Date.now() - started}ms  ${(statSync(artifact).size / 1024).toFixed(1)} KB`);
  return read();
}

export const ensureWasm = (opts: { force?: boolean } = {}): Uint8Array<ArrayBuffer> =>
  compileWasm(opts);

if (import.meta.main) {
  const flags = process.argv.slice(2);
  const task = flags.includes("--bench") ? "bench" : flags.includes("--test") ? "test" : null;
  if (task) {
    const extra = flags.includes("--build-only") ? ["--build-only"] : [];
    const done = spawnSync(
      moonBin(),
      [task, "--release", "--deny-warn", "--target", "wasm", ...extra],
      {
        cwd: moonDir,
        stdio: "inherit",
      },
    );
    if (done.error)
      throw new Error(`找不到 moon 工具链：装好 MoonBit（本机在 ~/.moon/bin）或用 MOON 指路径。`);
    process.exit(done.status ?? 1);
  }

  if (flags.includes("--ports")) {
    for (const target of ["js", "native"]) {
      const done = spawnSync(moonBin(), ["check", "--deny-warn", "--target", target], {
        cwd: moonDir,
        stdio: "inherit",
      });
      if (done.error) throw new Error(`找不到 moon 工具链（本机在 ~/.moon/bin），或用 MOON 指路径。`);
      if (done.status !== 0) process.exit(done.status ?? 1);
      console.log(`[moon] ${target} 后端可以编译 ✓`);
    }
    process.exit(0);
  }

  const bytes = ensureWasm({ force: flags.includes("--force") });
  console.log(`[moon] 内核产物 ${(bytes.length / 1024).toFixed(1)} KB`);
} else {
  // 被 import 就等于「用我之前先确保产物是新的」：`build.ts` / `serve.ts` 靠它，`bunfig.toml`
  // 的测试 preload 也靠它（原先为此单列了一个三行文件）。判 stale 的活只在真编的时候干，
  // 所以这里不会与调用方那次 `ensureWasm()` 重复编译。
  ensureWasm();
}

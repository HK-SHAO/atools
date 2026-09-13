import { existsSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moonDir = path.join(fileURLToPath(new URL("..", import.meta.url)), "moon");
const artifact = path.join(moonDir, "_build/wasm/release/build/dsp.wasm");

const moonBin = (): string => {
  if (process.env.MOON) return process.env.MOON;
  const exe = process.platform === "win32" ? "moon.exe" : "moon";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter))
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  const installed = path.join(homedir(), ".moon", "bin", exe);
  return existsSync(installed) ? installed : exe;
};

let cache: Uint8Array<ArrayBuffer> | null = null;

const missingToolchain = (message?: string): Error =>
  new Error(`找不到 moon 工具链：装好 MoonBit（本机在 ~/.moon/bin）或用 MOON 指路径。\n${message ?? ""}`);

export function compileWasm(): Uint8Array<ArrayBuffer> {
  if (cache) return cache;
  const build = (): ReturnType<typeof Bun.spawnSync> => {
    try {
      return Bun.spawnSync([moonBin(), "build", "--release", "--deny-warn", "--target", "wasm"], {
        cwd: moonDir,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw missingToolchain(String(error));
    }
  };

  const done = build();
  if (!done.success) {
    try {
      Bun.spawnSync([moonBin(), "clean"], { cwd: moonDir });
    } catch {}
    const retry = build();
    if (!retry.success) throw new Error(`moon 编译失败：\n${retry.stdout}\n${retry.stderr}`);
  }
  return (cache = new Uint8Array(readFileSync(artifact)));
}

export function watchKernel(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(moonDir, { recursive: true }, (_event, file) => {
    if (!file || file.startsWith("_build") || !/\.(mbt|pkg|mod)$/.test(file)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      cache = null;
      try {
        compileWasm();
        console.log("[moon] 内核已重编");
      } catch (error) {
        console.error(error);
      }
    }, 80);
  });
}

compileWasm();

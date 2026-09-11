import { rm } from "node:fs/promises";
import path from "node:path";
import { ensureWasm } from "./moon.ts";

const project = path.join(import.meta.dirname, "..");
const outdir = path.join(project, "dist");
const staticDir = path.join(project, "app/public");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const built = async (options: Bun.BuildConfig): Promise<Bun.BuildOutput> => {
  const done = await Bun.build(options);
  if (!done.success) {
    for (const log of done.logs) console.error(log);
    process.exit(1);
  }
  return done;
};

const rel = (output: Bun.BuildArtifact): string =>
  path.relative(outdir, output.path).split(path.sep).join("/");

ensureWasm();
await rm(outdir, { recursive: true, force: true });

const worker = await built({
  entrypoints: [path.join(project, "app/ui/pipeline.worker.ts")],
  outdir,
  minify: true,
  target: "browser",
  sourcemap: "none",
  naming: "pipeline.worker.js",
});
const workerFile = rel(worker.outputs[0]!);

const app = await built({
  entrypoints: [path.join(project, "app/index.html")],
  outdir,
  minify: true,
  target: "browser",
  sourcemap: "none",
  splitting: true,
  reactCompiler: true,
  naming: { chunk: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

const entryChunk = app.outputs.find(output => output.kind === "entry-point" && output.path.endsWith(".js"));
if (!entryChunk) fail("应用产物里没有入口脚本：index.html 的 <script type=module> 没被认出来？");
if (path.posix.dirname(rel(entryChunk)) !== ".")
  fail(
    `入口脚本落在了子目录（${rel(entryChunk)}）：worker 的地址是相对它自己解析的（./${workerFile}），` +
      `换目录就会解析到别处 —— 见 naming.chunk 的 [dir] 标记。`,
  );

const html = await Bun.file(path.join(outdir, "index.html")).text();
const pwa = (await Bun.file(path.join(staticDir, "manifest.webmanifest")).json()) as {
  icons: { src: string }[];
};
for (const icon of pwa.icons)
  await Bun.write(path.join(outdir, icon.src), Bun.file(path.join(staticDir, icon.src)));

const shell = [
  ...new Set([
    ...app.outputs.filter(output => output.kind === "entry-point").map(rel),
    ...[...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1]!),
    ...pwa.icons.map(icon => icon.src.replace(/^\.\//, "")),
    workerFile,
    ...app.outputs.filter(output => output.path.endsWith(".wasm")).map(rel),
  ]),
].sort();

for (const entry of shell)
  if (!(await Bun.file(path.join(outdir, entry)).exists()))
    fail(`应用壳里的 ${entry} 不在 dist/ 里：壳是推出来的，多半是引用或 manifest 图标路径写错了`);

const parts = await Promise.all(
  shell.map(entry => Bun.file(path.join(outdir, entry)).arrayBuffer().then(bytes => Buffer.from(bytes))),
);
const cache = `atools-${Bun.hash(Buffer.concat([Buffer.from(shell.join("\n")), ...parts]))
  .toString(36)
  .slice(-6)}`;

await built({
  entrypoints: [path.join(project, "app/sw.ts")],
  outdir,
  minify: true,
  target: "browser",
  sourcemap: "none",
  naming: "sw.js",
  define: { __SHELL__: JSON.stringify({ cache, home: "index.html", files: shell }) },
});
const serviceWorker = await Bun.file(path.join(outdir, "sw.js")).text();
if (serviceWorker.includes("__SHELL__")) fail("dist/sw.js 里还留着 __SHELL__：define 没注入上");

for (const output of app.outputs)
  console.log(`${rel(output)}  ${(output.size / 1024).toFixed(1)} KB`);
console.log(`${cache}  sw.js ${(serviceWorker.length / 1024).toFixed(1)} KB  预缓存 ${shell.length} 项`);
for (const entry of shell) console.log(`  ${entry}`);

import { rm } from "node:fs/promises";
import path from "node:path";
import "./moon.ts"; // import 即确保内核产物是新的（见 moon.ts），应用侧 import 它当资产

const project = path.join(import.meta.dirname, "..");
const outdir = path.join(project, "dist");
const publicDir = path.join(project, "app/public");
const at = (file: string): string => path.join(outdir, file);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// 三次打包共用的一套：产物给浏览器、压缩、不出去源映射（部署端 upload_source_maps 也关着）。
const build = async (options: Bun.BuildConfig): Promise<Bun.BuildOutput> => {
  const done = await Bun.build({ outdir, minify: true, target: "browser", sourcemap: "none", ...options });
  if (!done.success) {
    for (const log of done.logs) console.error(log);
    fail("打包失败");
  }
  return done;
};

const rel = (output: Bun.BuildArtifact): string =>
  path.relative(outdir, output.path).split(path.sep).join("/");

await rm(outdir, { recursive: true, force: true });

const worker = await build({
  entrypoints: [path.join(project, "app/ui/pipeline.worker.ts")],
  naming: "pipeline.worker.js",
});
const workerFile = rel(worker.outputs[0]!);

const app = await build({
  entrypoints: [path.join(project, "app/index.html")],
  splitting: true,
  reactCompiler: true,
  naming: { chunk: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

const entry = app.outputs.find(output => output.kind === "entry-point" && output.path.endsWith(".js"));
if (!entry) fail("应用产物里没有入口脚本：index.html 的 <script type=module> 没被认出来？");
if (path.posix.dirname(rel(entry)) !== ".")
  fail(
    `${rel(entry)} 落在了子目录：worker 的地址是相对入口脚本解析的（./${workerFile}），` +
      `换目录就会解析到别处 —— 见 naming.chunk 的 [dir] 标记。`,
  );

const html = await Bun.file(at("index.html")).text();
const pwa = (await Bun.file(path.join(publicDir, "manifest.webmanifest")).json()) as {
  icons: { src: string }[];
};
for (const { src } of pwa.icons) await Bun.write(at(src), Bun.file(path.join(publicDir, src)));

// 应用壳 = 装配好的东西的并集：入口产物、worker 与它的资产、HTML 引到的（样式、图标…）、
// manifest 引到的、以及**只在 JS 里 import、HTML 上看不到**的那几件（内核 .wasm）。
// 排序后再喂指纹：打包器给产物的顺序不是契约。
const shell = [
  ...new Set([
    ...app.outputs.filter(output => output.kind === "entry-point").map(rel),
    ...worker.outputs.map(rel),
    ...[...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1]!),
    ...pwa.icons.map(icon => icon.src.replace(/^\.\//, "")),
    ...app.outputs.filter(output => output.path.endsWith(".wasm")).map(rel),
  ]),
].sort();

for (const file of shell)
  if (!(await Bun.file(at(file)).exists()))
    fail(`应用壳里的 ${file} 不在 dist/ 里：壳是推出来的，多半是引用或 manifest 图标路径写错了`);

const parts = await Promise.all(shell.map(file => Bun.file(at(file)).arrayBuffer().then(Buffer.from)));
const cache = `atools-${Bun.hash(
  Buffer.concat([Buffer.from(shell.join("\n")), ...parts]),
)
  .toString(36)
  .slice(-6)}`;

await build({
  entrypoints: [path.join(project, "app/sw.ts")],
  naming: "sw.js",
  define: { PRECACHE: JSON.stringify({ cache, home: "index.html", files: shell }) },
});
const sw = await Bun.file(at("sw.js")).text();
if (sw.includes("PRECACHE")) fail("dist/sw.js 里还留着 PRECACHE：define 没注入上");

for (const output of app.outputs) console.log(`${rel(output)}  ${(output.size / 1024).toFixed(1)} KB`);
console.log(`${cache}  sw.js ${(sw.length / 1024).toFixed(1)} KB  预缓存 ${shell.length} 项`);
for (const file of shell) console.log(`  ${file}`);

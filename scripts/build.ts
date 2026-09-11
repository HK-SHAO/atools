import { rm } from "node:fs/promises";
import path from "node:path";
import "./moon.ts"; // import 即确保内核产物是新的（见 moon.ts），应用侧 import 它当资产
import workerPlugin, { workerFile } from "./worker.ts";

const project = path.join(import.meta.dirname, "..");
const outdir = path.join(project, "dist");
const publicDir = path.join(project, "app/public");
const workerSource = path.join(project, "app/ui/pipeline.worker.ts");
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

// worker 是独立入口（`app` 侧的 `?worker` 只负责算它的地址）。这里的名字与那个地址同源，
// 见 `workerFile()`。
const worker = await build({
  entrypoints: [workerSource],
  naming: workerFile(workerSource),
});

const app = await build({
  entrypoints: [path.join(project, "app/index.html")],
  splitting: true,
  reactCompiler: true,
  plugins: [workerPlugin],
  naming: { chunk: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

const entry = app.outputs.find(output => output.kind === "entry-point" && output.path.endsWith(".js"));
if (!entry) fail("应用产物里没有入口脚本：index.html 的 <script type=module> 没被认出来？");

// 主线程不挂内核：读图、画图、质检、重采样全在 worker 里跑，内核只由 worker 那一侧加载。
// `dsp_abi` 是 `dsp.ts` 的握手符号（只在那一处出现，且属性名压缩不掉），它落进入口产物就等于
// 有人把内核又拖回了主线程 —— 首屏白搭 20 KB 数值层，而主线程根本没有 `startKernel` 可调，
// 真跑起来是 `mustKernel()` 抛错。见 docs/build.md 的「worker 是唯一挂内核的一侧」。
if ((await Bun.file(entry.path).text()).includes("dsp_abi"))
  fail(`${rel(entry)} 里出现了内核握手：主线程不该挂内核（数值全在 worker，见 docs/build.md）`);

// dist 扁平是硬约束：worker 的地址相对 **index.html** 算（`document.baseURI`），内核 .wasm 的地址
// 相对**它所在的 chunk** 算（`import.meta.url`），两者都只在「同级文件」这个前提下成立。
for (const output of [...app.outputs, ...worker.outputs])
  if (path.posix.dirname(rel(output)) !== ".")
    fail(
      `${rel(output)} 落在了子目录：dist 必须扁平 —— worker 与 .wasm 都是按同级文件解析的` +
        `（见 naming.chunk / naming.asset 里的 [dir] 标记）。`,
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

import { rm } from "node:fs/promises";
import path from "node:path";
import "./moon.ts";
import workerPlugin, { workerEntries, workerFiles } from "./worker-plugin.ts";

const project = path.join(import.meta.dirname, "..");
const outdir = path.join(project, "dist");
const publicDir = path.join(project, "app/public");
const at = (file: string): string => path.join(outdir, file);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

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

const app = await build({
  target: "browser",
  entrypoints: [path.join(project, "app/index.html")],
  splitting: true,
  reactCompiler: true,
  naming: { chunk: "[name]-[hash].[ext]" },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [workerPlugin],
});

const entry = app.outputs.find(output => output.kind === "entry-point" && output.path.endsWith(".js"));
if (!entry) fail("应用产物里没有入口脚本：index.html 的 <script type=module> 没被认出来？");

const appCode = await Promise.all(
  app.outputs.filter(output => output.path.endsWith(".js")).map(output => output.text()),
);

for (const code of appCode)
  if (code.includes("dsp_abi"))
    fail(`应用产物里出现了内核握手：主线程不该挂内核（数值全在 worker，见 docs/build.md）`);

const workers = workerFiles();
if (!workers.length) fail("应用没有引用任何 ?worker&url Worker");

const missingEntry = workerEntries().find(name => !appCode.some(code => code.includes(`"./${name}"`)));
if (missingEntry) fail(`应用产物没有按相对 URL 引用 Worker ${missingEntry}`);

for (const file of workers)
  if (!(await Bun.file(at(file)).exists()))
    fail(`Worker 产物 ${file} 不在 dist/ 里`);

const html = await Bun.file(at("index.html")).text();
const pwa = (await Bun.file(path.join(publicDir, "manifest.webmanifest")).json()) as {
  icons: { src: string }[];
};
await Bun.write(at("_headers"), Bun.file(path.join(publicDir, "_headers")));
for (const { src } of pwa.icons) await Bun.write(at(src), Bun.file(path.join(publicDir, src)));

const shell = [
  ...new Set([
    ...app.outputs.filter(output => output.kind === "entry-point").map(rel),
    ...workers,
    ...[...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1]!),
    ...pwa.icons.map(icon => icon.src.replace(/^\.\//, "")),
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
  target: "browser",
  entrypoints: [path.join(project, "app/sw.ts")],
  naming: "sw.js",
  define: { PRECACHE: JSON.stringify({ cache, home: "index.html", files: shell }) },
});
const sw = await Bun.file(at("sw.js")).text();
if (sw.includes("PRECACHE")) fail("dist/sw.js 里还留着 PRECACHE：define 没注入上");

const sizes = new Map<string, number>();
for (const output of app.outputs) sizes.set(rel(output), output.size);
for (const file of workers)
  sizes.set(file, (await Bun.file(at(file))).size);
for (const [file, size] of sizes) console.log(`${file}  ${(size / 1024).toFixed(1)} KB`);
console.log(`${cache}  sw.js ${(sw.length / 1024).toFixed(1)} KB  预缓存 ${shell.length} 项`);
for (const file of shell) console.log(`  ${file}`);

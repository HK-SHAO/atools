// 纯静态产物，不带任何插件。五步：打包应用 → 定应用壳 → 取壳指纹 → 装 Service Worker → 出包。
import { rm } from "node:fs/promises";
import path from "node:path";

const toy = process.argv.slice(2).includes("--toy");
const project = process.cwd();
const outdir = path.join(project, "dist");

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// 应用与 Service Worker 是两次构建（后者要拿前者的产物当输入），失败的样子一样
const built = async (options: Bun.BuildConfig): Promise<Bun.BuildOutput> => {
  const done = await Bun.build(options);
  if (!done.success) {
    for (const log of done.logs) console.error(log);
    process.exit(1);
  }
  return done;
};

await rm(outdir, { recursive: true, force: true });

// ── 1. 打包应用 ────────────────────────────────────────────────────────────
const app = await built({
  entrypoints: [...new Bun.Glob("src/**/*.html").scanSync()],
  outdir,
  minify: true,
  target: "browser",
  sourcemap: "none",
  splitting: true,
  reactCompiler: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

// ── 2. 应用壳：首屏必需的一切 ─────────────────────────────────────────────
// 三处来源各自独立，合起来才是完整的壳：
//   入口产物 —— index.html 与入口脚本，打包器自己报（kind === "entry-point"）
//   HTML 引用 —— 样式、图标、manifest，以及 Bun 自插的 modulepreload 共享 chunk
//   manifest  —— 它的内容不经过打包器改写，图标按字面路径落盘、自己补进清单
// 解码器分包是 kind === "chunk" 且 HTML 不引，两头都不沾，天然留在壳外按需 import。
// 排序是为了让指纹与输出都稳定 —— 打包器给产物的顺序不是契约。
const html = await Bun.file(path.join(outdir, "index.html")).text();
const manifest = (await Bun.file(path.join(project, "src/manifest.webmanifest")).json()) as {
  icons: { src: string }[];
};
for (const icon of manifest.icons)
  await Bun.write(path.join(outdir, icon.src), Bun.file(path.join(project, "src", icon.src)));

const shell = [
  ...new Set([
    ...app.outputs
      .filter(output => output.kind === "entry-point")
      .map(output => path.relative(outdir, output.path)),
    ...[...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1]!),
    ...manifest.icons.map(icon => icon.src.replace(/^\.\//, "")),
  ]),
].sort();

// 壳里少一样就白屏。manifest 的图标是手写路径，是这里唯一真会写错的来源。
// （「sw.js 不许进壳」由 bench/offline.ts 盯真实缓存，构建期不重复 —— 它归属 worker 构建，
// 本来就到不了这份清单里。）
for (const entry of shell)
  if (!(await Bun.file(path.join(outdir, entry)).exists()))
    fail(`应用壳里的 ${entry} 不在 dist/ 里：壳是推出来的，多半是引用或 manifest 图标路径写错了`);

// ── 3. 缓存名：壳的内容指纹 ───────────────────────────────────────────────
// 带哈希的资源改内容会连名字一起改，index.html 与图标不会，所以指纹取的是字节而不是清单：
// 壳里任何一个字节、任何一个名字变了就换一代，activate 再删掉其余缓存。
const parts = await Promise.all(
  shell.map(entry => Bun.file(path.join(outdir, entry)).arrayBuffer().then(bytes => Buffer.from(bytes))),
);
const cache = `atools-${Bun.hash(Buffer.concat([Buffer.from(shell.join("\n")), ...parts])).toString(36).slice(-6)}`;

// ── 4. Service Worker：把壳装进去 ─────────────────────────────────────────
// 它不在应用的依赖图里（是应用的看门人），所以要二次构建，壳以常量注入。
// define 是文本替换：键名写错不会让构建失败，只会在浏览器里炸，补一道残留检查。
await built({
  entrypoints: [path.join(project, "src/sw.ts")],
  outdir,
  minify: true,
  target: "browser",
  naming: "sw.js",
  define: {
    __SHELL__: JSON.stringify({ cache, home: "index.html", files: shell }),
  },
});
const serviceWorker = await Bun.file(path.join(outdir, "sw.js")).text();
if (serviceWorker.includes("__SHELL__")) fail("dist/sw.js 里还留着 __SHELL__：define 没注入上");

// ── 5. 出包 / 报告 ────────────────────────────────────────────────────────
if (toy) {
  const zipPath = path.join(project, "toy.zip");
  await rm(zipPath, { force: true });
  await Bun.$`cd ${outdir} && zip -qr ${zipPath} . -x '*.DS_Store'`;
  console.log(`toy.zip  ${(Bun.file(zipPath).size / 1024 / 1024).toFixed(2)} MB  (index.html 在包根)`);
} else {
  for (const output of app.outputs) {
    console.log(`${path.relative(project, output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
  }
  console.log(
    `dist/sw.js ${(serviceWorker.length / 1024).toFixed(1)} KB \n预缓存 ${shell.length} 项：\n${shell.join("\n")}`,
  );
}

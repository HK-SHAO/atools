import { rm } from "node:fs/promises";
import path from "node:path";

const toy = process.argv.slice(2).includes("--toy");
const project = process.cwd();
const outdir = path.join(project, "dist");
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [...new Bun.Glob("src/**/*.html").scanSync()],
  outdir,
  minify: true,
  target: "browser",
  sourcemap: "none",
  splitting: true,
  reactCompiler: true,
  metafile: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// 应用壳就是 index.html 直接引用到的那几件：入口 JS、CSS、图标、manifest。
// 音频解码器走动态 import，不进壳，交给 Service Worker 按需入缓存。
const html = await Bun.file(path.join(outdir, "index.html")).text();
const manifest = (await Bun.file(path.join(project, "src/manifest.webmanifest")).json()) as {
  icons: { src: string }[];
};
// manifest 内部按字面路径引用图标，打包器不会改写 manifest 的内容，
// 所以 HTML 直接引到的那个走哈希输出，manifest 引的按原样落到它旁边。
for (const icon of manifest.icons)
  await Bun.write(path.join(outdir, icon.src), Bun.file(path.join(project, "src", icon.src)));

// 壳清单从 index.html 直接引到的同源相对路径推出来（外链与 data: 都匹配不上），
// 再加 manifest 自己引的图标；去重后逐项核实确实落进了 dist/。
// 校验这一步必须有：清单靠正则推，引用写错只会让条目静默消失，不会让构建失败，
// 而半壳的表现是「离线时白屏」，离出错的地方已经很远。
const precache = [
  ...new Set([
    "index.html",
    ...[...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(m => m[1]!),
    ...manifest.icons.map(icon => icon.src.replace(/^\.\//, "")),
  ]),
];

// sw.js 不在 HTML 里，天然收不进来 —— 这是硬要求：它一旦进壳，
// Service Worker 就会一直把旧的自己喂给浏览器，从此再也发不出新版。
if (precache.includes("sw.js") || precache.some(entry => entry.endsWith("/sw.js"))) {
  console.error("sw.js 被 index.html 直接引到了：它进了预缓存就再也更新不了，去掉这个引用");
  process.exit(1);
}
for (const entry of precache)
  if (!(await Bun.file(path.join(outdir, entry)).exists())) {
    console.error(`预缓存清单里的 ${entry} 不在 dist/ 里：清单由 index.html 推出，多半是引用写错了`);
    process.exit(1);
  }

// 上面那条只管「多」：引用写错会被抓住。清单「少」了却没人吭声 —— 正则一旦跟不上产物形态，
// 壳会静默缩水成一条 index.html，线上表现为首次离线导航白屏。用打包器自己的产物清单对一遍：
// 每个 CSS 与每个非 HTML 的入口产物，都必须落在壳里。
for (const output of result.outputs) {
  if (!output.path.endsWith(".css") && !(output.kind === "entry-point" && !output.path.endsWith(".html")))
    continue;
  const rel = path.relative(outdir, output.path);
  if (!precache.includes(rel)) {
    console.error(`打包器产出了 ${rel}，预缓存清单里却没有：清单是正则从 index.html 推的，多半是正则失灵了`);
    process.exit(1);
  }
}

// 反方向：只在 dynamic-import 里出现的产物是壳外的东西（解码器 1.9 MB，按需 import）。
// 它一旦进壳，首次访问就会全量拉下来 —— 这条守住「壳 = 首屏所需」这个设计。
const dynamicTargets = new Set<string>();
const staticTargets = new Set<string>();
for (const output of Object.values(result.metafile!.outputs))
  for (const imported of output.imports ?? [])
    (imported.kind === "dynamic-import" ? dynamicTargets : staticTargets).add(imported.path);
for (const target of dynamicTargets)
  if (!staticTargets.has(target) && precache.includes(target.replace(/^\.\//, ""))) {
    console.error(`${target} 只被动态 import 用到，却进了预缓存：壳只装首屏所需，按需分包不该预取`);
    process.exit(1);
  }

const worker = await Bun.build({
  entrypoints: [path.join(project, "src/sw.ts")],
  outdir,
  minify: true,
  target: "browser",
  naming: "sw.js",
  define: {
    __PRECACHE__: JSON.stringify(precache),
    __CACHE__: JSON.stringify(`atools-${Bun.hash(precache.join("\n")).toString(36).slice(-6)}`),
  },
});

if (!worker.success) {
  for (const log of worker.logs) console.error(log);
  process.exit(1);
}

if (toy) {
  const zipPath = path.join(project, "toy.zip");
  await rm(zipPath, { force: true });
  await Bun.$`cd ${outdir} && zip -qr ${zipPath} . -x '*.DS_Store'`;
  console.log(` toy.zip  ${(Bun.file(zipPath).size / 1024 / 1024).toFixed(2)} MB  (index.html 在包根)`);
} else {
  for (const output of result.outputs)
    console.log(` ${path.relative(project, output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
  const shell = await Bun.file(path.join(outdir, "sw.js")).text();
  console.log(
    ` dist/sw.js  ${(shell.length / 1024).toFixed(1)} KB  预缓存 ${precache.length} 项：${precache.join(" ")}`,
  );
}

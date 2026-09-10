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
const precache = [
  "index.html",
  ...[...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(m => m[1]!),
  ...manifest.icons.map(icon => icon.src.replace(/^\.\//, "")),
];

// manifest 内部按字面路径引用图标，打包器不会改写 manifest 的内容，
// 所以 HTML 直接引到的那个走哈希输出，manifest 引的按原样落到它旁边。
for (const icon of manifest.icons)
  await Bun.write(path.join(outdir, icon.src), Bun.file(path.join(project, "src", icon.src)));

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

import { rm } from "node:fs/promises";
import path from "node:path";
import stylex from "@stylexjs/unplugin";

/* 两种产物，同一份源码共用 dist/：
   —— web  dist/ 目录（默认），多文件，交给任意静态服务器；引用全为相对路径，
            兼容 B站 Toy 的 /toy/<slug>/ 子路径部署
   —— toy  web 产物原样压成 toy.zip，index.html 在包根，配 build:toy 发布 */

const ASSET = /\.(ogg|opus|mp3|m4a|aac|wav|flac|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/;

const asset: Bun.BunPlugin = {
  name: "asset",
  setup(build) {
    build.onLoad({ filter: ASSET }, async (args) => ({
      contents: new Uint8Array(await Bun.file(args.path).arrayBuffer()),
      loader: "file",
    }));
  },
};

const toy = process.argv.slice(2).includes("--toy");
const outdir = path.join(process.cwd(), "dist");
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [...new Bun.Glob("src/**/*.html").scanSync()],
  outdir,
  minify: true,
  target: "browser",
  sourcemap: "none",
  splitting: true,
  reactCompiler: true,
  plugins: [
    asset,
    stylex.esbuild({
      useCSSLayers: false,
      importSources: ["@stylexjs/stylex"],
      unstable_moduleResolution: { type: "commonJS" },
    }),
  ],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

if (toy) {
  // zip 是「更新」语义：已存在的包不会自动剔除消失的文件，先删干净再压；
  // 压的是目录里的东西而不是目录本身，index.html 必须在包根
  const zipPath = path.join(process.cwd(), "toy.zip");
  await rm(zipPath, { force: true });
  await Bun.$`cd ${outdir} && zip -qr ${zipPath} . -x '*.DS_Store'`;
  console.log(` toy.zip  ${(Bun.file(zipPath).size / 1024 / 1024).toFixed(2)} MB  (index.html 在包根)`);
} else {
  for (const output of result.outputs) {
    console.log(` ${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
  }
}

import { rm } from "node:fs/promises";
import path from "node:path";

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
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

if (toy) {
  const zipPath = path.join(process.cwd(), "toy.zip");
  await rm(zipPath, { force: true });
  await Bun.$`cd ${outdir} && zip -qr ${zipPath} . -x '*.DS_Store'`;
  console.log(` toy.zip  ${(Bun.file(zipPath).size / 1024 / 1024).toFixed(2)} MB  (index.html 在包根)`);
} else {
  for (const output of result.outputs) {
    console.log(` ${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
  }
}

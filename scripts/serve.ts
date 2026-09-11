import { watch } from "node:fs";
import path from "node:path";
import index from "../app/index.html";
import { ensureWasm } from "./moon.ts";

const project = path.join(import.meta.dirname, "..");
const port = Number(process.env.PORT ?? 3000);
const dist = path.join(project, "dist");

const server = process.argv.includes("--dist")
  ? Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(request) {
        const { pathname } = new URL(request.url);
        const target = path.resolve(dist, `.${pathname}`);
        if (target.startsWith(dist + path.sep)) {
          const file = Bun.file(target);
          if (await file.exists()) return new Response(file);
        }

        const fallback = Bun.file(path.join(dist, "index.html"));
        if (await fallback.exists()) return new Response(fallback);
        return new Response("dist/ 是空的：bun start 只服务构建产物，先跑 bun build:web。\n", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    })
  : await dev();

async function dev(): Promise<ReturnType<typeof Bun.serve>> {
  ensureWasm();

  const worker = process.env.PIPELINE_WORKER;
  if (!worker)
    throw new Error(
      "PIPELINE_WORKER 没设：dev 要用 `bun dev` 起（它带 scripts/dev.env）；直接 `bun scripts/serve.ts` 会缺这一条。",
    );
  const dir = path.posix.dirname(worker);
  const outdir = path.join(project, "node_modules/.tmp/dev-worker");

  const bundle = async (): Promise<void> => {
    const built = await Bun.build({
      entrypoints: [path.join(project, "app/ui/pipeline.worker.ts")],
      outdir,
      target: "browser",
      naming: "[name].[ext]",
    });
    if (!built.success) for (const log of built.logs) console.error(log);
  };
  await bundle();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: {
      [`${dir}/*`]: async (request: Request) => {
        await bundle();
        const file = Bun.file(path.join(outdir, path.basename(new URL(request.url).pathname)));
        return (await file.exists()) ? new Response(file) : new Response("dev: 没有这个文件", { status: 404 });
      },
      "/*": index,
    },
    development: { hmr: true, console: true },
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(path.join(project, "moon"), { recursive: true }, (_event, file) => {
    if (!file || file.startsWith("_build") || !/\.(mbt|pkg|mod)$/.test(file)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        ensureWasm();
      } catch (error) {
        console.error(error);
      }
    }, 80);
  });

  return server;
}

console.log(`🚀 ${process.argv.includes("--dist") ? "dist" : "dev"}  ${server.url}`);

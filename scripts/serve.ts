import { watch } from "node:fs";
import path from "node:path";
import index from "../app/index.html";

const project = path.join(import.meta.dirname, "..");
const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const onDisk = process.argv.includes("--dist");

function distServer(): ReturnType<typeof Bun.serve> {
  const dist = path.join(project, "dist");
  return Bun.serve({
    port,
    hostname,
    async fetch(request) {
      const target = path.resolve(dist, `.${new URL(request.url).pathname}`);
      if (target.startsWith(dist + path.sep)) {
        const file = Bun.file(target);
        if (await file.exists()) return new Response(file);
      }
      const home = Bun.file(path.join(dist, "index.html"));
      if (await home.exists()) return new Response(home);
      return new Response("dist/ 是空的：先跑 bun build:web。\n", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  });
}

const workerSource = path.join(project, "app/ui/pipeline.worker.ts");
const workerDir = path.join(project, "node_modules/.tmp/dev-worker");

const workerNames = async (): Promise<string[]> => {
  const done = await Bun.build({
    entrypoints: [workerSource],
    outdir: workerDir,
    target: "browser",
    naming: { entry: "[name].js", asset: "[name].[ext]" },
  });
  if (!done.success) for (const log of done.logs) console.error(log);
  return done.outputs.map(output => path.basename(output.path));
};

async function devServer(): Promise<ReturnType<typeof Bun.serve>> {
  const { ensureWasm } = await import("./moon.ts");

  const names = await workerNames();
  const serve = (name: string): Response =>
    new Response(Bun.file(path.join(workerDir, name)), { headers: { "cache-control": "no-store" } });

  const server = Bun.serve({
    port,
    hostname,
    routes: {
      ...Object.fromEntries(
        names.map(name => [
          `/${name}`,
          async () => {
            await workerNames();
            return serve(name);
          },
        ]),
      ),
      "/*": index,
    },
    development: { hmr: true, console: true },
  });

  const entry = "pipeline.worker.js";
  if (!names.includes(entry))
    throw new Error(`worker 出的是 ${names.join("、")}，而 app 侧算出来的地址是 /${entry}：两边对不上`);
  const type = (await fetch(new URL(`/${entry}`, server.url))).headers.get("content-type") ?? "";
  if (!type.includes("javascript"))
    throw new Error(`/${entry} 供出来的是「${type}」：被 SPA 回落吞了，worker 会静默拉不到`);

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

const server = onDisk ? distServer() : await devServer();

console.log(`🚀 ${onDisk ? "dist" : "dev"}  ${server.url}`);

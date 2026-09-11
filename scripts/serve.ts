import { watch } from "node:fs";
import path from "node:path";
import index from "../app/index.html";
import { ensureWasm } from "./moon.ts";

const project = path.join(import.meta.dirname, "..");
const dist = path.join(project, "dist");
const workerOut = path.join(project, "node_modules/.tmp/dev-worker");
const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const onDisk = process.argv.includes("--dist");
const text = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const fresh = (body: BodyInit): Response =>
  new Response(body, { headers: { "cache-control": "no-store" } });

const staticFetch = async (request: Request): Promise<Response> => {
  const target = path.resolve(dist, `.${new URL(request.url).pathname}`);
  if (target.startsWith(dist + path.sep)) {
    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);
  }
  const home = Bun.file(path.join(dist, "index.html"));
  return (await home.exists()) ? new Response(home) : text("dist/ 是空的：先跑 bun build:web。\n", 503);
};

// Bun 的 dev 服务器把入口 bundle 供在 /_bun/client/ 下，app 里那句
// `new URL("./pipeline.worker.js", 入口脚本.src)` 于是落到这个前缀上 —— worker 与它的兄弟资产
// （内核 .wasm）都得能在那儿取到，所以名字钉死、不带内容哈希，路由才认得出来。
const buildWorker = async (): Promise<string[]> => {
  const built = await Bun.build({
    entrypoints: [path.join(project, "app/ui/pipeline.worker.ts")],
    outdir: workerOut,
    target: "browser",
    naming: { entry: "pipeline.worker.js", asset: "[name].[ext]" },
  });
  if (!built.success) for (const log of built.logs) console.error(log);
  return built.outputs.map(output => path.basename(output.path));
};

async function dev(): Promise<ReturnType<typeof Bun.serve>> {
  ensureWasm();

  const [entry, ...assets] = await buildWorker();
  const under = (name: string): string => `/_bun/client/${name}`;
  const routes = {
    [under(entry!)]: async (): Promise<Response> => {
      await buildWorker();
      return fresh(Bun.file(path.join(workerOut, entry!)));
    },
    ...Object.fromEntries(
      assets.map(name => [
        under(name),
        () => fresh(Bun.file(path.join(workerOut, name))),
      ]),
    ),
    "/*": index,
  };

  const server = Bun.serve({ port, hostname, routes, development: { hmr: true, console: true } });

  // Bun 的 client 挂载点是它的内部约定，不是文档承诺：变了就当场说清楚，
  // 别让 worker 静默地拿回 SPA 回落的 HTML。
  for (const name of [entry!, ...assets]) {
    const served = await fetch(new URL(under(name), server.url));
    const type = served.headers.get("content-type") ?? "";
    if (type.includes("html") || type === "")
      throw new Error(`${under(name)} 供出来的是「${type}」：Bun 的 client 挂载点变了。`);
  }

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

const server = onDisk ? Bun.serve({ port, hostname, fetch: staticFetch }) : await dev();

console.log(`🚀 ${onDisk ? "dist" : "dev"}  ${server.url}`);

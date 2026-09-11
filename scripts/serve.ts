import { watch } from "node:fs";
import path from "node:path";
import index from "../app/index.html";

const project = path.join(import.meta.dirname, "..");
const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const onDisk = process.argv.includes("--dist");

// `bun start`：只服务 dist/。找不到实体文件就回落到 index.html（与 Cloudflare 的
// not_found_handling: single-page-application 同语义），顺带把路径穿越挡在 dist/ 里。
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

// Bun 的 dev 服务器把入口 bundle 供在 /_bun/client/ 下，于是 app 里那句
// `new URL("./pipeline.worker.js", 入口脚本.src)` 落到那个前缀上 —— worker 与它的兄弟资产
// （内核 .wasm）都得能在那儿取到，所以 dev 这一遍把名字钉死、不带内容哈希，路由才认得出来。
const workerDir = path.join(project, "node_modules/.tmp/dev-worker");

async function devServer(): Promise<ReturnType<typeof Bun.serve>> {
  // 动态引入：`bun start` 只服务产物，不该因此要求本机装了 MoonBit。
  const { ensureWasm } = await import("./moon.ts");

  const workerNames = async (): Promise<string[]> => {
    const done = await Bun.build({
      entrypoints: [path.join(project, "app/ui/pipeline.worker.ts")],
      outdir: workerDir,
      target: "browser",
      naming: { entry: "pipeline.worker.js", asset: "[name].[ext]" },
    });
    if (!done.success) for (const log of done.logs) console.error(log);
    return done.outputs.map(output => path.basename(output.path));
  };

  const [entry, ...assets] = await workerNames();
  const under = (name: string): string => `/_bun/client/${name}`;
  const serve = (name: string): Response =>
    new Response(Bun.file(path.join(workerDir, name)), { headers: { "cache-control": "no-store" } });

  const server = Bun.serve({
    port,
    hostname,
    routes: {
      // 现编现供：改完 worker 刷新就生效（名字钉住了，所以路由表不必重建）。
      [under(entry!)]: async () => {
        await workerNames();
        return serve(entry!);
      },
      ...Object.fromEntries(assets.map(name => [under(name), () => serve(name)])),
      "/*": index,
    },
    development: { hmr: true, console: true },
  });

  // Bun 的 client 挂载点是它的内部约定，不是文档承诺：变了就当场说清楚，
  // 别让 worker 静默地拿回 SPA 回落的 HTML。
  for (const name of [entry!, ...assets]) {
    const type = (await fetch(new URL(under(name), server.url))).headers.get("content-type") ?? "";
    if (type === "" || type.includes("html"))
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

const server = onDisk ? distServer() : await devServer();

console.log(`🚀 ${onDisk ? "dist" : "dev"}  ${server.url}`);

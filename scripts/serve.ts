import path from "node:path";
import index from "../app/index.html";
import { workerRoutes } from "./worker-plugin.ts";

const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const dist = path.join(import.meta.dirname, "..", "dist");
const onDisk = process.argv.includes("--dist");

const distServer = (): ReturnType<typeof Bun.serve> =>
  Bun.serve({
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
      return new Response("dist/ 是空的：先跑 bun run build:web\n", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  });

if (onDisk) {
  const server = distServer();
  console.log(`🚀 dist  ${server.url}`);
} else {
  const { watchKernel } = await import("./moon.ts");
  const server = Bun.serve({
    port,
    hostname,
    routes: { ...workerRoutes(), "/*": index },
    development: { hmr: true, console: true },
  });
  watchKernel();
  console.log(`🚀 dev  ${server.url}`);
}

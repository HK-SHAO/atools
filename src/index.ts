import { serve } from "bun";
import path from "node:path";
import index from "./index.html";

const dev = process.env.NODE_ENV !== "production";
const dist = path.join(import.meta.dir, "../dist");

const server = dev
  ? serve({
      routes: { "/*": index },
      development: { hmr: true, console: true },
    })
  : serve({
      async fetch(request) {
        const { pathname } = new URL(request.url);
        const file = Bun.file(path.join(dist, pathname));
        if (await file.exists()) return new Response(file);

        // 与 Cloudflare 的 not_found_handling: single-page-application 同语义
        const fallback = Bun.file(path.join(dist, "index.html"));
        if (await fallback.exists()) return new Response(fallback);
        return new Response("dist/ 是空的：bun start 只服务构建产物，先跑 bun build:web。\n", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    });

console.log(`🚀 ${dev ? "dev" : "dist"} server running at ${server.url}`);

import { serve } from "bun";
import path from "node:path";
import index from "./index.html";

const dev = process.env.NODE_ENV !== "production";
const dist = path.join(import.meta.dir, "../dist");

// 两条路刻意分开：dev 直出源码 + HMR；start 只服务构建产物。
// 合成一条是不行的 —— dev 把 `/*` 一律回落到 index.html，
// 于是 /sw.js 与 /manifest.webmanifest 都会拿回 HTML，PWA 在本地永远复现不出来。
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
        return (await fallback.exists())
          ? new Response(fallback)
          : new Response("dist/ 是空的：bun start 只服务构建产物，先跑 bun run build:web。\n", {
              status: 503,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
      },
    });

console.log(`🚀 ${dev ? "dev" : "dist"} server running at ${server.url}`);

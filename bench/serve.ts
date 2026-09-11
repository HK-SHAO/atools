import { compileWasm, WASM_FILE } from "../scripts/moon";
import { contentType } from "./cdp";

const root = import.meta.dir;
const PORT = Number(process.env.PORT ?? 4330);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    let file: string;
    if (path === "/") file = `${root}/index.html`;
    else if (path === "/bundle.js") file = `${root}/bundle-${PORT}.js`;
    else if (path.startsWith("/audio/")) file = `${root}/../docs/${path.slice(7)}`;
    else if (path.startsWith("/pcm/")) {
      try {
        file = (await import("./cache")).cachePath(decodeURIComponent(path.slice(5)));
      } catch {
        return new Response("missing", { status: 404 });
      }
    } else if (path === `/${WASM_FILE}`) {
      // 数值内核是页面上整条链的前置条件（没有 TS 参照实现可退），`entry.ts` 顶层就 await 它。
      // 这里现编现供：`bun bench` 因此不会拿着一份与 `moon/` 不同步的旧产物去量。
      return new Response(compileWasm(), { headers: { "content-type": "application/wasm" } });
    } else return new Response("nope", { status: 404 });

    const body = Bun.file(file);
    if (!(await body.exists())) return new Response("missing", { status: 404 });
    return new Response(body, { headers: { "content-type": contentType(file) } });
  },
});

console.log(`bench 服务 http://127.0.0.1:${PORT}`);

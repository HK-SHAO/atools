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
    } else return new Response("nope", { status: 404 });

    const body = Bun.file(file);
    if (!(await body.exists())) return new Response("missing", { status: 404 });
    return new Response(body, { headers: { "content-type": contentType(file) } });
  },
});

console.log(`bench 服务 http://127.0.0.1:${PORT}`);

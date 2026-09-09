const root = import.meta.dir;
const project = `${root}/..`;
const BUNDLE = `bundle-${process.env.PORT ?? 4330}.js`; // 并行实例各用各的 bundle

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".png": "image/png",
};

Bun.serve({
  port: Number(process.env.PORT ?? 4330),
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    let file: string;
    if (path === "/index.html") file = `${root}${path}`;
    else if (path === "/bundle.js") file = `${root}/${BUNDLE}`;
    else if (path.startsWith("/audio/")) file = `${project}/docs/${path.slice(7)}`;
    else if (path.startsWith("/pcm/")) {
      // 解码缓存（见 cache.ts），未命中返回 404，页面回退到 /audio/ 现场解码
      try {
        file = (await import("./cache")).cachePath(
          decodeURIComponent(path.slice(5)),
        );
      } catch {
        return new Response("missing", { status: 404 });
      }
    } else return new Response("nope", { status: 404 });

    const body = Bun.file(file);
    if (!(await body.exists())) return new Response("missing", { status: 404 });
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(body, {
      headers: { "content-type": TYPES[ext] ?? "application/octet-stream" },
    });
  },
});

console.log(`bench server on http://127.0.0.1:${process.env.PORT ?? 4330}`);

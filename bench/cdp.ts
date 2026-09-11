import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

function chromium(): string {
  const candidates = process.env.CHROME
    ? [process.env.CHROME]
    : [
        "chromium", "chromium-browser", "google-chrome", "chrome", "msedge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
          .filter((dir): dir is string => Boolean(dir))
          .map(dir => join(dir, "Google/Chrome/Application/chrome.exe")),
      ];
  for (const candidate of candidates) {
    const executable = Bun.which(candidate);
    if (executable) return executable;
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 Chromium / Chrome：安装浏览器，或设置 CHROME 为浏览器可执行文件路径。");
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface Session {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  ev<R = unknown>(expression: string): Promise<R>;
  on(listener: (msg: any) => void): void;
  goto(url: string, ready: string): Promise<void>;
  stop(): Promise<void>;
}

export async function waitFor<T>(label: string, fn: () => Promise<T | null>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error("超时：" + label);
    await sleep(250);
  }
}

interface Options {
  port: number;
  size: [number, number];
  url: string;
  args?: string[];
}

export async function open({ port, size, url, args = [] }: Options): Promise<Session> {
  const [w, h] = size;
  const proc = spawn(
    chromium(),
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-sandbox",
      "--disable-gpu",
      "--mute-audio",
      ...args,
      `--window-size=${w},${h}`,
      `--user-data-dir=${join(tmpdir(), `cdp-${port}-${Date.now()}`)}`,
      url,
    ],
    { stdio: "ignore" },
  );

  const stop = async (): Promise<void> => {
    proc.kill();
    await sleep(200);
  };

  try {
    const wsUrl = await waitFor("CDP 目标", async () => {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl?: string;
      }[];
      return list.find(x => x.type === "page")?.webSocketDebuggerUrl ?? null;
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, err) => {
      ws.onopen = ok;
      ws.onerror = err;
    });

    let seq = 0;
    const pending = new Map<number, (v: unknown) => void>();
    const listeners: ((msg: any) => void)[] = [];
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown };
      if (m.id !== undefined) pending.get(m.id)?.(m.result);
      else for (const f of listeners) f(m);
    };

    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
      new Promise(res => {
        const id = ++seq;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const ev = async <R,>(expression: string): Promise<R> => {
      const r = (await send("Runtime.evaluate", {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: R }; exceptionDetails?: { exception?: { description?: string } } };
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "求值失败");
      return r.result?.value as R;
    };

    await send("Runtime.enable");
    await send("Page.enable");

    return {
      send,
      ev,
      on: f => listeners.push(f),
      goto: async (target, ready) => {
        await send("Page.navigate", { url: target });
        for (let i = 0; i < 150; i++) {
          await sleep(100);
          if (await ev<boolean>(`return !!document.querySelector(${JSON.stringify(ready)})`)) return;
        }
        throw new Error(`导航超时：${target}`);
      },
      stop: async () => {
        ws.close();
        await stop();
      },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

const contentType = (file: string): string => TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".amr": "audio/amr",
  ".wasm": "application/wasm",
};

export interface Site {
  dir?: string;
  files?: Record<string, string | Uint8Array>;
  spa?: boolean;
}

export function serve(port: number, site: Site): { stop(): void } {
  const server = createServer((req, res) => {
    const path = decode(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    void respond(res, site, path).catch((error: unknown) => {
      if (res.headersSent) return;
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`静态服务供不出 ${path}：${String(error)}`);
    });
  });
  server.listen(port, "127.0.0.1");
  return {
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const decode = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

const asName = (path: string): string => (path === "/" ? "index.html" : path);

async function respond(res: ServerResponse, site: Site, path: string): Promise<void> {
  const exact = site.files?.[path];
  if (exact)
    return put(
      res,
      typeof exact === "string" ? await readFile(exact) : exact,
      typeof exact === "string" ? exact : asName(path),
    );

  if (site.dir) {
    const file = path === "/" ? `${site.dir}/index.html` : `${site.dir}${path}`;
    const body = await readFile(file).catch(() => null);
    if (body) return put(res, body, file);
    if (site.spa) {
      const fallback = await readFile(`${site.dir}/index.html`).catch(() => null);
      if (fallback) return put(res, fallback, "index.html");
    }
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("missing");
}

const put = (res: ServerResponse, body: Uint8Array, name: string): void => {
  res.writeHead(200, { "content-type": contentType(name) });
  res.end(body);
};

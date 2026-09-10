const CHROME =
  "/Users/sf/.chromium-browser-snapshots/chromium/mac_arm-1684550/chrome-mac/Chromium.app/Contents/MacOS/Chromium";

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface Session {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  ev<R = unknown>(expression: string): Promise<R>;
  on(listener: (msg: any) => void): void;
  goto(url: string, ready: string): Promise<void>;
  shot(path: string): Promise<void>;
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
  const proc = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-sandbox",
      "--disable-gpu",
      "--mute-audio",
      ...args,
      `--window-size=${w},${h}`,
      `--user-data-dir=/tmp/cdp-${port}-${Date.now()}`,
      url,
    ],
    { stdout: "ignore", stderr: "ignore" },
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
      shot: async path => {
        const r = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
        await Bun.write(path, Buffer.from(r.data, "base64"));
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

export const contentType = (file: string): string => TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
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
};

export function serveDir(
  port: number,
  dir: string,
  mounts: Record<string, string> = {},
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const mount = Object.keys(mounts).find(prefix => path.startsWith(prefix));
      const file = mount
        ? `${mounts[mount]}${path.slice(mount.length)}`
        : path === "/"
          ? `${dir}/index.html`
          : `${dir}${path}`;
      const body = Bun.file(file);
      if (!(await body.exists())) return new Response("missing", { status: 404 });
      return new Response(body, { headers: { "content-type": contentType(file) } });
    },
  });
}

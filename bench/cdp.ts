import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

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
  throw new Error("Chromium / Chrome not found: install a browser, or set CHROME to the browser executable path");
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
    if (Date.now() > end) throw new Error("Timed out: " + label);
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
  const profile = join(tmpdir(), `cdp-${port}-${Date.now()}`);
  const proc = Bun.spawn(
    [
      chromium(),
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-sandbox",
      "--disable-gpu",
      "--mute-audio",
      ...args,
      `--window-size=${w},${h}`,
      `--user-data-dir=${profile}`,
      url,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  const stop = async (): Promise<void> => {
    if (proc.exitCode === null) proc.kill();
    await Promise.race([proc.exited, sleep(2000)]);
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    await rm(profile, { recursive: true, force: true });
  };

  try {
    const wsUrl = await waitFor("CDP target", async () => {
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
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
    >();
    const listeners: ((msg: any) => void)[] = [];
    const rejectPending = (message: string): void => {
      for (const call of pending.values()) call.reject(new Error(message));
      pending.clear();
    };
    ws.onerror = () => rejectPending("CDP connection failed");
    ws.onclose = () => rejectPending("CDP connection closed");
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (m.id === undefined) {
        for (const f of listeners) f(m);
        return;
      }
      const call = pending.get(m.id);
      if (!call) return;
      pending.delete(m.id);
      if (m.error) call.reject(new Error(m.error.message ?? "CDP request failed"));
      else call.resolve(m.result);
    };

    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
      new Promise((accept, reject) => {
        const id = ++seq;
        pending.set(id, { resolve: accept, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    const ev = async <R,>(expression: string): Promise<R> => {
      const r = (await send("Runtime.evaluate", {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: R }; exceptionDetails?: { exception?: { description?: string } } };
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "Evaluation failed");
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
        throw new Error(`Navigation timed out: ${target}`);
      },
      stop: async () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ id: ++seq, method: "Browser.close", params: {} }));
        await stop();
        ws.close();
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

interface Site {
  dir?: string;
  files?: Record<string, string | Uint8Array>;
  spa?: boolean;
}

export function serve(port: number, site: Site): { stop(): void } {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      let path: string;
      try {
        path = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response("bad path", { status: 400 });
      }
      const exact = site.files?.[path];
      if (exact !== undefined)
        return response(
          typeof exact === "string" ? Bun.file(exact) : exact,
          path === "/" ? "index.html" : path,
        );

      if (site.dir) {
        const root = resolve(site.dir);
        const target = resolve(root, path === "/" ? "index.html" : `.${path}`);
        if (target.startsWith(root + sep)) {
          const file = Bun.file(target);
          if (await file.exists()) return response(file, target);
        }
        if (site.spa) {
          const home = Bun.file(join(root, "index.html"));
          if (await home.exists()) return response(home, "index.html");
        }
      }
      return new Response("missing", { status: 404 });
    },
  });
}

const response = (body: Blob | Uint8Array, name: string): Response =>
  new Response(body instanceof Blob ? body : Uint8Array.from(body).buffer, {
    headers: { "content-type": contentType(name) },
  });
